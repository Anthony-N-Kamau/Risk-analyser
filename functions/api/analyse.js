export async function onRequestPost({ request, env }) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  let scenario = "";
  try {
    const body = await request.json();
    scenario = String(body.scenario || "").trim();
  } catch (e) {
    return json({ error: "Invalid request." }, 400);
  }
  if (!scenario) return json({ error: "Please enter a scenario." }, 400);
  if (scenario.length > 1000) return json({ error: "Scenario is too long." }, 400);

  const categories = "Market risk, Credit risk, Liquidity risk, Operational risk, Interest rate risk, Inflation risk, Currency (exchange rate) risk, Political and regulatory risk, Reinvestment risk, Systemic risk, Non-systemic risk, Counterparty risk, Model risk, Settlement risk, Sovereign risk, Legal risk, Strategic risk, Reputational risk, Technology (cyber) risk, Commodity price risk";

  const system =
    "You are a risk analyst. Return ONLY valid JSON, with no markdown and no extra text, in this shape: " +
    '{"summary":"2 sentences","risks":[{"category":"","severity":"High|Medium|Low","explanation":"1-2 sentences specific to the scenario","example":"one concrete way it could happen","mitigation":"one practical step"}]}. ' +
    "Give 6 to 8 risks, most relevant first, in plain language for a beginner. " +
    "Use only risks that genuinely apply. Starting list of categories: " + categories +
    ". You may add others such as health, safety or personal risk when relevant.";

  // Models are tried in order; the first one that works is used.
  const models = [
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "@cf/meta/llama-3.1-8b-instruct-fp8",
    "@cf/meta/llama-3.2-3b-instruct",
  ];

  let lastError = "";
  for (const model of models) {
    try {
      const result = await env.AI.run(model, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: "Scenario: " + scenario },
        ],
        max_tokens: 1800,
      });

      let raw = result.response;
      if (raw === undefined || raw === null) {
        raw = result.choices && result.choices[0] && result.choices[0].message
          ? result.choices[0].message.content
          : "";
      }
      if (raw && typeof raw === "object") return json(raw);
      raw = String(raw || "");
      const a = raw.indexOf("{");
      const b = raw.lastIndexOf("}");
      if (a === -1 || b === -1) throw new Error("No JSON found in reply");
      return json(JSON.parse(raw.slice(a, b + 1)));
    } catch (e) {
      lastError = model + ": " + (e && e.message ? e.message : String(e));
    }
  }
  return json({ error: "The analysis failed: " + lastError }, 500)
}
