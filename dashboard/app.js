// Tollgate dashboard: reads channel state from public testnet RPC and the seller's receipt feed.
// Static, no build step, no keys.
// config.local.js (written by setup for your own deployment) wins over the committed config.js.
const CONFIG = await import('./config.local.js').then((m) => m.CONFIG, () => import('./config.js').then((m) => m.CONFIG));

const q = new URLSearchParams(location.search);
const contract = q.get('contract') || CONFIG.contract;
// Deployed next to the seller (e.g. on Vercel), default to the same origin.
const sameOrigin = !/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /localhost|127\.0\.0\.1/.test(CONFIG.sellerUrl || '');
const sellerUrl = (q.get('seller') || (sameOrigin ? location.origin : CONFIG.sellerUrl) || '').replace(/\/$/, '');
const rpcs = q.get('rpc') ? [q.get('rpc')] : CONFIG.rpcs;
const EXPLORER = 'https://testnet.nearblocks.io';
const $ = (id) => document.getElementById(id);
let selected = null;
let channels = [];

// ---------------------------------------------------------------- theme
const root = document.documentElement;
try {
  const t = localStorage.getItem('tollgate-theme');
  if (t) root.dataset.theme = t;
} catch {}
$('theme').onclick = () => {
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('tollgate-theme', root.dataset.theme); } catch {}
};

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function near(yocto, d = 4) {
  const v = BigInt(yocto || 0);
  const w = v / 10n ** 24n;
  const f = (v % 10n ** 24n).toString().padStart(24, '0').slice(0, d);
  return `${w}.${f}`;
}
const when = (ns) => (ns ? new Date(Number(BigInt(ns) / 1000000n)) : null);
function rel(d) {
  if (!d) return '';
  const s = Math.round((d.getTime() - Date.now()) / 1000);
  const a = Math.abs(s);
  const t = a < 90 ? `${a} s` : a < 5400 ? `${Math.round(a / 60)} min` : a < 172800 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} d`;
  return s >= 0 ? `in ${t}` : `${t} ago`;
}
const acct = (a) => `<a href="${EXPLORER}/address/${esc(a)}" target="_blank" rel="noopener">${esc(a)}</a>`;

async function rpc(method, params) {
  let last;
  for (const url of rpcs) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'dash', method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function view(method, args = {}) {
  const r = await rpc('query', {
    request_type: 'call_function', finality: 'optimistic', account_id: contract, method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  const text = new TextDecoder().decode(new Uint8Array(r.result));
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------- render
function stat(k, v) {
  return `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`;
}

async function loadChain() {
  const [stats, cfg] = await Promise.all([view('get_stats'), view('get_config')]);
  $('stats').innerHTML = [
    stat('channels', esc(stats.channels)),
    stat('open / closing', `${esc(stats.open)} / ${esc(stats.closing)}`),
    stat('locked (NEAR)', near(BigInt(stats.total_deposited) - BigInt(stats.total_settled) - BigInt(stats.total_refunded), 3)),
    stat('settled (NEAR)', near(stats.total_settled, 3)),
    stat('settlements', esc(stats.total_settlements)),
    stat('min dispute window', `${esc(cfg.min_dispute_window_sec)} s`),
  ].join('');
  const total = Number(stats.channels);
  const from = Math.max(0, total - 100);
  channels = (await view('get_channels', { from_index: String(from), limit: 100 })).reverse();
  $('channels').innerHTML = channels.length
    ? channels.map((c) => {
        const pct = Number((BigInt(c.settled) * 1000n) / (BigInt(c.deposit) || 1n)) / 10;
        return `<tr data-id="${esc(c.channel_id)}" class="${c.channel_id === selected ? 'sel' : ''}">
          <td class="mono">${esc(c.channel_id)}</td><td>${acct(c.owner)}</td><td>${acct(c.seller)}</td>
          <td>${near(c.deposit)}</td><td>${near(c.settled)}</td>
          <td><span class="bar" title="${pct}% of the deposit settled"><i style="width:${Math.min(100, pct)}%"></i></span></td>
          <td class="mono">${esc(c.last_nonce)}</td><td>${esc(c.settlements)}</td>
          <td><span class="pill ${esc(c.status)}">${esc(c.status)}</span></td>
          <td class="muted">${c.status === 'Closed' ? 'closed ' + rel(when(c.closed_at_ns)) : rel(when(c.expires_at_ns))}</td></tr>`;
      }).join('')
    : '<tr><td colspan="10" class="muted">No channels yet. Run npm run demo.</td></tr>';
  for (const tr of $('channels').querySelectorAll('tr[data-id]')) tr.onclick = () => select(tr.dataset.id);
  if (selected != null) renderDetail();
}

function select(id) {
  selected = id;
  for (const tr of $('channels').querySelectorAll('tr[data-id]')) tr.classList.toggle('sel', tr.dataset.id === id);
  renderDetail();
}

function renderDetail() {
  const c = channels.find((x) => x.channel_id === selected);
  if (!c) return;
  const rows = [
    ['channel', c.channel_id], ['status', c.status], ['owner (agent)', c.owner], ['seller', c.seller],
    ['channel key', c.agent_pubkey], ['deposit', `${near(c.deposit, 6)} NEAR`], ['settled', `${near(c.settled, 6)} NEAR`],
    ['remaining', `${near(c.remaining, 6)} NEAR`], ['refunded', `${near(c.refunded, 6)} NEAR`], ['last nonce', c.last_nonce],
    ['settlements', c.settlements], ['dispute window', `${c.dispute_window_sec} s`],
    ['opened', when(c.opened_at_ns)?.toISOString()], ['expires', `${when(c.expires_at_ns)?.toISOString()} (${rel(when(c.expires_at_ns))})`],
    ['settle deadline', `${when(c.settle_deadline_ns)?.toISOString()} (${rel(when(c.settle_deadline_ns))})`],
    ['close requested', c.close_requested_at_ns ? when(c.close_requested_at_ns).toISOString() : 'no'],
    ['last settled block', c.last_settled_block !== '0' ? `<a href="${EXPLORER}/blocks/${esc(c.last_settled_block)}" target="_blank" rel="noopener">${esc(c.last_settled_block)}</a>` : 'never'],
    ['storage fee', `${near(c.storage_fee, 6)} NEAR`],
  ];
  $('detail').innerHTML = `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${String(v).startsWith('<a') ? v : esc(v)}</dd>`).join('')}</dl>`;
}

async function loadReceipts() {
  if (!sellerUrl) {
    $('receipts').innerHTML = '<tr><td colspan="8" class="muted">No seller URL configured (?seller=http://localhost:8402).</td></tr>';
    return;
  }
  try {
    const r = await fetch(`${sellerUrl}/tollgate/receipts?limit=60`);
    const j = await r.json();
    $('receipts').innerHTML = j.receipts.length
      ? j.receipts.map((x) => {
          let p = x.resource;
          try { const u = new URL(x.resource); p = u.pathname + u.search; } catch {}
          return `<tr><td class="muted">${esc(new Date(x.ts).toLocaleTimeString())}</td><td class="mono">${esc(x.channel_id)}</td>
            <td class="mono" title="${esc(x.resource)}">${esc(p.length > 48 ? p.slice(0, 48) + '...' : p)}</td>
            <td>${near(x.price, 3)}</td><td>${near(x.cumulative, 3)}</td><td class="mono">${esc(x.nonce)}</td>
            <td class="muted">${Number(x.verify_us).toFixed(0)} us</td>
            <td>${x.settled ? `<a href="${EXPLORER}/txns/${esc(x.settle_tx)}" target="_blank" rel="noopener">${esc(String(x.settle_tx).slice(0, 8))}...</a>` : '<span class="muted">pending</span>'}</td></tr>`;
        }).join('')
      : '<tr><td colspan="8" class="muted">No paid calls yet.</td></tr>';
  } catch {
    $('receipts').innerHTML = `<tr><td colspan="8" class="muted">Seller at ${esc(sellerUrl)} is not reachable. Start it with npm run seller.</td></tr>`;
  }
}

// ---------------------------------------------------------------- voucher check
$('verify').onclick = async () => {
  $('verdict').textContent = 'checking...';
  $('vdetail').textContent = '';
  try {
    const body = JSON.parse(atob($('voucher').value.trim()));
    const p = body.payload;
    if (p.contract !== contract) throw new Error(`voucher is for ${p.contract}, dashboard reads ${contract}`);
    const ok = await view('verify_voucher', { channel_id: p.channel_id, cumulative_amount: p.cumulative, nonce: p.nonce, signature: p.signature });
    const msg = await view('voucher_message', { channel_id: p.channel_id, cumulative_amount: p.cumulative, nonce: p.nonce });
    $('verdict').innerHTML = ok ? '<span class="ok">valid signature</span>' : '<span class="bad">invalid signature</span>';
    $('vdetail').textContent = `signed message: ${msg} (${near(p.cumulative, 6)} NEAR cumulative)`;
  } catch (e) {
    $('verdict').innerHTML = `<span class="bad">${esc(e.message)}</span>`;
  }
};

// ---------------------------------------------------------------- loop
$('contract').textContent = contract;
$('sellerUrl').textContent = sellerUrl;
$('rpc').textContent = rpcs[0];
$('explorer').href = `${EXPLORER}/address/${contract}`;
async function refresh() {
  try {
    await Promise.all([loadChain(), loadReceipts()]);
    $('updated').textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    $('updated').textContent = `RPC error: ${e.message.slice(0, 80)}`;
  }
}
refresh();
setInterval(refresh, 5000);
