#!/usr/bin/env node
// Live-chain test for the NewKwLab Vercel AI SDK tools.
//
// Runs the tools against a gateway instance given by env vars (the test
// harness points this at a LOCAL instance of the production gateway code
// with a throwaway ledger — never at the production ledger):
//
//   NKW_BASE_URL   gateway base, e.g. http://127.0.0.1:<port>
//   NKW_API_KEY    trial key seeded with 1,000 credits
//
// Asserts the full chain through the tools: card_check charges exactly 1
// credit and returns a valid verdict, a malformed LEI lookup returns
// invalid_format and charges 0, and the /v1/usage ledger agrees with both.
// Usage rows are a LIST of {product_id, calls, charged, ...}.
//
// Usage:  NKW_BASE_URL=... NKW_API_KEY=... node test-live.mjs
// Exit:   0 = PASS, 1 = FAIL.

import { NewKwLabClient } from "../js-sdk/src/index.mjs";
import { createTools } from "./src/index.mjs";

const results = [];
function check(name, ok, detail = "") {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const row = (usage, productId) =>
  Array.isArray(usage?.usage_by_product)
    ? usage.usage_by_product.find((r) => r.product_id === productId) ?? null
    : null;

const EXEC_OPTS = { toolCallId: "live-test", messages: [] };

async function main() {
  const base = process.env.NKW_BASE_URL;
  const key = process.env.NKW_API_KEY;
  if (!base || !key) {
    console.error("LIVE TEST: FAIL — NKW_BASE_URL and NKW_API_KEY are required");
    process.exit(1);
  }
  const client = new NewKwLabClient({ apiKey: key, baseUrl: base });
  const tools = createTools({ client });

  const u0 = await client.usage();
  check("usage (before) balance = 1000", u0?.balance === 1000, `balance=${u0?.balance}`);

  // 1. card_check through the tool: real verdict, exactly 1 credit.
  const card = JSON.parse(
    await tools.card_check.execute({ number: "4242424242424242" }, EXEC_OPTS),
  );
  check(
    "tool card_check -> ok, valid=true, charged 1, balance 999",
    card.ok === true &&
      card.data?.valid === true &&
      card.credits_charged === 1 &&
      card.credits_balance === 999,
    JSON.stringify(card).slice(0, 200),
  );

  // 2. lei_lookup with a malformed LEI: not-found signal, 0 credits.
  const lei = JSON.parse(
    await tools.lei_lookup.execute({ lei: "984500ABCDEF12345678" }, EXEC_OPTS),
  );
  check(
    "tool lei_lookup (fake LEI) -> ok, status=invalid_format, charged 0",
    lei.ok === true && lei.data?.status === "invalid_format" && lei.credits_charged === 0,
    JSON.stringify(lei).slice(0, 200),
  );

  // 3. Ledger agrees: balance 999, per-product rows match the two calls.
  const u1 = await client.usage();
  const cardRow = row(u1, "cardcheck");
  const leiRow = row(u1, "leilookup");
  check(
    "usage (after card+lei) balance = 999, rows aligned",
    u1?.balance === 999 &&
      cardRow?.calls === 1 &&
      cardRow?.charged === 1 &&
      leiRow?.calls === 1 &&
      leiRow?.charged === 0 &&
      leiRow?.not_found === 1,
    `balance=${u1?.balance}, card=${JSON.stringify(cardRow)}, lei=${JSON.stringify(leiRow)}`,
  );

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(
    failed === 0
      ? `LIVE TEST: PASS (${results.length}/${results.length} assertions)`
      : `LIVE TEST: FAIL (${results.length - failed}/${results.length} assertions)`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("LIVE TEST: FAIL — harness error:", e);
  process.exit(1);
});
