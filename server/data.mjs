// Live, keyless U.S. public data sources sold by the demo API. Every response is real data
// fetched from the agency's public API; a short cache keeps 200 demo calls from hammering them.
const SEC_UA = process.env.SEC_USER_AGENT || 'Tollgate demo (Tensorust LLC) mattbusel@tensorust.com';
const cache = new Map();

async function cachedJson(url, { ttlMs = 60_000, headers = {} } = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return { json: hit.json, fetchedAt: hit.fetchedAt, cached: true };
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers } });
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} answered ${res.status}`), { status: 502 });
  const json = await res.json();
  const fetchedAt = new Date().toISOString();
  cache.set(url, { json, at: Date.now(), fetchedAt });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return { json, fetchedAt, cached: false };
}

function int(v, def, min, max) {
  const n = Number.parseInt(v ?? '', 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function num(v, def, min, max) {
  const n = Number.parseFloat(v ?? '');
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** USGS: recent earthquakes, newest first. */
export async function quakes(q) {
  const minmag = num(q.get('min_magnitude'), 4.5, 0, 10);
  const hours = int(q.get('hours'), 24, 1, 24 * 30);
  const limit = int(q.get('limit'), 10, 1, 50);
  const start = new Date(Math.floor((Date.now() - hours * 3600_000) / 60_000) * 60_000).toISOString();
  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=time&minmagnitude=${minmag}&starttime=${encodeURIComponent(start)}&limit=${limit}`;
  const { json, fetchedAt, cached } = await cachedJson(url);
  return {
    source: 'USGS Earthquake Hazards Program, FDSN event API',
    source_url: url,
    fetched_at: fetchedAt,
    cached,
    query: { min_magnitude: minmag, hours, limit },
    count: json.features.length,
    quakes: json.features.map((f) => ({
      id: f.id,
      magnitude: f.properties.mag,
      place: f.properties.place,
      time: new Date(f.properties.time).toISOString(),
      depth_km: f.geometry?.coordinates?.[2] ?? null,
      tsunami: Boolean(f.properties.tsunami),
      url: f.properties.url,
    })),
  };
}

/** CFPB: newest consumer complaints, optionally for one company and/or product. */
export async function complaints(q) {
  const size = int(q.get('size'), 5, 1, 25);
  const params = new URLSearchParams({ size: String(size), sort: 'created_date_desc', no_aggs: 'true' });
  if (q.get('company')) params.set('company', q.get('company').toUpperCase());
  if (q.get('product')) params.set('product', q.get('product'));
  if (q.get('search')) params.set('search_term', q.get('search'));
  const url = `https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/?${params}`;
  const { json, fetchedAt, cached } = await cachedJson(url, { ttlMs: 5 * 60_000 });
  return {
    source: 'Consumer Financial Protection Bureau, Consumer Complaint Database (CC0)',
    source_url: url,
    fetched_at: fetchedAt,
    cached,
    total_matching: json.hits?.total?.value ?? null,
    complaints: (json.hits?.hits || []).map((h) => ({
      id: h._source.complaint_id,
      date_received: h._source.date_received?.slice(0, 10),
      company: h._source.company,
      product: h._source.product,
      issue: h._source.issue,
      sub_issue: h._source.sub_issue,
      state: h._source.state,
      company_response: h._source.company_response,
      timely: h._source.timely,
    })),
  };
}

let tickerMap = null;
async function cikFor(ticker) {
  if (!tickerMap) {
    const { json } = await cachedJson('https://www.sec.gov/files/company_tickers.json', { ttlMs: 24 * 3600_000, headers: { 'user-agent': SEC_UA } });
    tickerMap = new Map(Object.values(json).map((r) => [r.ticker.toUpperCase(), { cik: r.cik_str, title: r.title }]));
  }
  return tickerMap.get(String(ticker).toUpperCase()) || null;
}

const CONCEPTS = [
  ['Revenues', 'USD'],
  ['RevenueFromContractWithCustomerExcludingAssessedTax', 'USD'],
  ['NetIncomeLoss', 'USD'],
  ['Assets', 'USD'],
  ['CashAndCashEquivalentsAtCarryingValue', 'USD'],
  ['ResearchAndDevelopmentExpense', 'USD'],
];

/** SEC EDGAR XBRL company facts: latest annual (10-K) values of headline concepts. */
export async function secFacts(q) {
  const ticker = (q.get('ticker') || 'AAPL').toUpperCase();
  const co = await cikFor(ticker);
  if (!co) throw Object.assign(new Error(`unknown ticker ${ticker}`), { status: 404 });
  const cik = String(co.cik).padStart(10, '0');
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  const { json, fetchedAt, cached } = await cachedJson(url, { ttlMs: 3600_000, headers: { 'user-agent': SEC_UA } });
  const gaap = json.facts?.['us-gaap'] || {};
  const facts = {};
  for (const [concept, unit] of CONCEPTS) {
    const rows = gaap[concept]?.units?.[unit];
    if (!rows) continue;
    const annual = rows.filter((r) => r.form === '10-K' && r.fp === 'FY' && r.frame && /^CY\d{4}$/.test(r.frame));
    const pick = (annual.length ? annual : rows.filter((r) => r.form === '10-K')).sort((a, b) => (a.end < b.end ? 1 : -1))[0];
    if (pick) facts[concept] = { value: pick.val, unit, period_end: pick.end, form: pick.form, filed: pick.filed, accession: pick.accn };
  }
  return {
    source: 'U.S. SEC EDGAR XBRL companyfacts API',
    source_url: url,
    fetched_at: fetchedAt,
    cached,
    ticker,
    cik,
    company: json.entityName || co.title,
    facts,
  };
}
