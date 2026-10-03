# Operations audit (2026-10-04 JST)

Reviewed X procurement, financial locks and budget allocation, pending order reconciliation, daily replenishment, invite rewards, vending reservations, and the signed bridge used by Xaccount-Bot. Existing automated tests were run before changes. This is a code and simulated API audit; no live purchase or transfer was performed.

## Corrected behavior

- The minute Cron reconciles pending HStora orders and detects wallet credits while automatic procurement is paused or Emergency Stop is active. Maintenance cannot create purchases or transfers and shares the purchase/budget financial lock.
- The dashboard shows overview request failures with a retry action and marks previously loaded information as stale. Failed refreshes do not produce success notices.
- Late responses from an earlier section, guild, or unmounted screen cannot overwrite current operations data.
- The default dashboard exposes Overview, Balance / Allocation, 18:00 Restock, and Vending. Other operations remain accessible through the advanced menu. The overview explains the operating sequence and provides start/pause actions. Starting live procurement retains the existing server confirmation contract.

## Exodus funding

The deployment has no connected LTC signer (`DisabledHotWalletProvider`). Exodus-to-HStora LTC transfer is manual. Once HStora credits payment, the bot detects the balance, allocates budgets, and replenishes automatically under the configured schedule and controls.

Exodus publishes a wallet SDK with balances and transaction-signing primitives. This is not a remote-control API for an installed consumer mobile wallet, and does not by itself establish a working Litecoin integration in this Worker. Full automatic transfers require a separately implemented and verified signing service plus an established HStora deposit-address lifecycle. Neither component has been connected in this audit. Recovery phrases and private keys must not be placed in the dashboard or repository.

Primary references:

- https://github.com/ExodusOSS/hydra/blob/master/sdks/headless/README.md
- https://docs.exodus.com/open-source/hydra/development/using-the-sdk
- https://docs.exodus.com/checkout (Business stablecoin checkout; not a consumer LTC send API)

## Verification and release

Tests use Miniflare D1 and mocked providers to check duplicate credits, paused/stopped operation, purchase-lock exclusion, dashboard failure recovery, live-start confirmation, and late responses after guild switching. Real HStora purchases and Discord/payment delivery are outside these simulations.

The existing GitHub Pages workflow deploys web changes. Discord-Shiire requires Worker redeployment through Bot Factory. Browser visual checks could not run locally because the browser download failed certificate validation; Bot Factory's browser session currently requires sign-in.
