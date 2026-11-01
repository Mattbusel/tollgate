// Tollgate end-to-end demo on NEAR TESTNET. Everything below is real: real accounts, real
// transactions, real public data, real HTTP 402 handshakes over localhost.
//
//   node scripts/demo.mjs                 # full run (about 6 to 10 minutes)
//   node scripts/demo.mjs --calls 50 --baseline 50
//
// 1. make sure the testnet accounts and the contract exist (faucet, idempotent)
// 2. start the seller (demo data API + settler) on http://127.0.0.1:8402
// 3. the agent client hits a 402, opens a channel with 1 NEAR, then makes N paid calls
// 4. prove no transaction happened per call (access key nonces, on-chain channel state)
// 5. the seller settles once; balances before/after
// 6. attacks: a replayed voucher, a forged amount and an overspend, each rejected on chain
// 7. 20 more calls, the agent starts a unilateral close, the seller settles inside the
//    dispute window, finalize is refused early, then refunds after the window
// 8. baseline: the same calls paid as plain per-call NEAR transfers, measured on chain
// 9. cost comparison from measured gas, fees and wall-clock time
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {
  ROOT, readEnv, rpc, view, balanceOf, accountWithKey, call, send, actions, KeyPair, EXPLORER_TX, EXPLORER_ACCOUNT,
} from '../src/core/near.mjs';
import { setup } from './setup.mjs';
import { startServer, sellerConfig } from '../server/index.mjs';
import { TollgateClient, nearChain } from '../src/agent/client.mjs';
import { signVoucher, parseNear, formatNear } from '../src/core/voucher.mjs';

const args = process.argv.slice(2);
const argNum = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : Number(args[i + 1]);
};
const CALLS = argNum('calls', 200);
const EXTRA_CALLS = argNum('extra', 20);
const BASELINE = argNum('baseline', CALLS);
const DEPOSIT = '1';
const DISPUTE_WINDOW_SEC = 20;
const PORT = argNum('port', 8402);

const out = [];
const record = { started_at: new Date().toISOString(), network: 'testnet', txs: {}, rejected: {}, measurements: {} };
function log(s = '') {
  console.log(s);
  out.push(s);
}
const h = (s) => log(`\n=== ${s} ===`);
const n = (y, d = 6) => formatNear(y, d);
const tg = (g) => (Number(g) / 1e12).toFixed(3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function accessKeyNonce(accountId, publicKey) {
  const r = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey });
  return BigInt(r.nonce);
}

// The paid calls: a rotation over the three products with varied parameters (real data).
const MAGS = ['2.5', '3', '4', '4.5', '5', '6'];
const HOURS = ['1', '6', '24', '72'];
const COMPANIES = ['CAPITAL ONE FINANCIAL CORPORATION', 'JPMORGAN CHASE & CO.', 'BANK OF AMERICA, NATIONAL ASSOCIATION', 'WELLS FARGO & COMPANY', 'EQUIFAX, INC.'];
const TICKERS = ['AAPL', 'NVDA', 'MSFT', 'TSLA', 'AMZN'];
function plan(base, i) {
  const k = i % 10;
  if (k <= 6) return `${base}/v1/quakes?min_magnitude=${MAGS[i % MAGS.length]}&hours=${HOURS[Math.floor(i / 6) % HOURS.length]}&limit=5`;
  if (k <= 8) return `${base}/v1/complaints?company=${encodeURIComponent(COMPANIES[i % COMPANIES.length])}&size=3`;
  return `${base}/v1/sec/facts?ticker=${TICKERS[Math.floor(i / 10) % TICKERS.length]}`;
}

function txLine(label, r) {
  const status = r.ok ? 'OK' : `REJECTED ${r.error}`;
  log(`  ${label}: ${status}`);
  log(`    tx ${EXPLORER_TX}${r.hash}`);
  log(`    gas burnt ${tg(r.gasBurnt)} Tgas, fee ${n(r.tokensBurnt, 8)} NEAR`);
}

async function main() {
  h('0. Testnet accounts and contract (idempotent setup via the public faucet)');
  const dep = await setup();
  const env = readEnv();
  const { contract: CONTRACT, seller: SELLER, agent: AGENT } = dep;
  log(`contract ${CONTRACT}  ${EXPLORER_ACCOUNT}${CONTRACT}`);
  log(`seller   ${SELLER}`);
  log(`agent    ${AGENT}`);
  const agentPub = KeyPair.fromString(env.AGENT_ACCOUNT_KEY).getPublicKey().toString();
  const sellerPub = KeyPair.fromString(env.SELLER_KEY).getPublicKey().toString();

  const before = { agent: await balanceOf(AGENT), seller: await balanceOf(SELLER), contract: await balanceOf(CONTRACT) };
  log(`balances before: agent ${n(before.agent, 4)} NEAR, seller ${n(before.seller, 4)} NEAR, contract ${n(before.contract, 4)} NEAR`);

  h('1. Start the seller: demo data API behind Tollgate prices');
  if (!(await portFree(PORT))) throw new Error(`port ${PORT} is busy (is npm run seller running?). Stop it or pass --port.`);
  const storeFile = path.join(ROOT, 'state', 'seller.json');
  const cfg = sellerConfig({ storeFile, settleEveryCalls: 1_000_000, settleEverySec: 1_000_000 });
  const sellerLogs = [];
  const { server, gate, url: BASE } = await startServer(cfg, { port: PORT, settler: false, log: (m) => sellerLogs.push(m) });
  gate.startSettler({ intervalMs: 2000 });
  log(`seller API on ${BASE} (settler running, auto thresholds off so the demo settles explicitly)`);
  const catalog = await (await fetch(`${BASE}/`)).json();
  for (const p of catalog.products) log(`  ${p.path.padEnd(16)} ${p.price_near} NEAR  ${p.description}`);

  const probe = await fetch(`${BASE}/v1/quakes?min_magnitude=5`);
  const probeBody = await probe.json();
  log(`\nunpaid request -> HTTP ${probe.status}`);
  log(`  x-tollgate-price: ${probe.headers.get('x-tollgate-price')} yoctoNEAR, x-tollgate-contract: ${probe.headers.get('x-tollgate-contract')}`);
  log(`  accepts[0]: scheme=${probeBody.accepts[0].scheme} network=${probeBody.accepts[0].network} payTo=${probeBody.accepts[0].payTo}`);
  log(`  voucher format: ${probeBody.accepts[0].extra.voucher}`);

  h(`2. Agent pays ${CALLS} calls through one channel`);
  const stateDir = path.join(ROOT, 'state', `demo-agent-${Date.now()}`);
  const chain = await nearChain({ accountId: AGENT, privateKey: env.AGENT_ACCOUNT_KEY });
  let openedTx = null;
  const realOpen = chain.openChannel;
  chain.openChannel = async (o) => {
    const r = await realOpen(o);
    openedTx = r.tx;
    return r;
  };
  const client = new TollgateClient({
    budget: DEPOSIT,
    channelDeposit: DEPOSIT,
    maxPricePerCall: '0.01',
    trustedContracts: [CONTRACT],
    disputeWindowSec: DISPUTE_WINDOW_SEC,
    chain,
    stateDir,
  });
  log(`agent limits: budget ${DEPOSIT} NEAR, max ${'0.01'} NEAR per call, only contract ${CONTRACT}`);
  const agentNonce0 = await accessKeyNonce(AGENT, agentPub);
  const sellerNonce0 = await accessKeyNonce(SELLER, sellerPub);

  const first = await client.fetch(plan(BASE, 0));
  const ch = client.state.channels[0];
  log(`first call hit 402, client opened channel ${ch.channel_id} with ${DEPOSIT} NEAR (dispute window ${DISPUTE_WINDOW_SEC} s):`);
  txLine('open_channel', openedTx);
  record.txs.open_channel = openedTx.hash;
  record.measurements.open = { gas: String(openedTx.gasBurnt), fee: String(openedTx.tokensBurnt) };
  const openedView = await view(CONTRACT, 'get_channel', { channel_id: ch.channel_id });
  record.measurements.storage_fee = openedView.storage_fee;
  log(`  storage fee kept by the contract for the channel record: ${n(openedView.storage_fee, 6)} NEAR (NEAR storage staking, ${Number(BigInt(openedView.storage_fee) / 10n ** 19n)} bytes)`);
  const agentNonce1 = await accessKeyNonce(AGENT, agentPub);
  log(`  sample data: ${first.body.quakes?.[0] ? `M${first.body.quakes[0].magnitude} ${first.body.quakes[0].place} (${first.body.source})` : JSON.stringify(first.body).slice(0, 120)}`);

  const t0 = Date.now();
  const latencies = [];
  let last;
  for (let i = 1; i < CALLS; i++) {
    const s = Date.now();
    last = await client.fetch(plan(BASE, i));
    latencies.push(Date.now() - s);
    if (last.response.status !== 200) log(`  call ${i + 1}: HTTP ${last.response.status} ${JSON.stringify(last.body).slice(0, 120)}`);
    if ((i + 1) % 50 === 0) log(`  ${i + 1} calls paid, cumulative ${n(last.receipt.cumulative, 3)} NEAR, voucher nonce ${last.receipt.nonce}`);
  }
  const callsMs = Date.now() - t0;
  const sellerReceipts = gate.receipts(1000).filter((r) => r.channel_id === ch.channel_id);
  const verifyUs = sellerReceipts.map((r) => r.verify_us).filter(Number.isFinite);
  const avgVerify = verifyUs.reduce((a, b) => a + b, 0) / verifyUs.length;
  const medVerify = [...verifyUs].sort((a, b) => a - b)[Math.floor(verifyUs.length / 2)];
  const sorted = [...latencies].sort((a, b) => a - b);
  log(`\n${CALLS} paid calls done. Seller holds the newest voucher: cumulative ${n(last.receipt.cumulative, 4)} NEAR at nonce ${last.receipt.nonce}.`);
  log(`  wall time for calls 2..${CALLS}: ${(callsMs / 1000).toFixed(1)} s, median ${sorted[Math.floor(sorted.length / 2)]} ms per call (includes the upstream public API, cached for 60 s)`);
  log(`  seller voucher verification (ed25519, node:crypto): median ${medVerify.toFixed(1)} us, mean ${avgVerify.toFixed(1)} us`);
  record.measurements.calls = { count: CALLS, wall_ms: callsMs, median_ms: sorted[Math.floor(sorted.length / 2)], verify_us_median: medVerify, verify_us_mean: avgVerify };

  h('3. Proof that no transaction happened per call');
  const agentNonce2 = await accessKeyNonce(AGENT, agentPub);
  const sellerNonce2 = await accessKeyNonce(SELLER, sellerPub);
  const onchain = await view(CONTRACT, 'get_channel', { channel_id: ch.channel_id });
  log(`  agent access key nonce: ${agentNonce0} before, ${agentNonce1} after open_channel, ${agentNonce2} after ${CALLS} calls  (+${agentNonce2 - agentNonce1} transactions for the calls)`);
  log(`  seller access key nonce: ${sellerNonce0} before, ${sellerNonce2} after  (+${sellerNonce2 - sellerNonce0})`);
  log(`  on-chain channel ${ch.channel_id}: settled ${n(onchain.settled, 4)} NEAR, last_nonce ${onchain.last_nonce}, deposit ${n(onchain.deposit, 4)} NEAR`);
  record.measurements.per_call_txs = Number(agentNonce2 - agentNonce1 + (sellerNonce2 - sellerNonce0));

  h('4. Seller settles once: one transaction for all calls');
  const sellerBal0 = await balanceOf(SELLER);
  const [settleTx] = await gate.settleAll();
  txLine(`settle(channel ${ch.channel_id}, cumulative ${n(last.receipt.cumulative, 4)} NEAR, nonce ${last.receipt.nonce})`, settleTx);
  record.txs.settle = settleTx.hash;
  record.measurements.settle = { gas: String(settleTx.gasBurnt), fee: String(settleTx.tokensBurnt) };
  const ev = settleTx.events.find((e) => e.event === 'channel_settled');
  log(`  event: ${JSON.stringify(ev)}`);
  const sellerBal1 = await balanceOf(SELLER);
  const after1 = await view(CONTRACT, 'get_channel', { channel_id: ch.channel_id });
  log(`  seller balance ${n(sellerBal0, 6)} -> ${n(sellerBal1, 6)} NEAR (+${n(sellerBal1 - sellerBal0, 6)}, after paying its own ${n(settleTx.tokensBurnt, 6)} fee)`);
  log(`  channel now: settled ${n(after1.settled, 4)}, remaining ${n(after1.remaining, 4)}, last_nonce ${after1.last_nonce}`);
  log(`  seller receipts for this channel marked settled: ${gate.receipts(1000).filter((r) => r.channel_id === ch.channel_id && r.settled).length}`);

  h('5. Attacks, each rejected by the contract on chain');
  const sellerAcc = accountWithKey(SELLER, env.SELLER_KEY);
  const sc = gate.store.getChannel(ch.channel_id);
  // 5a. Replay: the seller resubmits the voucher it already settled.
  const replay = await call(sellerAcc, CONTRACT, 'settle', {
    channel_id: ch.channel_id, cumulative_amount: sc.cumulative, nonce: sc.nonce, signature: sc.signature,
  });
  txLine('replay the settled voucher', replay);
  record.rejected.replay = { tx: replay.hash, error: replay.error };
  // 5b. Forged amount: a bigger number with the old signature.
  const forged = await call(sellerAcc, CONTRACT, 'settle', {
    channel_id: ch.channel_id, cumulative_amount: (BigInt(sc.cumulative) + parseNear('0.5')).toString(), nonce: String(BigInt(sc.nonce) + 1n), signature: sc.signature,
  });
  txLine('forged amount (+0.5 NEAR, old signature)', forged);
  record.rejected.forged = { tx: forged.hash, error: forged.error };
  // 5c. Overspend: a validly signed voucher for more than the deposit (the client never signs
  // this; we sign it here with the channel key to show the contract enforces the cap anyway).
  const overAmt = BigInt(after1.deposit) + parseNear('1');
  const overNonce = BigInt(sc.nonce) + 1n;
  const overSig = signVoucher(ch.secretKey, { contract: CONTRACT, channelId: ch.channel_id, cumulative: overAmt, nonce: overNonce });
  const offchain = await gate.acceptVoucher(
    Buffer.from(JSON.stringify({ scheme: 'near-channel', network: 'near-testnet', payload: { contract: CONTRACT, channel_id: ch.channel_id, cumulative: overAmt.toString(), nonce: overNonce.toString(), signature: overSig } })).toString('base64'),
    '0.001',
    'demo',
  ).then(() => 'accepted (unexpected)', (e) => `refused off chain: ${e.reason}`);
  log(`  overspend voucher at the seller SDK: ${offchain}`);
  const over = await call(sellerAcc, CONTRACT, 'settle', {
    channel_id: ch.channel_id, cumulative_amount: overAmt.toString(), nonce: overNonce.toString(), signature: overSig,
  });
  txLine(`overspend (signed voucher for ${n(overAmt, 4)} NEAR on a ${n(after1.deposit, 4)} NEAR deposit)`, over);
  record.rejected.overspend = { tx: over.hash, error: over.error };
  const after2 = await view(CONTRACT, 'get_channel', { channel_id: ch.channel_id });
  log(`  channel unchanged: settled ${n(after2.settled, 4)}, last_nonce ${after2.last_nonce}`);

  h(`6. ${EXTRA_CALLS} more calls, then the agent closes unilaterally`);
  for (let i = 0; i < EXTRA_CALLS; i++) last = await client.fetch(plan(BASE, i * 10));
  log(`  newest voucher now: cumulative ${n(last.receipt.cumulative, 4)} NEAR at nonce ${last.receipt.nonce} (unsettled: ${n(BigInt(last.receipt.cumulative) - BigInt(after2.settled), 4)} NEAR)`);
  const startClose = await client.startClose(ch.channel_id);
  txLine('agent start_close', startClose);
  record.txs.start_close = startClose.hash;
  record.measurements.start_close = { gas: String(startClose.gasBurnt), fee: String(startClose.tokensBurnt) };
  const tooEarly = await chain.finalize({ contract: CONTRACT, channelId: ch.channel_id });
  txLine('agent finalize right away', tooEarly);
  record.rejected.finalize_early = { tx: tooEarly.hash, error: tooEarly.error };
  log(`  waiting for the seller's settler to notice the close and settle inside the ${DISPUTE_WINDOW_SEC} s window...`);
  let disputeSettle = null;
  const deadline = Date.now() + DISPUTE_WINDOW_SEC * 1000;
  while (Date.now() < deadline) {
    const c = gate.store.getChannel(ch.channel_id);
    if (c.settleTx && c.settleTx !== settleTx.hash) {
      disputeSettle = c.settleTx;
      break;
    }
    await sleep(1000);
  }
  if (disputeSettle) {
    const st = await rpc('tx', { tx_hash: disputeSettle, sender_account_id: SELLER, wait_until: 'FINAL' });
    const gas = [st.transaction_outcome, ...st.receipts_outcome].reduce((a, o) => a + BigInt(o.outcome.gas_burnt), 0n);
    const fee = [st.transaction_outcome, ...st.receipts_outcome].reduce((a, o) => a + BigInt(o.outcome.tokens_burnt), 0n);
    log(`  seller settled during the dispute window: ${EXPLORER_TX}${disputeSettle}`);
    log(`    gas burnt ${tg(gas)} Tgas, fee ${n(fee, 8)} NEAR`);
    record.txs.settle_in_dispute_window = disputeSettle;
    record.measurements.settle2 = { gas: String(gas), fee: String(fee) };
  } else {
    log('  (the seller did not settle inside the window; its unsettled vouchers are lost)');
  }
  const closing = await view(CONTRACT, 'get_channel', { channel_id: ch.channel_id });
  const waitMs = Number(BigInt(closing.settle_deadline_ns) / 1_000_000n) - Date.now() + 3000;
  if (waitMs > 0) {
    log(`  dispute window ends in ${Math.ceil(waitMs / 1000)} s; waiting`);
    await sleep(waitMs);
  }
  const agentBalPre = await balanceOf(AGENT);
  let fin;
  for (let tries = 0; tries < 5; tries++) {
    fin = await chain.finalize({ contract: CONTRACT, channelId: ch.channel_id });
    if (fin.ok || !/DISPUTE_WINDOW/.test(fin.error || '')) break;
    await sleep(3000);
  }
  txLine('agent finalize after the window', fin);
  record.txs.finalize = fin.hash;
  record.measurements.finalize = { gas: String(fin.gasBurnt), fee: String(fin.tokensBurnt) };
  const closed = await view(CONTRACT, 'get_channel', { channel_id: ch.channel_id });
  const agentBalPost = await balanceOf(AGENT);
  log(`  refund to agent: ${n(closed.refunded, 6)} NEAR; agent balance ${n(agentBalPre, 6)} -> ${n(agentBalPost, 6)}`);
  log(`  final channel: status ${closed.status}, deposit ${n(closed.deposit, 4)}, settled ${n(closed.settled, 4)}, refunded ${n(closed.refunded, 4)}, settlements ${closed.settlements}`);
  await client.refresh();
  const allReceipts = client.receipts(100000);
  const byTx = {};
  for (const r of allReceipts) byTx[r.settlement_tx || 'unsettled'] = (byTx[r.settlement_tx || 'unsettled'] || 0) + 1;
  log(`  agent receipt log: ${allReceipts.length} receipts in ${path.relative(ROOT, stateDir).split(path.sep).join('/')}/receipts.jsonl`);
  for (const [tx, count] of Object.entries(byTx)) log(`    ${String(count).padStart(4)} receipts settled by ${tx}`);
  log(`  newest receipt: ${JSON.stringify(allReceipts[0])}`);
  gate.stopSettler();
  server.close();

  const after = { agent: await balanceOf(AGENT), seller: await balanceOf(SELLER), contract: await balanceOf(CONTRACT) };
  h('7. Balances before and after the channel lifecycle');
  for (const k of ['agent', 'seller', 'contract']) {
    log(`  ${k.padEnd(8)} ${n(before[k], 6)} -> ${n(after[k], 6)} NEAR  (${after[k] >= before[k] ? '+' : '-'}${n(after[k] >= before[k] ? after[k] - before[k] : before[k] - after[k], 6)})`);
  }
  log(`  the seller earned ${n(closed.settled, 6)} NEAR for ${CALLS + EXTRA_CALLS} calls; the agent got ${n(closed.refunded, 6)} NEAR back`);

  h(`8. Baseline: the same ${BASELINE} calls paid as plain per-call NEAR transfers`);
  const agentAcc = accountWithKey(AGENT, env.AGENT_ACCOUNT_KEY);
  let bGas = 0n;
  let bFee = 0n;
  let bOk = 0;
  const bLat = [];
  const sample = [];
  const tb = Date.now();
  for (let i = 0; i < BASELINE; i++) {
    const price = new URL(plan('http://x', i)).pathname === '/v1/quakes' ? '0.001' : new URL(plan('http://x', i)).pathname === '/v1/complaints' ? '0.002' : '0.003';
    const s = Date.now();
    const r = await send(agentAcc, SELLER, [actions.transfer(parseNear(price))], { waitUntil: 'EXECUTED_OPTIMISTIC' });
    bLat.push(Date.now() - s);
    if (r.ok) bOk++;
    bGas += r.gasBurnt;
    bFee += r.tokensBurnt;
    if (sample.length < 3) sample.push(r.hash);
    if ((i + 1) % 50 === 0) log(`  ${i + 1} transfers sent (${((Date.now() - tb) / 1000).toFixed(0)} s)`);
  }
  const bMs = Date.now() - tb;
  const bSorted = [...bLat].sort((a, b) => a - b);
  log(`  ${bOk}/${BASELINE} transfers succeeded; total gas ${tg(bGas)} Tgas, total fees ${n(bFee, 8)} NEAR, ${(bMs / 1000).toFixed(1)} s, median ${bSorted[Math.floor(bSorted.length / 2)]} ms per payment`);
  for (const s of sample) log(`    e.g. ${EXPLORER_TX}${s}`);
  record.measurements.baseline = { count: BASELINE, ok: bOk, gas: String(bGas), fee: String(bFee), wall_ms: bMs, median_ms: bSorted[Math.floor(bSorted.length / 2)], sample_txs: sample };

  h('9. Cost comparison (all numbers measured on testnet in this run)');
  const m = record.measurements;
  const sGas = BigInt(m.settle.gas);
  const sFee = BigInt(m.settle.fee);
  const lifeKeys = ['open', 'settle', 'settle2', 'start_close', 'finalize'].filter((k) => m[k]);
  const lifeGas = lifeKeys.reduce((a, k) => a + BigInt(m[k].gas), 0n);
  const lifeFee = lifeKeys.reduce((a, k) => a + BigInt(m[k].fee), 0n);
  const perTransferGas = bGas / BigInt(BASELINE);
  const perTransferFee = bFee / BigInt(BASELINE);
  const scaledGas = perTransferGas * BigInt(CALLS);
  const scaledFee = perTransferFee * BigInt(CALLS);
  const storage = BigInt(m.storage_fee);
  const rows = [
    ['', 'txs', 'gas (Tgas)', 'tx fees (NEAR)'],
    [`1 settlement covering ${CALLS} calls`, '1', tg(sGas), n(sFee, 8)],
    [`${CALLS} per-call transfers${BASELINE === CALLS ? '' : ` (${BASELINE} measured, scaled)`}`, String(CALLS), tg(scaledGas), n(scaledFee, 8)],
    [`full channel lifecycle, ${CALLS + EXTRA_CALLS} calls`, String(lifeKeys.length), tg(lifeGas), n(lifeFee, 8)],
  ];
  const w = [46, 6, 12, 16];
  for (const r of rows) log('  ' + r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join(''));
  const ratio = (a, b) => (Number(a) / Number(b)).toFixed(1);
  log(`
  gas: one settlement ${tg(sGas)} Tgas vs ${CALLS} transfers ${tg(scaledGas)} Tgas (${ratio(scaledGas, sGas)}x).`);
  log(`  gas: whole lifecycle (${lifeKeys.join(', ')}) ${tg(lifeGas)} Tgas vs ${tg(scaledGas)} Tgas (${ratio(scaledGas, lifeGas)}x).`);
  log(`  money: lifecycle tx fees ${n(lifeFee, 6)} + channel storage ${n(storage, 6)} = ${n(lifeFee + storage, 6)} NEAR vs ${n(scaledFee, 6)} NEAR of transfer fees.`);
  log(`  break-even: storage plus lifecycle fees equal about ${Math.ceil(Number(lifeFee + storage) / Number(perTransferFee))} per-call transfers; past that point each extra call adds no chain cost until the next settlement.`);
  log(`  latency per paid call: ${m.calls.median_ms} ms median with a voucher (including the upstream API) vs ${m.baseline.median_ms} ms median for an on-chain transfer.`);
  record.comparison = { storage_fee: String(storage), settle_gas: String(sGas), transfers_gas: String(scaledGas), lifecycle_gas: String(lifeGas), settle_fee: String(sFee), transfers_fee: String(scaledFee), lifecycle_fee: String(lifeFee) };

  record.channel_id = ch.channel_id;
  record.contract = CONTRACT;
  record.finished_at = new Date().toISOString();
  fs.mkdirSync(path.join(ROOT, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'demo', 'demo-latest.txt'), out.join('\n') + '\n');
  fs.writeFileSync(path.join(ROOT, 'demo', 'demo-latest.json'), JSON.stringify(record, null, 2) + '\n');
  log('\nSaved demo/demo-latest.txt and demo/demo-latest.json');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('demo failed:', e.stack || e.message);
    process.exit(1);
  },
);
