# Financial integrity audit — 2026-09-30

## Fixed
- Manual and scheduled X procurement/LTC purchase runs share a database lease covering balance checks, limits and submission. Ownership is verified before persisting a purchase intent.
- Unresolved supplier orders block new purchasing. Provider COMPLETED without available delivery remains PROCESSING for later reconciliation.
- Reconciliation-opened circuit breakers are rechecked before further purchasing. Ambiguous purchase results remain UNKNOWN rather than FAILED.
- Outstanding Binance intents prevent another market purchase. Existing server gate and manual-HStora funding mode are preserved.
- Disabled live procurement cannot start a funding purchase through a shortfall path.
- Reservation claims and reservation rows are atomic; failed inserts no longer strand stock. Finalizing a reservation checks its current state.
- Expiration and inventory release are atomic. Paid/pending orders cannot lose stock through an expiration race.
- Fulfillment requires a coherent successful bridge response and a sufficient integer amount.

## Validation
Typecheck and all 94 tests passed, including six new local Worker/D1 runtime tests for concurrent execution, lost lease, pending supplier orders, incomplete provider delivery, reservation failure and expiration failure. No real funds were moved and no production deployment was performed.

## Operational limits
Unresolved Binance intents and ambiguous payment receipts require provider-side reconciliation; automatic inference from balances or public payment-link status is not sufficient. Existing stranded inventory or historical inconsistent rows are not automatically repaired. End-to-end live Binance/HStora/Discord behavior was not exercised. Shared financial lease expires after 30 minutes after an interrupted invocation; persistent intent checks remain in place afterward.

Transaction reference: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
