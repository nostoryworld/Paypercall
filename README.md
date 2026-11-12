# PayPerCall — NEAR Hackathon entry (Agent Economy track)

Paid API marketplace for AI agents on NEAR. Sellers register paid endpoints
in an **on-chain registry contract**; buyers (human or autonomous agent)
pay per call in NEAR; the platform verifies the payment on-chain, then
serves/proxies **exactly one** call. Payments are NEAR testnet; services
read live NEAR mainnet/testnet data. Testnet only — no real funds anywhere.

**Live:** https://paypercall-v2.odemakindeezekiel5.workers.dev
(the original prototype demo at `paypercall-demo.…workers.dev` is untouched;
its history is in `~/workspace/paypercall/WORKER-DEPLOY.md`)

## Components

### `contract/` — PayPerCallRegistry (Rust, near-sdk 5.x)
- Deployed on NEAR testnet at **`paypercall-dev-t34qd7c9.testnet`**
  (dev account key in `.keys/dev-account.json`, 0600, gitignored).
- `register_listing` / `update_price` / `deactivate_listing` (seller-only),
  `get_listings` / `get_listing`. Prices are `price_yocto` (U128, serialized
  as a string).
- `cargo test` — **6/6 unit tests pass**.

### On-chain listings (seller `ppc-seller-ifmvubms.testnet`, 0.001 NEAR each)
| id | service | input |
|---|---|---|
| `ppc-seller-ifmvubms.testnet-2` | Token Safety Scan — NEAR tokens | `input.contract` — NEAR token contract ID |
| `ppc-seller-ifmvubms.testnet-3` | NEAR Wallet X-Ray | `input.account` — any NEAR account ID |

Registered by `scripts/register-services.mjs` (idempotent; it also
deactivated the Phase A throwaway listing, `…-1`, which stays on-chain
with `active: false` and is never shown).

### `worker/` — Cloudflare Worker v2 (`paypercall-v2`)
- `GET /api/listings` reads the registry **live from chain**
  (`call_function get_listings`, 30 s cache; chain is the source of truth).
  There is no worker-side listing creation — `POST /api/listings` → 405
  pointing at the contract.
- Purchase flow: `POST /api/purchase` → buyer sends a plain testnet
  transfer to the seller → `POST /api/purchase/:id/claim {tx_hash}` →
  the worker verifies signer/receiver/amount via
  `EXPERIMENTAL_tx_status`, serves one call, marks the purchase consumed.
  Replays and re-used tx hashes → 409. Bad payments → 402.
- `POST /api/demo/buy` — one-tap demo: the worker pays from the demo-buyer
  wallet (Worker secrets `DEMO_BUYER_ACCOUNT_ID` / `DEMO_BUYER_SECRET_KEY`
  only) and runs the same verify-then-serve path in a single request.
- **Purchases storage: Cloudflare KV** — namespace `paypercall-v2-purchases`
  bound as `PURCHASES` (see `scripts/deploy-v2.py`; `GET /api/health`
  reports `"purchases_storage": "kv"`). If the binding is ever absent the
  worker falls back to per-isolate in-memory storage automatically.
- Services are served in-process (never self-subrequested):
  - `/paid/token-scan` — contract existence + code hash, `ft_metadata`,
    `ft_total_supply`, holder count, known-token registry match,
    impersonation detection, 0–100 risk score + verdict (NEAR mainnet RPC).
  - `/paid/wallet-xray` — account existence, balance, locked amount,
    storage used (+approx. storage cost), contract code, creation time
    and transaction count (NearBlocks, best effort), one-line summary.
    `.testnet` accounts read testnet, everything else reads mainnet.
- Build + pre-deploy gate:
  `cd worker && npm run build && node test-local.mjs` → must print
  `LOCAL E2E GREEN` (runs the exact bundle in Node with real testnet
  transfers; storage runs in memory mode locally).
- Deploy: `python3 scripts/deploy-v2.py` (raw script-upload API with the
  KV binding in the upload metadata — the stock `cf-worker-deploy` helper
  cannot set bindings).

### `scripts/agent-buyer.mjs` — autonomous agent buyer
No human clicks. The agent uses its own faucet-created testnet account
(`.keys/agent-buyer.json`, 0600), reads listings from the registry
contract, creates a purchase on the worker, **signs and sends the payment
itself**, claims, and prints the report:

```bash
node scripts/agent-buyer.mjs [token-contract]   # default usdt.tether-token.near
```

Verified run: agent `ppc-agent-3dxpfv1w.testnet`, payment tx
`2akieseTifwED3mXBBZdEBzYoXPijyYvCcxtKJFwD9PM` → Tether USD report,
risk score 100, verdict LOW RISK.

### `settlement/` — NEAR Intents 1Click settlement (Phase D)
Code-ready and **off by default**; the live flow is transfer-verify.
See `INTENTS.md` for the design, the status mapping, and exactly what
flips it live. Tests: `cd settlement && node --test test/` — **15/15 pass**
(offline, stubbed fetch).

## Caveats (honest list)
- **Indexer fields degrade on the live Worker.** NearBlocks refuses
  shared Cloudflare egress IPs, so on the deployed worker the scan's
  `holder_count` and the X-Ray's `created_at` / `tx_count` come back
  `null` and the reports flag them as unavailable. From a normal network
  (and in the local E2E) the same code returns real values
  (USDT holders 2,495,713; wrap.near created 2021-02-15, 173M+ txns).
  All RPC-derived fields are unaffected.
- **`/api/demo/buy` is public** and spends the demo buyer's testNEAR
  (0.001 per buy; faucet-funded, no real value). Top up via the testnet
  faucet if it runs dry.
- The 30 s listings cache means a brand-new on-chain listing can take up
  to ~30 s to appear in `GET /api/listings` on a warm isolate.
- Intents settlement is not live (1Click has no testnet; see INTENTS.md).

Prototype/demo history: `~/workspace/paypercall/` (`WORKER-DEPLOY.md`,
`NEAR-TOOLS.md`).

## Phase A — on-chain registry (done, 2026-10-20)

`PayPerCallRegistry` contract built, unit-tested (6/6 passing), and deployed on NEAR testnet.

- **Contract account id:** `paypercall-dev-t34qd7c9.testnet`
- Details (wasm size, tx hashes, verification): see `contract/DEPLOYMENT.md`.
