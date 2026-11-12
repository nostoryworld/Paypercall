# PayPerCallRegistry — Deployment (Phase A)

NEAR **testnet** only. No real funds spent (faucet-funded testnet account).

## Accounts

- **Contract account id:** `paypercall-dev-t34qd7c9.testnet`
- **Dev account id:** `paypercall-dev-t34qd7c9.testnet` (contract is deployed to the dev account itself)
- Dev key: `~/workspace/paypercall-entry/.keys/dev-account.json` (mode 0600, gitignored — never committed, never printed)

The dev account was created via the public testnet faucet helper
(`POST https://helper.testnet.near.org/account`) — succeeded on attempt 1,
initial balance 10 NEAR (testnet).

## Build

- Toolchain: rust-toolchain.toml pins Rust 1.93.0 (same as the working
  `~/workspace/near-toolchain-check/` template); near-sdk 5.29.1
  (near-sdk-core 4.2.3).
- Build command: `cargo near build non-reproducible-wasm`
- **Wasm:** `contract/target/near/paypercall_registry.wasm`
- **Wasm size:** 104,143 bytes (104.1 KB)
- SHA-256 (hex): `35fd32334a2a02561d9d334b50588fb3cf8753d5044fbd89420e6aa6af109356`

## Tests

`cargo test` — **6 passed, 0 failed**:

- `register_happy_path`
- `get_listing_round_trip`
- `non_seller_update_price_panics`
- `non_seller_deactivate_panics`
- `invalid_price_panics`
- `seller_can_update_price_and_deactivate`

## Deploy + verification (testnet, 2026-10-20)

Deployment and calls were made with a Node script using the vendored
near-api-js (`~/workspace/paypercall/node_modules`), signing with the dev
key read from the 0600 key file. (near-cli-rs 0.30.1's default archival
RPC endpoint was unreachable from this VM; `https://rpc.testnet.near.org`
works and was used for all verification reads.)

- **Deploy tx:** `1BZiZaeLv9qP1fjScSDwB4wmCtfTLwpu3hZiv5Gmn1v`
  (deployed without an init call — the contract uses `Default` state)
- **Register tx:** `CYhvyXGDqAQkBcL1uAnEcLqVQHFVT9WCokZ7zhp1CAFT`
  - Explorer: https://testnet.nearblocks.io/txns/CYhvyXGDqAQkBcL1uAnEcLqVQHFVT9WCokZ7zhp1CAFT
  - Returned listing id: `paypercall-dev-t34qd7c9.testnet-1`
  - Test listing: "Phase A Test Listing", price_yocto `1000000000000000000000` (0.001 NEAR), `https://example.com/phase-a-test`
- **Verification reads (successful):**
  - `get_listings` returned the test listing with all fields intact
    (price serialized as the yocto string `"1000000000000000000000"`, `active: true`).
  - `get_listing("paypercall-dev-t34qd7c9.testnet-1")` returned the same listing.
- Contract on explorer: https://testnet.nearblocks.io/address/paypercall-dev-t34qd7c9.testnet
