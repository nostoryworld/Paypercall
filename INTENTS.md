# PayPerCall — NEAR Intents settlement (Phase D, code-ready, OFF by default)

Status: **designed and code-ready, not live.** Nothing in the running
PayPerCall flow uses this yet. No deploys, no on-chain actions, and no funds
were involved in building it. The module lives in `settlement/intents.js`
with offline tests in `settlement/test/`:

```bash
cd settlement && node --test test/   # 15 tests, stubbed fetch, no network
```

(`settlement/test/package.json` exists only so that the `node --test test/`
directory argument resolves on Node 24 builds that treat a bare directory
path as a module entry — its `main` points at the test file.)

## How settlement works today: transfer-verify

1. Buyer creates a purchase (`POST /api/purchase` with a listing id and
   their NEAR account). The purchase records the listing's price and
   `seller_account`.
2. Buyer pays with a **plain NEAR testnet transfer** of at least the price,
   directly to the seller's account, from their own wallet / near-cli.
3. Buyer claims with the transaction hash (`POST /api/purchase/:id/claim`).
4. The platform verifies the transfer on-chain via NEAR RPC:
   the tx exists and succeeded, the signer is the buyer, the receiver is
   the seller, and the transferred amount is ≥ the price.
5. Only then does it proxy **exactly one** call to the seller's endpoint.
   Each tx hash can be claimed once and each purchase is single-use —
   replays are rejected. (NEAR native transfers have no memo field, so the
   tx hash itself is the claim token.)

This works, but it locks both sides to NEAR-native payment on one chain,
paid in raw NEAR, with the buyer hand-managing a transfer.

## How the Intents path slots in

NEAR Intents via the **1Click API** (`https://1click.chaindefuser.com`)
lets the buyer pay with any supported asset on any supported chain while
the seller still receives a chosen asset at their address. The purchase
flow keeps the same shape — create purchase → pay → verify → release one
call — with the payment leg swapped:

1. **Create purchase** as today, snapshotting `settlement_mode` on the
   purchase so a purchase never changes rails mid-flight.
2. **Request a quote.** The server (not the buyer) calls
   `POST /v0/quote` through `settlement/intents.js`:
   `EXACT_INPUT`, `amount` = the listing price in the origin asset's
   smallest unit, `recipient` = the seller's address,
   `refundTo` = the buyer's address, `deadline` = quote expiry
   (default: now + 1 hour). The response's `quote.depositAddress` is
   stored against the purchase id — **the deposit address replaces the
   tx hash as the correlation / claim token**, and stays single-use.
3. **Buyer deposits** exactly `amountIn` of the origin asset to that
   deposit address, from whatever wallet/chain the asset lives on.
   (Optionally the server can call `POST /v0/deposit/submit` with the
   deposit tx hash to speed up detection; 1Click also detects deposits
   on its own. Not implemented in this module — polling is sufficient.)
4. **Poll status.** The server polls `GET /v0/status?depositAddress=…`
   (every ~5–10s, backing off) and maps the result through
   `client.getStatus()`, which returns `{ status, settled, terminal }`:

   | 1Click status | Meaning | PayPerCall action |
   |---|---|---|
   | `PENDING_DEPOSIT` | Quote created, nothing deposited yet | Keep waiting; show buyer the deposit address + deadline |
   | `KNOWN_DEPOSIT_TX` | Deposit tx seen, not yet confirmed | Keep waiting |
   | `INCOMPLETE_DEPOSIT` | Deposit below the required amount | Prompt buyer to top up before the deadline |
   | `PROCESSING` | Deposit confirmed, swap executing | Keep waiting |
   | `SUCCESS` | Destination asset delivered to the seller (`settled=true`) | **Release exactly one call**, mark purchase consumed |
   | `REFUNDED` | Swap failed, funds returned to `refundTo` (terminal) | Do NOT release; mark purchase refunded (see below) |
   | `FAILED` | Irrecoverable error (terminal) | Do NOT release; mark purchase failed (see below) |

5. **Release on SUCCESS only.** `settled` is true for no other status,
   and unknown/future statuses are treated as unsettled and non-terminal,
   so a new 1Click state can never accidentally release a call.

## Exactly what flips it live

Two pieces of configuration, both server-side in the Worker's environment:

| Config | Value | Effect |
|---|---|---|
| `SETTLEMENT_MODE` | `intents` | The ONLY switch. `intentsEnabled(env)` in `settlement/intents.js` returns true solely for this exact value; unset or `transfer` (the default) keeps transfer-verify live. |
| `ONECLICK_JWT` | JWT from the NEAR Intents partner portal | Sent as `Authorization: Bearer …` by the client. Effectively required: unauthenticated quotes exist (at a +0.25% fee per the docs) but `GET /v0/status` requires a JWT, and without status polling nothing can be released. Keep it in the Worker's secret store, never in code or the repo. |
| `ONECLICK_BASE_URL` | optional, defaults to `https://1click.chaindefuser.com` | Override only for a staging/proxy endpoint. |

Wiring (a later phase, deliberately not done here): the Worker checks
`intentsEnabled(env)` at purchase creation; if true it builds a client
with `createIntentsClient({ jwt: env.ONECLICK_JWT })` and follows the
flow above; if false it runs transfer-verify exactly as today. Nothing
else in the codebase needs to change — the release step and the
single-use guard are shared.

## Asset identifiers

1Click asset ids are `nep141:<contract>` style strings, resolved live
from `GET /v0/tokens` (the only unauthenticated endpoint). The pair this
design targets:

| Role | Asset id | Notes |
|---|---|---|
| Destination (seller receives) | `nep141:wrap.near` | wNEAR on NEAR mainnet; `recipient` = seller's NEAR account, `recipientType: DESTINATION_CHAIN` |
| Origin (buyer pays) | any asset from `/v0/tokens` — e.g. `nep141:wrap.near`, or USDC on NEAR `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, or the same tokens on Base/Ethereum/Solana etc. | That's the point of Intents: the buyer pays where their funds already are |
| Design-time testnet placeholder | `nep141:wrap.testnet` | The wrapped-NEAR contract on NEAR testnet, in the same format. **Not a live 1Click asset** — see the honesty note below. Used only so config/fixtures can be written in the right shape. |

> **Honesty note — 1Click is mainnet-first, and this phase is not live.**
> The 1Click FAQ states there is **no testnet deployment and no plans for
> one**; `/v0/tokens` lists mainnet assets only (verified live in this
> phase: the list contains `wrap.near`, not any testnet asset). So there
> is no way to rehearse this flow with testnet funds. Going live therefore
> means, all at once: mainnet asset ids, a funded mainnet account on the
> payer side, a partner-portal JWT, and real-money failure modes. None of
> that is done in this phase, and flipping `SETTLEMENT_MODE=intents`
> before those exist would break purchases rather than upgrade them.
>
> What WAS verified live in this phase (no funds involved): one
> **dry** quote (`dry: true`) against the real API through this module —
> 0.1 wNEAR → USDC on NEAR returned `amountOut: "459784"`, a quote
> envelope of `{ quote, quoteRequest, signature, timestamp,
> correlationId }`, and, as documented for dry quotes, **no
> depositAddress** — which the client reports as `depositAddress: null`
> for dry quotes and refuses (throws) for non-dry ones. The quote took
> ~18s from this network, which is why the client's default timeout is
> 30s. Status polling could not be verified live (it needs a JWT and a
> real deposit); its fixtures follow the documented response shape.

Amounts are always integers in the asset's smallest unit (yoctoNEAR for
wNEAR, 24 decimals; USDC 6 decimals) — never floats, never NEAR-denominated
decimals. Convert the listing price once, at quote time, and store the
exact `amountIn` string on the purchase.

## Failure and refund handling

- **`REFUNDED`** — 1Click returns the deposited funds to the quote's
  `refundTo` address (the buyer) automatically; PayPerCall does not move
  money and cannot intercept the refund. Mark the purchase `refunded`,
  never release the call, and let the buyer start a fresh purchase (a new
  quote → a new deposit address; never re-use an old one). Common causes:
  deadline passed before the deposit confirmed, slippage beyond
  tolerance, or an under-amount deposit for `EXACT_INPUT`.
- **`FAILED`** — terminal, no automatic guarantee of a refund. Do not
  release the call. Keep the purchase's stored `depositAddress`, the raw
  quote response (including its `signature`) and the raw status response;
  those are the evidence needed for a 1Click support follow-up. Surface
  the failure to the buyer with the deposit address as the reference.
- **`INCOMPLETE_DEPOSIT`** — not terminal and not settled. Prompt the
  buyer to top up to the full `amountIn` at the same deposit address
  before the deadline; if the deadline passes, expect `REFUNDED`.
- **Deadline discipline** — never present a deposit address after its
  `deadline`, and never accept a deposit made against an expired quote
  as payment. An expired/unused quote costs nothing; just request a new
  one on a new purchase attempt.
- **Amount discipline (`EXACT_INPUT`)** — the buyer must send exactly
  `amountIn`. Under-payment leads to `INCOMPLETE_DEPOSIT`/refund;
  over-payment is swapped with the excess refunded (per 1Click docs).
  If the quote returns a `depositMemo` (memo-mode chains like Stellar),
  it must be shown to the buyer and passed back to `getStatus()` — the
  client supports it; the deposit is not identifiable without it.
- **Polling failures** — a failed status request (network error, 5xx)
  is not a settlement outcome: back off and retry. A 404 means the
  deposit address is unknown to 1Click (wrong/expired quote) — treat as
  a bug, not a refund. Only `SUCCESS` releases a call; every other
  outcome, including "we stopped hearing back", leaves the call
  unreleased.
- **Single-use, as today** — a deposit address settles at most one
  purchase, and a purchase releases at most one call, enforced by the
  same consumed-flag guard that protects tx hashes in transfer-verify.
