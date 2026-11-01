import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  voucherMessage, signVoucher, verifyVoucher, keyPairFromSeed, generateChannelKey, base58Encode, base58Decode,
  encodePaymentHeader, decodePaymentHeader, parseNear, formatNear, closeMessage, signRaw, verifyRaw,
} from '../src/core/voucher.mjs';

const vec = (f) => fs.readFileSync(new URL(`./vectors/${f}`, import.meta.url), 'utf8').trim();

test('voucher message format matches the contract', () => {
  assert.equal(
    voucherMessage({ contract: 'channels.tollgate.testnet', channelId: 3, cumulative: 10n ** 21n, nonce: 7 }),
    'tollgate:v1:channels.tollgate.testnet:3:1000000000000000000000:7',
  );
});

test('cross-language vector: same signature as the Rust unit test', () => {
  const kp = keyPairFromSeed(Buffer.alloc(32, 7));
  assert.equal(kp.publicKey, 'ed25519:' + vec('pubkey.txt'));
  const sig = signVoucher(kp.secretKey, { contract: 'channels.tollgate.testnet', channelId: 0, cumulative: 10n ** 21n, nonce: 1 });
  assert.equal(sig, vec('signature.txt'));
});

test('sign and verify; any changed field fails', () => {
  const k = generateChannelKey();
  const v = { contract: 'channels.tollgate-busel.testnet', channelId: 12n, cumulative: parseNear('0.2'), nonce: 200n };
  const sig = signVoucher(k.secretKey, v);
  assert.ok(verifyVoucher(k.publicKey, v, sig));
  assert.ok(!verifyVoucher(k.publicKey, { ...v, cumulative: v.cumulative + 1n }, sig));
  assert.ok(!verifyVoucher(k.publicKey, { ...v, nonce: 201n }, sig));
  assert.ok(!verifyVoucher(k.publicKey, { ...v, channelId: 13n }, sig));
  assert.ok(!verifyVoucher(k.publicKey, { ...v, contract: 'channels.evil.testnet' }, sig));
  assert.ok(!verifyVoucher(generateChannelKey().publicKey, v, sig));
  assert.ok(!verifyVoucher(k.publicKey, v, 'AAAA'));
});

test('rejects malformed voucher fields', () => {
  assert.throws(() => voucherMessage({ contract: 'Bad:Contract', channelId: 0, cumulative: 1, nonce: 1 }));
  assert.throws(() => voucherMessage({ contract: 'a.testnet', channelId: -1, cumulative: 1, nonce: 1 }));
  assert.throws(() => voucherMessage({ contract: 'a.testnet', channelId: 0, cumulative: 1n << 128n, nonce: 1 }));
  assert.throws(() => voucherMessage({ contract: 'a.testnet', channelId: 0, cumulative: 1, nonce: 1n << 64n }));
});

test('base58 round trip including leading zeros', () => {
  for (const b of [Buffer.from([0, 0, 1, 2, 255]), Buffer.alloc(32, 9), Buffer.from([])]) {
    assert.deepEqual(base58Decode(base58Encode(b)), b);
  }
});

test('X-PAYMENT header round trip keeps u128 precision', () => {
  const h = encodePaymentHeader({ network: 'near-testnet', contract: 'c.testnet', channelId: 5n, cumulative: (1n << 100n) + 3n, nonce: 9n, signature: 'sig' });
  const d = decodePaymentHeader(h);
  assert.equal(d.cumulative, (1n << 100n) + 3n);
  assert.equal(d.channelId, 5n);
  assert.equal(d.nonce, 9n);
  assert.throws(() => decodePaymentHeader('not base64 json'));
  assert.throws(() => decodePaymentHeader(Buffer.from(JSON.stringify({ scheme: 'exact', payload: {} })).toString('base64')), /unsupported scheme/);
});

test('NEAR amount parsing is exact', () => {
  assert.equal(parseNear('0.001'), 10n ** 21n);
  assert.equal(parseNear('1'), 10n ** 24n);
  assert.equal(formatNear(parseNear('1.234567'), 6), '1.234567');
  assert.throws(() => parseNear('-1'));
  assert.throws(() => parseNear('1e3'));
});

test('close request signature is domain separated from vouchers', () => {
  const k = generateChannelKey();
  const msg = closeMessage('channels.tollgate-busel.testnet', 4);
  assert.equal(msg, 'tollgate:v1:close:channels.tollgate-busel.testnet:4');
  const sig = signRaw(k.secretKey, msg);
  assert.ok(verifyRaw(k.publicKey, msg, sig));
  assert.ok(!verifyRaw(k.publicKey, closeMessage('channels.tollgate-busel.testnet', 5), sig));
});
