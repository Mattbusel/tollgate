// One-time testnet setup. Idempotent: every step checks chain state first.
//
//   node scripts/setup.mjs
//
// Creates (testnet only), for the reference deployment:
//   OPERATOR  tollgate-busel.testnet               faucet account that owns the deployment
//   CONTRACT  channels.tollgate-busel.testnet      the Tollgate channels contract
//   SELLER    seller.tollgate-busel.testnet        the demo data API's NEAR account
//   AGENT     tollgate-agent-busel.testnet         the AI agent's own account (faucet)
//
// On a fresh clone (no .env.testnet) it picks new random names (tollgate-<random>.testnet and
// tollgate-agent-<random>.testnet), creates them with the public faucet, deploys its own copy
// of the contract and writes deployments/testnet.local.json. Override the names with
// TOLLGATE_OPERATOR / TOLLGATE_AGENT. Keys are written only to .env.testnet (gitignored).
// Nothing secret is printed.
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, readEnv, appendEnv, writeDeployments, accountWithKey, newKeyPair, viewAccount, view, send,
  actions, TGAS, EXPLORER_ACCOUNT, RPC_URL, REFERENCE_OPERATOR, REFERENCE_AGENT, DEPLOY_FILE_REFERENCE,
  DEPLOY_FILE_LOCAL,
} from '../src/core/near.mjs';
import { parseNear, formatNear } from '../src/core/voucher.mjs';

/** Account names: env overrides, then names saved in .env.testnet, then fresh random ones. */
export function resolveNames() {
  const env = readEnv();
  let operator = process.env.TOLLGATE_OPERATOR || env.OPERATOR_ID;
  let agent = process.env.TOLLGATE_AGENT || env.AGENT_ID;
  if (!operator) {
    operator = env.OPERATOR_KEY ? REFERENCE_OPERATOR : `tollgate-${Math.random().toString(36).slice(2, 8)}.testnet`;
  }
  if (!agent) {
    agent = env.AGENT_ACCOUNT_KEY && operator === REFERENCE_OPERATOR ? REFERENCE_AGENT : operator.replace(/^tollgate-/, 'tollgate-agent-');
  }
  const save = {};
  if (!env.OPERATOR_ID) save.OPERATOR_ID = operator;
  if (!env.AGENT_ID) save.AGENT_ID = agent;
  if (Object.keys(save).length) appendEnv(save);
  return { operator, agent, contract: `channels.${operator}`, seller: `seller.${operator}` };
}
const WASM = path.join(ROOT, 'res', 'tollgate_channels.wasm');

// Testnet deployment parameters. The minimum dispute window is short so the demo can show a
// full unilateral close in under a minute; sellers enforce their own, longer minimum off chain.
export const MIN_DISPUTE_WINDOW_SEC = 15;
export const MAX_EXPIRY_SEC = 30 * 24 * 3600;

const log = (...a) => console.log(...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function faucetAccount(id, keyName) {
  const env = readEnv();
  if (await viewAccount(id)) {
    if (!env[keyName]) {
      throw new Error(`${id} already exists on testnet but its key is not in .env.testnet. Pick another name with TOLLGATE_OPERATOR / TOLLGATE_AGENT.`);
    }
    log(`= ${id} exists`);
    return false;
  }
  if (env[keyName]) throw new Error(`${keyName} is set in .env.testnet but ${id} does not exist on chain`);
  const kp = newKeyPair();
  const r = await fetch('https://helper.nearprotocol.com/account', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!r.ok) throw new Error(`testnet faucet refused ${id}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  appendEnv({ [keyName]: kp.toString() });
  for (let i = 0; i < 20 && !(await viewAccount(id)); i++) await wait(1500);
  const a = await viewAccount(id);
  log(`+ ${id} created by the testnet faucet with ${formatNear(a?.amount ?? 0, 2)} NEAR`);
  return true;
}

async function subAccount(parent, id, keyName, amount) {
  if (await viewAccount(id)) {
    log(`= ${id} exists`);
    return null;
  }
  const kp = newKeyPair();
  const r = await send(parent, id, [
    actions.createAccount(),
    actions.transfer(amount),
    actions.addFullAccessKey(kp.getPublicKey()),
  ]);
  if (!r.ok) throw new Error(`create ${id} failed: ${r.error}`);
  appendEnv({ [keyName]: kp.toString() });
  log(`+ ${id} created with ${formatNear(amount, 2)} NEAR  ${r.url}`);
  return r.hash;
}

async function deploy(account) {
  const st = await viewAccount(account.accountId);
  if (st.code_hash !== '11111111111111111111111111111111') {
    log(`= ${account.accountId} already has code ${st.code_hash}`);
    return null;
  }
  const code = fs.readFileSync(WASM);
  const r = await send(account, account.accountId, [
    actions.deployContract(new Uint8Array(code)),
    actions.functionCall(
      'new',
      { min_dispute_window_sec: String(MIN_DISPUTE_WINDOW_SEC), max_expiry_sec: String(MAX_EXPIRY_SEC) },
      100n * TGAS,
      0n,
    ),
  ]);
  if (!r.ok) throw new Error(`deploy failed: ${r.error}`);
  log(`+ deployed tollgate_channels.wasm to ${account.accountId}  ${r.url}`);
  return r.hash;
}

export async function setup() {
  if (!fs.existsSync(WASM)) throw new Error('Build the contract first: npm run build');
  const { operator: OPERATOR_ID, agent: AGENT_ID, contract: CONTRACT_ID, seller: SELLER_ID } = resolveNames();
  const reference = OPERATOR_ID === REFERENCE_OPERATOR;
  const DEPLOY_FILE = reference ? DEPLOY_FILE_REFERENCE : DEPLOY_FILE_LOCAL;
  log(`operator ${OPERATOR_ID}, agent ${AGENT_ID}${reference ? ' (reference deployment)' : ' (your own deployment)'}`);
  await faucetAccount(OPERATOR_ID, 'OPERATOR_KEY');
  await faucetAccount(AGENT_ID, 'AGENT_ACCOUNT_KEY');
  let env = readEnv();
  const operator = accountWithKey(OPERATOR_ID, env.OPERATOR_KEY);

  const txs = {};
  txs.create_contract = await subAccount(operator, CONTRACT_ID, 'CONTRACT_KEY', parseNear('3'));
  txs.create_seller = await subAccount(operator, SELLER_ID, 'SELLER_KEY', parseNear('0.5'));
  env = readEnv();
  txs.deploy = await deploy(accountWithKey(CONTRACT_ID, env.CONTRACT_KEY));
  const config = await view(CONTRACT_ID, 'get_config');
  log(`= contract config ${JSON.stringify(config)}`);

  let prev = {};
  if (fs.existsSync(DEPLOY_FILE)) prev = JSON.parse(fs.readFileSync(DEPLOY_FILE, 'utf8'));
  for (const [k, v] of Object.entries(prev.setup_txs || {})) if (!txs[k] && v) txs[k] = v;
  const code = await viewAccount(CONTRACT_ID);
  const d = {
    ...prev,
    network: 'testnet',
    rpc: RPC_URL,
    contract: CONTRACT_ID,
    contract_code_hash: code.code_hash,
    operator: OPERATOR_ID,
    seller: SELLER_ID,
    agent: AGENT_ID,
    config,
    setup_txs: txs,
    explorer: {
      contract: EXPLORER_ACCOUNT + CONTRACT_ID,
      seller: EXPLORER_ACCOUNT + SELLER_ID,
      agent: EXPLORER_ACCOUNT + AGENT_ID,
    },
  };
  writeDeployments(d, DEPLOY_FILE);
  fs.writeFileSync(
    path.join(ROOT, 'dashboard', reference ? 'config.js' : 'config.local.js'),
    [
      '// Written by scripts/setup.mjs. Override in the URL: ?contract=<account>&seller=<url>&rpc=<url>',
      'export const CONFIG = {',
      `  contract: '${CONTRACT_ID}',`,
      `  sellerAccount: '${SELLER_ID}',`,
      "  sellerUrl: 'http://localhost:8402',",
      "  rpcs: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'],",
      '};',
      '',
    ].join('\n'),
  );
  log(`\nWrote ${path.relative(ROOT, DEPLOY_FILE)}. Contract: ${EXPLORER_ACCOUNT}${CONTRACT_ID}`);
  return d;
}

if (path.basename(process.argv[1] || '') === 'setup.mjs') {
  setup().catch((e) => {
    console.error('setup failed:', e.message);
    process.exit(1);
  });
}
