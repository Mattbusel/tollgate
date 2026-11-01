import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeChain, startSeller, CONTRACT } from './helpers.mjs';
import { TollgateClient } from '../src/agent/client.mjs';
import { parseNear } from '../src/core/voucher.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tollgate-budget-'));
const mk = (chain, o = {}) =>
  new TollgateClient({ budget: '1', maxPricePerCall: '0.01', trustedContracts: [CONTRACT], chain, stateDir: tmp(), ...o });

test('per-call price cap: refuses before opening any channel', async () => {
  const chain = fakeChain();
  const s = await startSeller(chain);
  try {
    const c = mk(chain);
    await assert.rejects(c.fetch(`${s.url}/pricey`), (e) => e.code === 'price_too_high');
    assert.deepEqual(chain.calls, []);
  } finally {
    await s.close();
  }
});

test('total budget: the call that would cross it is refused', async () => {
  const chain = fakeChain();
  const s = await startSeller(chain);
  try {
    const c = mk(chain, { budget: '0.005' });
    for (let i = 0; i < 5; i++) assert.equal((await c.fetch(`${s.url}/item`)).response.status, 200);
    await assert.rejects(c.fetch(`${s.url}/item`), (e) => e.code === 'budget_exhausted');
    assert.equal(chain.channels.get('0').deposit, parseNear('0.005').toString(), 'deposit capped at the budget');
    assert.equal(c.status().spent, '0.005000');
    assert.equal(s.gate.receipts().length, 5);
  } finally {
    await s.close();
  }
});

test('deposits never exceed what is left of the budget (top up uses the remainder)', async () => {
  const chain = fakeChain();
  const s = await startSeller(chain);
  try {
    const c = mk(chain, { budget: '0.005', channelDeposit: '0.003' });
    for (let i = 0; i < 5; i++) await c.fetch(`${s.url}/item`);
    assert.deepEqual(chain.calls, ['open_channel', 'top_up']);
    assert.equal(chain.channels.get('0').deposit, parseNear('0.005').toString());
    await assert.rejects(c.fetch(`${s.url}/item`), (e) => e.code === 'budget_exhausted');
  } finally {
    await s.close();
  }
});

test('untrusted channel contract: refuses to lock funds', async () => {
  const chain = fakeChain();
  const s = await startSeller(chain);
  try {
    const c = mk(chain, { trustedContracts: ['channels.someone-else.testnet'] });
    await assert.rejects(c.fetch(`${s.url}/item`), (e) => e.code === 'untrusted_contract');
    assert.deepEqual(chain.calls, []);
  } finally {
    await s.close();
  }
});

test('state survives a restart: nonces continue, spend is remembered', async () => {
  const chain = fakeChain();
  const s = await startSeller(chain);
  try {
    const dir = tmp();
    const a = mk(chain, { stateDir: dir, budget: '0.004' });
    await a.fetch(`${s.url}/item`);
    await a.fetch(`${s.url}/item`);
    const b = mk(chain, { stateDir: dir, budget: '0.004' });
    const r = await b.fetch(`${s.url}/item`);
    assert.equal(r.receipt.nonce, '3');
    assert.equal(b.status().spent, '0.003000');
    assert.equal(b.receipts().length, 3);
    await b.fetch(`${s.url}/item`);
    await assert.rejects(b.fetch(`${s.url}/item`), (e) => e.code === 'budget_exhausted');
    assert.deepEqual(chain.calls, ['open_channel']);
  } finally {
    await s.close();
  }
});

test('a refused voucher is not counted as spent', async () => {
  const chain = fakeChain();
  const s = await startSeller(chain);
  try {
    const c = mk(chain, { budget: '0.0025' });
    await c.fetch(`${s.url}/item`);
    // The seller sees the channel closed, so it refuses the next voucher with a 402. The
    // client must roll that voucher back, and it has no budget left to open a second channel.
    chain.channels.get('0').status = 'Closed';
    await assert.rejects(c.fetch(`${s.url}/item`), (e) => e.code === 'budget_exhausted');
    assert.equal(c.status().spent, '0.001000');
    assert.equal(c.state.channels[0].nonce, '1');
    assert.equal(c.state.channels[0].status, 'Stale');
    assert.deepEqual(chain.calls, ['open_channel']);
  } finally {
    await s.close();
  }
});
