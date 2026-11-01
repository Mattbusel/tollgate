// Build a TollgateClient from environment variables (and, inside this repo, from
// deployments/testnet.json and .env.testnet). The human sets the money limits here.
//
//   TOLLGATE_ACCOUNT_ID        agent's NEAR account (pays channel deposits)
//   TOLLGATE_ACCOUNT_KEY       its key, ed25519:... (only used to open/top up/close channels)
//   TOLLGATE_BUDGET_NEAR       total NEAR the agent may commit, default 1
//   TOLLGATE_MAX_PRICE_NEAR    refuse any call priced above this, default 0.01
//   TOLLGATE_CHANNEL_NEAR      deposit per new channel, default = budget
//   TOLLGATE_CONTRACTS         comma-separated trusted channel contracts
//   TOLLGATE_DISPUTE_WINDOW_SEC  dispute window for new channels, default 60
//   TOLLGATE_STATE_DIR         channel keys + receipts, default <repo>/.tollgate
import fs from 'node:fs';
import path from 'node:path';
import { TollgateClient, nearChain } from './client.mjs';
import { ROOT, readEnv, readDeploymentsOrEmpty } from '../core/near.mjs';

export async function clientFromEnv(overrides = {}) {
  const env = readEnv();
  const dep = readDeploymentsOrEmpty();
  const accountId = process.env.TOLLGATE_ACCOUNT_ID || dep.agent;
  const privateKey = process.env.TOLLGATE_ACCOUNT_KEY || env.AGENT_ACCOUNT_KEY;
  if (!accountId || !privateKey) throw new Error('Set TOLLGATE_ACCOUNT_ID and TOLLGATE_ACCOUNT_KEY (or run npm run setup).');
  const contracts = (process.env.TOLLGATE_CONTRACTS || dep.contract || '').split(',').map((s) => s.trim()).filter(Boolean);
  const budget = process.env.TOLLGATE_BUDGET_NEAR || '1';
  return new TollgateClient({
    budget,
    maxPricePerCall: process.env.TOLLGATE_MAX_PRICE_NEAR || '0.01',
    channelDeposit: process.env.TOLLGATE_CHANNEL_NEAR || budget,
    trustedContracts: contracts,
    disputeWindowSec: Number(process.env.TOLLGATE_DISPUTE_WINDOW_SEC || 60),
    chain: await nearChain({ accountId, privateKey }),
    stateDir: process.env.TOLLGATE_STATE_DIR || path.join(ROOT, '.tollgate'),
    ...overrides,
  });
}
