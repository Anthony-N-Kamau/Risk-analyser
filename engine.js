/* Risk Analyser financial calculation engine. Deterministic, dependency-free, UMD (browser + Node).
   Version string is stored with every assessment so results can be reproduced. */
(function (root) {
  "use strict";
  var VERSION = "ra-engine 1.0.0";
  var ok = function (x) { return typeof x === "number" && isFinite(x); };

  /* ---------- core formulas ---------- */
  // NPV: flows[0] at t=0, flows[t] at end of period t, rate is per period (decimal).
  function npv(rate, flows) {
    if (!ok(rate) || rate <= -1) throw new Error("Invalid discount rate");
    var s = 0; for (var t = 0; t < flows.length; t++) s += flows[t] / Math.pow(1 + rate, t); return s;
  }
  // IRR (per period): scans for a sign change in NPV, then bisects. Returns {rate:null, reason} if none exists.
  function irr(flows) {
    var pos = flows.some(function (f) { return f > 0; }), neg = flows.some(function (f) { return f < 0; });
    if (!pos || !neg) return { rate: null, reason: "Cash flows never change sign, so no meaningful IRR exists." };
    var f = function (r) { return npv(r, flows); }, lo = -0.99, hi = null, prev = -0.99, fp = f(prev);
    for (var r = -0.9; r <= 100; r = r < 1 ? r + 0.01 : r * 1.2) {
      var fr = f(r);
      if (fp === 0) return { rate: prev, reason: "" };
      if (fp * fr < 0) { lo = prev; hi = r; break; }
      prev = r; fp = fr;
    }
    if (hi === null) return { rate: null, reason: "No IRR found in the range -99% to 10,000% per period." };
    for (var i = 0; i < 200; i++) { var mid = (lo + hi) / 2; if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid; }
    return { rate: (lo + hi) / 2, reason: "" };
  }
  var roi = function (invested, totalReturn) { if (!ok(invested) || invested <= 0) return null; return (totalReturn - invested) / invested; };
  var expectedLoss = function (items) { return items.reduce(function (s, x) { return s + x.p * x.loss; }, 0); }; // p as decimal
  var expectedCreditLoss = function (pd, lgd, ead) { // IFRS 9 style 12-month ECL = PD x LGD x EAD
    [pd, lgd].forEach(function (v) { if (!ok(v) || v < 0 || v > 1) throw new Error("PD and LGD must be between 0 and 1"); });
    if (!ok(ead) || ead < 0) throw new Error("EAD must be >= 0"); return pd * lgd * ead;
  };
  var annualToMonthly = function (a) { return Math.pow(1 + a, 1 / 12) - 1; };

  /* ---------- statistics ---------- */
  function percentile(sorted, q) { // linear interpolation between closest ranks
    if (!sorted.length) return null; var p = (sorted.length - 1) * q, i = Math.floor(p), w = p - i;
    return i + 1 < sorted.length ? sorted[i] * (1 - w) + sorted[i + 1] * w : sorted[i];
  }
  function invNorm(p) { // Acklam's rational approximation, abs error < 1.2e-9
    if (p <= 0 || p >= 1) throw new Error("p must be in (0,1)");
    var a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239],
      b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572],
      c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783],
      d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416], q, r;
    if (p < 0.02425) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - 0.02425) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  function rng(seed) { // mulberry32 + Box-Muller: same seed, same results
    var s = seed >>> 0, spare = null;
    var u = function () { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    var normal = function () { if (spare !== null) { var v = spare; spare = null; return v; } var a = u() || 1e-12, b = u(), m = Math.sqrt(-2 * Math.log(a)); spare = m * Math.sin(2 * Math.PI * b); return m * Math.cos(2 * Math.PI * b); };
    return { uniform: u, normal: normal };
  }
  // Value at Risk / Conditional VaR on a sample of outcomes (profit; negative = loss). Returned as positive loss amounts.
  function varCvar(outcomes, conf) {
    var s = Array.prototype.slice.call(outcomes).sort(function (a, b) { return a - b; }), q = percentile(s, 1 - conf), tail = s.filter(function (x) { return x <= q; });
    var cv = tail.reduce(function (a, b) { return a + b; }, 0) / tail.length;
    return { var: Math.max(0, -q), cvar: Math.max(0, -cv) };
  }
  var historicalVar = varCvar; // historical simulation = same estimator applied to observed returns/outcomes
  function parametricVar(mean, sd, conf) { // normal assumption
    var z = invNorm(conf), v = -(mean - z * sd), pdf = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
    return { var: Math.max(0, v), cvar: Math.max(0, -(mean - sd * pdf / (1 - conf))) };
  }

  /* ---------- cash flow projection ---------- */
  // inp: {cash0, invest, rev0, growth (per month, decimal), cost (per month), months, minCash, annualRate}
  // adj: {revMult, costMult, delay (months of zero revenue), rateShift (decimal)}
  function validate(inp) {
    var e = [];
    ["cash0", "invest", "rev0", "cost", "minCash"].forEach(function (k) { if (!ok(inp[k]) || inp[k] < 0) e.push(k + " must be a number >= 0"); });
    if (!ok(inp.growth) || inp.growth <= -1) e.push("growth must be greater than -100% per month");
    if (!(inp.months >= 1 && inp.months <= 60 && inp.months === Math.floor(inp.months))) e.push("months must be a whole number from 1 to 60");
    if (!ok(inp.annualRate) || inp.annualRate <= -1) e.push("annualRate must be greater than -100%");
    return e;
  }
  function project(inp, adj) {
    adj = adj || {}; var rm = adj.revMult == null ? 1 : adj.revMult, cm = adj.costMult == null ? 1 : adj.costMult, dl = adj.delay || 0, T = inp.months;
    var rev = [], cost = [], net = [], bal = [inp.cash0];
    for (var t = 1; t <= T; t++) {
      var r = t <= dl ? 0 : inp.rev0 * Math.pow(1 + inp.growth, t - dl - 1) * rm, c = inp.cost * cm;
      rev.push(r); cost.push(c); net.push(r - c); bal.push(bal[t - 1] + r - c);
    }
    var rate = annualToMonthly(inp.annualRate + (adj.rateShift || 0)), flows = [-inp.invest].concat(net);
    var cum = -inp.invest, be = null; for (var i = 0; i < T; i++) { cum += net[i]; if (be === null && cum >= 0) be = i + 1; }
    var minBal = Math.min.apply(null, bal), runway = null; for (var j = 1; j <= T; j++) if (bal[j] < 0) { runway = j - 1; break; }
    var burns = net.filter(function (x) { return x < 0; });
    var total = net.reduce(function (a, b) { return a + b; }, 0);
    return { rev: rev, cost: cost, net: net, bal: bal, npv: npv(rate, flows), irr: irr(flows), roi: roi(inp.invest, total), totalNet: total,
      outcome: total - inp.invest, breakEvenMonth: be, minBalance: minBal, runwayMonths: runway, // null = cash lasts beyond the horizon
      burnRate: burns.length ? -burns.reduce(function (a, b) { return a + b; }, 0) / burns.length : 0,
      shortfall: Math.max(0, inp.minCash - minBal), insolvent: minBal < 0 };
  }

  /* ---------- Monte Carlo ---------- */
  // Revenue and cost shocks are lognormal (mean-preserving) with correlation rho between them.
  function simulate(inp, o, adj) {
    o = o || {}; var n = o.n || 10000, seed = o.seed == null ? 12345 : o.seed, sr = o.sigmaRev == null ? 0.2 : o.sigmaRev, sc = o.sigmaCost == null ? 0.1 : o.sigmaCost, rho = o.rho == null ? 0 : o.rho;
    if (Math.abs(rho) > 1) throw new Error("rho must be between -1 and 1");
    adj = adj || {}; var rm = adj.revMult == null ? 1 : adj.revMult, cm = adj.costMult == null ? 1 : adj.costMult, dl = adj.delay || 0, g = rng(seed), T = inp.months;
    var out = new Float64Array(n), insolv = 0, a = Math.sqrt(1 - rho * rho);
    for (var k = 0; k < n; k++) {
      var cash = inp.cash0, minB = cash, tot = 0;
      for (var t = 1; t <= T; t++) {
        var z1 = g.normal(), z2 = rho * z1 + a * g.normal();
        var r = t <= dl ? 0 : inp.rev0 * Math.pow(1 + inp.growth, t - dl - 1) * rm * Math.exp(sr * z1 - sr * sr / 2), c = inp.cost * cm * Math.exp(sc * z2 - sc * sc / 2);
        cash += r - c; tot += r - c; if (cash < minB) minB = cash;
      }
      out[k] = tot - inp.invest; if (minB < 0) insolv++;
    }
    return { outcomes: out, insolvent: insolv, n: n, seed: seed };
  }
  function summarise(sim, confs) {
    var s = Array.prototype.slice.call(sim.outcomes).sort(function (a, b) { return a - b; }), n = s.length, mean = s.reduce(function (a, b) { return a + b; }, 0) / n;
    var sd = Math.sqrt(s.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (n - 1)), pl = s.filter(function (x) { return x < 0; }).length / n, pi = sim.insolvent / n, res = {};
    (confs || [0.95, 0.975, 0.99]).forEach(function (c) { res[c] = { mc: varCvar(s, c), parametric: parametricVar(mean, sd, c) }; });
    var z = 1.96, se = function (p) { return z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n); }; // Wilson half-width, stays > 0 at p = 0 or 1
    return { n: n, seed: sim.seed, mean: mean, median: percentile(s, 0.5), p5: percentile(s, 0.05), p95: percentile(s, 0.95), best: s[n - 1], worst: s[0], sd: sd,
      pLoss: pl, pLossCI: se(pl), pInsolvency: pi, pInsolvencyCI: se(pi), risk: res, sorted: s };
  }
  function histogram(sorted, bins) {
    var lo = sorted[0], hi = sorted[sorted.length - 1], w = (hi - lo) / bins || 1, c = new Array(bins).fill(0);
    sorted.forEach(function (x) { var i = Math.min(bins - 1, Math.floor((x - lo) / w)); c[i]++; });
    return { lo: lo, width: w, counts: c };
  }

  /* ---------- sensitivity and scenarios ---------- */
  function tornado(inp, delta) { // one-at-a-time change of each driver, measured on NPV
    delta = delta || 0.1; var base = project(inp).npv, rows = [];
    var add = function (label, lowAdj, highAdj, lowI, highI) { var l = project(lowI || inp, lowAdj).npv, h = project(highI || inp, highAdj).npv; rows.push({ label: label, low: Math.min(l, h), high: Math.max(l, h), swing: Math.abs(h - l) }); };
    add("Revenue ±" + delta * 100 + "%", { revMult: 1 - delta }, { revMult: 1 + delta });
    add("Operating costs ±" + delta * 100 + "%", { costMult: 1 + delta }, { costMult: 1 - delta });
    add("Monthly revenue growth ±2 pts", null, null, Object.assign({}, inp, { growth: inp.growth - 0.02 }), Object.assign({}, inp, { growth: inp.growth + 0.02 }));
    add("Discount rate ±2 pts", { rateShift: 0.02 }, { rateShift: -0.02 });
    add("Launch delayed 3 months", { delay: 3 }, { delay: 0 });
    return { base: base, rows: rows.sort(function (a, b) { return b.swing - a.swing; }) };
  }
  var SCENARIOS = { // illustrative defaults, editable by the user
    optimistic: { label: "Optimistic", adj: { revMult: 1.15, costMult: 0.9, delay: 0, rateShift: -0.01 } },
    base: { label: "Base", adj: { revMult: 1, costMult: 1, delay: 0, rateShift: 0 } },
    pessimistic: { label: "Pessimistic", adj: { revMult: 0.8, costMult: 1.15, delay: 3, rateShift: 0.02 } }
  };

  root.RAEngine = { VERSION: VERSION, npv: npv, irr: irr, roi: roi, expectedLoss: expectedLoss, expectedCreditLoss: expectedCreditLoss, annualToMonthly: annualToMonthly,
    percentile: percentile, invNorm: invNorm, rng: rng, varCvar: varCvar, historicalVar: historicalVar, parametricVar: parametricVar, validate: validate, project: project,
    simulate: simulate, summarise: summarise, histogram: histogram, tornado: tornado, SCENARIOS: SCENARIOS };
  if (typeof module !== "undefined" && module.exports) module.exports = root.RAEngine;
})(typeof window !== "undefined" ? window : globalThis);
