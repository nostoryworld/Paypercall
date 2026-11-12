// Offline unit tests for settlement/intents.js — node:test + a stubbed
// fetchImpl. NO live network is touched by any test in this file.
//
// Fixtures are shaped like real 1Click API responses per the public docs
// (docs.near-intents.org, 1Click API) and the official TypeScript SDK's
// response models:
//   quote:  { timestamp, signature, quoteRequest, quote: { depositAddress,
//             depositMemo, amountIn, ..., amountOut, ..., deadline,
//             timeEstimate, depositMode } }
//   status: { status, updatedAt, quoteResponse, swapDetails: {...} }
//   error:  { message } / { statusCode, message, error }
//
// Run from the settlement/ directory:  node --test test/

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createIntentsClient,
  intentsEnabled,
  IntentsApiError,
  IntentsQuoteError,
  ONECLICK_STATUSES,
  TERMINAL_STATUSES,
} from "../intents.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEPOSIT_ADDRESS = "0x9f3c8a1b7e5d2046f8a9b0c1d2e3f40516273849aabbccddeeff00112233445566";
const DEADLINE = "2026-10-20T15:00:00.000Z";

const QUOTE_REQUEST = {
  dry: false,
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: "nep141:wrap.near",
  depositType: "ORIGIN_CHAIN",
  destinationAsset: "nep141:wrap.near",
  amount: "100000000000000000000000", // 0.1 NEAR in yoctoNEAR
  recipient: "seller.testnet",
  recipientType: "DESTINATION_CHAIN",
  refundTo: "buyer.testnet",
  refundType: "ORIGIN_CHAIN",
  deadline: DEADLINE,
};

const QUOTE_RESPONSE = {
  timestamp: "2026-10-20T14:00:00.000Z",
  signature: "ed25519:fixtureSignatureNotARealKey1111111111111111111111111111",
  correlationId: "fixture-correlation-id-0001",
  quoteRequest: QUOTE_REQUEST,
  quote: {
    depositAddress: DEPOSIT_ADDRESS,
    depositMemo: null,
    amountIn: "100000000000000000000000",
    amountInFormatted: "0.1",
    amountInUsd: "0.19",
    amountOut: "99800000000000000000000",
    amountOutFormatted: "0.0998",
    amountOutUsd: "0.19",
    deadline: DEADLINE,
    timeWhenInactive: "2026-10-20T14:05:00.000Z",
    timeEstimate: 10,
    depositMode: "SIMPLE",
  },
};

// A dry-run quote: same envelope, but no depositAddress is issued — a dry
// quote validates and prices the swap without creating anything payable.
const DRY_QUOTE_RESPONSE = {
  timestamp: "2026-10-20T14:00:00.000Z",
  signature: "ed25519:fixtureSignatureNotARealKey1111111111111111111111111111",
  correlationId: "fixture-correlation-id-0002",
  quoteRequest: { ...QUOTE_REQUEST, dry: true },
  quote: {
    amountIn: "100000000000000000000000",
    amountInFormatted: "0.1",
    amountInUsd: "0.19",
    amountOut: "99800000000000000000000",
    amountOutFormatted: "0.0998",
    amountOutUsd: "0.19",
    deadline: DEADLINE,
    timeWhenInactive: "2026-10-20T14:05:00.000Z",
    timeEstimate: 10,
    depositMode: "SIMPLE",
  },
};

function statusResponse(status, swapDetailsExtra = {}) {
  return {
    status,
    updatedAt: "2026-10-20T14:01:00.000Z",
    quoteResponse: QUOTE_RESPONSE,
    swapDetails: {
      intentHashes: [],
      nearTxHashes: [],
      originChainTxHashes: [],
      destinationChainTxHashes: [],
      amountIn: null,
      amountOut: null,
      slippage: null,
      refundedAmount: null,
      depositedAmount: null,
      ...swapDetailsExtra,
    },
  };
}

const ERROR_RESPONSE = {
  statusCode: 401,
  message: "Unauthorized: a valid JWT is required for this endpoint",
  error: "Unauthorized",
};

// ---------------------------------------------------------------------------
// Stub fetch
// ---------------------------------------------------------------------------

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Records every call; handler(url, init, callIndex) decides the response.
function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init, calls.length - 1);
  };
  return { fetchImpl, calls };
}

function quoteParams(overrides = {}) {
  return {
    originAsset: "nep141:wrap.near",
    destinationAsset: "nep141:wrap.near",
    amount: "100000000000000000000000",
    recipient: "seller.testnet",
    refundTo: "buyer.testnet",
    deadline: DEADLINE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// intentsEnabled — the config gate
// ---------------------------------------------------------------------------

test("intentsEnabled: true only for SETTLEMENT_MODE === 'intents'", () => {
  assert.equal(intentsEnabled({ SETTLEMENT_MODE: "intents" }), true);
  assert.equal(intentsEnabled({ SETTLEMENT_MODE: "transfer" }), false);
  assert.equal(intentsEnabled({}), false);
  assert.equal(intentsEnabled({ SETTLEMENT_MODE: "INTENTS" }), false);
  assert.equal(intentsEnabled({ SETTLEMENT_MODE: "intents " }), false);
  assert.equal(intentsEnabled(undefined), false);
  assert.equal(intentsEnabled(null), false);
});

// ---------------------------------------------------------------------------
// (a) Successful quote, dry = false
// ---------------------------------------------------------------------------

test("requestQuote: successful non-dry quote returns a normalized, payable result", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(QUOTE_RESPONSE));
  const client = createIntentsClient({ jwt: "test-jwt", fetchImpl });

  const result = await client.requestQuote(quoteParams());

  assert.equal(result.depositAddress, DEPOSIT_ADDRESS);
  assert.equal(result.amountIn, "100000000000000000000000");
  assert.equal(result.amountOut, "99800000000000000000000");
  assert.equal(result.deadline, DEADLINE);
  assert.equal(result.depositMemo, null);
  assert.equal(result.timeEstimate, 10);
  assert.equal(result.dry, false);
  assert.deepEqual(result.raw.quote, QUOTE_RESPONSE.quote);

  // The outgoing request must hit the 1Click quote endpoint with the JWT
  // attached and a body the API can act on.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://1click.chaindefuser.com/v0/quote");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-jwt");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.dry, false);
  assert.equal(sent.swapType, "EXACT_INPUT");
  assert.equal(sent.originAsset, "nep141:wrap.near");
  assert.equal(sent.destinationAsset, "nep141:wrap.near");
  assert.equal(sent.amount, "100000000000000000000000");
  assert.equal(sent.recipient, "seller.testnet");
  assert.equal(sent.refundTo, "buyer.testnet");
  assert.equal(sent.deadline, DEADLINE);
  assert.equal(sent.depositType, "ORIGIN_CHAIN");
  assert.equal(sent.recipientType, "DESTINATION_CHAIN");
  assert.equal(sent.refundType, "ORIGIN_CHAIN");
});

test("requestQuote: no Authorization header is sent when no JWT is configured", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(QUOTE_RESPONSE));
  const client = createIntentsClient({ fetchImpl });
  await client.requestQuote(quoteParams());
  assert.equal(calls[0].init.headers.Authorization, undefined);
});

test("requestQuote: a JWT resolver function is awaited and used", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(QUOTE_RESPONSE));
  const client = createIntentsClient({ jwt: async () => "refreshed-jwt", fetchImpl });
  await client.requestQuote(quoteParams());
  assert.equal(calls[0].init.headers.Authorization, "Bearer refreshed-jwt");
});

test("requestQuote: missing required parameters throw a TypeError naming them", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(QUOTE_RESPONSE));
  const client = createIntentsClient({ fetchImpl });
  await assert.rejects(() => client.requestQuote({ originAsset: "nep141:wrap.near" }), (err) => {
    assert.ok(err instanceof TypeError);
    assert.match(err.message, /destinationAsset/);
    assert.match(err.message, /refundTo/);
    return true;
  });
  assert.equal(calls.length, 0); // validation happens before any network call
});

// ---------------------------------------------------------------------------
// (b) Dry-run quote — no depositAddress
// ---------------------------------------------------------------------------

test("requestQuote: dry quote reports depositAddress as null instead of pretending to be payable", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(DRY_QUOTE_RESPONSE));
  const client = createIntentsClient({ fetchImpl });

  const result = await client.requestQuote(quoteParams({ dry: true }));

  assert.equal(result.dry, true);
  assert.equal(result.depositAddress, null); // clearly reported: nothing to deposit to
  assert.equal(result.amountIn, "100000000000000000000000");
  assert.equal(result.amountOut, "99800000000000000000000");
  assert.equal(result.deadline, DEADLINE);
  assert.equal(JSON.parse(calls[0].init.body).dry, true);
});

test("requestQuote: a NON-dry quote without a depositAddress throws IntentsQuoteError", async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(DRY_QUOTE_RESPONSE));
  const client = createIntentsClient({ fetchImpl });
  await assert.rejects(() => client.requestQuote(quoteParams({ dry: false })), (err) => {
    assert.ok(err instanceof IntentsQuoteError);
    assert.match(err.message, /no depositAddress/);
    assert.deepEqual(err.raw.quote, DRY_QUOTE_RESPONSE.quote);
    return true;
  });
});

// ---------------------------------------------------------------------------
// (c) Status polling transitions PENDING_DEPOSIT -> PROCESSING -> SUCCESS
// ---------------------------------------------------------------------------

test("getStatus: PENDING_DEPOSIT -> PROCESSING -> SUCCESS, settled only on SUCCESS", async () => {
  const sequence = [
    statusResponse("PENDING_DEPOSIT"),
    statusResponse("PROCESSING"),
    statusResponse("SUCCESS", {
      amountIn: "100000000000000000000000",
      amountOut: "99800000000000000000000",
      depositedAmount: "100000000000000000000000",
    }),
  ];
  const { fetchImpl, calls } = stubFetch((url, init, i) => jsonResponse(sequence[i]));
  const client = createIntentsClient({ jwt: "test-jwt", fetchImpl });

  const pending = await client.getStatus(DEPOSIT_ADDRESS);
  assert.equal(pending.status, "PENDING_DEPOSIT");
  assert.equal(pending.settled, false);
  assert.equal(pending.terminal, false);

  const processing = await client.getStatus(DEPOSIT_ADDRESS);
  assert.equal(processing.status, "PROCESSING");
  assert.equal(processing.settled, false);
  assert.equal(processing.terminal, false);

  const success = await client.getStatus(DEPOSIT_ADDRESS);
  assert.equal(success.status, "SUCCESS");
  assert.equal(success.settled, true);
  assert.equal(success.terminal, true);
  assert.equal(success.raw.swapDetails.amountOut, "99800000000000000000000");

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.headers.Authorization, "Bearer test-jwt");
    const url = new URL(call.url);
    assert.equal(url.origin + url.pathname, "https://1click.chaindefuser.com/v0/status");
    assert.equal(url.searchParams.get("depositAddress"), DEPOSIT_ADDRESS);
  }
});

test("getStatus: KNOWN_DEPOSIT_TX and INCOMPLETE_DEPOSIT are known, non-terminal, unsettled", async () => {
  for (const status of ["KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT"]) {
    const { fetchImpl } = stubFetch(() => jsonResponse(statusResponse(status)));
    const client = createIntentsClient({ fetchImpl });
    const result = await client.getStatus(DEPOSIT_ADDRESS);
    assert.equal(result.status, status);
    assert.equal(result.settled, false);
    assert.equal(result.terminal, false);
    assert.ok(ONECLICK_STATUSES.includes(result.status));
  }
});

test("getStatus: depositMemo is forwarded as a query parameter when provided", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(statusResponse("PENDING_DEPOSIT")));
  const client = createIntentsClient({ fetchImpl, baseUrl: "https://example.invalid/api/" });
  await client.getStatus("some*address", { depositMemo: "memo 123" });
  const url = new URL(calls[0].url);
  // Trailing slash on baseUrl is normalized away; params are URL-encoded.
  assert.equal(url.origin + url.pathname, "https://example.invalid/api/v0/status");
  assert.equal(url.searchParams.get("depositAddress"), "some*address");
  assert.equal(url.searchParams.get("depositMemo"), "memo 123");
});

// ---------------------------------------------------------------------------
// (d) REFUNDED terminal status (and FAILED)
// ---------------------------------------------------------------------------

test("getStatus: REFUNDED is terminal but NOT settled (the call must not be released)", async () => {
  const refunded = statusResponse("REFUNDED", { refundedAmount: "100000000000000000000000" });
  const { fetchImpl } = stubFetch(() => jsonResponse(refunded));
  const client = createIntentsClient({ fetchImpl });
  const result = await client.getStatus(DEPOSIT_ADDRESS);
  assert.equal(result.status, "REFUNDED");
  assert.equal(result.settled, false);
  assert.equal(result.terminal, true);
  assert.equal(result.raw.swapDetails.refundedAmount, "100000000000000000000000");
});

test("getStatus: FAILED is terminal but NOT settled", async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(statusResponse("FAILED")));
  const client = createIntentsClient({ fetchImpl });
  const result = await client.getStatus(DEPOSIT_ADDRESS);
  assert.equal(result.status, "FAILED");
  assert.equal(result.settled, false);
  assert.equal(result.terminal, true);
  assert.ok(TERMINAL_STATUSES.includes("FAILED"));
});

// ---------------------------------------------------------------------------
// (e) API error response
// ---------------------------------------------------------------------------

test("requestQuote: a non-2xx response throws IntentsApiError with status and API message attached", async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(ERROR_RESPONSE, 401));
  const client = createIntentsClient({ fetchImpl });
  await assert.rejects(() => client.requestQuote(quoteParams()), (err) => {
    assert.ok(err instanceof IntentsApiError);
    assert.equal(err.status, 401);
    assert.match(err.message, /valid JWT is required/);
    assert.deepEqual(err.body, ERROR_RESPONSE);
    return true;
  });
});

test("getStatus: a 404 for an unknown deposit address throws IntentsApiError", async () => {
  const notFound = { statusCode: 404, message: "Deposit address not found", error: "Not Found" };
  const { fetchImpl } = stubFetch(() => jsonResponse(notFound, 404));
  const client = createIntentsClient({ jwt: "test-jwt", fetchImpl });
  await assert.rejects(() => client.getStatus("0xdeadbeef"), (err) => {
    assert.ok(err instanceof IntentsApiError);
    assert.equal(err.status, 404);
    assert.match(err.message, /Deposit address not found/);
    return true;
  });
});

test("getStatus: a 2xx response with no status field throws instead of guessing", async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse({ updatedAt: "2026-10-20T14:01:00.000Z" }));
  const client = createIntentsClient({ fetchImpl });
  await assert.rejects(() => client.getStatus(DEPOSIT_ADDRESS), (err) => {
    assert.ok(err instanceof IntentsApiError);
    assert.match(err.message, /did not contain a status field/);
    return true;
  });
});
