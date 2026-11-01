#!/usr/bin/env node
// tollgate: command line agent client for HTTP 402 "near-channel" APIs.
//
//   tollgate fetch <url> [--method POST] [--data '{"json":1}']
//   tollgate status                 budget, spend, channels
//   tollgate receipts [--limit 20]  what was bought, from whom, price, voucher nonce, settlement tx
//   tollgate refresh                pull settled amounts and status from the chain
//   tollgate close <channel_id>     ask the seller to close now (cooperative, instant refund)
//   tollgate start-close <channel_id>   unilateral close; finalize after the dispute window
//   tollgate finalize <channel_id>
//   tollgate mcp                    run the MCP server on stdio
import { clientFromEnv } from './config.mjs';

function flag(args, name, def = null) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

const print = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  if (!cmd || cmd === 'help' || cmd === '--help') {
    print(
      [
        'tollgate fetch <url> [--method M] [--data JSON]',
        'tollgate status | receipts [--limit N] | refresh',
        'tollgate close <channel_id> | start-close <channel_id> | finalize <channel_id>',
        'tollgate mcp',
        '',
        'Limits come from TOLLGATE_BUDGET_NEAR, TOLLGATE_MAX_PRICE_NEAR, TOLLGATE_CHANNEL_NEAR.',
      ].join('\n'),
    );
    return;
  }
  if (cmd === 'mcp') {
    await import('./mcp.mjs');
    return;
  }
  const client = await clientFromEnv({ log: (m) => console.error(`[tollgate] ${m}`) });
  switch (cmd) {
    case 'fetch': {
      const method = flag(args, 'method', 'GET');
      const data = flag(args, 'data');
      const url = args[0];
      if (!url) throw new Error('usage: tollgate fetch <url>');
      const init = { method };
      if (data) {
        init.body = data;
        init.headers = { 'content-type': 'application/json' };
      }
      const { response, body, receipt } = await client.fetch(url, init);
      print(body);
      if (receipt) {
        console.error(
          `[tollgate] HTTP ${response.status}; paid ${receipt.price_near} NEAR to ${receipt.seller} on channel ${receipt.channel_id} (voucher nonce ${receipt.nonce}, cumulative ${receipt.cumulative} yocto). No on-chain transaction for this call.`,
        );
      } else {
        console.error(`[tollgate] HTTP ${response.status}; free endpoint`);
      }
      break;
    }
    case 'status':
      print(client.status());
      break;
    case 'refresh':
      print(await client.refresh());
      break;
    case 'receipts':
      print(client.receipts(Number(flag(args, 'limit', '20'))));
      break;
    case 'close':
      print(await client.cooperativeClose(args[0]));
      break;
    case 'start-close': {
      const r = await client.startClose(args[0]);
      print({ ok: r.ok, tx: r.url, error: r.error, settle_deadline_ns: r.value?.settle_deadline_ns });
      break;
    }
    case 'finalize': {
      const r = await client.finalize(args[0]);
      print({ ok: r.ok, tx: r.url, refund_yocto: r.value, error: r.error });
      break;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

main().catch((e) => {
  console.error(`tollgate: ${e.code ? e.code + ': ' : ''}${e.message}`);
  process.exit(1);
});
