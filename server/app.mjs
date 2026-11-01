// The demo paid API: live U.S. public data, each endpoint behind a Tollgate price.
// Plain node:http handler, so the same code runs under `node server/index.mjs` and as a
// Vercel Node function (api/index.mjs).
import { quakes, complaints, secFacts } from './data.mjs';
import { PaymentError } from '../src/seller/tollgate.mjs';

export const PRODUCTS = [
  {
    path: '/v1/quakes',
    price: '0.001',
    description: 'Recent earthquakes worldwide from the USGS FDSN event API',
    params: { min_magnitude: 'number, default 4.5', hours: 'lookback, default 24', limit: '1-50, default 10' },
    run: quakes,
  },
  {
    path: '/v1/complaints',
    price: '0.002',
    description: 'Newest CFPB consumer complaints, filterable by company and product',
    params: { company: 'exact CFPB company name, e.g. CAPITAL ONE FINANCIAL CORPORATION', product: 'e.g. Credit card', size: '1-25, default 5' },
    run: complaints,
  },
  {
    path: '/v1/sec/facts',
    price: '0.003',
    description: 'Latest annual headline financials (revenue, net income, assets, cash, R&D) from SEC EDGAR XBRL',
    params: { ticker: 'e.g. NVDA, default AAPL' },
    run: secFacts,
  },
];

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body; // Vercel pre-parses JSON
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export function createApp({ gate, adminToken = null }) {
  const paid = new Map(
    PRODUCTS.map((p) => [
      p.path,
      gate.protect({ price: p.price, description: p.description }, async (req, res, receipt) => {
        const url = new URL(req.url, 'http://x');
        try {
          const data = await p.run(url.searchParams);
          sendJson(res, 200, { ...data, paid: { channel_id: receipt.channel_id, nonce: receipt.nonce, price_yocto: receipt.price } });
        } catch (e) {
          // The voucher was accepted; the agent still has a receipt for this call.
          sendJson(res, e.status || 502, { error: e.message, paid: { channel_id: receipt.channel_id, nonce: receipt.nonce } });
        }
      }),
    ]),
  );

  return async function handle(req, res) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, x-payment');
    res.setHeader('access-control-expose-headers', 'x-payment-response, x-tollgate-price, x-tollgate-contract, x-tollgate-seller');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }
    const url = new URL(req.url, 'http://x');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (paid.has(route)) return await paid.get(route)(req, res);
      if (route === '/' || route === '/v1') {
        return sendJson(res, 200, {
          name: 'Tollgate demo data API',
          about: 'Live U.S. public data, paid per call over HTTP 402 with NEAR payment channel vouchers.',
          payment: {
            scheme: 'near-channel',
            network: gate.network,
            contract: gate.contract,
            seller: gate.seller,
            how: 'Call any product. A 402 answer describes the price and the voucher format. Open a channel on the contract once, then send X-PAYMENT with each call.',
          },
          products: PRODUCTS.map(({ path, price, description, params }) => ({ path, price_near: price, description, params })),
          free: ['/', '/tollgate/health', '/tollgate/receipts', '/tollgate/channels', 'POST /tollgate/close'],
        });
      }
      if (route === '/tollgate/health') return sendJson(res, 200, { ok: true, contract: gate.contract, seller: gate.seller });
      if (route === '/tollgate/receipts') {
        const limit = Math.min(500, Number(url.searchParams.get('limit')) || 100);
        return sendJson(res, 200, { seller: gate.seller, contract: gate.contract, receipts: gate.receipts(limit) });
      }
      if (route === '/tollgate/channels') return sendJson(res, 200, { seller: gate.seller, channels: gate.channels() });
      if (route === '/tollgate/close' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const r = await gate.closeRequest(body);
          return sendJson(res, r.ok ? 200 : 409, { ok: r.ok, tx: r.hash, url: r.url, refund: r.value, error: r.error });
        } catch (e) {
          if (e instanceof PaymentError) return sendJson(res, 400, { ok: false, reason: e.reason, error: e.message });
          throw e;
        }
      }
      if (route === '/tollgate/settle' && (req.method === 'POST' || req.method === 'GET')) {
        // For serverless deployments (Vercel cron): settle everything due, protected by a token.
        const auth = req.headers.authorization || '';
        if (!adminToken || auth !== `Bearer ${adminToken}`) return sendJson(res, 401, { error: 'unauthorized' });
        const out = await gate.settleAll();
        return sendJson(res, 200, { settled: out.map((r) => ({ ok: r.ok, tx: r.hash, error: r.error })) });
      }
      return sendJson(res, 404, { error: 'not found', see: '/' });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  };
}
