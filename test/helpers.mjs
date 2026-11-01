// Test fixtures: an in-memory stand-in for the channels contract (views + the agent-side
// calls), used only by the Node unit tests. The demo (scripts/demo.mjs) uses the real testnet.
import http from 'node:http';
import { createTollgate } from '../src/seller/tollgate.mjs';
import { MemoryStore } from '../src/seller/store.mjs';

export const CONTRACT = 'channels.test.testnet';
export const SELLER = 'seller.test.testnet';
const NS = 1_000_000n;

export function fakeChain() {
  const channels = new Map();
  const calls = [];
  let next = 0;
  return {
    channels,
    calls,
    async openChannel({ contract, seller, publicKey, deposit, expiresInSec, disputeWindowSec }) {
      calls.push('open_channel');
      const id = String(next++);
      channels.set(id, {
        channel_id: id, owner: 'agent.test.testnet', seller, agent_pubkey: publicKey,
        deposit: String(deposit), settled: '0', last_nonce: '0', status: 'Open',
        expires_at_ns: String(BigInt(Date.now() + expiresInSec * 1000) * NS),
        dispute_window_sec: String(disputeWindowSec), refunded: '0',
      });
      return { channelId: id, hash: `tx-open-${id}`, deposit: String(deposit), expiresAtMs: Date.now() + expiresInSec * 1000 };
    },
    async topUp({ channelId, deposit }) {
      calls.push('top_up');
      const c = channels.get(String(channelId));
      c.deposit = String(BigInt(c.deposit) + BigInt(deposit));
      return { ok: true, hash: `tx-topup-${channelId}` };
    },
    async startClose({ channelId }) {
      calls.push('start_close');
      channels.get(String(channelId)).status = 'Closing';
      return { ok: true };
    },
    async finalize({ channelId }) {
      calls.push('finalize');
      const c = channels.get(String(channelId));
      c.status = 'Closed';
      c.refunded = String(BigInt(c.deposit) - BigInt(c.settled));
      return { ok: true, value: c.refunded };
    },
    async getChannel({ channelId }) {
      return channels.get(String(channelId)) || null;
    },
    source: async (id) => channels.get(String(id)) || null,
  };
}

export async function startSeller(chain, opts = {}) {
  const settled = [];
  const gate = createTollgate({
    contract: CONTRACT,
    seller: SELLER,
    channelSource: chain.source,
    store: new MemoryStore(),
    settle: async (v) => {
      settled.push(v);
      const c = chain.channels.get(v.channelId);
      c.settled = v.cumulative;
      c.last_nonce = v.nonce;
      return { ok: true, hash: `tx-settle-${settled.length}` };
    },
    cooperativeClose: async ({ channelId, voucher }) => {
      settled.push({ channelId, ...(voucher || {}), cooperative: true });
      const c = chain.channels.get(channelId);
      if (voucher) {
        c.settled = voucher.cumulative;
        c.last_nonce = voucher.nonce;
      }
      c.status = 'Closed';
      c.refunded = String(BigInt(c.deposit) - BigInt(c.settled));
      return { ok: true, hash: `tx-coop-${channelId}`, value: c.refunded };
    },
    channelCacheMs: 0,
    ...opts,
  });
  const priced = gate.protect({ price: '0.001', description: 'test item' }, (req, res, receipt) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, nonce: receipt.nonce }));
  });
  const pricey = gate.protect({ price: '0.5', description: 'expensive item' }, (req, res) => res.end('{}'));
  const server = http.createServer(async (req, res) => {
    if (req.url === '/tollgate/close' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      res.setHeader('content-type', 'application/json');
      try {
        const r = await gate.closeRequest(JSON.parse(raw));
        return res.end(JSON.stringify({ ok: r.ok, tx: r.hash, refund: r.value }));
      } catch (e) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, reason: e.reason, error: e.message }));
      }
    }
    if (req.url === '/tollgate/channels') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ channels: gate.channels() }));
    }
    if (req.url.startsWith('/item')) return priced(req, res);
    if (req.url.startsWith('/pricey')) return pricey(req, res);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ free: true }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { gate, server, url, settled, close: () => new Promise((r) => server.close(r)) };
}
