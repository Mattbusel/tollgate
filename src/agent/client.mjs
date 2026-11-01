// Tollgate agent client. fetch() that pays HTTP 402 "near-channel" paywalls automatically:
// opens (or tops up) a channel on a trusted contract within the budget the human set, signs
// each call with a dedicated channel key (never the account key), enforces a per-call price cap
// and a total budget, and keeps a local receipt log.
import fs from 'node:fs';
import path from 'node:path';
import {
  SCHEME, PAYMENT_HEADER, PAYMENT_RESPONSE_HEADER, generateChannelKey, signVoucher, signRaw,
  closeMessage, encodePaymentHeader, decodeJsonHeader, parseNear, formatNear,
} from '../core/voucher.mjs';

export class BudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const NS_PER_MS = 1_000_000n;

function originOf(url) {
  return new URL(url).origin;
}

export class TollgateClient {
  /**
   * @param {object} o
   * @param {string|bigint} o.budget            total NEAR this client may commit (spent + locked), e.g. "1"
   * @param {string|bigint} o.maxPricePerCall   refuse any single call priced above this, e.g. "0.01"
   * @param {string|bigint} [o.channelDeposit]  how much to lock per new channel (capped by budget)
   * @param {string[]} o.trustedContracts       only open channels on these contract ids
   * @param {object} o.chain                    { openChannel, topUp, startClose, finalize, getChannel }
   * @param {string} o.stateDir                 where channel keys, budget use and receipts live
   */
  constructor(o) {
    this.budget = typeof o.budget === 'bigint' ? o.budget : parseNear(o.budget);
    this.maxPrice = typeof o.maxPricePerCall === 'bigint' ? o.maxPricePerCall : parseNear(o.maxPricePerCall);
    this.channelDeposit = o.channelDeposit == null ? this.budget : typeof o.channelDeposit === 'bigint' ? o.channelDeposit : parseNear(o.channelDeposit);
    this.trusted = new Set(o.trustedContracts || []);
    this.network = o.network || 'near-testnet';
    this.chain = o.chain;
    this.stateDir = o.stateDir;
    this.expiresInSec = o.expiresInSec || 24 * 3600;
    this.disputeWindowSec = o.disputeWindowSec || 60;
    this.fetchImpl = o.fetch || globalThis.fetch;
    this.log = o.log || (() => {});
    this.locks = new Map();
    this.priceHints = new Map(); // origin+path -> requirements from the last 402
    fs.mkdirSync(this.stateDir, { recursive: true });
    this.stateFile = path.join(this.stateDir, 'state.json');
    this.receiptFile = path.join(this.stateDir, 'receipts.jsonl');
    this.state = fs.existsSync(this.stateFile)
      ? JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      : { spent: '0', channels: [] };
  }

  save() {
    const tmp = this.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
  }

  // ---------------------------------------------------------------- budget

  spent() {
    return BigInt(this.state.spent);
  }

  /** Unspent deposit still locked in channels that are not closed. */
  locked() {
    let sum = 0n;
    for (const c of this.state.channels) {
      if (c.status === 'Closed') continue;
      sum += BigInt(c.deposit) - BigInt(c.cumulative);
    }
    return sum;
  }

  /** Non-refundable chain costs charged against the budget (channel storage staking). */
  fees() {
    return BigInt(this.state.fees || '0');
  }

  available() {
    const a = this.budget - this.spent() - this.locked() - this.fees();
    return a > 0n ? a : 0n;
  }

  status() {
    return {
      budget: formatNear(this.budget, 6),
      spent: formatNear(this.spent(), 6),
      locked_in_channels: formatNear(this.locked(), 6),
      channel_storage_fees: formatNear(this.fees(), 6),
      available_for_new_channels: formatNear(this.available(), 6),
      max_price_per_call: formatNear(this.maxPrice, 6),
      trusted_contracts: [...this.trusted],
      channels: this.state.channels.map((c) => ({
        channel_id: c.channel_id,
        contract: c.contract,
        seller: c.seller,
        seller_origin: c.origin,
        deposit: formatNear(c.deposit, 6),
        spent: formatNear(c.cumulative, 6),
        nonce: c.nonce,
        status: c.status,
        public_key: c.publicKey,
        last_settlement_tx: c.settleTx || null,
      })),
    };
  }

  // ---------------------------------------------------------------- receipts

  addReceipt(r) {
    fs.appendFileSync(this.receiptFile, JSON.stringify(r) + '\n');
  }

  receipts(limit = 50) {
    if (!fs.existsSync(this.receiptFile)) return [];
    const lines = fs.readFileSync(this.receiptFile, 'utf8').trim().split('\n').filter(Boolean);
    const all = lines.map((l) => JSON.parse(l));
    // Attach settlement info known for each channel (from the seller and the chain): a call is
    // settled by the first settlement whose nonce reaches the call's voucher nonce.
    const byId = new Map(this.state.channels.map((c) => [`${c.contract}/${c.channel_id}`, c]));
    for (const r of all) {
      const c = byId.get(`${r.contract}/${r.channel_id}`);
      if (!c) continue;
      const log = [...(c.settlementLog || [])].sort((a, b) => (BigInt(a.nonce) < BigInt(b.nonce) ? -1 : 1));
      const hit = log.find((x) => BigInt(x.nonce) >= BigInt(r.nonce));
      if (hit) {
        r.settled = true;
        r.settlement_tx = hit.tx;
      } else if (c.settledNonce && BigInt(r.nonce) <= BigInt(c.settledNonce)) {
        r.settled = true; // the chain says so; the seller did not tell us the tx
        r.settlement_tx = r.settlement_tx || null;
      }
    }
    return all.slice(-limit).reverse();
  }

  // ---------------------------------------------------------------- channels

  async withLock(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve();
    let release;
    const next = new Promise((r) => (release = r));
    this.locks.set(key, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  findChannel(contract, seller, price) {
    const nowMs = Date.now();
    return this.state.channels.find(
      (c) =>
        c.contract === contract &&
        c.seller === seller &&
        c.status === 'Open' &&
        c.expiresAtMs - nowMs > 5 * 60_000 &&
        BigInt(c.deposit) - BigInt(c.cumulative) >= price,
    );
  }

  async ensureChannel(req, origin) {
    const contract = req.extra.contract;
    const seller = req.payTo;
    const price = BigInt(req.maxAmountRequired);
    let ch = this.findChannel(contract, seller, price);
    if (ch) return ch;

    const window = Math.max(this.disputeWindowSec, Number(req.extra.minDisputeWindowSec || 0));
    const avail = this.available();
    // An open channel that is merely short of funds gets a top-up instead of a new channel.
    const short = this.state.channels.find(
      (c) => c.contract === contract && c.seller === seller && c.status === 'Open' && c.expiresAtMs - Date.now() > 5 * 60_000,
    );
    let amount = this.channelDeposit < avail ? this.channelDeposit : avail;
    if (amount < price) {
      throw new BudgetError('budget_exhausted', `budget left for new deposits is ${formatNear(avail, 6)} NEAR, call costs ${formatNear(price, 6)}`);
    }
    if (short) {
      this.log(`topping up channel ${short.channel_id} with ${formatNear(amount, 4)} NEAR`);
      const r = await this.chain.topUp({ contract, channelId: short.channel_id, deposit: amount });
      short.deposit = (BigInt(short.deposit) + amount).toString();
      short.topUps = [...(short.topUps || []), r.hash];
      this.save();
      return short;
    }
    const key = generateChannelKey();
    this.log(`opening a channel to ${seller} on ${contract} with ${formatNear(amount, 4)} NEAR`);
    const opened = await this.chain.openChannel({
      contract,
      seller,
      publicKey: key.publicKey,
      deposit: amount,
      expiresInSec: this.expiresInSec,
      disputeWindowSec: window,
    });
    ch = {
      contract,
      seller,
      origin,
      channel_id: String(opened.channelId),
      secretKey: key.secretKey,
      publicKey: key.publicKey,
      deposit: String(opened.deposit ?? amount),
      cumulative: '0',
      nonce: '0',
      status: 'Open',
      openedTx: opened.hash,
      expiresAtMs: opened.expiresAtMs || Date.now() + this.expiresInSec * 1000,
      disputeWindowSec: window,
    };
    const storageFee = amount - BigInt(ch.deposit);
    if (storageFee > 0n) this.state.fees = (this.fees() + storageFee).toString();
    this.state.channels.push(ch);
    this.save();
    return ch;
  }

  pickRequirements(body) {
    const accepts = Array.isArray(body?.accepts) ? body.accepts : [];
    const req = accepts.find((a) => a.scheme === SCHEME && a.network === this.network);
    if (!req) throw new BudgetError('no_supported_scheme', `seller offers no ${SCHEME} payment on ${this.network}`);
    if (!this.trusted.has(req.extra?.contract)) {
      throw new BudgetError('untrusted_contract', `refusing to lock funds in ${req.extra?.contract}; trusted: ${[...this.trusted].join(', ')}`);
    }
    const price = BigInt(req.maxAmountRequired);
    if (price > this.maxPrice) {
      throw new BudgetError('price_too_high', `call costs ${formatNear(price, 6)} NEAR, cap is ${formatNear(this.maxPrice, 6)}`);
    }
    if (this.spent() + price > this.budget) {
      throw new BudgetError('budget_exhausted', `spent ${formatNear(this.spent(), 6)} of ${formatNear(this.budget, 6)} NEAR; this call costs ${formatNear(price, 6)}`);
    }
    return req;
  }

  /**
   * fetch() with automatic 402 handling. Returns { response, body, receipt }.
   * `receipt` is null for free endpoints.
   */
  async fetch(url, init = {}) {
    const origin = originOf(url);
    const hintKey = origin + new URL(url).pathname;
    let req = this.priceHints.get(hintKey);
    let paidAttempt = 0;
    let first;
    if (!req) {
      first = await this.fetchImpl(url, init);
      if (first.status !== 402) return { response: first, body: await readBody(first), receipt: null };
      const body = await first.json();
      req = this.pickRequirements(body);
      this.priceHints.set(hintKey, req);
    } else {
      req = this.pickRequirements({ accepts: [req] });
    }

    for (;;) {
      paidAttempt++;
      const price = BigInt(req.maxAmountRequired);
      const lockKey = `${req.extra.contract}/${req.payTo}`;
      const { response, voucher, ch } = await this.withLock(lockKey, async () => {
        const ch = await this.ensureChannel(req, origin);
        const voucher = {
          contract: ch.contract,
          channelId: ch.channel_id,
          cumulative: BigInt(ch.cumulative) + price,
          nonce: BigInt(ch.nonce) + 1n,
        };
        const signature = signVoucher(ch.secretKey, voucher);
        // Persist before sending: never reuse a nonce, never lose track of what we signed.
        ch.cumulative = voucher.cumulative.toString();
        ch.nonce = voucher.nonce.toString();
        this.state.spent = (this.spent() + price).toString();
        this.save();
        const headers = new Headers(init.headers || {});
        headers.set(PAYMENT_HEADER, encodePaymentHeader({ network: this.network, ...voucher, signature }));
        const response = await this.fetchImpl(url, { ...init, headers });
        return { response, voucher, ch };
      });

      const pr = response.headers.get(PAYMENT_RESPONSE_HEADER);
      // The voucher was not accepted: un-count it. The signature exists, but the seller
      // refused it, and the next voucher (same nonce or higher) supersedes it anyway.
      const rollback = () => {
        if (ch.nonce === voucher.nonce.toString()) {
          ch.cumulative = (voucher.cumulative - price).toString();
          this.state.spent = (this.spent() - price).toString();
          ch.nonce = (voucher.nonce - 1n).toString();
        }
      };
      if (response.status !== 402 && !pr) {
        await this.withLock(lockKey, async () => {
          rollback();
          this.save();
        });
        const text = await response.text().catch(() => '');
        throw new BudgetError('seller_error', `seller answered ${response.status} without accepting the voucher: ${text.slice(0, 200)}`);
      }
      if (response.status === 402) {
        const body = await response.json().catch(() => ({}));
        const reason = body?.accepts?.[0]?.extra?.reason;
        await this.withLock(lockKey, async () => {
          rollback();
          const sellerState = body?.accepts?.[0]?.extra?.channel;
          if (reason === 'stale_nonce' && sellerState && BigInt(sellerState.nonce) >= BigInt(ch.nonce)) {
            ch.nonce = sellerState.nonce; // adopt a higher nonce only; never a higher amount
          }
          if (['channel_not_open', 'channel_expiring', 'overspend'].includes(reason)) ch.status = reason === 'overspend' ? ch.status : 'Stale';
          this.save();
        });
        this.priceHints.delete(hintKey);
        if (paidAttempt >= 2 || !['stale_nonce', 'channel_not_open', 'channel_expiring', 'underpaid'].includes(reason)) {
          throw new BudgetError('payment_rejected', `seller refused the voucher: ${body?.error || reason || 'unknown'}`);
        }
        req = this.pickRequirements(body);
        continue;
      }

      let settlement = null;
      if (pr) {
        try {
          settlement = decodeJsonHeader(pr).settlement;
        } catch {
          /* ignore malformed header */
        }
      }
      if (settlement?.tx) this.noteSettlement(ch, settlement.nonce, settlement.tx);
      const receipt = {
        ts: new Date().toISOString(),
        url,
        method: init.method || 'GET',
        status: response.status,
        seller: req.payTo,
        contract: ch.contract,
        channel_id: ch.channel_id,
        price: price.toString(),
        price_near: formatNear(price, 6),
        cumulative: voucher.cumulative.toString(),
        nonce: voucher.nonce.toString(),
        settlement_tx: settlement?.tx && BigInt(settlement.nonce) >= voucher.nonce ? settlement.tx : null,
        description: req.description || '',
      };
      this.addReceipt(receipt);
      return { response, body: await readBody(response), receipt };
    }
  }

  // ---------------------------------------------------------------- closing

  channelById(channelId, contract) {
    const c = this.state.channels.find((x) => x.channel_id === String(channelId) && (!contract || x.contract === contract));
    if (!c) throw new Error(`no local channel ${channelId}`);
    return c;
  }

  noteSettlement(ch, nonce, tx) {
    ch.settlementLog = ch.settlementLog || [];
    if (!ch.settlementLog.some((x) => x.tx === tx)) ch.settlementLog.push({ nonce: String(nonce), tx });
    ch.settleTx = tx;
    if (!ch.settledNonce || BigInt(nonce) > BigInt(ch.settledNonce)) ch.settledNonce = String(nonce);
    this.save();
  }

  /** Pull on-chain truth (settled amount, status) and the seller's settlement txs into local state. */
  async refresh() {
    for (const c of this.state.channels) {
      if (c.status === 'Closed' && c.refreshedClosed) continue;
      try {
        const feed = await (await this.fetchImpl(`${c.origin}/tollgate/channels`)).json();
        const sc = (feed.channels || []).find((x) => x.channel_id === c.channel_id);
        for (const st of sc?.settlements || []) this.noteSettlement(c, st.nonce, st.tx);
      } catch {
        /* seller offline: the chain view below is still authoritative */
      }
      const v = await this.chain.getChannel({ contract: c.contract, channelId: c.channel_id });
      if (!v) continue;
      c.status = v.status === 'Open' && c.status === 'Stale' ? 'Stale' : v.status;
      c.chainSettled = v.settled;
      c.chainDeposit = v.deposit;
      c.deposit = v.deposit;
      if (BigInt(v.last_nonce) > BigInt(c.settledNonce || 0)) c.settledNonce = v.last_nonce;
      if (v.status === 'Closed') {
        // Spending is what the seller actually settled; the rest came back.
        const signedButUnsettled = BigInt(c.cumulative) - BigInt(v.settled);
        if (signedButUnsettled > 0n) this.state.spent = (this.spent() - signedButUnsettled).toString();
        c.cumulative = v.settled;
        c.refunded = v.refunded;
        c.refreshedClosed = true;
      }
    }
    this.save();
    return this.status();
  }

  /** Ask the seller to close now (settles the newest voucher and refunds the rest at once). */
  async cooperativeClose(channelId, contract) {
    const c = this.channelById(channelId, contract);
    const signature = signRaw(c.secretKey, closeMessage(c.contract, c.channel_id));
    const res = await this.fetchImpl(`${c.origin}/tollgate/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel_id: c.channel_id, signature }),
    });
    const body = await res.json();
    await this.refresh();
    return body;
  }

  async startClose(channelId, contract) {
    const c = this.channelById(channelId, contract);
    const r = await this.chain.startClose({ contract: c.contract, channelId: c.channel_id });
    if (r.ok) c.status = 'Closing';
    this.save();
    return r;
  }

  async finalize(channelId, contract) {
    const c = this.channelById(channelId, contract);
    const r = await this.chain.finalize({ contract: c.contract, channelId: c.channel_id });
    await this.refresh();
    return r;
  }
}

async function readBody(res) {
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  if (type.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

// ---------------------------------------------------------------- default chain adapter

/** Chain adapter backed by near-api-js and the agent's own NEAR account key. */
export async function nearChain({ accountId, privateKey }) {
  const near = await import('../core/near.mjs');
  const account = near.accountWithKey(accountId, privateKey);
  return {
    accountId,
    async openChannel({ contract, seller, publicKey, deposit, expiresInSec, disputeWindowSec }) {
      const r = await near.call(
        account,
        contract,
        'open_channel',
        { seller, agent_pubkey: publicKey, expires_in_sec: String(expiresInSec), dispute_window_sec: String(disputeWindowSec) },
        { deposit },
      );
      if (!r.ok) throw new Error(`open_channel failed: ${r.error}`);
      const ev = r.events.find((e) => e.event === 'channel_opened')?.data?.[0];
      return {
        channelId: String(r.value),
        hash: r.hash,
        url: r.url,
        deposit: ev?.deposit,
        expiresAtMs: ev ? Number(BigInt(ev.expires_at_ns) / NS_PER_MS) : undefined,
        tx: r,
      };
    },
    async topUp({ contract, channelId, deposit }) {
      const r = await near.call(account, contract, 'top_up', { channel_id: String(channelId) }, { deposit });
      if (!r.ok) throw new Error(`top_up failed: ${r.error}`);
      return r;
    },
    startClose: ({ contract, channelId }) => near.call(account, contract, 'start_close', { channel_id: String(channelId) }),
    finalize: ({ contract, channelId }) => near.call(account, contract, 'finalize', { channel_id: String(channelId) }),
    getChannel: ({ contract, channelId }) => near.view(contract, 'get_channel', { channel_id: String(channelId) }),
  };
}
