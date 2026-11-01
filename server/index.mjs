// Run the demo paid API with node:http and a background settler.
//
//   node server/index.mjs            # http://localhost:8402
//
// Config (env): PORT, TOLLGATE_CONTRACT, TOLLGATE_SELLER, TOLLGATE_SELLER_KEY (else SELLER_KEY
// from .env.testnet), TOLLGATE_STORE (default state/seller.json), SETTLE_EVERY_CALLS (100),
// SETTLE_EVERY_SEC (60), MIN_DISPUTE_WINDOW_SEC (15), NEAR_RPC.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { createTollgate } from '../src/seller/tollgate.mjs';
import { FileStore, MemoryStore } from '../src/seller/store.mjs';
import { ROOT, RPC_URL, readEnv, readDeploymentsOrEmpty } from '../src/core/near.mjs';
import { sellerChain } from './chain.mjs';
import { createApp } from './app.mjs';

export function sellerConfig(overrides = {}) {
  const env = readEnv();
  const dep = readDeploymentsOrEmpty();
  return {
    contract: process.env.TOLLGATE_CONTRACT || dep.contract,
    seller: process.env.TOLLGATE_SELLER || dep.seller,
    sellerKey: process.env.TOLLGATE_SELLER_KEY || env.SELLER_KEY,
    storeFile: process.env.TOLLGATE_STORE || path.join(ROOT, 'state', 'seller.json'),
    settleEveryCalls: Number(process.env.SETTLE_EVERY_CALLS || 100),
    settleEverySec: Number(process.env.SETTLE_EVERY_SEC || 60),
    minDisputeWindowSec: Number(process.env.MIN_DISPUTE_WINDOW_SEC || 15),
    ...overrides,
  };
}

export function buildSeller(cfg, log = (m) => console.log(`[seller] ${m}`)) {
  if (!cfg.contract || !cfg.seller) throw new Error('No contract/seller configured. Run npm run setup or set TOLLGATE_CONTRACT and TOLLGATE_SELLER.');
  const chain = cfg.sellerKey ? sellerChain({ accountId: cfg.seller, privateKey: cfg.sellerKey, contract: cfg.contract }) : {};
  const gate = createTollgate({
    contract: cfg.contract,
    seller: cfg.seller,
    rpcUrl: RPC_URL,
    store: cfg.storeFile ? new FileStore(cfg.storeFile) : new MemoryStore(),
    settle: chain.settle || null,
    cooperativeClose: chain.cooperativeClose || null,
    settleEveryCalls: cfg.settleEveryCalls,
    settleEverySec: cfg.settleEverySec,
    minDisputeWindowSec: cfg.minDisputeWindowSec,
    log,
  });
  return { gate, handler: createApp({ gate, adminToken: process.env.CRON_SECRET || null }) };
}

export function startServer(cfg, { port = 8402, settler = true, log } = {}) {
  const { gate, handler } = buildSeller(cfg, log);
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      if (settler && cfg.sellerKey) gate.startSettler();
      resolve({ server, gate, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

if (path.basename(process.argv[1] || '') === 'index.mjs' && process.argv[1].includes('server')) {
  const cfg = sellerConfig();
  const port = Number(process.env.PORT || 8402);
  startServer(cfg, { port }).then(({ url }) => {
    console.log(`Tollgate demo API on ${url}`);
    console.log(`  seller ${cfg.seller}, contract ${cfg.contract}, store ${cfg.storeFile}`);
    console.log(`  settler: every ${cfg.settleEveryCalls} calls or ${cfg.settleEverySec} s${cfg.sellerKey ? '' : ' (DISABLED: no seller key)'}`);
  });
}
