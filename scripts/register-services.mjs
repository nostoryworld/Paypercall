#!/usr/bin/env node
// Register the two real PayPerCall services as on-chain listings in the
// PayPerCallRegistry contract (NEAR testnet), signed by the demo seller.
// Also deactivates the Phase A throwaway listing (its seller is the dev
// account, which owns the registry deploy).
//
// Keys are read from files, never printed:
//   seller: ~/workspace/paypercall/.demo-keys.json   (gitignored, 0600)
//   dev:    .keys/dev-account.json                   (gitignored, 0600)
// near-api-js is vendored in ~/workspace/paypercall/node_modules — resolved
// through createRequire so this repo needs no node_modules of its own.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire("/home/hatch/workspace/paypercall/package.json");
const { connect, keyStores, utils } = require("near-api-js");

const here = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = "paypercall-dev-t34qd7c9.testnet";
const V2_ORIGIN = "https://paypercall-v2.odemakindeezekiel5.workers.dev";
const PRICE_YOCTO = "1000000000000000000000"; // 0.001 NEAR

const demoKeys = JSON.parse(
  readFileSync("/home/hatch/workspace/paypercall/.demo-keys.json", "utf8")
);
const devKeys = JSON.parse(
  readFileSync(path.join(here, "..", ".keys", "dev-account.json"), "utf8")
);

const SERVICES = [
  {
    name: "Token Safety Scan — NEAR tokens",
    description:
      "Real safety report for any fungible token on NEAR: contract existence and code, token metadata, total supply, holder count, known-token registry match and impersonation detection, with a 0-100 risk score and a one-line verdict. Input: the NEAR token contract account ID.",
    endpoint_url: V2_ORIGIN + "/paid/token-scan",
    price_yocto: PRICE_YOCTO,
  },
  {
    name: "NEAR Wallet X-Ray",
    description:
      "Snapshot of any NEAR account: existence, balance, storage used, deployed contract code, creation and recent activity (best effort from public indexers), plus a one-line summary. Input: the account ID (mainnet .near or testnet .testnet).",
    endpoint_url: V2_ORIGIN + "/paid/wallet-xray",
    price_yocto: PRICE_YOCTO,
  },
];

const TEST_LISTING_ID = REGISTRY + "-1"; // "Phase A Test Listing"

async function accountWithKey(near, { accountId, secretKey }) {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(
    "testnet",
    accountId,
    utils.KeyPair.fromString(secretKey)
  );
  const cfg = { networkId: "testnet", keyStore, nodeUrl: "https://rpc.testnet.near.org" };
  const conn = await connect({ ...cfg, ...(near ? {} : {}) });
  return conn.account(accountId);
}

async function main() {
  const seller = await accountWithKey(null, demoKeys.seller);
  const dev = await accountWithKey(null, devKeys);

  const before = await seller.viewFunction({
    contractId: REGISTRY,
    methodName: "get_listings",
    args: {},
  });
  console.log("listings before:", before.length);

  for (const svc of SERVICES) {
    const existing = before.find(
      (l) => l.active && l.seller === demoKeys.seller.accountId && l.name === svc.name
    );
    if (existing) {
      console.log("already registered, skipping:", svc.name, "->", existing.id);
      continue;
    }
    const res = await seller.functionCall({
      contractId: REGISTRY,
      methodName: "register_listing",
      args: svc,
      gas: "30000000000000",
      attachedDeposit: "0",
    });
    const id = res.status && res.status.SuccessValue
      ? JSON.parse(Buffer.from(res.status.SuccessValue, "base64").toString())
      : "(unknown id)";
    console.log("registered:", svc.name, "->", id, "tx:", res.transaction.hash);
  }

  const testListing = before.find((l) => l.id === TEST_LISTING_ID);
  if (testListing && testListing.active) {
    const res = await dev.functionCall({
      contractId: REGISTRY,
      methodName: "deactivate_listing",
      args: { listing_id: TEST_LISTING_ID },
      gas: "30000000000000",
      attachedDeposit: "0",
    });
    console.log("deactivated test listing:", TEST_LISTING_ID, "tx:", res.transaction.hash);
  } else {
    console.log("test listing already inactive or absent:", TEST_LISTING_ID);
  }

  const after = await seller.viewFunction({
    contractId: REGISTRY,
    methodName: "get_listings",
    args: {},
  });
  console.log("\nfinal listings:");
  for (const l of after) {
    console.log(
      JSON.stringify({
        id: l.id,
        seller: l.seller,
        name: l.name,
        endpoint_url: l.endpoint_url,
        price_yocto: l.price_yocto,
        active: l.active,
      })
    );
  }
}

main().catch((e) => {
  console.error("register-services failed:", e.message || e);
  process.exit(1);
});
