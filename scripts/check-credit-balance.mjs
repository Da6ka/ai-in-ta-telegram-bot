// Pre-flight check for the ANTHROPIC_API_KEY credit balance, run before the
// real (WebSearch-driven, multi-dollar) generation step. There is no Anthropic
// API endpoint that reports remaining credit balance directly -- the only way
// to observe it is a request that would actually be billed. This makes the
// cheapest possible one (Haiku, max_tokens: 1, no tools) and inspects the
// error type rather than guessing from the workflow's eventual "credit balance
// is too low" stdout, which only surfaced after the 2-attempt retry loop and a
// multi-dollar WebSearch generation had already been attempted and burned time.
//
// Only the specific low-balance condition sets `low_balance=true` -- any other
// failure (rate limit, network blip, model hiccup) is logged but not treated
// as a balance problem, so this can't false-negative-block a real generation
// attempt over an unrelated transient error.
import { appendFileSync } from "node:fs";

const { ANTHROPIC_API_KEY } = process.env;

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");

let res;
try {
  res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
} catch (err) {
  console.log(
    `Balance precheck request failed to send (${err.message}) -- not blocking on this; the real generation step will surface whatever's actually wrong.`,
  );
  setOutput("low_balance", "false");
  process.exit(0);
}

if (res.ok) {
  console.log("Balance precheck OK.");
  setOutput("low_balance", "false");
  process.exit(0);
}

const body = await res.text();
if (/credit balance is too low/i.test(body)) {
  console.log(
    `Anthropic API credit balance is too low (HTTP ${res.status}):\n${body}`,
  );
  setOutput("low_balance", "true");
} else {
  console.log(
    `Balance precheck got an unrelated error (HTTP ${res.status}) -- not blocking on this; the real generation step will surface it:\n${body}`,
  );
  setOutput("low_balance", "false");
}
