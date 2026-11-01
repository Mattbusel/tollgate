// MCP smoke test: start the Tollgate MCP server over stdio like Claude Code would, list its
// tools, show the budget, and (with a URL argument) make one paid call and show the receipt.
//   node scripts/mcp-smoke.mjs [http://127.0.0.1:8402/v1/quakes]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const transport = new StdioClientTransport({ command: process.execPath, args: ['src/agent/mcp.mjs'], env: { ...process.env, TOLLGATE_STATE_DIR: process.env.TOLLGATE_STATE_DIR || 'state/mcp-smoke' }, stderr: 'inherit' });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);
const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));
const st = await client.callTool({ name: 'tollgate_status', arguments: {} });
console.log(st.content[0].text.slice(0, 400));
if (process.argv[2]) {
  const r = await client.callTool({ name: 'tollgate_fetch', arguments: { url: process.argv[2] } });
  console.log(r.content[0].text.slice(0, 900));
  const rc = await client.callTool({ name: 'tollgate_receipts', arguments: { limit: 2 } });
  console.log(rc.content[0].text.slice(0, 900));
}
await client.close();
