// Vercel Node function: the same demo paid API as server/index.mjs.
// Env: TOLLGATE_CONTRACT, TOLLGATE_SELLER, TOLLGATE_SELLER_KEY, CRON_SECRET, SEC_USER_AGENT.
// Storage: /tmp/seller.json, which is per instance and not durable. See README "Limitations".
import { buildSeller, sellerConfig } from '../server/index.mjs';

let app = null;
export default async function handler(req, res) {
  if (!app) {
    const cfg = sellerConfig({ storeFile: process.env.TOLLGATE_STORE || '/tmp/tollgate-seller.json' });
    app = buildSeller(cfg, (m) => console.log(`[seller] ${m}`)).handler;
  }
  return app(req, res);
}
