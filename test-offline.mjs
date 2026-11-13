#!/usr/bin/env node
// Offline smoke test for the NewKwLab Vercel AI SDK tools.
//
// No network: a stub SDK client records every call, so the test asserts the
// tool surface (names, descriptions, zod input schemas), the routing into
// the client (which method / product / endpoint / params each tool uses),
// and both execute() return shapes (success + gateway error + local misuse)
// without touching the gateway.
//
// Requires the peer deps to be installed somewhere Node can resolve them
// from this package (npm install ai zod in a scratch copy — see
// checks-vercel.md). Usage: node test-offline.mjs
// Exit: 0 = PASS, 1 = FAIL.

import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { GatewayError, NewKwLabClient } from "../js-sdk/src/index.mjs";
import { TOOL_NAMES, createTools } from "./src/index.mjs";

const results = [];
function check(name, ok, detail = "") {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// -- Stub client: same method surface as NewKwLabClient, records calls ------

function makeStub(behavior = "ok") {
  const calls = [];
  const canned = (method) => async (...args) => {
    calls.push([method, ...args]);
    if (behavior === "gateway-error") {
      throw new GatewayError(402, "INSUFFICIENT_CREDITS", "Balance below price.");
    }
    if (behavior === "client-error") {
      throw new Error("An API key is required for this call — pass { apiKey } or set NKW_API_KEY.");
    }
    return {
      data: { stub: true },
      creditsCharged: 1,
      creditsBalance: 999,
      cache: "MISS",
    };
  };
  return {
    calls,
    client: {
      emailCheck: canned("emailCheck"),
      phoneCheck: canned("phoneCheck"),
      cardCheck: canned("cardCheck"),
      call: canned("call"),
    },
  };
}

const EXPECTED_FIELDS = {
  email_check: ["email"],
  phone_check: ["phone"],
  card_check: ["number"],
  lei_lookup: ["lei"],
  airport_lookup: ["code"],
  sanctions_screen: ["name"],
};

const SAMPLE_ARGS = {
  email_check: { email: "alice@example.com" },
  phone_check: { phone: "+14155552671" },
  card_check: { number: "4242424242424242" },
  lei_lookup: { lei: "984500ABCDEF12345678" },
  airport_lookup: { code: "LAX" },
  sanctions_screen: { name: "Test Person" },
};

const EXPECTED_ROUTES = {
  email_check: ["emailCheck", "alice@example.com"],
  phone_check: ["phoneCheck", "+14155552671"],
  card_check: ["cardCheck", "4242424242424242"],
  lei_lookup: ["call", "leilookup", "/lei/984500ABCDEF12345678"],
  airport_lookup: ["call", "airportbase", "/airport", { params: { code: "LAX" } }],
  sanctions_screen: ["call", "sanctionscreen", "/screen", { params: { name: "Test Person" } }],
};

const EXEC_OPTS = { toolCallId: "offline-smoke", messages: [] };

function schemaFields(schema) {
  // zod object schemas expose .shape in both zod v3 and v4.
  return Object.keys(schema?.shape ?? {}).sort();
}

async function main() {
  // The factory must also work with a real client (no stub-only shortcuts).
  check(
    "real NewKwLabClient exposes the methods the tools depend on",
    ["emailCheck", "phoneCheck", "cardCheck", "call"].every(
      (m) => typeof NewKwLabClient.prototype[m] === "function",
    ),
  );

  // 1. Tool surface: exactly the 6 aligned tools.
  const stub = makeStub();
  const tools = createTools({ client: stub.client });
  check(
    "createTools returns exactly the 6 tool names",
    JSON.stringify(Object.keys(tools).sort()) === JSON.stringify([...TOOL_NAMES].sort()),
    Object.keys(tools).join(","),
  );

  // 2. Per-tool shape: description with pricing, zod schema fields on target.
  for (const name of TOOL_NAMES) {
    const t = tools[name];
    const fields = schemaFields(t.inputSchema);
    check(
      `${name}: description non-empty and states the credit price`,
      typeof t.description === "string" && t.description.length > 40 && /credits?/.test(t.description),
    );
    check(
      `${name}: zod input schema fields = {${EXPECTED_FIELDS[name]}}`,
      JSON.stringify(fields) === JSON.stringify([...EXPECTED_FIELDS[name]].sort()),
      fields.join(","),
    );
    let parses = true;
    try {
      t.inputSchema.parse(SAMPLE_ARGS[name]);
    } catch {
      parses = false;
    }
    let rejectsEmpty = false;
    try {
      t.inputSchema.parse({});
    } catch {
      rejectsEmpty = true;
    }
    check(`${name}: schema accepts a valid arg and rejects {}`, parses && rejectsEmpty);
    check(`${name}: execute is a function`, typeof t.execute === "function");
  }

  // 3. Routing: each execute() lands on the right client method + arguments.
  for (const name of TOOL_NAMES) {
    stub.calls.length = 0;
    const out = await tools[name].execute(SAMPLE_ARGS[name], EXEC_OPTS);
    const expected = EXPECTED_ROUTES[name];
    check(
      `${name}: routes to client as expected`,
      JSON.stringify(stub.calls) === JSON.stringify([expected]),
      JSON.stringify(stub.calls),
    );
    // 4. Success shape: compact JSON string, credit headers passed through.
    const parsed = JSON.parse(out);
    check(
      `${name}: success returns compact JSON string with ok/tool/credits`,
      typeof out === "string" &&
        parsed.ok === true &&
        parsed.tool === name &&
        parsed.credits_charged === 1 &&
        parsed.credits_balance === 999 &&
        parsed.cache === "MISS" &&
        parsed.data?.stub === true,
      out.slice(0, 140),
    );
  }

  // 5. Gateway error -> readable failure string, never throws.
  const errStub = makeStub("gateway-error");
  const errTools = createTools({ client: errStub.client });
  let threw = false;
  let errOut = null;
  try {
    errOut = await errTools.card_check.execute(SAMPLE_ARGS.card_check, EXEC_OPTS);
  } catch {
    threw = true;
  }
  const errParsed = errOut ? JSON.parse(errOut) : {};
  check(
    "gateway error (402) returns failure string, does not throw",
    !threw &&
      errParsed.ok === false &&
      errParsed.tool === "card_check" &&
      errParsed.error?.code === "INSUFFICIENT_CREDITS" &&
      errParsed.error?.status === 402 &&
      errParsed.error?.detail === "Balance below price.",
    errOut ?? "(threw)",
  );

  // 6. Local misuse (no API key) -> CLIENT_ERROR string, never throws.
  const noKeyTools = createTools({ client: makeStub("client-error").client });
  let clientThrew = false;
  let clientOut = null;
  try {
    clientOut = await noKeyTools.email_check.execute(SAMPLE_ARGS.email_check, EXEC_OPTS);
  } catch {
    clientThrew = true;
  }
  const clientParsed = clientOut ? JSON.parse(clientOut) : {};
  check(
    "local misuse returns CLIENT_ERROR string, does not throw",
    !clientThrew &&
      clientParsed.ok === false &&
      clientParsed.error?.code === "CLIENT_ERROR" &&
      clientParsed.error?.status === null,
    clientOut ?? "(threw)",
  );

  // 7. Mount proof: the tools object drops into generateText() as-is; a
  // mock model issues a tool call and receives the compact JSON string.
  {
    const mountStub = makeStub();
    let step = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "tc1",
                toolName: "email_check",
                input: JSON.stringify({ email: "alice@example.com" }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: "done" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
        };
      },
    });
    const res = await generateText({
      model,
      tools: createTools({ client: mountStub.client }),
      stopWhen: stepCountIs(3),
      prompt: "check alice@example.com",
    });
    const toolResults = res.steps.flatMap((s) =>
      s.content.filter((c) => c.type === "tool-result"),
    );
    check(
      "tools object mounts into generateText; mock model call returns the JSON string",
      toolResults.length === 1 &&
        String(toolResults[0].output).includes('"ok":true') &&
        res.text === "done",
      JSON.stringify(toolResults).slice(0, 160),
    );
  }

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(
    failed === 0
      ? `OFFLINE SMOKE: PASS (${results.length}/${results.length} assertions)`
      : `OFFLINE SMOKE: FAIL (${results.length - failed}/${results.length} assertions)`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("OFFLINE SMOKE: FAIL — harness error:", e);
  process.exit(1);
});
