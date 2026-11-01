#!/usr/bin/env node
// Tollgate MCP server (stdio). Gives Claude Code, Codex or any MCP client paid HTTP tools:
// 402 paywalls are paid from a NEAR payment channel inside the budget the human configured
// (TOLLGATE_BUDGET_NEAR, TOLLGATE_MAX_PRICE_NEAR). The model never sees a key.
//
//   claude mcp add tollgate -- node /path/to/tollgate/src/agent/mcp.mjs
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { clientFromEnv } from './config.mjs';

const client = await clientFromEnv({ log: (m) => console.error(`[tollgate] ${m}`) });
const server = new McpServer({ name: 'tollgate', version: '0.1.0' });

const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `${e.code ? e.code + ': ' : ''}${e.message}` }] });

function clip(body, max = 20_000) {
  const s = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  return s.length > max ? s.slice(0, max) + `\n... (${s.length - max} more characters)` : s;
}

server.registerTool(
  'tollgate_fetch',
  {
    title: 'Fetch a URL, paying HTTP 402 automatically',
    description:
      'HTTP request that pays "near-channel" 402 paywalls from a NEAR payment channel. Each paid call costs one off-chain voucher (no blockchain transaction). Refuses calls above the per-call price cap or beyond the total budget the human set. Returns the response body and a receipt.',
    inputSchema: {
      url: z.string().url().describe('Full URL, e.g. http://127.0.0.1:8402/v1/quakes?min_magnitude=5'),
      method: z.string().optional().describe('HTTP method, default GET'),
      body: z.string().optional().describe('Request body (JSON string) for POST/PUT'),
    },
  },
  async ({ url, method, body }) => {
    try {
      const init = { method: method || 'GET' };
      if (body) {
        init.body = body;
        init.headers = { 'content-type': 'application/json' };
      }
      const r = await client.fetch(url, init);
      const payment = r.receipt
        ? `Paid ${r.receipt.price_near} NEAR to ${r.receipt.seller} (channel ${r.receipt.channel_id}, voucher nonce ${r.receipt.nonce}). Budget: ${client.status().spent} of ${client.status().budget} NEAR spent.`
        : 'Free endpoint, nothing paid.';
      return text(`HTTP ${r.response.status}\n${payment}\n\n${clip(r.body)}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'tollgate_status',
  {
    title: 'Budget and channels',
    description: 'Show the budget the human set, how much is spent, how much is locked in channels, and each channel.',
    inputSchema: {},
  },
  async () => text(client.status()),
);

server.registerTool(
  'tollgate_receipts',
  {
    title: 'Receipts',
    description: 'Recent purchases: what was bought (URL), from whom, price, cumulative amount, voucher nonce and the settlement transaction once the seller has settled.',
    inputSchema: { limit: z.number().int().min(1).max(500).optional() },
  },
  async ({ limit }) => text(client.receipts(limit || 20)),
);

server.registerTool(
  'tollgate_close_channel',
  {
    title: 'Close a channel',
    description:
      'Get the unspent deposit back. mode "cooperative" asks the seller to settle and refund now; "start" begins a unilateral close (the seller can still settle during the dispute window); "finalize" refunds after the window.',
    inputSchema: {
      channel_id: z.string(),
      mode: z.enum(['cooperative', 'start', 'finalize']).default('cooperative'),
    },
  },
  async ({ channel_id, mode }) => {
    try {
      if (mode === 'cooperative') return text(await client.cooperativeClose(channel_id));
      const r = mode === 'start' ? await client.startClose(channel_id) : await client.finalize(channel_id);
      return text({ ok: r.ok, tx: r.url, value: r.value, error: r.error });
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
console.error('[tollgate] MCP server ready on stdio');
