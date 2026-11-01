// On-chain side of the seller: settle the newest voucher and close cooperatively, signed with
// the seller account's own key (read from the environment, never from the request).
import { accountWithKey, call } from '../src/core/near.mjs';

export function sellerChain({ accountId, privateKey, contract }) {
  const account = accountWithKey(accountId, privateKey);
  return {
    settle: ({ channelId, cumulative, nonce, signature }) =>
      call(account, contract, 'settle', {
        channel_id: String(channelId),
        cumulative_amount: String(cumulative),
        nonce: String(nonce),
        signature,
      }),
    cooperativeClose: ({ channelId, voucher }) =>
      call(account, contract, 'cooperative_close', {
        channel_id: String(channelId),
        cumulative_amount: voucher ? String(voucher.cumulative) : null,
        nonce: voucher ? String(voucher.nonce) : null,
        signature: voucher ? voucher.signature : null,
      }),
  };
}
