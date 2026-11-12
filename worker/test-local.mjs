// Local pre-deploy test for PayPerCall v2: runs the EXACT bundled worker in
// Node (shimmed Workers runtime) including REAL NEAR testnet transfers,
// on-chain registry reads, NEAR mainnet token scans, wallet X-rays and
// name checks (read-only). Demo-buyer secrets are read from the prototype's
// .demo-keys.json (0600) and injected as env — the same names the Worker
// secrets use in production. Purchases storage runs in "memory" mode here
// (no KV binding in Node); production uses KV — see ../README.md.
//
//   node test-local.mjs    ->  prints "LOCAL E2E GREEN" on success

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const keys = JSON.parse(
  readFileSync(path.join(here, "..", "..", "paypercall", ".demo-keys.json"), "utf8")
);

const env = {
  DEMO_BUYER_ACCOUNT_ID: keys.buyer.accountId,
  DEMO_BUYER_SECRET_KEY: keys.buyer.secretKey,
};

// --- minimal NEAR transfer signer for the manual-flow test -----------------
// (duplicates the worker's Borsh+ed25519 path on purpose: independent check)
import * as ed from "@noble/ed25519";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58d(s) {
  const b = [0];
  for (const c of s) {
    let carry = B58.indexOf(c);
    for (let i = 0; i < b.length; i++) { carry += b[i] * 58; b[i] = carry & 255; carry >>= 8; }
    while (carry) { b.push(carry & 255); carry >>= 8; }
  }
  let z = 0; while (z < s.length && s[z] === "1") z++;
  const out = new Uint8Array(z + b.length);
  for (let i = 0; i < b.length; i++) out[z + b.length - 1 - i] = b[i];
  return out;
}
function b58e(bytes) {
  const d = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < d.length; i++) { carry += d[i] << 8; d[i] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { d.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let z = 0; while (z < bytes.length && bytes[z] === 0) z++;
  return "1".repeat(z) + d.reverse().map((x) => B58[x]).join("");
}
async function rpcLocal(method, params) {
  const r = await fetch("https://rpc.testnet.near.org", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
async function sendTransferLocal(from, secret, to, yocto) {
  const raw = b58d(secret.replace(/^ed25519:/, ""));
  const seed = raw.slice(0, 32);
  const pub = await ed.getPublicKeyAsync(seed);
  const ak = await rpcLocal("query", {
    request_type: "view_access_key", finality: "final",
    account_id: from, public_key: "ed25519:" + b58e(pub),
  });
  const block = await rpcLocal("block", { finality: "final" });
  const parts = [];
  const push = (u) => parts.push(u);
  const str = (s) => { const e = new TextEncoder().encode(s); const l = new Uint8Array(4); new DataView(l.buffer).setUint32(0, e.length, true); push(l); push(e); };
  str(from);
  push(new Uint8Array([0])); push(pub);
  const nb = new Uint8Array(8); new DataView(nb.buffer).setBigUint64(0, BigInt(ak.nonce) + 1n, true); push(nb);
  str(to);
  push(b58d(block.header.hash));
  const one = new Uint8Array(4); new DataView(one.buffer).setUint32(0, 1, true); push(one);
  push(new Uint8Array([3]));
  const dep = new Uint8Array(16); let x = BigInt(yocto);
  for (let i = 0; i < 16; i++) { dep[i] = Number(x & 255n); x >>= 8n; }
  push(dep);
  const txLen = parts.reduce((n, p) => n + p.length, 0);
  const tx = new Uint8Array(txLen); let off = 0;
  for (const p of parts) { tx.set(p, off); off += p.length; }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", tx));
  const sig = await ed.signAsync(hash, seed);
  const signed = new Uint8Array(tx.length + 65);
  signed.set(tx, 0); signed[tx.length] = 0; signed.set(sig, tx.length + 1);
  let b64 = "";
  for (let i = 0; i < signed.length; i += 0x8000) b64 += String.fromCharCode.apply(null, signed.subarray(i, i + 0x8000));
  const res = await rpcLocal("broadcast_tx_commit", [btoa(b64)]);
  return res.transaction_outcome.id;
}

const worker = (await import("./dist/worker.js")).default;
const ORIGIN = "https://paypercall-v2.odemakindeezekiel5.workers.dev";
const REGISTRY = "paypercall-dev-t34qd7c9.testnet";
const USDT = "usdt.tether-token.near";
const WRAP = "wrap.near";
const FAKE = "fake-usdt.near"; // does not exist on mainnet
const SQUATTER = "usdt.near"; // exists, but is NOT the Tether contract
const SELLER = keys.seller.accountId;

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log((cond ? "  ok  " : " FAIL ") + label + (extra ? " — " + extra : ""));
  if (!cond) failures++;
};

async function call(method, p, body) {
  const req = new Request(ORIGIN + p, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

console.log("== GET / ==");
{
  const req = new Request(ORIGIN + "/");
  const res = await worker.fetch(req, env);
  const html = await res.text();
  check("status 200", res.status === 200);
  check("page mentions PayPerCall", html.includes("PayPerCall"));
  check("page names the registry contract", html.includes(REGISTRY));
  check("page pre-fills NEAR samples", html.includes(USDT) && html.includes(WRAP));
}

console.log("== GET /api/health ==");
{
  const { status, data } = await call("GET", "/api/health");
  check("status 200", status === 200);
  check("registry reported", data && data.registry_contract === REGISTRY);
  check("storage mode memory locally", data && data.purchases_storage === "memory", data && data.purchases_storage);
}

console.log("== GET /api/listings (from chain) ==");
let scanListing, xrayListing, nameListing;
{
  const { status, data } = await call("GET", "/api/listings");
  check("status 200", status === 200);
  check("at least 2 listings", Array.isArray(data) && data.length >= 2, Array.isArray(data) && String(data.length));
  scanListing = Array.isArray(data) && data.find((l) => l.name.includes("Token Safety Scan"));
  xrayListing = Array.isArray(data) && data.find((l) => l.name.includes("Wallet X-Ray"));
  nameListing = Array.isArray(data) && data.find((l) => l.name.includes("Name Checker"));
  check("scan listing from chain", !!scanListing, scanListing && scanListing.id);
  check("xray listing from chain", !!xrayListing, xrayListing && xrayListing.id);
  check("scan id is the seller's on-chain id", !!scanListing && scanListing.id === SELLER + "-2", scanListing && scanListing.id);
  check("xray id is the seller's on-chain id", !!xrayListing && xrayListing.id === SELLER + "-3", xrayListing && xrayListing.id);
  if (nameListing) {
    check("name id is the seller's on-chain id", nameListing.id === SELLER + "-4", nameListing.id);
    check("name price 0.001 NEAR", nameListing.price_near === "0.001");
  } else {
    console.log("  (name listing not on-chain yet — skipping name listing checks)");
  }
  check("prices mapped to 0.001 NEAR", !!scanListing && scanListing.price_near === "0.001" && !!xrayListing && xrayListing.price_near === "0.001");
  check("no example.com endpoints", Array.isArray(data) && !data.some((l) => (l.endpoint_url || "").includes("example.com")));
  check("no Phase A test listing", Array.isArray(data) && !data.some((l) => /Phase A/.test(l.name)));
}

console.log("== POST /api/listings is refused (listings are on-chain) ==");
{
  const { status } = await call("POST", "/api/listings", { name: "x" });
  check("405", status === 405, "status=" + status);
}

console.log("== GET /paid/token-scan (USDT, direct) ==");
{
  const { status, data } = await call("GET", "/paid/token-scan?contract=" + USDT);
  check("status 200", status === 200, JSON.stringify(data).slice(0, 200));
  check("name Tether USD", data && data.token_name === "Tether USD", data && data.token_name);
  check("verdict LOW RISK", data && data.verdict === "LOW RISK", data && data.verdict);
  check("holder count large", data && data.holder_count > 100000, String(data && data.holder_count));
}

console.log("== GET /paid/token-scan (squatter usdt.near) ==");
{
  const { status, data } = await call("GET", "/paid/token-scan?contract=" + SQUATTER);
  const flagged = status === 422 || (data && typeof data.verdict === "string" && data.verdict.includes("HIGH RISK"));
  check("flagged (422 or HIGH RISK)", flagged, "status=" + status + " verdict=" + (data && data.verdict));
}

console.log("== GET /paid/wallet-xray (wrap.near, mainnet, direct) ==");
{
  const { status, data } = await call("GET", "/paid/wallet-xray?account=" + WRAP);
  check("status 200", status === 200, JSON.stringify(data).slice(0, 240));
  check("account echoed", data && data.account === WRAP);
  check("network mainnet", data && data.network === "mainnet");
  check("has contract code", data && data.has_contract_code === true);
  check("balance present", !!data && typeof data.balance_near === "string" && /\d/.test(data.balance_near), data && data.balance_near);
  check("storage present", !!data && typeof data.storage_used_bytes === "number" && data.storage_used_bytes > 0);
  check("summary mentions account", !!data && typeof data.summary === "string" && data.summary.includes(WRAP));
  check("created_at from indexer", !!data && typeof data.created_at === "string" && data.created_at.startsWith("2021-02"), data && data.created_at);
  check("tx_count from indexer", !!data && typeof data.tx_count === "number" && data.tx_count > 1000000, String(data && data.tx_count));
}

console.log("== GET /paid/wallet-xray (seller, testnet, direct) ==");
{
  const { status, data } = await call("GET", "/paid/wallet-xray?account=" + SELLER);
  check("status 200", status === 200, JSON.stringify(data).slice(0, 200));
  check("network testnet", data && data.network === "testnet");
  check("summary present", !!data && typeof data.summary === "string" && data.summary.includes(SELLER));
}

console.log("== GET /paid/wallet-xray (fake + garbage) ==");
{
  const fake = await call("GET", "/paid/wallet-xray?account=" + FAKE);
  check("nonexistent -> clean 404", fake.status === 404, JSON.stringify(fake.data).slice(0, 160));
  const junk = await call("GET", "/paid/wallet-xray?account=NO WAY!!");
  check("garbage -> clean 400", junk.status === 400, JSON.stringify(junk.data).slice(0, 160));
}

console.log("== GET /paid/name-check (wrap.near taken, direct) ==");
{
  const { status, data } = await call("GET", "/paid/name-check?account=" + WRAP);
  check("status 200", status === 200, JSON.stringify(data).slice(0, 200));
  check("account echoed", data && data.account === WRAP);
  check("network mainnet", data && data.network === "mainnet");
  check("exists true", data && data.exists === true);
  check("available false", data && data.available === false);
  check("checked_at present", !!data && typeof data.checked_at === "string");
}

console.log("== GET /paid/name-check (free name, testnet, garbage) ==");
{
  const free = await call("GET", "/paid/name-check?account=definitely-not-a-real-name-xyz123.near");
  check("free name -> 200 exists false", free.status === 200 && free.data && free.data.exists === false && free.data.available === true, JSON.stringify(free.data).slice(0, 160));
  const tst = await call("GET", "/paid/name-check?account=" + SELLER);
  check("testnet seller exists", tst.status === 200 && tst.data && tst.data.exists === true && tst.data.network === "testnet", JSON.stringify(tst.data).slice(0, 160));
  const junk = await call("GET", "/paid/name-check?account=NO WAY!!");
  check("garbage -> clean 400", junk.status === 400, JSON.stringify(junk.data).slice(0, 160));
}

console.log("== POST /api/demo/buy (scan, USDT) — REAL testnet transfer ==");
{
  const { status, data } = await call("POST", "/api/demo/buy", {
    listing_id: scanListing.id,
    input: { contract: USDT },
  });
  check("status 200", status === 200, JSON.stringify(data).slice(0, 200));
  check("real tx hash", !!data.tx_hash && /^[A-Za-z0-9]{43,44}$/.test(data.tx_hash), data.tx_hash);
  const rep = data.result && data.result.body;
  check("report is Tether USD", !!rep && rep.token_name === "Tether USD", rep && rep.token_name);
  check("report verdict LOW RISK", !!rep && rep.verdict === "LOW RISK", rep && rep.verdict);
  console.log("  tx:", data.tx_hash, data.explorer_url || "");
}

console.log("== POST /api/demo/buy (xray, wrap.near) — REAL testnet transfer ==");
{
  const { status, data } = await call("POST", "/api/demo/buy", {
    listing_id: xrayListing.id,
    input: { account: WRAP },
  });
  check("status 200", status === 200, JSON.stringify(data).slice(0, 200));
  check("real tx hash", !!data.tx_hash && /^[A-Za-z0-9]{43,44}$/.test(data.tx_hash), data.tx_hash);
  const rep = data.result && data.result.body;
  check("xray account wrap.near", !!rep && rep.account === WRAP);
  check("xray summary present", !!rep && typeof rep.summary === "string" && rep.summary.includes(WRAP));
  console.log("  tx:", data.tx_hash, data.explorer_url || "");
}

console.log("== POST /api/demo/buy (garbage inputs spend nothing) ==");
{
  const bad1 = await call("POST", "/api/demo/buy", { listing_id: scanListing.id, input: { contract: "NOT A CONTRACT!!" } });
  check("scan garbage -> 400", bad1.status === 400 && !bad1.data.tx_hash);
  const bad2 = await call("POST", "/api/demo/buy", { listing_id: xrayListing.id, input: { account: FAKE } });
  check("xray nonexistent -> 404", bad2.status === 404 && !bad2.data.tx_hash, "status=" + bad2.status);
}

console.log("== POST /api/demo/buy (name-check, wrap.near taken) — REAL testnet transfer ==");
if (nameListing) {
  const { status, data } = await call("POST", "/api/demo/buy", {
    listing_id: nameListing.id,
    input: { account: WRAP },
  });
  check("status 200", status === 200, JSON.stringify(data).slice(0, 200));
  check("real tx hash", !!data.tx_hash && /^[A-Za-z0-9]{43,44}$/.test(data.tx_hash), data.tx_hash);
  const rep = data.result && data.result.body;
  check("name check wrap.near taken", !!rep && rep.account === WRAP && rep.exists === true && rep.available === false);
  console.log("  tx:", data.tx_hash, data.explorer_url || "");
} else {
  console.log("  (name listing not on-chain yet — skipping name-check demo buy)");
}

console.log("== Manual flow: purchase (xray, seller account) -> pay -> claim (REAL) ==");
{
  const { status, data: purchase } = await call("POST", "/api/purchase", {
    listing_id: xrayListing.id,
    buyer_account: keys.buyer.accountId,
    input: { account: SELLER },
  });
  check("purchase 201", status === 201, purchase && purchase.id);
  check("purchase stored input", !!purchase.input && purchase.input.account === SELLER);
  check("purchase price from chain", !!purchase && purchase.price_near === "0.001");

  const { status: bogusStatus } = await call(
    "POST",
    "/api/purchase/" + purchase.id + "/claim",
    { tx_hash: "11111111111111111111111111111111111111111111" }
  );
  check("bogus claim rejected 402", bogusStatus === 402);

  const txHash = await sendTransferLocal(
    keys.buyer.accountId,
    keys.buyer.secretKey,
    xrayListing.seller_account,
    "1000000000000000000000" // 0.001 NEAR in yocto
  );
  check("manual payment sent", /^[A-Za-z0-9]{43,44}$/.test(txHash), txHash);
  const { status: claimStatus, data: claim } = await call(
    "POST",
    "/api/purchase/" + purchase.id + "/claim",
    { tx_hash: txHash }
  );
  check("claim 200", claimStatus === 200, JSON.stringify(claim).slice(0, 200));
  const rep = claim.result && claim.result.body;
  check("claim returned xray of seller", !!rep && rep.account === SELLER && typeof rep.summary === "string");

  const { status: replayStatus } = await call(
    "POST",
    "/api/purchase/" + purchase.id + "/claim",
    { tx_hash: txHash }
  );
  check("replay rejected 409", replayStatus === 409);
}

console.log(failures === 0 ? "\nLOCAL E2E GREEN" : "\nLOCAL E2E FAILED (" + failures + ")");
process.exit(failures === 0 ? 0 : 1);
