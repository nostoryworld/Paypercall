#!/usr/bin/env node
// Autonomous agent buyer for PayPerCall — NO human clicks.
//
// The agent:
//   1. uses its own NEAR testnet account (created once via the public
//      faucet; key in .keys/agent-buyer.json, 0600, gitignored),
//   2. reads listings straight from the on-chain PayPerCallRegistry,
//   3. picks the Token Safety Scan, creates a purchase on the v2 worker,
//   4. signs and sends the NEAR payment transfer itself,
//   5. claims with the tx hash and prints the scan report.
//
// Usage: node scripts/agent-buyer.mjs [token-contract-to-scan]
//   default target: usdt.tether-token.near
// Env:   PPC_V2_URL — worker base URL (default the deployed paypercall-v2)

import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire("/home/hatch/workspace/paypercall/package.json");
const { connect, keyStores, utils } = require("near-api-js");

const here = path.dirname(fileURLToPath(import.meta.url));
const KEYS_FILE = path.join(here, "..", ".keys", "agent-buyer.json");
const REGISTRY = "paypercall-dev-t34qd7c9.testnet";
const WORKER_URL =
  process.env.PPC_V2_URL || "https://paypercall-v2.odemakindeezekiel5.workers.dev";
const FAUCET_URL = "https://helper.testnet.near.org/account";
const TARGET = process.argv[2] || "usdt.tether-token.near";
const EXPLORER = "https://testnet.nearblocks.io/txns/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 10);

async function ensureAgentAccount() {
  if (existsSync(KEYS_FILE)) {
    const rec = JSON.parse(readFileSync(KEYS_FILE, "utf8"));
    console.log("agent account (existing):", rec.accountId);
    return rec;
  }
  const accountId = "ppc-agent-" + rand() + ".testnet";
  const keyPair = utils.KeyPair.fromRandom("ed25519");
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(FAUCET_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          newAccountId: accountId,
          newAccountPublicKey: keyPair.getPublicKey().toString(),
        }),
      });
      if (res.ok) {
        const rec = { accountId, secretKey: keyPair.toString() };
        writeFileSync(KEYS_FILE, JSON.stringify(rec, null, 2));
        chmodSync(KEYS_FILE, 0o600);
        console.log("agent account (created via faucet):", accountId);
        return rec;
      }
      console.log("faucet attempt", attempt, "->", res.status);
    } catch (e) {
      console.log("faucet attempt", attempt, "error:", e.message);
    }
    await sleep(5000 * attempt);
  }
  throw new Error("could not create the agent testnet account (faucet)");
}

async function connectAccount({ accountId, secretKey }) {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey("testnet", accountId, utils.KeyPair.fromString(secretKey));
  const near = await connect({
    networkId: "testnet",
    keyStore,
    nodeUrl: "https://rpc.testnet.near.org",
  });
  return near.account(accountId);
}

async function workerPost(pathname, body) {
  const res = await fetch(WORKER_URL + pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  const creds = await ensureAgentAccount();
  const agent = await connectAccount(creds);
  const state = await agent.state();
  console.log(
    "agent balance:",
    utils.format.formatNearAmount(state.amount, 4),
    "NEAR"
  );

  // 1. Listings from the on-chain registry (chain is the source of truth).
  const listings = await agent.viewFunction({
    contractId: REGISTRY,
    methodName: "get_listings",
    args: {},
  });
  const active = listings.filter((l) => l.active);
  console.log("active listings on-chain:", active.length);
  const scan = active.find((l) => l.name.includes("Token Safety Scan"));
  if (!scan) throw new Error("Token Safety Scan listing not found on-chain");
  console.log(
    "picked:",
    scan.name,
    "| id:",
    scan.id,
    "| price:",
    utils.format.formatNearAmount(scan.price_yocto, 4),
    "NEAR | seller:",
    scan.seller
  );

  // 2. Create the purchase on the worker.
  const purchaseRes = await workerPost("/api/purchase", {
    listing_id: scan.id,
    buyer_account: creds.accountId,
    input: { contract: TARGET },
  });
  if (purchaseRes.status !== 201) {
    throw new Error(
      "purchase creation failed (" + purchaseRes.status + "): " +
        JSON.stringify(purchaseRes.data).slice(0, 300)
    );
  }
  const purchase = purchaseRes.data;
  console.log("purchase created:", purchase.id);

  // 3. The agent signs and sends the payment itself.
  const outcome = await agent.sendMoney(scan.seller, scan.price_yocto);
  const txHash = outcome.transaction.hash;
  console.log("payment sent by agent:", txHash);
  console.log("explorer:", EXPLORER + txHash);

  // 4. Claim — the worker verifies the transfer on-chain, then serves
  //    exactly one scan. Retry briefly while the tx settles.
  let claim = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    claim = await workerPost("/api/purchase/" + purchase.id + "/claim", {
      tx_hash: txHash,
    });
    if (claim.status === 200) break;
    console.log("claim attempt", attempt, "->", claim.status,
      JSON.stringify(claim.data).slice(0, 160));
    if (claim.status !== 402) break;
    await sleep(3000);
  }
  if (!claim || claim.status !== 200) {
    throw new Error("claim failed: " + JSON.stringify(claim && claim.data).slice(0, 300));
  }

  // 5. Print the report.
  const report = claim.data.result && claim.data.result.body;
  if (!report) throw new Error("claim returned no report body");
  console.log("\n================ SCAN REPORT ================");
  console.log("contract:      ", report.contract);
  console.log("token:         ", report.token_name, "(" + report.token_symbol + ")");
  console.log("decimals:      ", report.token_decimals);
  console.log("total supply:  ", report.total_supply, report.token_symbol);
  console.log("holder count:  ", report.holder_count);
  console.log("known token:   ", report.known_token, report.registry_match || "");
  console.log("impersonation: ", report.impersonation_suspect);
  console.log("risk score:    ", report.risk_score, "/ 100");
  console.log("verdict:       ", report.verdict);
  if (report.flags && report.flags.length) {
    console.log("flags:");
    for (const f of report.flags) console.log("  -", f);
  }
  console.log("=============================================");
  console.log("payment tx:", txHash);
}

main().catch((e) => {
  console.error("agent-buyer failed:", e.message || e);
  process.exit(1);
});
