# newkwlab-vercel-ai

Vercel AI SDK tools for the **NewKwLab API Bundle** gateway — one API key and
one shared credit balance for a suite of data tools, ready to drop into any
`streamText` / `generateText` agent.

> **Pre-release.** This package is built and tested locally but not yet
> published to npm. Its gateway client — the JavaScript SDK in the sibling
> `../js-sdk` directory (future npm name `@newkwlab/api-bundle`) — is not on
> npm yet either, so `src/index.mjs` references it by local relative path.
> Use this package from inside the monorepo (see Install below); nothing
> else changes when the SDK is published.

## Tools

| Tool | What it does | Credits |
|---|---|---|
| `email_check` | Validate an email address: syntax, MX, disposable / role account, typo suggestion, catch-all risk, 0–100 score | 1 |
| `phone_check` | Validate a phone number: format, country, line type | 1 |
| `card_check` | Validate a bank-card number: Luhn, network, type (validation only — never a payment) | 1 |
| `lei_lookup` | Look up a company by Legal Entity Identifier (GLEIF data) | 2, **0 if no record** |
| `airport_lookup` | Airport data by IATA code: name, city, country, coordinates, timezone | 2 |
| `sanctions_screen` | Screen a person/company name against sanctions & watchlists | 2 |

Charging rules come from the gateway and are surfaced on every result:
a result is charged its credit price, a lookup with **no record is free**,
repeating the same call within 24h hits the **cache and is free**, and
upstream errors are never charged.

Every tool returns a compact JSON string for the model:

```json
{"ok":true,"tool":"card_check","credits_charged":1,"credits_balance":999,"cache":"MISS","data":{"valid":true,"network":"Visa"}}
```

Errors come back in the same shape — tools never throw into the agent loop:

```json
{"ok":false,"tool":"card_check","error":{"code":"INSUFFICIENT_CREDITS","status":402,"detail":null}}
```

## Install (from this monorepo, pre-release)

```bash
npm install ai zod   # the peer dependencies (Vercel AI SDK v7, zod v4)
```

Then import this package's `src/index.mjs` by path — it resolves the gateway
SDK from `../js-sdk` automatically. Requires Node.js 18+.

## Quick start

```js
import { generateText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai"; // or any other AI SDK model
import { createTools } from "./src/index.mjs"; // newkwlab-vercel-ai

const { text } = await generateText({
  model: openai("gpt-5-mini"),
  tools: createTools({ apiKey: "nkw_live_..." }), // placeholder — use your own key
  stopWhen: stepCountIs(5),
  prompt: "Validate alice@example.com and the card 4242424242424242.",
});
console.log(text);
```

`createTools()` with no arguments works too — the key and gateway URL fall
back to the `NKW_API_KEY` / `NKW_BASE_URL` environment variables, exactly
like the SDK. If you already use the gateway SDK elsewhere, pass your client
so key, base URL and fetch implementation are shared:

```js
import { NewKwLabClient } from "../js-sdk/src/index.mjs"; // @newkwlab/api-bundle once published
import { createTools } from "./src/index.mjs";

const client = new NewKwLabClient({ apiKey: process.env.NKW_API_KEY });
const tools = createTools({ client });
```

## Getting a key

Keys are issued by activating a license purchased on Gumroad — see the
gateway JS SDK (`../js-sdk`) for `activate()`, `usage()`, balance and ledger
history. This package only wraps product calls as tools.

## Errors

Tools convert every failure into the `{"ok":false,...}` string above, with
the gateway's error `code` and HTTP `status` (`UNAUTHORIZED` 401,
`INSUFFICIENT_CREDITS` 402, `CAPABILITY_DENIED` 403,
`PRODUCT_NOT_CONNECTED` 503, upstream errors free of charge, …). Local
misuse — for example building tools without any API key — comes back as
`CLIENT_ERROR`. Nothing throws, so a bad call cannot crash the agent loop.

## Configuration

| Option / env var | Default |
|---|---|
| `apiKey` / `NKW_API_KEY` | — |
| `baseUrl` / `NKW_BASE_URL` | `https://api.newkwlab.com/gateway` |
| `client` | a new SDK client built from the options above |

## License

MIT
