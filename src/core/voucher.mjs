// Tollgate voucher format, keys and the X-PAYMENT header. Shared by the seller SDK, the agent
// client and the tests. Only node:crypto, no other dependency.
//
// A voucher is the UTF-8 string
//
//   tollgate:v1:<contract_id>:<channel_id>:<cumulative_yocto>:<nonce>
//
// signed with the channel's dedicated ed25519 key. cumulative_yocto is the total the agent has
// agreed to pay on this channel so far (decimal yoctoNEAR), nonce grows by one per call.
// The contract rebuilds the same string in `voucher_message` and checks it with
// env::ed25519_verify, so this file and contracts/channels/src/lib.rs must agree byte for byte.
import crypto from 'node:crypto';

export const VOUCHER_DOMAIN = 'tollgate:v1';
export const SCHEME = 'near-channel';
export const PAYMENT_HEADER = 'x-payment';
export const PAYMENT_RESPONSE_HEADER = 'x-payment-response';

// ------------------------------------------------------------------ base58 (bitcoin alphabet)

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = Object.fromEntries([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58Encode(bytes) {
  const buf = Buffer.from(bytes);
  let n = BigInt('0x' + (buf.length ? buf.toString('hex') : '0'));
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function base58Decode(str) {
  let n = 0n;
  for (const c of str) {
    const v = ALPHABET_MAP[c];
    if (v === undefined) throw new Error(`invalid base58 character ${JSON.stringify(c)}`);
    n = n * 58n + v;
  }
  let hex = n === 0n ? '' : n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = Buffer.from(hex, 'hex');
  let zeros = 0;
  for (const c of str) {
    if (c !== '1') break;
    zeros++;
  }
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

// ------------------------------------------------------------------ keys

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// KeyObjects are cached: a seller verifies many vouchers against the same channel key.
const keyCache = new Map();
function cached(kind, raw, make) {
  const k = kind + Buffer.from(raw).toString('hex');
  let v = keyCache.get(k);
  if (!v) {
    v = make();
    if (keyCache.size > 10_000) keyCache.clear();
    keyCache.set(k, v);
  }
  return v;
}

function privateKeyObject(seed) {
  return cached('s', seed, () => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' }));
}

function publicKeyObject(raw) {
  return cached('p', raw, () => crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' }));
}

function rawPublicFromSeed(seed) {
  const spki = crypto.createPublicKey(privateKeyObject(seed)).export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32);
}

/** Parse "ed25519:<base58>" secret keys (64-byte seed||pub, NEAR format) or a 32-byte seed. */
export function parseSecretKey(secretKey) {
  const s = String(secretKey);
  if (!s.startsWith('ed25519:')) throw new Error('channel secret key must start with ed25519:');
  const raw = base58Decode(s.slice(8));
  if (raw.length !== 64 && raw.length !== 32) throw new Error(`bad ed25519 secret key length ${raw.length}`);
  const seed = raw.subarray(0, 32);
  return { seed, publicKey: rawPublicFromSeed(seed) };
}

export function parsePublicKey(publicKey) {
  const s = String(publicKey);
  if (!s.startsWith('ed25519:')) throw new Error('public key must start with ed25519:');
  const raw = base58Decode(s.slice(8));
  if (raw.length !== 32) throw new Error(`bad ed25519 public key length ${raw.length}`);
  return raw;
}

/** Build a NEAR-format key pair from a 32-byte seed. */
export function keyPairFromSeed(seed) {
  const s = Buffer.from(seed);
  if (s.length !== 32) throw new Error('seed must be 32 bytes');
  const pub = rawPublicFromSeed(s);
  return {
    secretKey: 'ed25519:' + base58Encode(Buffer.concat([s, pub])),
    publicKey: 'ed25519:' + base58Encode(pub),
  };
}

/** A fresh, dedicated channel key. It is not an account key and controls no account. */
export function generateChannelKey() {
  return keyPairFromSeed(crypto.randomBytes(32));
}

// ------------------------------------------------------------------ vouchers

const ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

function u64(v, name) {
  const n = BigInt(v);
  if (n < 0n || n > 0xffffffffffffffffn) throw new Error(`${name} out of u64 range`);
  return n;
}

function u128(v, name) {
  const n = BigInt(v);
  if (n < 0n || n >= 1n << 128n) throw new Error(`${name} out of u128 range`);
  return n;
}

export function voucherMessage({ contract, channelId, cumulative, nonce }) {
  if (!ACCOUNT_ID_RE.test(String(contract)) || String(contract).length < 2 || String(contract).length > 64) {
    throw new Error(`invalid contract account id ${JSON.stringify(contract)}`);
  }
  return `${VOUCHER_DOMAIN}:${contract}:${u64(channelId, 'channelId')}:${u128(cumulative, 'cumulative')}:${u64(nonce, 'nonce')}`;
}

/** Sign a voucher; returns the 64-byte signature as base64. */
export function signVoucher(secretKey, voucher) {
  const { seed } = parseSecretKey(secretKey);
  const msg = Buffer.from(voucherMessage(voucher), 'utf8');
  return crypto.sign(null, msg, privateKeyObject(seed)).toString('base64');
}

/** Verify a voucher signature against the channel's public key ("ed25519:..."). */
export function verifyVoucher(publicKey, voucher, signatureB64) {
  let sig;
  try {
    sig = Buffer.from(String(signatureB64), 'base64');
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  let msg;
  try {
    msg = Buffer.from(voucherMessage(voucher), 'utf8');
  } catch {
    return false;
  }
  return crypto.verify(null, msg, publicKeyObject(parsePublicKey(publicKey)), sig);
}

/** The string an agent signs (with the channel key) to ask a seller for a cooperative close. */
export function closeMessage(contract, channelId) {
  return `${VOUCHER_DOMAIN}:close:${contract}:${BigInt(channelId)}`;
}

/** Sign an arbitrary UTF-8 message with a channel key; base64 signature. */
export function signRaw(secretKey, message) {
  const { seed } = parseSecretKey(secretKey);
  return crypto.sign(null, Buffer.from(message, 'utf8'), privateKeyObject(seed)).toString('base64');
}

export function verifyRaw(publicKey, message, signatureB64) {
  try {
    const sig = Buffer.from(String(signatureB64), 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(message, 'utf8'), publicKeyObject(parsePublicKey(publicKey)), sig);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ X-PAYMENT header

/**
 * X-PAYMENT: base64(JSON) of
 *   { scheme: "near-channel", network: "near-testnet",
 *     payload: { contract, channel_id, cumulative, nonce, signature } }
 * Amounts and ids are decimal strings so nothing loses precision in JSON.
 */
export function encodePaymentHeader({ network, contract, channelId, cumulative, nonce, signature }) {
  const body = {
    scheme: SCHEME,
    network,
    payload: {
      contract,
      channel_id: String(channelId),
      cumulative: String(cumulative),
      nonce: String(nonce),
      signature,
    },
  };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
}

export function decodePaymentHeader(header) {
  let body;
  try {
    body = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8'));
  } catch {
    throw new Error('X-PAYMENT is not base64 JSON');
  }
  if (body?.scheme !== SCHEME) throw new Error(`unsupported scheme ${JSON.stringify(body?.scheme)}`);
  const p = body.payload || {};
  for (const k of ['contract', 'channel_id', 'cumulative', 'nonce', 'signature']) {
    if (typeof p[k] !== 'string' || !p[k]) throw new Error(`payload.${k} missing`);
  }
  if (!/^\d+$/.test(p.channel_id) || !/^\d+$/.test(p.cumulative) || !/^\d+$/.test(p.nonce)) {
    throw new Error('channel_id, cumulative and nonce must be decimal strings');
  }
  return {
    network: body.network,
    contract: p.contract,
    channelId: BigInt(p.channel_id),
    cumulative: BigInt(p.cumulative),
    nonce: BigInt(p.nonce),
    signature: p.signature,
  };
}

export function encodeJsonHeader(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

export function decodeJsonHeader(h) {
  return JSON.parse(Buffer.from(String(h), 'base64').toString('utf8'));
}

// ------------------------------------------------------------------ amounts

export const YOCTO_PER_NEAR = 10n ** 24n;

/** "0.001" -> 1000000000000000000000n (exact decimal). */
export function parseNear(amount) {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`bad NEAR amount ${JSON.stringify(amount)}`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 24) throw new Error('more than 24 decimals');
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt((frac + '0'.repeat(24)).slice(0, 24));
}

export function formatNear(yocto, digits = 4) {
  const v = BigInt(yocto ?? 0);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / YOCTO_PER_NEAR;
  const frac = (a % YOCTO_PER_NEAR).toString().padStart(24, '0').slice(0, digits);
  return `${neg ? '-' : ''}${whole}${digits ? '.' + frac : ''}`;
}
