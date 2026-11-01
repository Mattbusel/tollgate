// Tollgate seller SDK. Wrap any node:http style handler with a price; requests without a valid
// voucher get HTTP 402 with machine-readable payment instructions (x402-shaped, scheme
// "near-channel"). Vouchers are verified off chain in microseconds; the newest voucher per
// channel is kept, and a settler cashes it on chain every N calls or T seconds, or right away
// when the agent starts closing the channel.
//
//   const gate = createTollgate({ contract, seller, settlerAccount, store });
//   server.on('request', gate.protect({ price: '0.001', description: 'USGS quakes' }, handler));
//   gate.startSettler();
import {
  SCHEME, PAYMENT_HEADER, PAYMENT_RESPONSE_HEADER, VOUCHER_DOMAIN, decodePaymentHeader,
  verifyVoucher, encodeJsonHeader, parseNear, formatNear, voucherMessage, closeMessage, verifyRaw,
} from '../core/voucher.mjs';
import { MemoryStore } from './store.mjs';

const NS_PER_MS = 1_000_000n;

/** Reads channel state from the contract. Replaceable in tests. */
export function rpcChannelSource(rpcUrl, contract) {
  return async (channelId) => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'tollgate-seller',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'optimistic',
          account_id: contract,
          method_name: 'get_channel',
          args_base64: Buffer.from(JSON.stringify({ channel_id: String(channelId) })).toString('base64'),
        },
      }),
    });
    const j = await res.json();
    if (j.error) throw new Error(`RPC error: ${JSON.stringify(j.error).slice(0, 200)}`);
    const text = Buffer.from(j.result.result).toString('utf8');
    return text ? JSON.parse(text) : null;
  };
}

export class PaymentError extends Error {
  constructor(reason, message, extra = {}) {
    super(message);
    this.reason = reason;
    this.extra = extra;
  }
}

export function createTollgate(opts) {
  const {
    contract,
    seller,
    network = 'near-testnet',
    rpcUrl = 'https://test.rpc.fastnear.com',
    channelSource = rpcChannelSource(opts.rpcUrl || 'https://test.rpc.fastnear.com', opts.contract),
    store = new MemoryStore(),
    settle = null, // async ({channelId, cumulative, nonce, signature}) => {hash, ok, error, value}
    cooperativeClose = null, // async ({channelId, voucher|null}) => {hash, ok, error, value}
    minDisputeWindowSec = 15,
    minRemainingSec = 120,
    settleEveryCalls = 100,
    settleEverySec = 60,
    channelCacheMs = 30_000,
    now = () => Date.now(),
    log = () => {},
  } = opts;
  if (!contract || !seller) throw new Error('createTollgate needs contract and seller');

  const channelCache = new Map(); // id -> { view, fetchedAt }
  let settling = new Set();
  let timer = null;

  async function getChannel(channelId, { fresh = false } = {}) {
    const key = String(channelId);
    const c = channelCache.get(key);
    if (!fresh && c && now() - c.fetchedAt < channelCacheMs) return c.view;
    const v = await channelSource(key);
    channelCache.set(key, { view: v, fetchedAt: now() });
    return v;
  }

  function requirements(price, resource, description, extraInfo = {}) {
    const yocto = parseNear(price).toString();
    return {
      scheme: SCHEME,
      network,
      maxAmountRequired: yocto,
      asset: 'NEAR',
      payTo: seller,
      resource,
      description,
      mimeType: 'application/json',
      maxTimeoutSeconds: 60,
      extra: {
        contract,
        price: yocto,
        priceNear: String(price),
        voucher: `${VOUCHER_DOMAIN}:{contract}:{channel_id}:{cumulative_yocto}:{nonce}`,
        signature: 'ed25519 over the UTF-8 voucher string, base64, made with the channel key',
        header: 'X-PAYMENT',
        headerFormat: 'base64(JSON {scheme, network, payload:{contract, channel_id, cumulative, nonce, signature}})',
        minDisputeWindowSec,
        minRemainingSec,
        openChannel: {
          contract,
          method: 'open_channel',
          deposit: 'attach the budget in yoctoNEAR',
          args: { seller, agent_pubkey: 'ed25519:<channel public key>', expires_in_sec: '86400', dispute_window_sec: String(Math.max(minDisputeWindowSec, 15)) },
        },
        ...extraInfo,
      },
    };
  }

  function paymentRequiredBody(price, resource, description, error = 'payment required', extraInfo = {}) {
    return {
      x402Version: 1,
      error,
      accepts: [requirements(price, resource, description, extraInfo)],
    };
  }

  /** Verify a voucher for `price` and record it as the newest for its channel. */
  async function acceptVoucher(header, price, resource) {
    const priceY = parseNear(price);
    let v;
    try {
      v = decodePaymentHeader(header);
    } catch (e) {
      throw new PaymentError('bad_header', e.message);
    }
    if (v.contract !== contract) throw new PaymentError('wrong_contract', `this seller only accepts channels on ${contract}`);
    if (v.network && v.network !== network) throw new PaymentError('wrong_network', `expected ${network}`);
    const id = v.channelId.toString();
    let ch = await getChannel(id);
    if (ch && BigInt(v.cumulative) > BigInt(ch.deposit)) ch = await getChannel(id, { fresh: true }); // maybe topped up
    if (!ch) throw new PaymentError('unknown_channel', `channel ${id} does not exist on ${contract}`);
    if (ch.seller !== seller) throw new PaymentError('wrong_seller', `channel ${id} pays ${ch.seller}, not ${seller}`);
    if (ch.status !== 'Open') {
      ch = await getChannel(id, { fresh: true });
      if (ch.status !== 'Open') throw new PaymentError('channel_not_open', `channel ${id} is ${ch.status}`);
    }
    if (Number(ch.dispute_window_sec) < minDisputeWindowSec) {
      throw new PaymentError('window_too_short', `dispute window must be at least ${minDisputeWindowSec} s`);
    }
    const remainingMs = Number((BigInt(ch.expires_at_ns) / NS_PER_MS)) - now();
    if (remainingMs < minRemainingSec * 1000) {
      throw new PaymentError('channel_expiring', `channel ${id} expires in ${Math.round(remainingMs / 1000)} s; open a new one`);
    }

    // --- synchronous from here on: check and commit atomically (single-threaded) ---
    const prev = store.getChannel(id) || {
      cumulative: ch.settled,
      nonce: ch.last_nonce,
      calls: 0,
      settledCumulative: ch.settled,
      settledNonce: ch.last_nonce,
      settleTx: null,
      owner: ch.owner,
    };
    const prevCum = BigInt(prev.cumulative);
    const prevNonce = BigInt(prev.nonce);
    const state = { channel_id: id, cumulative: prevCum.toString(), nonce: prevNonce.toString() };
    if (v.nonce <= prevNonce) throw new PaymentError('stale_nonce', `nonce must be above ${prevNonce}`, { channel: state });
    if (v.cumulative - prevCum < priceY) {
      throw new PaymentError('underpaid', `cumulative must grow by at least ${priceY} yoctoNEAR (to ${prevCum + priceY})`, { channel: state });
    }
    if (v.cumulative > BigInt(ch.deposit)) {
      throw new PaymentError('overspend', `cumulative ${v.cumulative} exceeds the channel deposit ${ch.deposit}; top up or open a new channel`, { channel: state });
    }
    const t0 = process.hrtime.bigint();
    const ok = verifyVoucher(ch.agent_pubkey, { contract, channelId: v.channelId, cumulative: v.cumulative, nonce: v.nonce }, v.signature);
    const verifyNs = process.hrtime.bigint() - t0;
    if (!ok) throw new PaymentError('bad_signature', 'voucher signature does not match the channel key', { channel: state });

    const paid = v.cumulative - prevCum;
    const next = {
      ...prev,
      cumulative: v.cumulative.toString(),
      nonce: v.nonce.toString(),
      signature: v.signature,
      calls: (prev.calls || 0) + 1,
      callsSinceSettle: (prev.callsSinceSettle || 0) + 1,
      firstUnsettledAt: prev.firstUnsettledAt || now(),
      updatedAt: now(),
      deposit: ch.deposit,
      expiresAtMs: Number(BigInt(ch.expires_at_ns) / NS_PER_MS),
      owner: ch.owner,
    };
    store.putChannel(id, next);
    const receipt = {
      ts: new Date(now()).toISOString(),
      channel_id: id,
      owner: ch.owner,
      resource,
      price: priceY.toString(),
      paid: paid.toString(),
      cumulative: v.cumulative.toString(),
      nonce: v.nonce.toString(),
      verify_us: Number(verifyNs) / 1000,
      settled: false,
    };
    store.addReceipt(receipt);
    return { receipt, channel: next };
  }

  function paymentResponse(channelState, receipt) {
    return encodeJsonHeader({
      success: true,
      scheme: SCHEME,
      network,
      contract,
      channel_id: receipt.channel_id,
      cumulative: receipt.cumulative,
      nonce: receipt.nonce,
      paid: receipt.paid,
      settlement: channelState.settleTx
        ? { tx: channelState.settleTx, cumulative: channelState.settledCumulative, nonce: channelState.settledNonce }
        : null,
    });
  }

  /** Wrap a (req, res) handler. The handler runs only after the voucher is accepted. */
  function protect({ price, description = '' }, handler) {
    parseNear(price); // validate early
    return async (req, res) => {
      const resource = resourceUrl(req);
      const header = req.headers[PAYMENT_HEADER];
      const set402 = (error, extra) => {
        const body = paymentRequiredBody(price, resource, description, error, extra);
        res.statusCode = 402;
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-tollgate-scheme', SCHEME);
        res.setHeader('x-tollgate-network', network);
        res.setHeader('x-tollgate-contract', contract);
        res.setHeader('x-tollgate-seller', seller);
        res.setHeader('x-tollgate-price', body.accepts[0].maxAmountRequired);
        res.end(JSON.stringify(body, null, 2));
      };
      if (!header) return set402('payment required');
      let accepted;
      try {
        accepted = await acceptVoucher(header, price, resource);
      } catch (e) {
        if (e instanceof PaymentError) return set402(e.message, { reason: e.reason, ...e.extra });
        log(`voucher check failed: ${e.message}`);
        res.statusCode = 503;
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ error: 'could not check the channel on chain, retry', detail: e.message }));
      }
      res.setHeader(PAYMENT_RESPONSE_HEADER, paymentResponse(accepted.channel, accepted.receipt));
      res.setHeader('access-control-expose-headers', PAYMENT_RESPONSE_HEADER);
      return handler(req, res, accepted.receipt);
    };
  }

  // ---------------------------------------------------------------- settlement

  function dueChannels({ force = false } = {}) {
    const out = [];
    for (const [id, c] of store.channels()) {
      if (settling.has(id)) continue;
      if (BigInt(c.nonce) <= BigInt(c.settledNonce || 0)) continue;
      const age = now() - (c.firstUnsettledAt || now());
      const expiringSoon = c.expiresAtMs && c.expiresAtMs - now() < minRemainingSec * 1000;
      if (force || c.closing || expiringSoon || (c.callsSinceSettle || 0) >= settleEveryCalls || age >= settleEverySec * 1000) {
        out.push(id);
      }
    }
    return out;
  }

  /** Settle the newest voucher of one channel on chain. Returns the transaction summary. */
  async function settleChannel(id) {
    if (!settle) throw new Error('no settle function configured (seller key missing)');
    const c = store.getChannel(String(id));
    if (!c || BigInt(c.nonce) <= BigInt(c.settledNonce || 0)) return null;
    settling.add(String(id));
    try {
      const r = await settle({ channelId: String(id), cumulative: c.cumulative, nonce: c.nonce, signature: c.signature });
      const latest = store.getChannel(String(id));
      if (r.ok || /TOLLGATE_REPLAY/.test(r.error || '')) {
        latest.settledCumulative = r.ok ? c.cumulative : latest.settledCumulative;
        latest.settledNonce = r.ok ? c.nonce : latest.settledNonce;
        if (r.ok) {
          latest.settleTx = r.hash;
          latest.settlements = [...(latest.settlements || []), { nonce: c.nonce, cumulative: c.cumulative, tx: r.hash, at: new Date(now()).toISOString() }];
        }
        if (BigInt(latest.nonce) <= BigInt(latest.settledNonce)) {
          latest.callsSinceSettle = 0;
          latest.firstUnsettledAt = null;
        } else {
          latest.callsSinceSettle = Number(BigInt(latest.nonce) - BigInt(latest.settledNonce));
          latest.firstUnsettledAt = now();
        }
        store.putChannel(String(id), latest);
        if (r.ok) store.markSettled(String(id), BigInt(c.nonce), r.hash);
        log(`settled channel ${id} at nonce ${c.nonce}: ${r.ok ? r.hash : r.error}`);
      } else {
        log(`settle channel ${id} failed: ${r.error}`);
      }
      return r;
    } finally {
      settling.delete(String(id));
    }
  }

  async function refreshClosingFlags() {
    for (const [id, c] of store.channels()) {
      if (BigInt(c.nonce) <= BigInt(c.settledNonce || 0)) continue;
      try {
        const v = await getChannel(id, { fresh: true });
        if (v && v.status === 'Closing' && !c.closing) {
          c.closing = true;
          store.putChannel(id, c);
          log(`channel ${id} is closing; settling inside the dispute window`);
        }
      } catch {
        /* RPC hiccup: try again next tick */
      }
    }
  }

  async function tick() {
    await refreshClosingFlags();
    for (const id of dueChannels()) await settleChannel(id).catch((e) => log(`settle ${id}: ${e.message}`));
  }

  function startSettler({ intervalMs = 3000 } = {}) {
    if (timer) return;
    let running = false;
    timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await tick();
      } finally {
        running = false;
      }
    }, intervalMs);
    timer.unref?.();
  }

  function stopSettler() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function settleAll() {
    const out = [];
    for (const id of dueChannels({ force: true })) out.push(await settleChannel(id));
    return out.filter(Boolean);
  }

  /** Cooperative close, requested by the agent with a signature from the channel key. */
  async function closeRequest({ channel_id, signature }) {
    if (!cooperativeClose) throw new PaymentError('unsupported', 'cooperative close not configured');
    const id = String(channel_id);
    const ch = await getChannel(id, { fresh: true });
    if (!ch || ch.seller !== seller) throw new PaymentError('unknown_channel', `channel ${id} is not ours`);
    const msg = closeMessage(contract, id);
    if (!verifyRaw(ch.agent_pubkey, msg, signature)) throw new PaymentError('bad_signature', 'close request must be signed by the channel key');
    const c = store.getChannel(id);
    const voucher = c && BigInt(c.nonce) > BigInt(c.settledNonce || 0) ? { cumulative: c.cumulative, nonce: c.nonce, signature: c.signature } : null;
    settling.add(id);
    try {
      const r = await cooperativeClose({ channelId: id, voucher });
      if (r.ok) {
        const latest = store.getChannel(id) || {};
        if (voucher) {
          latest.settledCumulative = voucher.cumulative;
          latest.settledNonce = voucher.nonce;
          latest.settleTx = r.hash;
          latest.settlements = [...(latest.settlements || []), { nonce: voucher.nonce, cumulative: voucher.cumulative, tx: r.hash, at: new Date(now()).toISOString(), how: 'cooperative_close' }];
          store.markSettled(id, BigInt(voucher.nonce), r.hash);
        }
        latest.closed = true;
        store.putChannel(id, latest);
      }
      return r;
    } finally {
      settling.delete(id);
    }
  }

  return {
    contract,
    seller,
    network,
    protect,
    acceptVoucher,
    paymentRequiredBody,
    settleChannel,
    settleAll,
    startSettler,
    stopSettler,
    tick,
    closeRequest,
    getChannel,
    store,
    receipts: (limit = 100) => store.receipts(limit),
    channels: () => [...store.channels()].map(([id, c]) => ({ channel_id: id, ...c, signature: undefined })),
  };
}

export function resourceUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const proto = req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
  return `${proto}://${host}${req.url}`;
}

export { voucherMessage, formatNear };
