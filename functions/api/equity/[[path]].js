import directory from '../../_data/sec-listings.json' with { type: 'json' };

const SEC = 'https://data.sec.gov/submissions/';
const FMP = 'https://financialmodelingprep.com/stable/news/stock';
const SYMBOL = /^[A-Z0-9][A-Z0-9.-]{0,19}$/;
const QUERY = /^[\p{L}\p{M}\p{N} .,&'’/()-]+$/u;
const FORMS = /^(8-K|6-K|10-Q|10-K|20-F|40-F)(\/A)?$/;
const clean = (s, max) => typeof s === 'string' ? s.replace(/\s+/gu, ' ').trim().slice(0, max) : '';
const normalize = s => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const tickerKey = s => s.toUpperCase().replace(/\./g, '-');
const listings = directory.data.map(([cik, name, symbol, exchange]) => ({
  cik: String(cik).padStart(10, '0'), name, symbol, exchange, normal: normalize(name),
}));
const bySymbol = new Map(listings.filter(r => SYMBOL.test(r.symbol)).map(r => [tickerKey(r.symbol), r]));
const day = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const httpsUrl = value => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && u.href.length <= 1600 ? u.href : '';
  } catch { return ''; }
};
const json = (body, status = 200, extra = {}) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
});

function search(q) {
  const term = normalize(q);
  const symbol = tickerKey(q);
  const candidates = [];
  for (const r of listings) {
    if (!SYMBOL.test(r.symbol)) continue;
    const displayTicker = tickerKey(r.symbol);
    const index = r.normal.indexOf(term);
    const rank = displayTicker === symbol ? 0 : r.normal === term ? 1 :
      index === 0 ? 2 : displayTicker.startsWith(symbol) ? 3 :
      index > 0 && /[\s(.-]/.test(r.normal[index - 1]) ? 4 : index >= 0 ? 5 : Infinity;
    if (Number.isFinite(rank)) candidates.push({ r, rank });
  }
  return candidates.sort((a, b) => a.rank - b.rank || a.r.symbol.localeCompare(b.r.symbol))
    .slice(0, 8).map(({ r: { name, symbol, exchange } }) => ({ name, symbol, exchange }));
}

async function readJson(fetchImpl, url, headers) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(7000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('Upstream not available');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_500_000) { await reader.cancel(); throw new Error('Oversize upstream response'); }
      body += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(body + decoder.decode());
}

function secIndex(cik) { return `https://www.sec.gov/edgar/browse/?CIK=${cik}`; }

function secItems(raw, listing, now) {
  const recent = raw?.filings?.recent;
  if (!recent || Number(raw.cik) !== Number(listing.cik) ||
      !['form', 'filingDate', 'accessionNumber', 'primaryDocument'].every(k => Array.isArray(recent[k]))) {
    throw new Error('Unexpected SEC response');
  }
  const items = [];
  const seen = new Set();
  for (let i = 0; i < recent.form.length; i += 1) {
    const form = recent.form[i], date = recent.filingDate[i], acc = recent.accessionNumber[i];
    const doc = recent.primaryDocument[i];
    const age = now - Date.parse(date);
    if (!FORMS.test(form || '') || !day(date) || age < -86_400_000 || age > 366 * 86_400_000 ||
        !/^\d{10}-\d{2}-\d{6}$/.test(acc || '') || !/^[\w.-]+\.html?$/i.test(doc || '') || seen.has(acc)) continue;
    const group = form.split('/')[0];
    const type = ({ '8-K': 'Current report', '6-K': 'Foreign issuer report', '10-Q': 'Quarterly report',
      '10-K': 'Annual report', '20-F': 'Annual report', '40-F': 'Annual report' })[group];
    const url = `https://www.sec.gov/Archives/edgar/data/${Number(listing.cik)}/${acc.replaceAll('-', '')}/${acc}-index.htm`;
    items.push({ title: `${type} (Form ${form})`, url, date, form, publisher: 'SEC EDGAR' });
    seen.add(acc);
  }
  return items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
}

function pressItems(raw, symbol, now) {
  if (!Array.isArray(raw)) throw new Error('Unexpected press response');
  const best = new Map();
  for (const row of raw) {
    if (!row || typeof row.symbol !== 'string' ||
        !row.symbol.split(/[,;\s]+/).some(s => tickerKey(s) === tickerKey(symbol))) continue;
    const title = clean(row.title, 320), url = httpsUrl(row.url);
    const stamp = clean(row.publishedDate, 40);
    const date = stamp.slice(0, 10);
    const timestamp = Date.parse(stamp.replace(' ', 'T') +
      (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(stamp.replace(' ', 'T')) ? 'Z' : ''));
    if (!title || !url || !day(date) || !Number.isFinite(timestamp) ||
        timestamp > now + 86_400_000 || now - timestamp > 90 * 86_400_000) continue;
    const publisher = clean(row.publisher, 90) || clean(row.site, 90) || new URL(url).hostname;
    const canonical = new URL(url);
    canonical.search = ''; canonical.hash = '';
    const entry = { title, url, publisher, date, timestamp };
    const key = canonical.href;
    if (!best.has(key) || best.get(key).timestamp < timestamp) best.set(key, entry);
  }
  return [...best.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 8)
    .map(({ timestamp, ...entry }) => entry);
}

async function stored(cache, context, feed, symbol, ttl, run) {
  const cacheKey = new Request(new URL(`/api/equity/news/${symbol}?__ketonda_v1=${feed}`, context.request.url));
  if (cache) {
    try { const hit = await cache.match(cacheKey); if (hit) return await hit.json(); } catch { /* cache miss */ }
  }
  const result = await run();
  if (cache) {
    const write = cache.put(cacheKey, json(result, 200, { 'Cache-Control': `public, max-age=${ttl}` })).catch(() => {});
    if (context.waitUntil) context.waitUntil(write);
    else await write;
  }
  return result;
}

async function loadFeed(enabled, cache, context, feed, id, ttl, fetchItems) {
  if (!enabled) return { status: 'disabled', items: [] };
  try {
    const items = await stored(cache, context, feed, id, ttl, fetchItems);
    return { status: items.length ? 'ok' : 'empty', items };
  } catch { return { status: 'unavailable', items: [] }; }
}

export async function handleEquity(context, opts = {}) {
  const { request, env = {} } = context;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const cache = opts.cache === undefined ? globalThis.caches?.default : opts.cache;
  const now = opts.now ?? Date.now();
  if (request.method !== 'GET') return json({ detail: 'Use GET for this endpoint.' }, 405, { Allow: 'GET' });
  const path = Array.isArray(context.params.path) ? context.params.path : [context.params.path];
  const [route, rawSymbol] = path;
  if (route === 'health' && path.length === 1) {
    return json({ status: 'ok', directory: 'SEC EDGAR', snapshot: directory.snapshot });
  }
  if (route === 'search' && path.length === 1) {
    const params = new URL(request.url).searchParams;
    const q = (params.get('q') || '').normalize('NFC').trim().replace(/\s+/gu, ' ');
    if (params.getAll('q').length !== 1 || q.length < 1 || q.length > 80 || !QUERY.test(q)) {
      return json({ detail: 'Enter a company name or ticker (up to 80 characters).' }, 400);
    }
    return json({ results: search(q), source: 'SEC EDGAR', snapshot: directory.snapshot });
  }
  if (route !== 'news' || path.length !== 2) return json({ detail: 'Not found.' }, 404);
  const symbol = String(rawSymbol).toUpperCase();
  if (!SYMBOL.test(symbol)) return json({ detail: 'That ticker format is not supported.' }, 400);
  const listing = bySymbol.get(tickerKey(symbol));
  if (!listing) return json({ detail: 'This listing was not found in the SEC directory.' }, 404);
  const userAgent = env.SEC_USER_AGENT?.trim();
  const key = env.FMP_API_KEY?.trim();
  const secReady = !!(userAgent && /\S+@\S+\.\S+/.test(userAgent) && !/example\.(com|org|net)\b/i.test(userAgent));
  const pressReady = env.FMP_PUBLIC_NEWS === 'true' && !!key;
  const [filings, press] = await Promise.all([
    loadFeed(secReady, cache, context, 'sec', listing.cik, 600,
      async () => secItems(await readJson(fetchImpl, `${SEC}CIK${listing.cik}.json`, { 'User-Agent': userAgent }), listing, now)),
    loadFeed(pressReady, cache, context, 'fmp', listing.symbol, 300, async () => {
      const url = new URL(FMP);
      url.search = new URLSearchParams({ symbols: listing.symbol, page: '0', limit: '20', apikey: key });
      return pressItems(await readJson(fetchImpl, url), listing.symbol, now);
    }),
  ]);
  return json({ symbol: listing.symbol, company: listing.name, exchange: listing.exchange,
    filings: filings.items, filingsStatus: filings.status, filingsUrl: secIndex(listing.cik),
    articles: press.items, pressStatus: press.status, retrievedAt: new Date(now).toISOString() });
}

export const onRequest = context => handleEquity(context);
