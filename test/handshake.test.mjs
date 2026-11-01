import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeChain, startSeller, CONTRACT, SELLER } from './helpers.mjs';
import { TollgateClient } from '../src/agent/client.mjs';
import { encodePaymentHeader, signVoucher, parseNear, decodeJsonHeader, signRaw, closeMessage, generateChannelKey } from '../src/core/voucher.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tollgate-test-'));
const client = (chain, extra = {}) =>
  new TollgateClient({ budget: '1', maxPricePerCall: '0.01', channelDeposit: '0.1', trustedContracts: [CONTRACT], chain, stateDir: tmp(), disputeWindowSec: 30, ...extra });

test('402 without a voucher describes price, contract, seller and voucher format', async () => {
  const chain = fakeChain();
  const s = await startSeller(chain);
  try {
    const r = await fetch(`${s.url}/item`);
    assert.equal(r.status, 402);
    assert.equal(r.headers.get('x-tollgate-scheme'), 'near-channel');
    assert.equal(r.headers.get('x-tollgate-price'), parseNear('0.001').toString());
    assert.equal(r.headers.get('x-tollgate-contract'), CONTRACT);
    assert.equal(r.headers.get('x-tollgate-seller'), SELLER);
    const body = await r.json();
    assert.equal(body.x402Version, 1);
    const a = body.accepts[0];
    assert.equal(a.scheme, 'near-channel');
    assert.equal(a.network, 'near-testnet');
    assert.equal(a.payTo, SELLER);
    assert.equal(a.maxAmountRequired, '1000000000000000000000');
    assert.equal(a.extra.contract, CONTRACT);
    assert.match(a.extra.voucher, /^tollgate:v1:\{contract\}:\{channel_id\}:\{cumulative_yocto\}:\{nonce\}$/);
  } finally {
    await s.close();
  }
});

test('client opens one channel, then pays 25 calls with vouchers only', async () => {
  const chain = fakeChain();
  const s = await startSeller(chain);
  try {
    const c = client(chain);
    for (let i = 1; i <= 25; i++) {
      const r = await c.fetch(`${s.url}/item?i=${i}`);
      assert.equal(r.response.status, 200);
      assert.equal(r.body.nonce, String(i));
      assert.ok(r.response.headers.get('x-payment-response'));
    }
    assert.deepEqual(chain.calls, ['open_channel'], 'exactly one chain call for 25 paid requests');
    const seller = s.gate.store.getChannel('0');
    assert.equal(seller.cumulative, (parseNear('0.001') * 25n).toString());
    assert.equal(seller.nonce, '25');
    assert.equal(s.gate.receipts(100).length, 25);
    assert.equal(c.status().spent, '0.025000');
    const rec = c.receipts(100);
    assert.equal(rec.length, 25);
    assert.equal(rec[0].nonce, '25');
    assert.equal(rec[0].seller, SELLER);
    // Free endpoint: no payment, no receipt.
    const free = await c.fetch(`${s.url}/free`);
    assert.equal(free.receipt, null);
  } finally {
    await s.close();
  }
});

async function openedChannel() {
  const chain = fakeChain();
  const s = await startSeller(chain);
  const c = client(chain);
  await c.fetch(`${s.url}/item`);
  const ch = c.state.channels[0];
  const send = (v, sig) => {
    const contract = v.contract || CONTRACT;
    const signature = sig ?? signVoucher(ch.secretKey, { contract, channelId: 0n, cumulative: v.cumulative, nonce: v.nonce });
    return fetch(`${s.url}/item`, {
      headers: { 'x-payment': encodePaymentHeader({ network: 'near-testnet', contract, channelId: 0n, cumulative: v.cumulative, nonce: v.nonce, signature }) },
    });
  };
  return { chain, s, c, ch, send };
}

async function reason(r) {
  assert.equal(r.status, 402);
  return (await r.json()).accepts[0].extra.reason;
}

test('seller rejects a replayed voucher', async () => {
  const { s, send } = await openedChannel();
  try {
    assert.equal(await reason(await send({ cumulative: parseNear('0.001'), nonce: 1n })), 'stale_nonce');
  } finally {
    await s.close();
  }
});

test('seller rejects underpaying, overspending, tampered and foreign-contract vouchers', async () => {
  const { s, send, ch } = await openedChannel();
  try {
    assert.equal(await reason(await send({ cumulative: parseNear('0.0015'), nonce: 2n })), 'underpaid');
    assert.equal(await reason(await send({ cumulative: parseNear('5'), nonce: 2n })), 'overspend');
    const good = { cumulative: parseNear('0.002'), nonce: 2n };
    const sig = signVoucher(ch.secretKey, { contract: CONTRACT, channelId: 0n, cumulative: parseNear('0.003'), nonce: 2n });
    assert.equal(await reason(await send(good, sig)), 'bad_signature');
    assert.equal(await reason(await send({ ...good, contract: 'channels.other.testnet' })), 'wrong_contract');
    // and the honest next voucher still works
    assert.equal((await send(good)).status, 200);
  } finally {
    await s.close();
  }
});

test('settler settles the newest voucher once and the client learns the tx', async () => {
  const { s, c, chain } = await openedChannel();
  try {
    for (let i = 0; i < 9; i++) await c.fetch(`${s.url}/item`);
    const out = await s.gate.settleAll();
    assert.equal(out.length, 1);
    assert.equal(s.settled.length, 1);
    assert.equal(s.settled[0].nonce, '10');
    assert.equal(s.settled[0].cumulative, (parseNear('0.001') * 10n).toString());
    assert.ok(s.gate.receipts(100).every((r) => r.settled && r.settle_tx === 'tx-settle-1'));
    assert.equal((await s.gate.settleAll()).length, 0, 'nothing new to settle');
    const r = await c.fetch(`${s.url}/item`);
    const pr = decodeJsonHeader(r.response.headers.get('x-payment-response'));
    assert.equal(pr.settlement.tx, 'tx-settle-1');
    assert.equal(pr.settlement.nonce, '10');
    assert.equal(chain.channels.get('0').settled, (parseNear('0.001') * 10n).toString());
  } finally {
    await s.close();
  }
});

test('settler settles automatically every N calls and when the agent starts closing', async () => {
  const chain = fakeChain();
  const s = await startSeller(chain, { settleEveryCalls: 5, settleEverySec: 3600 });
  try {
    const c = client(chain);
    for (let i = 0; i < 4; i++) await c.fetch(`${s.url}/item`);
    await s.gate.tick();
    assert.equal(s.settled.length, 0);
    await c.fetch(`${s.url}/item`);
    await s.gate.tick();
    assert.equal(s.settled.length, 1);
    await c.fetch(`${s.url}/item`);
    await c.startClose('0');
    await s.gate.tick();
    assert.equal(s.settled.length, 2, 'closing channel is settled inside the dispute window');
    assert.equal(s.settled[1].nonce, '6');
  } finally {
    await s.close();
  }
});

test('a closing channel is refused and the client opens a fresh one', async () => {
  const { s, c, chain } = await openedChannel();
  try {
    chain.channels.get('0').status = 'Closing';
    const r = await c.fetch(`${s.url}/item`);
    assert.equal(r.response.status, 200);
    assert.deepEqual(chain.calls, ['open_channel', 'open_channel']);
    assert.equal(r.receipt.channel_id, '1');
    assert.equal(r.receipt.nonce, '1');
  } finally {
    await s.close();
  }
});

test('cooperative close: only a request signed by the channel key closes, with the newest voucher', async () => {
  const { s, c, chain } = await openedChannel();
  try {
    await c.fetch(`${s.url}/item`);
    await c.fetch(`${s.url}/item`);
    const forged = await fetch(`${s.url}/tollgate/close`, {
      method: 'POST',
      body: JSON.stringify({ channel_id: '0', signature: signRaw(generateChannelKey().secretKey, closeMessage(CONTRACT, 0)) }),
    });
    assert.equal((await forged.json()).reason, 'bad_signature');
    assert.equal(chain.channels.get('0').status, 'Open');
    const r = await c.cooperativeClose('0');
    assert.equal(r.ok, true);
    assert.equal(s.settled.at(-1).nonce, '3');
    assert.equal(s.settled.at(-1).cooperative, true);
    const st = c.status();
    assert.equal(st.channels[0].status, 'Closed');
    assert.equal(st.spent, '0.003000');
    assert.equal(st.locked_in_channels, '0.000000');
    assert.ok(c.receipts(10).every((x) => x.settled && x.settlement_tx === 'tx-coop-0'));
  } finally {
    await s.close();
  }
});
