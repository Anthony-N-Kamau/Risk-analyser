export async function onRequestPost({ request, env }) {
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  let scenario = "", params = {};
  try {
    const b = await request.json();
    scenario = String(b.scenario || "").trim();
    params = b.params || {};
  } catch (e) { return json({ error: "Invalid request." }, 400); }
  if (!scenario) return json({ error: "Please enter a scenario." }, 400);
  if (scenario.length > 1000) return json({ error: "Scenario is too long." }, 400);

  const clean = (v) => String(v || "").slice(0, 80).trim();
  const ctx = [
    params.capital ? "Capital available: " + (/^[A-Z]{3}$/.test(String(params.currency || "")) ? params.currency : "USD") + " " + Number(params.capital) : "",
    clean(params.timeline) && "Target timeline: " + clean(params.timeline),
    clean(params.sector) && "Industry sector: " + clean(params.sector),
    clean(params.region) && "Country: " + clean(params.region),
  ].filter(Boolean).join("; ");

  const system =
    "You are a financial risk analyst. Return ONLY valid JSON, no markdown, in exactly this shape: " +
    '{"summary":"2 sentences","breakeven":{"sensitivity":"Low|Medium|High","note":"one short sentence"},' +
    '"risks":[{"factor":"short name","group":"Financial|Operational|Market|Regulatory","probability":0,"impact":0,' +
    '"root_cause":"1-2 sentences","mitigation":"1-2 sentences","metrics":["metric to watch","metric to watch"]}]}. ' +
    "Give 7 to 9 risks. probability is an integer 1-99 (chance it occurs). impact is an integer 1-60 (percent of starting capital lost if it occurs). " +
    "Financial = cash flow, capital, credit, liquidity. Operational = supply chain, execution, technology. Market = demand, competition, pricing. Regulatory = legal, compliance, tax. " +
    "Be specific to the scenario, use plain language, and keep every text field short.";

  const models = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fp8", "@cf/meta/llama-3.2-3b-instruct"];
  const num = (v, lo, hi, d) => { v = Number(v); return isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d; };
  const txt = (v, n = 400) => String(v || "").slice(0, n);
  const grp = (s) => {
    s = String(s || "").toLowerCase();
    if (/reg|legal|compl|tax|licen|privacy|law/.test(s)) return "Regulatory";
    if (/fin|cash|capital|credit|liquid|debt|fund|interest/.test(s)) return "Financial";
    if (/market|compet|demand|brand|customer|price|econom|inflat|currency/.test(s)) return "Market";
    return "Operational";
  };

  let last = "";
  for (const model of models) {
    try {
      const r = await env.AI.run(model, {
        messages: [{ role: "system", content: system }, { role: "user", content: "Scenario: " + scenario + (ctx ? "\nContext: " + ctx : "") }],
        max_tokens: 2600,
      });
      let raw = r.response;
      if (raw === undefined || raw === null) raw = r.choices && r.choices[0] && r.choices[0].message ? r.choices[0].message.content : "";
      let d = raw && typeof raw === "object" ? raw : null;
      if (!d) { raw = String(raw || ""); const a = raw.indexOf("{"), b = raw.lastIndexOf("}"); if (a < 0 || b < 0) throw new Error("No JSON found"); d = JSON.parse(raw.slice(a, b + 1)); }
      const risks = (Array.isArray(d.risks) ? d.risks : []).slice(0, 10).map((x) => ({
        factor: txt(x.factor || x.category, 80) || "Risk",
        group: grp(x.group || x.category),
        probability: num(x.probability, 1, 99, 40),
        impact: num(x.impact, 1, 60, 10),
        root_cause: txt(x.root_cause || x.explanation),
        mitigation: txt(x.mitigation),
        metrics: (Array.isArray(x.metrics) ? x.metrics : [x.metrics]).filter(Boolean).slice(0, 3).map((m) => txt(m, 80)),
      }));
      if (risks.length < 3) throw new Error("Too few risks returned");
      const s = String((d.breakeven && d.breakeven.sensitivity) || "").toLowerCase();
      return json({
        summary: txt(d.summary, 500),
        breakeven: { sensitivity: s.startsWith("h") ? "High" : s.startsWith("l") ? "Low" : "Medium", note: txt(d.breakeven && d.breakeven.note, 200) },
        risks,
      });
    } catch (e) { last = model + ": " + (e && e.message ? e.message : String(e)); }
  }
  return json({ error: "The analysis failed: " + last }, 500);
}
