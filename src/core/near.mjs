// NEAR helpers for Tollgate: config, RPC views, signing and sending transactions, and a summary
// of each transaction including the gas and fees it actually burned. Testnet only: it refuses
// to run against an RPC URL that does not look like testnet.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from 'near-api-js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ENV_FILE = path.join(ROOT, '.env.testnet');
// The reference deployment (committed) and a local one written when you run setup with your
// own accounts. Readers prefer the local file.
export const REFERENCE_OPERATOR = 'tollgate-busel.testnet';
export const REFERENCE_AGENT = 'tollgate-agent-busel.testnet';
export const DEPLOY_FILE_REFERENCE = path.join(ROOT, 'deployments', 'testnet.json');
export const DEPLOY_FILE_LOCAL = path.join(ROOT, 'deployments', 'testnet.local.json');
export function deployFile() {
  return fs.existsSync(DEPLOY_FILE_LOCAL) ? DEPLOY_FILE_LOCAL : DEPLOY_FILE_REFERENCE;
}
export function readDeploymentsOrEmpty() {
  const f = deployFile();
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}
export const NETWORK = 'near-testnet';
export const RPC_URL = process.env.NEAR_RPC || 'https://test.rpc.fastnear.com';
export const EXPLORER_TX = 'https://testnet.nearblocks.io/txns/';
export const EXPLORER_ACCOUNT = 'https://testnet.nearblocks.io/address/';
export const TGAS = 1_000_000_000_000n;

if (!/test/.test(RPC_URL)) {
  throw new Error(`Refusing to run: NEAR_RPC (${RPC_URL}) does not look like a testnet endpoint.`);
}

export const provider = new JsonRpcProvider({ url: RPC_URL });

// ------------------------------------------------------------------ env / deployments

export function readEnv(file = ENV_FILE) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function appendEnv(entries, file = ENV_FILE) {
  const lines = Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.appendFileSync(file, lines, { mode: 0o600 });
}

export function writeDeployments(d, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
}

// ------------------------------------------------------------------ accounts

export function accountWithKey(accountId, privateKey) {
  if (!privateKey) throw new Error(`Missing key for ${accountId}`);
  const signer = new KeyPairSigner(KeyPair.fromString(privateKey));
  return new Account(accountId, provider, signer);
}

export function newKeyPair() {
  return KeyPair.fromRandom('ed25519');
}

// ------------------------------------------------------------------ RPC

export async function rpc(method, params, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'tollgate', method, params }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`RPC HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) {
        const err = new Error(j.error.data || j.error.message || JSON.stringify(j.error));
        err.rpc = j.error;
        err.permanent = true;
        throw err;
      }
      return j.result;
    } catch (e) {
      lastErr = e;
      if (e.permanent) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function viewAccount(accountId) {
  try {
    return await rpc('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
  } catch (e) {
    if (String(e.message).includes('does not exist') || e.rpc?.cause?.name === 'UNKNOWN_ACCOUNT') return null;
    throw e;
  }
}

export async function balanceOf(accountId) {
  const a = await viewAccount(accountId);
  return a ? BigInt(a.amount) : 0n;
}

export async function view(contractId, methodName, args = {}, finality = 'optimistic') {
  const r = await rpc('query', {
    request_type: 'call_function',
    finality,
    account_id: contractId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  const text = Buffer.from(r.result).toString('utf8');
  return text ? JSON.parse(text) : null;
}

// ------------------------------------------------------------------ transactions

/** Sign, send, wait for final execution, summarise (never throws on a failed execution). */
export async function send(account, receiverId, actionList, { waitUntil = 'FINAL' } = {}) {
  const started = Date.now();
  const res = await account.signAndSendTransaction({
    receiverId,
    actions: actionList,
    waitUntil,
    throwOnFailure: false,
  });
  const s = summarise(res);
  s.ms = Date.now() - started;
  return s;
}

export function call(account, contractId, methodName, args = {}, { gasTgas = 30, deposit = 0n, waitUntil } = {}) {
  return send(
    account,
    contractId,
    [actions.functionCall(methodName, args, BigInt(gasTgas) * TGAS, BigInt(deposit))],
    { waitUntil },
  );
}

export function summarise(res) {
  const hash = res.transaction_outcome?.id || res.transaction?.hash;
  const logs = [];
  const failures = [];
  let gasBurnt = 0n;
  let tokensBurnt = 0n;
  for (const o of [res.transaction_outcome, ...(res.receipts_outcome || [])]) {
    if (!o) continue;
    logs.push(...(o.outcome.logs || []));
    gasBurnt += BigInt(o.outcome.gas_burnt || 0);
    tokensBurnt += BigInt(o.outcome.tokens_burnt || 0);
    const st = o.outcome.status;
    if (st && st.Failure) failures.push(st.Failure);
  }
  const events = logs
    .filter((l) => l.startsWith('EVENT_JSON:'))
    .map((l) => {
      try {
        return JSON.parse(l.slice('EVENT_JSON:'.length));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  let value = null;
  const sv = res.status?.SuccessValue;
  if (typeof sv === 'string' && sv.length) {
    const txt = Buffer.from(sv, 'base64').toString('utf8');
    try {
      value = JSON.parse(txt);
    } catch {
      value = txt;
    }
  }
  const failure = res.status?.Failure || failures[0] || null;
  return {
    hash,
    url: hash ? EXPLORER_TX + hash : null,
    ok: Boolean(res.status && 'SuccessValue' in res.status),
    value,
    logs,
    events,
    failure,
    error: failure ? describeFailure(failure) : null,
    gasBurnt,
    tokensBurnt,
  };
}

/** Pull the contract's panic message (TOLLGATE_...) out of an execution failure. */
export function describeFailure(f) {
  const s = JSON.stringify(f);
  const m = s.match(/TOLLGATE_[A-Z_]+:[^"\\]*/);
  if (m) return m[0];
  const pe = s.match(/"ExecutionError":"([^"]*)"/);
  if (pe) return pe[1];
  return s.length > 300 ? s.slice(0, 300) + '...' : s;
}

export { actions, KeyPair };
