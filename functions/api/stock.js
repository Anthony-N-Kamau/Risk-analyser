// Cloudflare Pages Function: GET /api/stock
//   /api/stock?q=apple        -> company search
//   /api/stock?symbol=AAPL    -> company figures mapped to the Equity analyser fields (amounts in millions)
// Needs a secret named FMP_API_KEY (Cloudflare Pages > Settings > Variables and Secrets).
const BASE = "https://financialmodelingprep.com/stable/";

export async function onRequestGet({ request, env }) {
  const json = (o, s = 200, cache = "no-store") =>
    new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": cache } });

  if (request.headers.get("Sec-Fetch-Site") === "cross-site") return json({ error: "forbidden" }, 403);
  if (!env.FMP_API_KEY) return json({ error: "not_configured" }, 503);

  const u = new URL(request.url);
  const q = (u.searchParams.get("q") || "").trim();
  const sym = (u.searchParams.get("symbol") || "").trim().toUpperCase();

  const get = async (path, params) => {
    const r = await fetch(BASE + path + "?" + new URLSearchParams({ ...params, apikey: env.FMP_API_KEY }));
    if (r.status === 429) throw new Error("rate_limited");
    if (r.status === 401 || r.status === 403) throw new Error("key_rejected");
    if (r.status === 402) throw new Error("plan_limit");
    if (!r.ok) throw new Error("upstream_" + r.status);
    const d = await r.json();
    if (!Array.isArray(d)) {
      const m = String((d && (d["Error Message"] || d.message)) || "");
      if (/limit/i.test(m)) throw new Error("rate_limited");
      if (/api.?key|invalid/i.test(m)) throw new Error("key_rejected");
      if (/subscription|plan|premium|upgrade/i.test(m)) throw new Error("plan_limit");
      throw new Error("bad_response");
    }
    return d;
  };
  const fail = (e) => {
    const c = e && e.message ? e.message : "error";
    const known = { rate_limited: 429, key_rejected: 502, plan_limit: 502, bad_response: 502 };
    return json({ error: known[c] ? c : c.startsWith("upstream_") ? c : "error" }, known[c] || 502);
  };

  try {
    if (q) {
      if (q.length < 2 || q.length > 40) return json({ error: "bad_request" }, 400);
      const d = await get("search-symbol", { query: q, limit: 10 });
      const results = d.filter((x) => x && x.symbol && x.name).slice(0, 10).map((x) => ({
        symbol: String(x.symbol), name: String(x.name), exchange: String(x.exchange || x.exchangeFullName || ""), currency: String(x.currency || ""),
      }));
      return json({ results }, 200, "public, max-age=86400");
    }

    if (!/^[A-Z0-9.\-^]{1,12}$/.test(sym)) return json({ error: "bad_request" }, 400);
    const opt = (p) => p.catch(() => []);
    const [quote, profile, inc, bal, cf] = await Promise.all([
      get("quote", { symbol: sym }),
      opt(get("profile", { symbol: sym })),
      get("income-statement", { symbol: sym, period: "annual", limit: 2 }),
      get("balance-sheet-statement", { symbol: sym, period: "annual", limit: 1 }),
      get("cash-flow-statement", { symbol: sym, period: "annual", limit: 1 }),
    ]);
    const q0 = quote[0] || {}, p0 = profile[0] || {}, i0 = inc[0], i1 = inc[1] || {}, b0 = bal[0] || {}, c0 = cf[0] || {};
    const num = (x) => (typeof x === "number" && isFinite(x) ? x : null);
    const price = num(q0.price);
    if (!price || !i0) return json({ error: "no_data" }, 404);
    const mcap = num(q0.marketCap) || num(p0.marketCap);
    const sharesAbs = mcap ? mcap / price : num(i0.weightedAverageShsOut);
    const M = (x) => { x = num(x); return x === null ? null : Math.round((x / 1e6) * 100) / 100; };
    const first = (...v) => { for (const x of v) if (num(x) !== null) return num(x); return null; };
    const paid = [c0.commonDividendsPaid, c0.netDividendsPaid, c0.dividendsPaid].map(num).find((x) => x !== null && x !== 0);
    const dps = paid && sharesAbs ? Math.abs(paid) / sharesAbs : first(p0.lastDividend, 0);
    const debt = first(b0.totalDebt, (num(b0.shortTermDebt) || 0) + (num(b0.longTermDebt) || 0) || null);
    const fields = {
      price, shares: sharesAbs ? Math.round((sharesAbs / 1e6) * 100) / 100 : null, dps: dps === null ? 0 : Math.round(dps * 10000) / 10000,
      rev: M(i0.revenue), gp: M(i0.grossProfit), ebit: M(i0.operatingIncome), ebitda: M(i0.ebitda),
      intexp: M(num(i0.interestExpense) === null ? null : Math.abs(i0.interestExpense)), ni: M(i0.netIncome),
      rev0: M(i1.revenue), ni0: M(i1.netIncome),
      ta: M(b0.totalAssets), ca: M(b0.totalCurrentAssets), cl: M(b0.totalCurrentLiabilities), inv: M(b0.inventory),
      cash: M(first(b0.cashAndShortTermInvestments, b0.cashAndCashEquivalents)), debt: M(debt), eq: M(b0.totalStockholdersEquity),
      ocf: M(first(c0.operatingCashFlow, c0.netCashProvidedByOperatingActivities)),
      capex: M(num(first(c0.capitalExpenditure, c0.investmentsInPropertyPlantAndEquipment)) === null ? null : Math.abs(first(c0.capitalExpenditure, c0.investmentsInPropertyPlantAndEquipment))),
    };
    return json({
      symbol: sym, name: q0.name || p0.companyName || sym, exchange: q0.exchange || p0.exchange || "", currency: p0.currency || null,
      reportedCurrency: i0.reportedCurrency || null, sector: p0.sector || null, industry: p0.industry || null,
      fiscalYearEnd: i0.date || null, fiscalYear: i0.fiscalYear || null, dpsEstimated: !!(paid && sharesAbs), fields,
      source: "Financial Modeling Prep",
    }, 200, "public, max-age=900");
  } catch (e) {
    return fail(e);
  }
}
