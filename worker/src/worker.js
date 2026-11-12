// PayPerCall v2 — Cloudflare Worker (fetch handler), NEAR Hackathon entry.
//
// Paid API marketplace for AI agents on NEAR. What changed vs the demo
// worker (~/workspace/paypercall/worker-src):
//   * Listings are read LIVE from the on-chain registry contract
//     PayPerCallRegistry at paypercall-dev-t34qd7c9.testnet (NEAR testnet
//     RPC call_function get_listings, short in-memory cache). The chain is
//     the source of truth — there is no worker-side listing creation.
//   * Three real services, both served in-process after a verified payment:
//       - /paid/token-scan   NEAR Token Safety Scan (NEAR mainnet reads)
//       - /paid/wallet-xray  NEAR Wallet X-Ray (mainnet or testnet reads)
//       - /paid/name-check   NEAR Name Checker (mainnet or testnet reads)
//   * Purchases persist in a Cloudflare KV namespace when the PURCHASES
//     binding is present; otherwise they fall back to in-memory Maps
//     (demo-grade, per-isolate). Check /api/health for the live mode.
//
// Payments stay on NEAR testnet (plain transfers, verified on-chain via
// EXPERIMENTAL_tx_status, one call released per payment, replays 409).
// The paid services only READ chain state (mainnet/testnet RPC + public
// indexers) — they never move funds.
//
// Demo-buyer credentials come from Worker secrets ONLY:
//   DEMO_BUYER_ACCOUNT_ID, DEMO_BUYER_SECRET_KEY  (never in source)

import * as ed from "@noble/ed25519";
import { FRONTEND_HTML } from "./frontend.js";

const RPC_URL = "https://rpc.testnet.near.org"; // payments + registry (testnet)
const MAINNET_RPC_URL = "https://rpc.mainnet.near.org"; // service reads (mainnet)
const NEARBLOCKS_API = "https://api.nearblocks.io/v1"; // holder-count enrichment
const WORKER_ORIGIN = "https://paypercall-v2.odemakindeezekiel5.workers.dev";
const REGISTRY_CONTRACT = "paypercall-dev-t34qd7c9.testnet";
const TOKEN_SCAN_PATH = "/paid/token-scan";
const WALLET_XRAY_PATH = "/paid/wallet-xray";
const NAME_CHECK_PATH = "/paid/name-check";
const EXPLORER_TX = "https://testnet.nearblocks.io/txns/";
const NO_CODE_HASH = "11111111111111111111111111111111";

// ---------------------------------------------------------------------------
// Storage: KV (PERSISTENT) when bound, in-memory fallback otherwise.
// A purchase record: { id, listing_id, buyer_account, price_near,
// price_yocto, seller_account, status, claimed_tx_hash, input, created_at }
// ---------------------------------------------------------------------------

const memPurchases = new Map();
const memUsedTx = new Set();

function purchaseStore(env) {
  const kv = env && env.PURCHASES;
  if (kv && typeof kv.get === "function" && typeof kv.put === "function") {
    return {
      mode: "kv",
      async get(id) {
        const t = await kv.get("purchase:" + id);
        return t ? JSON.parse(t) : null;
      },
      async set(p) {
        await kv.put("purchase:" + p.id, JSON.stringify(p));
      },
      async txUsed(hash) {
        return (await kv.get("tx:" + hash)) !== null;
      },
      async txMark(hash, purchaseId) {
        await kv.put("tx:" + hash, purchaseId);
      },
    };
  }
  return {
    mode: "memory",
    async get(id) {
      return memPurchases.get(id) || null;
    },
    async set(p) {
      memPurchases.set(p.id, p);
    },
    async txUsed(hash) {
      return memUsedTx.has(hash);
    },
    async txMark(hash) {
      memUsedTx.add(hash);
    },
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const newId = (prefix) =>
  prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

const isValidNearAccount = (a) =>
  typeof a === "string" && a.length >= 2 && a.length <= 64 && /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(a);

// Strict NEAR account ID for token contracts: lowercase, dot-separated
// segments of [a-z0-9_-], each segment starting/ending alphanumeric, at
// least two segments (e.g. usdt.tether-token.near), 2-64 chars total.
const isNearAccountId = (s) => {
  if (typeof s !== "string" || s.length < 2 || s.length > 64) return false;
  if (s !== s.toLowerCase()) return false;
  const segs = s.split(".");
  if (segs.length < 2) return false;
  return segs.every((seg) => /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/.test(seg));
};

// Looser account ID for Wallet X-Ray targets: any valid NEAR account —
// named (one or more dot-separated segments, e.g. "near", "alice.testnet")
// or a 64-char hex implicit account.
const isNearAccountLoose = (s) => {
  if (typeof s !== "string" || s.length < 2 || s.length > 64) return false;
  if (/^[0-9a-f]{64}$/.test(s)) return true;
  if (s !== s.toLowerCase()) return false;
  return s.split(".").every((seg) => /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/.test(seg));
};

// "0.001" -> 1000000000000000000000n (yoctoNEAR)
function parseNearAmount(s) {
  const [intPart, fracRaw = ""] = String(s).split(".");
  const frac = (fracRaw + "0".repeat(24)).slice(0, 24);
  return BigInt(intPart || "0") * 10n ** 24n + BigInt(frac || "0");
}

// yoctoNEAR (string/BigInt) -> trimmed NEAR decimal string, e.g. "0.001"
function yoctoToNearString(yocto) {
  let v;
  try {
    v = BigInt(String(yocto));
  } catch {
    return null;
  }
  const scale = 10n ** 24n;
  const whole = v / scale;
  const frac = v % scale;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(24, "0").replace(/0+$/, "");
  return whole.toString() + "." + fracStr;
}

// Full-precision NEAR string capped at 4 fraction digits (display balances).
function yoctoToNearDisplay(yocto) {
  let v;
  try {
    v = BigInt(String(yocto));
  } catch {
    return null;
  }
  const scale = 10n ** 24n;
  const whole = v / scale;
  const frac4 = (v % scale) / 10n ** 20n;
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (frac4 === 0n) return wholeStr;
  return wholeStr + "." + frac4.toString().padStart(4, "0").replace(/0+$/, "");
}

// ---------------------------------------------------------------------------
// base58
// ---------------------------------------------------------------------------

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58decode(str) {
  const bytes = [0];
  for (const ch of str) {
    const idx = B58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base58 character");
    let carry = idx;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + bytes.length - 1 - i] = bytes[i];
  return out;
}

function b58encode(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

// ---------------------------------------------------------------------------
// NEAR RPC + transfer signing (Borsh + ed25519, no near-api-js)
// Payments use the TESTNET rpc; token scan / wallet x-ray read mainnet too.
// ---------------------------------------------------------------------------

async function rpc(method, params) {
  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "paypercall", method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error("NEAR RPC " + method + " failed: " + JSON.stringify(j.error));
  return j.result;
}

// JSON-RPC "query" against an arbitrary NEAR RPC endpoint, one retry.
// Throws an Error with .rpcError set when the node returns an RPC error.
async function queryRpc(rpcUrl, requestType, extra) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "paypercall/0.4" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "paypercall-query",
          method: "query",
          params: { request_type: requestType, finality: "final", ...extra },
        }),
      });
      const j = await r.json();
      if (j.error) {
        const err = new Error("RPC " + requestType + ": " + JSON.stringify(j.error));
        err.rpcError = j.error;
        throw err;
      }
      return j.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const isUnknownAccountError = (e) =>
  !!e && /does not exist|UNKNOWN_ACCOUNT/i.test(JSON.stringify(e.rpcError || e.message || e));

class BorshWriter {
  constructor() {
    this.parts = [];
  }
  push(u8) {
    this.parts.push(u8);
    return this;
  }
  u8(v) {
    return this.push(new Uint8Array([v & 0xff]));
  }
  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    return this.push(b);
  }
  u64(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
    return this.push(b);
  }
  u128(v) {
    const b = new Uint8Array(16);
    let x = BigInt(v);
    for (let i = 0; i < 16; i++) {
      b[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    return this.push(b);
  }
  bytes(arr) {
    return this.push(new Uint8Array(arr));
  }
  string(s) {
    const enc = new TextEncoder().encode(s);
    this.u32(enc.length);
    return this.push(enc);
  }
  finish() {
    const total = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

function demoKeypair(env) {
  const secret = env.DEMO_BUYER_SECRET_KEY;
  const accountId = env.DEMO_BUYER_ACCOUNT_ID;
  if (!secret || !accountId) throw new Error("demo buyer secrets are not configured");
  const raw = b58decode(secret.replace(/^ed25519:/, ""));
  if (raw.length < 32) throw new Error("demo buyer secret key is malformed");
  return { accountId, seed: raw.slice(0, 32) };
}

// Sends a plain NEAR transfer from the demo buyer. Returns the tx hash.
async function sendTransfer(env, receiverId, amountYocto) {
  const { accountId, seed } = demoKeypair(env);
  const pubKeyBytes = await ed.getPublicKeyAsync(seed);
  const pubKeyStr = "ed25519:" + b58encode(pubKeyBytes);

  const accessKey = await rpc("query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: accountId,
    public_key: pubKeyStr,
  });
  const block = await rpc("block", { finality: "final" });
  const blockHash = b58decode(block.header.hash);
  const nonce = BigInt(accessKey.nonce) + 1n;

  const tx = new BorshWriter()
    .string(accountId)
    .u8(0) // public key variant: ed25519
    .bytes(pubKeyBytes)
    .u64(nonce)
    .string(receiverId)
    .bytes(blockHash)
    .u32(1) // one action
    .u8(3) // action variant: Transfer
    .u128(amountYocto)
    .finish();

  const txHashBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", tx));
  const signature = await ed.signAsync(txHashBytes, seed);

  const signedTx = new BorshWriter()
    .bytes(tx)
    .u8(0) // signature variant: ed25519
    .bytes(signature)
    .finish();

  let b64 = "";
  const chunk = 0x8000;
  for (let i = 0; i < signedTx.length; i += chunk) {
    b64 += String.fromCharCode.apply(null, signedTx.subarray(i, i + chunk));
  }
  const result = await rpc("broadcast_tx_commit", [btoa(b64)]);
  const hash = result && result.transaction_outcome && result.transaction_outcome.id;
  if (!hash) throw new Error("broadcast_tx_commit returned no transaction hash");
  return hash;
}

// Verify a NEAR testnet transfer on-chain.
async function verifyTransfer({ txHash, buyerAccount, sellerAccount, priceNear }) {
  let outcome;
  try {
    outcome = await rpc("EXPERIMENTAL_tx_status", [txHash, buyerAccount]);
  } catch {
    return { ok: false, reason: "transaction not found on NEAR testnet" };
  }
  const status =
    outcome.transaction_outcome && outcome.transaction_outcome.outcome
      ? outcome.transaction_outcome.outcome.status
      : undefined;
  if (status && typeof status === "object" && "Failure" in status) {
    return { ok: false, reason: "transaction failed on-chain" };
  }
  const tx = outcome.transaction || {};
  if (tx.signer_id !== buyerAccount) {
    return { ok: false, reason: "signer " + tx.signer_id + " does not match buyer " + buyerAccount };
  }
  if (tx.receiver_id !== sellerAccount) {
    return { ok: false, reason: "receiver " + tx.receiver_id + " does not match seller " + sellerAccount };
  }
  const expected = parseNearAmount(priceNear);
  let transferred = 0n;
  for (const action of tx.actions || []) {
    if (action && action.Transfer && action.Transfer.deposit) {
      transferred += BigInt(action.Transfer.deposit);
    }
  }
  if (transferred < expected) {
    return { ok: false, reason: "transferred amount is below the price " + priceNear + " NEAR" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// On-chain listings (PayPerCallRegistry, NEAR testnet)
// ---------------------------------------------------------------------------

let listingsCache = { at: 0, items: null };
const LISTINGS_CACHE_TTL_MS = 30 * 1000;

async function fetchChainListings() {
  const res = await queryRpc(RPC_URL, "call_function", {
    account_id: REGISTRY_CONTRACT,
    method_name: "get_listings",
    args_base64: "e30=",
  });
  if (!res || !Array.isArray(res.result)) {
    throw new Error("registry get_listings returned no result bytes");
  }
  const raw = JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)));
  const items = raw
    .filter((l) => l && l.active === true)
    // Belt-and-braces: never surface placeholder/test endpoints.
    .filter((l) => typeof l.endpoint_url === "string" && !l.endpoint_url.includes("example.com"))
    .map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      endpoint_url: l.endpoint_url,
      price_yocto: String(l.price_yocto),
      price_near: yoctoToNearString(l.price_yocto),
      seller_account: l.seller,
      source: "on-chain registry " + REGISTRY_CONTRACT,
    }));
  return items;
}

// Chain is the source of truth; a short cache only smooths RPC latency.
// On RPC failure we serve the last good cache if we have one, else throw.
async function getListings() {
  const now = Date.now();
  if (listingsCache.items && now - listingsCache.at < LISTINGS_CACHE_TTL_MS) {
    return listingsCache.items;
  }
  try {
    const items = await fetchChainListings();
    listingsCache = { at: now, items };
    return items;
  } catch (e) {
    if (listingsCache.items) return listingsCache.items;
    throw e;
  }
}

async function findListing(id) {
  const items = await getListings();
  return items.find((l) => l.id === id) || null;
}

// ---------------------------------------------------------------------------
// NEAR Token Safety Scan (mainnet, read-only)
// ---------------------------------------------------------------------------

// Known-token registry. Every entry was verified live against NEAR mainnet
// RPC (view_account + ft_metadata + ft_total_supply) on 2026-10-20.
const KNOWN_TOKENS = {
  "wrap.near": { label: "Wrapped NEAR", symbol: "wNEAR" },
  "usdt.tether-token.near": { label: "Tether USD", symbol: "USDt" },
  "token.v2.ref-finance.near": { label: "Ref Finance Token", symbol: "REF" },
};

const normTokenText = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// True when a token's metadata (or squatted account name) imitates a
// registry token while the contract is NOT the registry contract.
function impersonationOf(contractId, meta) {
  for (const [regId, reg] of Object.entries(KNOWN_TOKENS)) {
    if (regId === contractId) continue;
    const regSymbol = normTokenText(reg.symbol);
    const regName = normTokenText(reg.label);
    if (meta) {
      const sym = normTokenText(meta.symbol);
      const name = normTokenText(meta.name);
      if (sym && sym === regSymbol) return reg;
      if (name && (name === regName || (name.length >= 4 && regName.includes(name)) || name.includes(regName))) {
        return reg;
      }
    }
    // Account-name squatting, e.g. usdt.near or tether.near.
    const firstLabel = normTokenText(contractId.split(".")[0]);
    if (firstLabel && (firstLabel === regSymbol || firstLabel === "tether" && regSymbol === "usdt")) {
      return reg;
    }
  }
  return null;
}

const scanCache = new Map(); // account id -> { at, result } (200s only)
const SCAN_CACHE_TTL_MS = 5 * 60 * 1000;

// call_function returning parsed JSON, or null when the call fails / the
// method is missing / the result is not JSON (all common for fake tokens).
async function callFunctionJson(accountId, methodName) {
  try {
    const res = await queryRpc(MAINNET_RPC_URL, "call_function", {
      account_id: accountId,
      method_name: methodName,
      args_base64: "e30=",
    });
    if (!res || !Array.isArray(res.result)) return null;
    return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)));
  } catch {
    return null;
  }
}

async function nearblocksHolderCount(accountId) {
  // api.nearblocks.io sometimes refuses Cloudflare egress IPs; api3 is the
  // same index on a different host — try both, degrade to null.
  for (const base of [NEARBLOCKS_API, "https://api3.nearblocks.io/v1"]) {
    try {
      const r = await fetch(base + "/fts/" + accountId + "/holders/count", {
        headers: { accept: "application/json", "user-agent": "paypercall/0.4" },
      });
      if (!r.ok) continue;
      const j = await r.json();
      const n = j && Array.isArray(j.holders) && j.holders[0] ? Number(j.holders[0].count) : NaN;
      if (Number.isFinite(n)) return n;
    } catch {
      /* try the next host */
    }
  }
  return null;
}

function humanizeSupply(supplyRaw, decimals) {
  if (supplyRaw === null || supplyRaw === undefined) return null;
  let v;
  try {
    v = BigInt(String(supplyRaw));
  } catch {
    return null;
  }
  const d = Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 0;
  const scale = 10n ** BigInt(d);
  const whole = v / scale;
  const frac = v % scale;
  let s = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (frac > 0n && d > 0) {
    const fracStr = frac.toString().padStart(d, "0").slice(0, 2).replace(/0+$/, "");
    if (fracStr) s += "." + fracStr;
  }
  return s;
}

// Returns { status, body } — never throws for unknown/fake tokens.
async function tokenScan(contractId) {
  if (!isNearAccountId(contractId || "")) {
    return {
      status: 400,
      body: {
        error:
          "invalid NEAR account ID — expected a lowercase token contract like usdt.tether-token.near (letters, digits, dots, dashes, underscores)",
        contract: contractId ?? null,
      },
    };
  }
  const cached = scanCache.get(contractId);
  if (cached && Date.now() - cached.at < SCAN_CACHE_TTL_MS) return cached.result;

  // 1. Contract existence + deployed code.
  let account;
  try {
    account = await queryRpc(MAINNET_RPC_URL, "view_account", { account_id: contractId });
  } catch (e) {
    if (isUnknownAccountError(e)) {
      return {
        status: 404,
        body: { error: "account does not exist on NEAR mainnet", contract: contractId },
      };
    }
    return {
      status: 502,
      body: { error: "NEAR mainnet RPC is unavailable right now — try again in a minute", contract: contractId },
    };
  }
  const codeHash = typeof account.code_hash === "string" ? account.code_hash : null;
  const hasCode = !!codeHash && codeHash !== NO_CODE_HASH;
  if (!hasCode) {
    return {
      status: 422,
      body: {
        error: "account exists on NEAR mainnet but has NO contract code deployed — it is not a token contract",
        contract: contractId,
      },
    };
  }

  // 2. Token metadata + supply (parallel) and holder count enrichment.
  const [metaRaw, supplyRaw, holderCount] = await Promise.all([
    callFunctionJson(contractId, "ft_metadata"),
    callFunctionJson(contractId, "ft_total_supply"),
    nearblocksHolderCount(contractId),
  ]);

  const meta =
    metaRaw && typeof metaRaw === "object" && typeof metaRaw.symbol === "string"
      ? metaRaw
      : null;
  const totalSupplyRaw =
    typeof supplyRaw === "string" && /^\d+$/.test(supplyRaw) ? supplyRaw : null;

  const flags = [];
  let score = 100;

  const registry = KNOWN_TOKENS[contractId] || null;
  const impersonated = impersonationOf(contractId, meta);

  if (registry) {
    flags.push("Known token: this is the canonical " + registry.label + " (" + registry.symbol + ") contract");
  }
  if (impersonated) {
    score = Math.min(score, 8);
    flags.push(
      "Possible impersonation of " + impersonated.label + " (" + impersonated.symbol +
      ") — the real contract is a different account; this one only copies the name/symbol"
    );
  }
  if (!meta) {
    score -= 55;
    flags.push("No valid ft_metadata: the contract does not answer the standard NEAR fungible-token metadata call");
  } else {
    if (meta.spec && meta.spec !== "ft-1.0.0") {
      score -= 10;
      flags.push("Non-standard metadata spec: " + String(meta.spec));
    }
    if (!Number.isInteger(meta.decimals) || meta.decimals < 0 || meta.decimals > 24) {
      score -= 10;
      flags.push("Unusual decimals value: " + String(meta.decimals));
    }
  }
  if (totalSupplyRaw === null) {
    score -= 10;
    flags.push("ft_total_supply did not return a value");
  } else if (totalSupplyRaw === "0") {
    score -= 25;
    flags.push("Total supply is zero — the token is not in circulation");
  }
  if (holderCount === null) {
    flags.push("Holder count unavailable from the indexer right now");
  } else if (holderCount < 10) {
    score -= 15;
    flags.push("Very few holders: " + holderCount);
  } else if (holderCount < 100) {
    score -= 5;
    flags.push("Small holder base: " + holderCount);
  }

  if (registry && !impersonated) score = 100;
  score = Math.max(0, Math.min(100, score));
  let verdict;
  if (impersonated) verdict = "HIGH RISK — possible impersonation";
  else if (score >= 75) verdict = "LOW RISK";
  else if (score >= 45) verdict = "CAUTION";
  else verdict = "HIGH RISK";

  const result = {
    status: 200,
    body: {
      contract: contractId,
      chain: "near",
      network: "mainnet",
      contract_exists: true,
      has_contract_code: hasCode,
      code_hash: codeHash,
      token_name: meta ? meta.name || null : null,
      token_symbol: meta ? meta.symbol || null : null,
      token_decimals: meta && Number.isInteger(meta.decimals) ? meta.decimals : null,
      metadata_spec: meta ? meta.spec || null : null,
      total_supply_raw: totalSupplyRaw,
      total_supply: humanizeSupply(totalSupplyRaw, meta ? meta.decimals : null),
      holder_count: holderCount,
      known_token: !!registry,
      registry_match: registry ? registry.label + " (" + registry.symbol + ")" : null,
      impersonation_suspect: !!impersonated,
      impersonates: impersonated ? impersonated.label + " (" + impersonated.symbol + ")" : null,
      risk_score: score,
      verdict,
      flags,
      source: "NEAR mainnet RPC (view_account, ft_metadata, ft_total_supply) + NearBlocks holder index",
      scanned_at: new Date().toISOString(),
    },
  };
  scanCache.set(contractId, { at: Date.now(), result });
  return result;
}

// ---------------------------------------------------------------------------
// NEAR Wallet X-Ray (mainnet or testnet, read-only)
// ---------------------------------------------------------------------------

const xrayCache = new Map(); // account id -> { at, result } (200s only)
const XRAY_CACHE_TTL_MS = 60 * 1000;

function nearblocksBases(network) {
  return network === "testnet"
    ? ["https://api-testnet.nearblocks.io/v1"]
    : [NEARBLOCKS_API, "https://api3.nearblocks.io/v1"];
}

// Best-effort indexer enrichment: creation time + transaction count.
// NearBlocks refuses some shared egress IPs — any failure just yields
// nulls and the report labels the fields unavailable. Never throws.
async function nearblocksAccountInfo(accountId, network) {
  const out = { created_at: null, created_tx_hash: null, tx_count: null };
  for (const base of nearblocksBases(network)) {
    try {
      const r = await fetch(base + "/account/" + accountId, {
        headers: { accept: "application/json", "user-agent": "paypercall/0.4" },
      });
      if (!r.ok) continue;
      const text = await r.text();
      // block_timestamp is a nanosecond integer too big for JSON.parse
      // precision games at the edges — pull the raw digits out as text.
      const m = text.match(/"created"\s*:\s*\{[^}]*"block_timestamp"\s*:\s*"?(\d+)"?/);
      if (m) {
        const ms = BigInt(m[1]) / 1000000n;
        out.created_at = new Date(Number(ms)).toISOString();
      }
      const tm = text.match(/"created"\s*:\s*\{[^}]*"transaction_hash"\s*:\s*"([^"]+)"/);
      if (tm) out.created_tx_hash = tm[1];
      break;
    } catch {
      /* try the next host */
    }
  }
  for (const base of nearblocksBases(network)) {
    try {
      const r = await fetch(base + "/account/" + accountId + "/txns/count", {
        headers: { accept: "application/json", "user-agent": "paypercall/0.4" },
      });
      if (!r.ok) continue;
      const j = await r.json();
      const n = j && Array.isArray(j.txns) && j.txns[0] ? Number(j.txns[0].count) : NaN;
      if (Number.isFinite(n)) out.tx_count = n;
      break;
    } catch {
      /* try the next host */
    }
  }
  return out;
}

// Returns { status, body } — never throws for unknown accounts.
async function walletXray(accountIdRaw) {
  const accountId = typeof accountIdRaw === "string" ? accountIdRaw.trim() : "";
  if (!isNearAccountLoose(accountId)) {
    return {
      status: 400,
      body: {
        error:
          "invalid NEAR account ID — expected an account like wrap.near or alice.testnet, or a 64-char hex implicit account",
        account: accountIdRaw ?? null,
      },
    };
  }
  const cached = xrayCache.get(accountId);
  if (cached && Date.now() - cached.at < XRAY_CACHE_TTL_MS) return cached.result;

  const network = accountId.endsWith(".testnet") ? "testnet" : "mainnet";
  const rpcUrl = network === "testnet" ? RPC_URL : MAINNET_RPC_URL;

  let account;
  try {
    account = await queryRpc(rpcUrl, "view_account", { account_id: accountId });
  } catch (e) {
    if (isUnknownAccountError(e)) {
      return {
        status: 404,
        body: { error: "account does not exist on NEAR " + network, account: accountId, network },
      };
    }
    return {
      status: 502,
      body: { error: "NEAR " + network + " RPC is unavailable right now — try again in a minute", account: accountId, network },
    };
  }

  const balanceYocto = String(account.amount ?? "0");
  const lockedYocto = String(account.locked ?? "0");
  const storageUsed = Number.isFinite(account.storage_usage) ? account.storage_usage : null;
  // NEAR storage costs 10^19 yocto per byte (1 NEAR per 100 KB).
  const storageCostYocto =
    storageUsed !== null ? (BigInt(storageUsed) * 10n ** 19n).toString() : null;
  const codeHash = typeof account.code_hash === "string" ? account.code_hash : null;
  const hasCode = !!codeHash && codeHash !== NO_CODE_HASH;

  const info = await nearblocksAccountInfo(accountId, network);

  const balanceNear = yoctoToNearDisplay(balanceYocto);
  const lockedNear = yoctoToNearDisplay(lockedYocto);
  const storageKb = storageUsed !== null ? (storageUsed / 1024).toFixed(1) : null;
  const createdDate = info.created_at ? info.created_at.slice(0, 10) : null;

  let summary =
    accountId + " is a NEAR " + network + " account holding " + balanceNear + " NEAR";
  if (lockedYocto !== "0") summary += " (" + lockedNear + " NEAR locked/staked)";
  summary +=
    ", using " + (storageKb !== null ? storageKb + " KB" : "an unknown amount") +
    " of storage, " + (hasCode ? "with a smart contract deployed" : "with no contract code");
  if (createdDate) summary += ", created " + createdDate;
  if (info.tx_count !== null) {
    summary += ", with " + info.tx_count.toLocaleString("en-US") + " transactions";
  }
  summary += ".";

  const flags = [];
  if (info.created_at === null) flags.push("Creation time unavailable from the indexer right now");
  if (info.tx_count === null) flags.push("Transaction count unavailable from the indexer right now");

  const result = {
    status: 200,
    body: {
      account: accountId,
      chain: "near",
      network,
      exists: true,
      balance_near: balanceNear,
      balance_yocto: balanceYocto,
      locked_near: lockedNear,
      locked_yocto: lockedYocto,
      storage_used_bytes: storageUsed,
      storage_cost_near: storageCostYocto ? yoctoToNearDisplay(storageCostYocto) : null,
      has_contract_code: hasCode,
      code_hash: codeHash,
      created_at: info.created_at,
      created_tx_hash: info.created_tx_hash,
      tx_count: info.tx_count,
      summary,
      flags,
      source:
        "NEAR " + network + " RPC (view_account)" +
        (info.created_at !== null || info.tx_count !== null ? " + NearBlocks account index" : ""),
      scanned_at: new Date().toISOString(),
    },
  };
  xrayCache.set(accountId, { at: Date.now(), result });
  return result;
}

// ---------------------------------------------------------------------------
// NEAR Name Checker: is a NEAR account name taken or free?
// Reads view_account on mainnet (.near etc.) or testnet (.testnet),
// mirroring walletXray's network pick. A missing account is a clean
// "free" result, not an error — and no indexer is involved, so this
// never degrades on the live Worker the way NearBlocks fields do.
// Returns { status, body } like the other services.
// ---------------------------------------------------------------------------
async function nameCheck(accountIdRaw) {
  const accountId = typeof accountIdRaw === "string" ? accountIdRaw.trim() : "";
  if (!isNearAccountLoose(accountId)) {
    return {
      status: 400,
      body: {
        error:
          "invalid NEAR account ID — expected a lowercase account name like alice.near or bob.testnet (2-64 chars, letters, digits, -, _, .)",
        account: accountIdRaw ?? null,
      },
    };
  }
  const network = accountId.endsWith(".testnet") ? "testnet" : "mainnet";
  const rpcUrl = network === "testnet" ? RPC_URL : MAINNET_RPC_URL;

  let exists;
  try {
    await queryRpc(rpcUrl, "view_account", { account_id: accountId });
    exists = true;
  } catch (e) {
    if (isUnknownAccountError(e)) {
      exists = false;
    } else {
      return {
        status: 502,
        body: { error: "NEAR " + network + " RPC is unavailable right now — try again in a minute", account: accountId, network },
      };
    }
  }

  return {
    status: 200,
    body: {
      account: accountId,
      chain: "near",
      network,
      exists,
      available: !exists,
      source: "NEAR " + network + " RPC (view_account)",
      checked_at: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Input handling + serving
// ---------------------------------------------------------------------------

const isScanListing = (listing) =>
  typeof listing.endpoint_url === "string" && listing.endpoint_url.includes(TOKEN_SCAN_PATH);
const isXrayListing = (listing) =>
  typeof listing.endpoint_url === "string" && listing.endpoint_url.includes(WALLET_XRAY_PATH);
const isNameCheckListing = (listing) =>
  typeof listing.endpoint_url === "string" && listing.endpoint_url.includes(NAME_CHECK_PATH);

function sanitizeInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

// For listings that need input, validate BEFORE any payment is taken and
// pre-flight the actual service so un-payable requests fail clean.
// Returns { status, body } error or null when fine.
async function validateListingInput(listing, input) {
  if (isScanListing(listing)) {
    const contract = input.contract || input.address;
    if (!contract) {
      return { status: 400, body: { error: "this endpoint needs input.contract — the NEAR token contract account ID to scan, e.g. usdt.tether-token.near" } };
    }
    if (!isNearAccountId(contract)) {
      return { status: 400, body: { error: "invalid NEAR account ID — expected a lowercase token contract like usdt.tether-token.near", contract } };
    }
    const pre = await tokenScan(contract);
    if (pre.status !== 200) return pre;
    return null;
  }
  if (isXrayListing(listing)) {
    const account = input.account;
    if (!account) {
      return { status: 400, body: { error: "this endpoint needs input.account — the NEAR account ID to X-ray, e.g. wrap.near or alice.testnet" } };
    }
    if (!isNearAccountLoose(account)) {
      return { status: 400, body: { error: "invalid NEAR account ID — expected an account like wrap.near or alice.testnet", account } };
    }
    const pre = await walletXray(account);
    if (pre.status !== 200) return pre;
    return null;
  }
  if (isNameCheckListing(listing)) {
    const account = input.account;
    if (!account) {
      return { status: 400, body: { error: "this endpoint needs input.account — the NEAR account name to check, e.g. alice.near or bob.testnet" } };
    }
    if (!isNearAccountLoose(account)) {
      return { status: 400, body: { error: "invalid NEAR account ID — expected a lowercase account name like alice.near", account } };
    }
    // nameCheck returns 200 for taken AND free names (both are valid
    // results), so a pre-flight pass here only fails on bad input or
    // an unavailable RPC — never on a name being taken.
    const pre = await nameCheck(account);
    if (pre.status !== 200) return pre;
    return null;
  }
  return null;
}

// Serve exactly ONE call for a paid purchase (input merged as query
// params). Our own paid services run in-process — never via a
// self-subrequest to our own workers.dev origin (edge 404 quirk).
// External seller endpoints proxy normally via fetch.
async function serveCall(listing, input) {
  const url = new URL(listing.endpoint_url);
  for (const [k, v] of Object.entries(input || {})) url.searchParams.set(k, v);

  if (url.pathname === TOKEN_SCAN_PATH) {
    return tokenScan(url.searchParams.get("contract") || url.searchParams.get("address"));
  }
  if (url.pathname === WALLET_XRAY_PATH) {
    return walletXray(url.searchParams.get("account"));
  }
  if (url.pathname === NAME_CHECK_PATH) {
    return nameCheck(url.searchParams.get("account"));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(url.toString(), {
      method: "GET",
      signal: controller.signal,
      headers: { "user-agent": "paypercall/0.4" },
    });
    const text = await r.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* keep raw text */ }
    return { status: r.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handlePurchase(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: "invalid JSON body" }, 400);
  const listing = await findListing(body.listing_id);
  if (!listing) return json({ error: "listing not found in the on-chain registry" }, 404);
  if (!isValidNearAccount(body.buyer_account)) {
    return json({ error: "buyer_account must be a valid NEAR account id" }, 400);
  }
  const input = sanitizeInput(body.input);
  const invalid = await validateListingInput(listing, input);
  if (invalid) return json(invalid.body, invalid.status);

  const purchase = {
    id: newId("pay"),
    listing_id: listing.id,
    buyer_account: body.buyer_account,
    price_near: listing.price_near,
    price_yocto: listing.price_yocto,
    seller_account: listing.seller_account,
    status: "pending",
    claimed_tx_hash: null,
    input,
    created_at: new Date().toISOString(),
  };
  await purchaseStore(env).set(purchase);
  return json(
    {
      ...purchase,
      instructions: [
        "Send exactly " + listing.price_near + " NEAR (testnet) from " + body.buyer_account + " to " + listing.seller_account + ".",
        "Use a plain native transfer from your wallet or near-cli.",
        'Once sent, POST the transaction hash to /api/purchase/' + purchase.id + '/claim as { "tx_hash": "<hash>" }.',
      ],
    },
    201
  );
}

async function runClaim(env, purchase, listing, txHash) {
  const store = purchaseStore(env);
  if (purchase.status === "consumed") {
    return json({ error: "purchase already claimed (replay rejected)" }, 409);
  }
  if (await store.txUsed(txHash)) {
    return json({ error: "this transaction hash was already used for another purchase" }, 409);
  }
  const verified = await verifyTransfer({
    txHash,
    buyerAccount: purchase.buyer_account,
    sellerAccount: purchase.seller_account,
    priceNear: purchase.price_near,
  });
  if (!verified.ok) {
    return json({ error: "payment verification failed", detail: verified.reason }, 402);
  }
  let upstream;
  try {
    upstream = await serveCall(listing, purchase.input);
  } catch (err) {
    return json({ error: "seller endpoint unreachable", detail: String(err && err.message || err) }, 502);
  }
  purchase.status = "consumed";
  purchase.claimed_tx_hash = txHash;
  await store.set(purchase);
  await store.txMark(txHash, purchase.id);
  return json({ purchase_id: purchase.id, result: upstream });
}

async function handleClaim(req, env, purchaseId) {
  const body = await req.json().catch(() => null);
  const txHash = body && body.tx_hash;
  if (typeof txHash !== "string" || !/^[A-Za-z0-9]{43,44}$/.test(txHash)) {
    return json({ error: "tx_hash must be a base58 NEAR transaction hash" }, 400);
  }
  const purchase = await purchaseStore(env).get(purchaseId);
  if (!purchase) return json({ error: "purchase not found" }, 404);
  const listing = await findListing(purchase.listing_id);
  if (!listing) return json({ error: "listing for this purchase no longer exists in the registry" }, 410);
  return runClaim(env, purchase, listing, txHash);
}

// One-tap demo buy: the worker pays with the demo buyer wallet, verifies its
// own payment on-chain, serves the call, and returns everything in one go.
async function handleDemoBuy(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: "invalid JSON body" }, 400);
  const listing = await findListing(body.listing_id);
  if (!listing) return json({ error: "listing not found in the on-chain registry" }, 404);

  const input = sanitizeInput(body.input);
  const invalid = await validateListingInput(listing, input);
  if (invalid) return json(invalid.body, invalid.status);

  let buyerAccount;
  try {
    buyerAccount = demoKeypair(env).accountId;
  } catch (err) {
    return json({ error: "demo buy unavailable", detail: String(err && err.message || err) }, 500);
  }

  const purchase = {
    id: newId("pay"),
    listing_id: listing.id,
    buyer_account: buyerAccount,
    price_near: listing.price_near,
    price_yocto: listing.price_yocto,
    seller_account: listing.seller_account,
    status: "pending",
    claimed_tx_hash: null,
    input,
    created_at: new Date().toISOString(),
  };
  await purchaseStore(env).set(purchase);

  let txHash;
  try {
    txHash = await sendTransfer(env, listing.seller_account, parseNearAmount(listing.price_near));
  } catch (err) {
    return json({ error: "demo payment failed", detail: String(err && err.message || err) }, 502);
  }

  const claimRes = await runClaim(env, purchase, listing, txHash);
  const claimBody = await claimRes.json().catch(() => ({}));
  if (!claimRes.ok) {
    return json({ ...claimBody, tx_hash: txHash }, claimRes.status);
  }
  return json({
    purchase_id: purchase.id,
    tx_hash: txHash,
    explorer_url: EXPLORER_TX + txHash,
    result: claimBody.result,
    buyer: buyerAccount,
    paid_near: listing.price_near,
  });
}

// ---------------------------------------------------------------------------
// Fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/") {
        return new Response(FRONTEND_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (req.method === "GET" && path === "/api/health") {
        return json({
          ok: true,
          base_url: WORKER_ORIGIN,
          registry_contract: REGISTRY_CONTRACT,
          listings_source: "on-chain",
          purchases_storage: purchaseStore(env).mode,
        });
      }
      if (req.method === "GET" && path === "/api/listings") {
        try {
          return json(await getListings());
        } catch {
          return json({ error: "on-chain registry is unavailable right now — try again in a minute" }, 502);
        }
      }
      if (req.method === "POST" && path === "/api/listings") {
        return json(
          {
            error:
              "listings live on-chain — register by calling register_listing on the PayPerCallRegistry contract (" +
              REGISTRY_CONTRACT + ") from the seller account",
          },
          405
        );
      }
      if (req.method === "POST" && path === "/api/purchase") {
        return handlePurchase(req, env);
      }
      if (req.method === "POST" && path === "/api/demo/buy") {
        return handleDemoBuy(req, env);
      }
      const claimMatch = path.match(/^\/api\/purchase\/([^/]+)\/claim$/);
      if (req.method === "POST" && claimMatch) {
        return handleClaim(req, env, claimMatch[1]);
      }
      if (req.method === "GET" && path === TOKEN_SCAN_PATH) {
        const { status, body } = await tokenScan(
          url.searchParams.get("contract") || url.searchParams.get("address")
        );
        return json(body, status);
      }
      if (req.method === "GET" && path === WALLET_XRAY_PATH) {
        const { status, body } = await walletXray(url.searchParams.get("account"));
        return json(body, status);
      }
      if (req.method === "GET" && path === NAME_CHECK_PATH) {
        const { status, body } = await nameCheck(url.searchParams.get("account"));
        return json(body, status);
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: "internal error", detail: String(err && err.message || err) }, 500);
    }
  },
};
