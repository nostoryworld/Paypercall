// intents.js — NEAR Intents (1Click API) settlement client for PayPerCall.
//
// PHASE D — CODE-READY ONLY. This module is NOT wired into the live purchase
// flow and performs NO on-chain actions by itself. It only talks to the
// 1Click REST API when a caller explicitly invokes it. The Intents path is
// gated behind `intentsEnabled(env)` (SETTLEMENT_MODE === "intents"); the
// default everywhere else in PayPerCall remains plain transfer-verify.
//
// Dependency-free ES module: plain global `fetch`, so the same file runs in
// Node 24 and in Cloudflare Workers. No imports, no build step.
//
// 1Click API reference (public docs, docs.near-intents.org — 1Click API):
//   POST /v0/quote   -> { timestamp, signature, quoteRequest, quote: {...} }
//   GET  /v0/status?depositAddress=... -> { status, updatedAt, quoteResponse, swapDetails }
// Base URL: https://1click.chaindefuser.com
// Auth: Bearer JWT from the NEAR Intents partner portal. The quote endpoint
// also answers unauthenticated (at a worse fee schedule, +0.25% per docs),
// but /v0/status requires a JWT, so a full settlement flow needs one.

export const DEFAULT_BASE_URL = "https://1click.chaindefuser.com";

/** Every status the 1Click status endpoint is documented to return. */
export const ONECLICK_STATUSES = Object.freeze([
  "PENDING_DEPOSIT",
  "KNOWN_DEPOSIT_TX",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
]);

/** Statuses after which polling must stop: the swap will not move again. */
export const TERMINAL_STATUSES = Object.freeze(["SUCCESS", "REFUNDED", "FAILED"]);

const SWAP_TYPES = Object.freeze(["EXACT_INPUT", "EXACT_OUTPUT", "FLEX_INPUT", "ANY_INPUT"]);

/**
 * Error thrown for any non-2xx 1Click API response (and for malformed 2xx
 * bodies). Carries the HTTP status and the parsed/raw API body so callers
 * can log or surface the API's own message without re-parsing.
 */
export class IntentsApiError extends Error {
  constructor(message, { status = null, body = null, cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "IntentsApiError";
    this.status = status; // HTTP status code, when the error came from a response
    this.body = body; // parsed JSON body if possible, otherwise raw text / null
  }
}

/**
 * Error thrown when a 2xx quote response cannot be used for settlement —
 * most importantly a non-dry quote with no depositAddress. A dry quote is
 * the one case where a missing depositAddress is expected, and it is
 * reported in the result instead of thrown (see requestQuote).
 */
export class IntentsQuoteError extends Error {
  constructor(message, { raw = null } = {}) {
    super(message);
    this.name = "IntentsQuoteError";
    this.raw = raw;
  }
}

/**
 * The single config gate for the Intents settlement path.
 * Returns true ONLY when env.SETTLEMENT_MODE is exactly "intents".
 * Anything else — unset, "transfer" (the default), other values, a
 * non-object env — returns false, i.e. plain transfer-verify stays live.
 */
export function intentsEnabled(env) {
  return Boolean(env) && typeof env === "object" && env.SETTLEMENT_MODE === "intents";
}

function extractApiMessage(body, fallback) {
  if (body && typeof body === "object") {
    if (typeof body.message === "string" && body.message) return body.message;
    if (Array.isArray(body.message) && body.message.length) return body.message.join("; ");
    if (typeof body.error === "string" && body.error) return body.error;
    if (body.error && typeof body.error.message === "string") return body.error.message;
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
  return fallback;
}

async function readBody(res) {
  // Read as text first so a non-JSON error page never crashes the parser;
  // upgrade to an object when the body actually is JSON.
  try {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

function requireFields(method, params, fields) {
  const missing = fields.filter((f) => params[f] === undefined || params[f] === null || params[f] === "");
  if (missing.length) {
    throw new TypeError(`${method}: missing required parameter(s): ${missing.join(", ")}`);
  }
}

/**
 * Create a 1Click client.
 *
 * @param {object}   [options]
 * @param {string}   [options.baseUrl="https://1click.chaindefuser.com"]
 * @param {string|Function|null} [options.jwt=null] Bearer token, or a
 *   (sync/async) function returning one — useful for token refresh in a
 *   long-lived Worker. Sent as `Authorization: Bearer <jwt>` when set.
 * @param {Function} [options.fetchImpl=globalThis.fetch] fetch-compatible
 *   function; injectable so tests can run fully offline.
 * @param {number|null} [options.timeoutMs=30000] per-request timeout via
 *   AbortController; pass null/0 to disable. (A live dry quote from a
 *   cold/proxied network took ~18s during Phase D verification, so the
 *   default is generous; the API itself normally answers in ~1s.)
 */
export function createIntentsClient({
  baseUrl = DEFAULT_BASE_URL,
  jwt = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
} = {}) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    throw new TypeError("createIntentsClient: baseUrl must be a non-empty string");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createIntentsClient: no fetch implementation available (pass fetchImpl)");
  }
  const base = baseUrl.replace(/\/+$/, "");

  async function resolveJwt() {
    if (jwt === null || jwt === undefined) return null;
    const token = typeof jwt === "function" ? await jwt() : jwt;
    return token ? String(token) : null;
  }

  async function request(path, init) {
    const headers = { Accept: "application/json", ...(init.headers || {}) };
    const token = await resolveJwt();
    if (token) headers.Authorization = `Bearer ${token}`;

    let signal;
    let timer;
    if (timeoutMs && typeof AbortController === "function") {
      const controller = new AbortController();
      signal = controller.signal;
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }
    let res;
    try {
      res = await fetchImpl(base + path, { ...init, headers, ...(signal ? { signal } : {}) });
    } catch (err) {
      throw new IntentsApiError(
        `1Click request to ${path} failed before a response was received: ${err?.message ?? String(err)}`,
        { cause: err },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    const body = await readBody(res);
    const ok = typeof res.ok === "boolean" ? res.ok : res.status >= 200 && res.status < 300;
    if (!ok) {
      throw new IntentsApiError(extractApiMessage(body, `1Click API error (HTTP ${res.status})`), {
        status: res.status,
        body,
      });
    }
    return body;
  }

  /**
   * Request a swap quote from POST /v0/quote.
   *
   * @param {object}  params
   * @param {string}  params.originAsset      1Click assetId the payer sends, e.g. "nep141:wrap.near"
   * @param {string}  params.destinationAsset 1Click assetId the recipient receives
   * @param {string|number|bigint} params.amount Amount in the asset's smallest unit.
   *   For EXACT_INPUT this is the input amount; for EXACT_OUTPUT the output amount.
   * @param {string}  [params.swapType="EXACT_INPUT"]
   * @param {string}  params.recipient        Address that receives the destination asset
   * @param {string}  params.refundTo         Address refunds go to if the swap fails
   * @param {string}  [params.deadline]       ISO timestamp; defaults to now + 1 hour
   * @param {boolean} [params.dry=false]      true = validate + price only, nothing executable
   * @param {number}  [params.slippageTolerance=100] basis points (100 = 1%)
   * @param {string}  [params.depositType="ORIGIN_CHAIN"]
   * @param {string}  [params.recipientType="DESTINATION_CHAIN"]
   * @param {string}  [params.refundType="ORIGIN_CHAIN"]
   * @param {string}  [params.referral]       optional referral identifier
   *
   * @returns {Promise<{depositAddress: string|null, depositMemo: string|null,
   *   amountIn: string|null, amountOut: string|null, deadline: string|null,
   *   timeEstimate: number|null, dry: boolean, raw: object}>}
   *   `depositAddress` is null ONLY for a dry quote (dry quotes are not
   *   payable — there is nothing to deposit to). A non-dry quote without a
   *   depositAddress throws IntentsQuoteError instead of returning a
   *   settlement object that could never be paid.
   */
  async function requestQuote(params = {}) {
    const {
      originAsset,
      destinationAsset,
      amount,
      swapType = "EXACT_INPUT",
      recipient,
      refundTo,
      deadline,
      dry = false,
      slippageTolerance = 100,
      depositType = "ORIGIN_CHAIN",
      recipientType = "DESTINATION_CHAIN",
      refundType = "ORIGIN_CHAIN",
      referral,
    } = params;

    requireFields("requestQuote", params, ["originAsset", "destinationAsset", "amount", "recipient", "refundTo"]);
    if (!SWAP_TYPES.includes(swapType)) {
      throw new TypeError(`requestQuote: swapType must be one of ${SWAP_TYPES.join(", ")} (got ${JSON.stringify(swapType)})`);
    }

    const effectiveDeadline = deadline ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const requestBody = {
      dry: Boolean(dry),
      swapType,
      slippageTolerance,
      originAsset,
      depositType,
      destinationAsset,
      amount: String(amount),
      recipient,
      recipientType,
      refundTo,
      refundType,
      deadline: effectiveDeadline,
      ...(referral ? { referral } : {}),
    };

    const raw = await request("/v0/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    // Defensive parse: the documented shape is { quote: {...} }, wrapped in
    // some responses as { quoteResponse: { quote: {...} } }. Accept either,
    // plus a bare quote object, rather than breaking on envelope changes.
    const quote =
      raw?.quote ?? raw?.quoteResponse?.quote ?? (raw && (raw.depositAddress || raw.amountIn) ? raw : null);
    if (!quote || typeof quote !== "object") {
      throw new IntentsQuoteError("1Click quote response did not contain a quote object", { raw });
    }

    const depositAddress = quote.depositAddress ?? null;
    if (!depositAddress && !dry) {
      throw new IntentsQuoteError(
        "1Click quote response contained no depositAddress for a non-dry quote; " +
          "refusing to treat it as payable. Re-request the quote (it may have expired) " +
          "or check the request parameters.",
        { raw },
      );
    }

    return {
      depositAddress,
      depositMemo: quote.depositMemo ?? null,
      amountIn: quote.amountIn != null ? String(quote.amountIn) : null,
      amountOut: quote.amountOut != null ? String(quote.amountOut) : null,
      deadline: quote.deadline ?? raw?.quoteRequest?.deadline ?? effectiveDeadline,
      timeEstimate: typeof quote.timeEstimate === "number" ? quote.timeEstimate : null,
      dry: Boolean(dry),
      raw,
    };
  }

  /**
   * Poll the execution status of a quote via GET /v0/status.
   *
   * @param {string} depositAddress the depositAddress from a non-dry quote
   * @param {object} [options]
   * @param {string} [options.depositMemo] required by some chains (e.g.
   *   Stellar/TON) when the quote returned a depositMemo
   * @returns {Promise<{status: string, settled: boolean, terminal: boolean, raw: object}>}
   *   settled is true ONLY on SUCCESS (funds delivered to the recipient —
   *   the only status on which PayPerCall may release a call).
   *   terminal is true on SUCCESS / REFUNDED / FAILED (stop polling).
   *   Unknown future statuses are passed through upper-cased with
   *   settled=false, terminal=false, so new states never release a call.
   */
  async function getStatus(depositAddress, { depositMemo } = {}) {
    requireFields("getStatus", { depositAddress }, ["depositAddress"]);
    const query = new URLSearchParams({ depositAddress: String(depositAddress) });
    if (depositMemo) query.set("depositMemo", String(depositMemo));

    const raw = await request(`/v0/status?${query.toString()}`, { method: "GET" });
    const statusRaw = raw?.status ?? raw?.swapDetails?.status ?? null;
    if (typeof statusRaw !== "string" || !statusRaw) {
      throw new IntentsApiError("1Click status response did not contain a status field", {
        status: 200,
        body: raw,
      });
    }
    const status = statusRaw.toUpperCase();
    return {
      status,
      settled: status === "SUCCESS",
      terminal: TERMINAL_STATUSES.includes(status),
      raw,
    };
  }

  return { requestQuote, getStatus, baseUrl: base };
}

export default createIntentsClient;
