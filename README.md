# Risk Analyser

**An AI-assisted web app that gives a clear overview and assessment of the risks in any plan or decision.**

Live site: https://risk-analyser.pages.dev/

**Status:** In active development. The current version works end to end, but it relies on AI-generated estimates. 

**Where this is heading:** Eventually the goal is to pair a top financial reasoning model with code execution, so that code handles the math while the AI handles scenario parsing and mitigation planning. These plans are underway.

**Knowledge cutoffs.** Most models used in this website are outdated in terms of knowledge, with some having a knowledge cutoff as early as December 2023. Results may therefore not reflect recent events, regulations or market conditions.

**Consistency.** For more consistent answers, we have lowered the temperature to around 0.2 to 0.4.



## Aim

Risk Analyser helps people think through what could go wrong before they commit time or money. A user describes a plan in plain language, such as starting a business, moving abroad, or making an investment, and the site returns a structured risk overview and assessment:

- which risks apply to the plan,
- how likely each one is and how much it could cost,
- how serious the risks are overall,
- and what could be done to reduce each one.

The goal is to make risk thinking accessible to non-specialists while keeping the output structured enough to support real business and financial decisions.

## Features

- **Scenario input** in plain language, with optional financial parameters: capital and currency (any current ISO currency), timeline, industry sector and country (searchable lists).
- **Ranked risk ledger** with category (Financial, Operational, Market, Regulatory), severity, probability, estimated impact, root cause, mitigation strategy and metrics to watch.
- **Overall risk score and classification** (Low, Moderate, Elevated, Critical), with an estimated capital-at-risk range.
- **Visual dashboard**: probability and impact risk matrix, exposure by category and breakeven sensitivity.
- **Stress testing**: re-scores the same risks under optimistic and downside conditions, without changing the original analysis.
- **Saved scenarios**, stored locally in the browser, that can be opened, renamed, duplicated, deleted and compared side by side.
- **Reports**: export or print a report to PDF, or copy it as Markdown.
- **Learn**, **Methodology**, **Help** and **Settings** pages, and a light and dark theme.
- **Risk Intelligence** section, marked "Soon" (see the roadmap).

## How it works

```
Browser (static site)  ──POST /api/analyse──▶  Cloudflare Pages Function  ──▶  Cloudflare Workers AI
 index.html                                     functions/api/analyse.js          (language model)
 scoring, charts, saved scenarios               validation, prompting,
 run in the browser                             model fallback, output cleaning
```

1. The user's description and parameters are sent to a serverless function.
2. The function prompts a language model to identify 7 to 9 risks, each with a category, a probability, an impact, a root cause, a mitigation and metrics to watch.
3. The function validates the response, clamps the numbers to allowed ranges, normalises the categories and returns clean JSON.
4. The browser calculates the score, classification and charts from those values, so the scoring logic is fixed and transparent.

No API key appears in the front-end code. The AI is reached through a server-side Cloudflare binding.

### Model fallback

The function does not depend on a single model. It tries models in order and uses the first one that returns a usable result:

| Priority | Model |
|---|---|
| 1 | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| 2 | `@cf/meta/llama-3.1-8b-instruct-fp8` |
| 3 | `@cf/meta/llama-3.2-3b-instruct` |

A model is skipped if it errors, is unavailable or deprecated, or returns output that cannot be parsed into the expected structure. If all three fail, the user sees a clear error message and nothing is saved. This keeps the site working when a provider retires or changes a model.

### Scoring method

| Step | Rule |
|---|---|
| Exposure of a risk | probability × impact ÷ 100 |
| Severity of a risk | High at 10 or more, Medium at 4 or more, otherwise Low |
| Overall score | sum of exposures, rounded and capped at 100 |
| Classification | Low below 20, Moderate below 45, Elevated below 70, Critical at 70 or more |

Probability is an AI estimate from 1% to 99%. Impact is an AI estimate from 1% to 60% of starting capital lost if the risk occurs. The full methodology is also available on the site's Methodology page.

## Tech stack

- HTML, CSS and vanilla JavaScript (no build step, no framework)
- SVG charts drawn in the browser
- Cloudflare Pages (hosting and continuous deployment from this repository)
- Cloudflare Pages Functions (serverless API)
- Cloudflare Workers AI (language models)
- Browser local storage for saved scenarios and preferences

## Repository structure

```
.
├── index.html                 # the whole front end
└── functions/
    └── api/
        └── analyse.js         # serverless function: prompting, model fallback, validation
```

## Deployment

1. Push this repository to GitHub.
2. In Cloudflare, create a **Pages** project and connect the repository. Leave the build command and output directory empty.
3. In the project's **Settings**, add a **Workers AI** binding with the variable name `AI`.
4. Redeploy. Every later push to the `main` branch deploys automatically.

## Roadmap

Risk Analyser is still being developed. Planned improvements:

- **Real-time and official data.** Today the assessment relies on AI-generated responses. The aim is to ground it in sourced, dated data (for example inflation, interest rates, growth and exchange rates by country) and to build out the Risk Intelligence section, with every figure showing its source.
- **Interactive chatbot.** An assistant that answers users' questions about their results, their risks and how the platform works.
- **In-depth quantitative risk modelling.** Assessing each risk in more depth with quantitative methods such as Monte Carlo simulation, to move beyond single-point AI estimates to ranges and probabilities.
- **Design upgrades.** Continued improvements to the layout, visuals and overall user experience.

## Limitations and responsible use

- Probabilities, impacts and explanations are **AI-generated estimates**, not measured data. Running the same scenario twice can give different results.
- Risks overlap and often occur together, so the overall score is a rough warning level, not a forecast.
- The AI can miss risks or be wrong, especially for specific places and situations.
- Amounts in different currencies are not converted.
- This tool supports thinking and discussion. It is **not financial, legal or investment advice**. Check important decisions with qualified professionals.
