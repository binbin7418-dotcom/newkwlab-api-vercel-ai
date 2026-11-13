// NewKwLab API Bundle — Vercel AI SDK tools
//
// Wraps the already-verified gateway JavaScript SDK (NewKwLabClient) as
// Vercel AI SDK `tool()` objects, so any AI SDK agent (streamText /
// generateText) can call the gateway's validation, lookup and screening
// products with the customer's single aggregate key and shared credit
// balance.
//
// PRE-RELEASE / MONOREPO NOTE: the gateway JS SDK is not on npm yet, so it
// is referenced by local relative path (../../js-sdk/src/index.mjs — the
// sibling `access/js-sdk/` package, published name `@newkwlab/api-bundle`).
// Once the SDK is published, that import becomes the package name and this
// file needs no other change.
//
// Design rules (aligned with the LangChain plugin, access/langchain/):
// - No HTTP code lives here — every tool delegates to the JS SDK client.
// - Every tool's execute() resolves to a compact JSON *string* for the model:
//   success -> {"ok":true,"tool":...,"credits_charged":...,
//               "credits_balance":...,"cache":...,"data":{...}}
//   failure -> {"ok":false,"tool":...,"error":{"code":...,"status":...,
//               "detail":...}}
// - Tools never throw: gateway errors (GatewayError) and local misuse are
//   converted into the failure string above, so a bad call cannot crash the
//   agent loop. `credits_charged` is the amount the gateway actually took
//   (not-found results and errors are charged 0 by gateway design).

import { tool } from "ai";
import { z } from "zod";

import { GatewayError, NewKwLabClient } from "../../js-sdk/src/index.mjs";

export const TOOL_NAMES = [
  "email_check",
  "phone_check",
  "card_check",
  "lei_lookup",
  "airport_lookup",
  "sanctions_screen",
];

// -- Result formatting --------------------------------------------------------

function success(toolName, result) {
  return JSON.stringify({
    ok: true,
    tool: toolName,
    credits_charged: result.creditsCharged,
    credits_balance: result.creditsBalance,
    cache: result.cache,
    data: result.data,
  });
}

function failure(toolName, code, status, detail) {
  return JSON.stringify({
    ok: false,
    tool: toolName,
    error: { code, status, detail },
  });
}

async function guarded(toolName, fn) {
  try {
    return success(toolName, await fn());
  } catch (e) {
    if (e instanceof GatewayError) {
      return failure(toolName, e.code, e.status, e.detail ?? null);
    }
    if (e instanceof Error) {
      // Local misuse (e.g. client built without an API key — the SDK throws
      // a plain Error before any request is sent).
      return failure(toolName, "CLIENT_ERROR", null, e.message);
    }
    return failure(toolName, "UNEXPECTED_ERROR", null, String(e));
  }
}

// -- Tool factory ---------------------------------------------------------------

/**
 * Build the NewKwLab gateway tools for a Vercel AI SDK agent.
 *
 * @param {object} [options]
 * @param {NewKwLabClient} [options.client]  Existing SDK client (recommended
 *   when you also use the SDK directly). Wins over apiKey/baseUrl.
 * @param {string} [options.apiKey]   Aggregate API key (nkw_live_...).
 *   Defaults to the SDK's own resolution (options, then NKW_API_KEY env).
 * @param {string} [options.baseUrl]  Gateway base URL (defaults to the SDK's
 *   default, https://api.newkwlab.com/gateway, or NKW_BASE_URL env).
 * @returns {object} A tools object ready to drop into the `tools` field of
 *   streamText() / generateText(): { email_check, phone_check, card_check,
 *   lei_lookup, airport_lookup, sanctions_screen }.
 */
export function createTools(options = {}) {
  const client =
    options.client ??
    new NewKwLabClient({ apiKey: options.apiKey, baseUrl: options.baseUrl });

  return {
    email_check: tool({
      description:
        "Validate one email address through the NewKwLab gateway: syntax, MX " +
        "records, disposable / role-account detection, typo suggestion, " +
        "catch-all risk and a 0-100 score. Costs 1 credit per result; " +
        "repeat calls with the same parameters within 24h are cached and free.",
      inputSchema: z.object({
        email: z
          .string()
          .describe("The email address to validate, e.g. 'alice@example.com'."),
      }),
      execute: async ({ email }) =>
        guarded("email_check", () => client.emailCheck(email)),
    }),

    phone_check: tool({
      description:
        "Validate one phone number through the NewKwLab gateway: format " +
        "validity, country and line-type details. Costs 1 credit per result; " +
        "repeat calls with the same parameters within 24h are cached and free.",
      inputSchema: z.object({
        phone: z
          .string()
          .describe(
            "The phone number to validate, in international format, e.g. '+14155552671'.",
          ),
      }),
      execute: async ({ phone }) =>
        guarded("phone_check", () => client.phoneCheck(phone)),
    }),

    card_check: tool({
      description:
        "Validate one bank-card number through the NewKwLab gateway: Luhn " +
        "check, card network and type. Validation only — never a payment. " +
        "Costs 1 credit per result; repeat calls with the same parameters " +
        "within 24h are cached and free.",
      inputSchema: z.object({
        number: z
          .string()
          .describe(
            "The bank-card number to validate (digits, spaces/dashes are stripped " +
              "by the service). Validation only — this never charges the card.",
          ),
      }),
      execute: async ({ number }) =>
        guarded("card_check", () => client.cardCheck(number)),
    }),

    lei_lookup: tool({
      description:
        "Look up a company by its Legal Entity Identifier (LEI) through the " +
        "NewKwLab gateway (GLEIF data): registration status and entity " +
        "details. Costs 2 credits when a record is found; a malformed LEI " +
        "or a lookup with no record costs 0 credits.",
      inputSchema: z.object({
        lei: z
          .string()
          .describe("The 20-character Legal Entity Identifier (LEI) code to look up."),
      }),
      execute: async ({ lei }) =>
        guarded("lei_lookup", () =>
          client.call("leilookup", `/lei/${encodeURIComponent(lei)}`),
        ),
    }),

    airport_lookup: tool({
      description:
        "Get airport data by IATA code through the NewKwLab gateway: name, " +
        "city, country, coordinates and timezone. Costs 2 credits per result.",
      inputSchema: z.object({
        code: z.string().describe("The airport's IATA code, e.g. 'LAX'."),
      }),
      execute: async ({ code }) =>
        guarded("airport_lookup", () =>
          client.call("airportbase", "/airport", { params: { code } }),
        ),
    }),

    sanctions_screen: tool({
      description:
        "Screen a person or company name against sanctions and watchlists " +
        "through the NewKwLab gateway. Returns match candidates with list " +
        "sources and scores — review matches before acting on them. " +
        "Costs 2 credits per screening.",
      inputSchema: z.object({
        name: z
          .string()
          .describe(
            "The person or company name to screen against sanctions and watchlists.",
          ),
      }),
      execute: async ({ name }) =>
        guarded("sanctions_screen", () =>
          client.call("sanctionscreen", "/screen", { params: { name } }),
        ),
    }),
  };
}

export default createTools;
