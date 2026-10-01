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

## Follow-up on new main commits (through c6651ce)

Integrated the new category budgets, supplier priority, daily 18:00 restock and public actual-stock notification changes with the financial integrity branch. The previous PR was still unmerged.

- Reproduced duplicate deposit budget credit after an audit-write failure; budget credit and the observed balance checkpoint now commit atomically. Manual rebalance also updates that checkpoint atomically and uses the procurement lease.
- Reserved budgets and purchase intent records now share a transaction. A failed order insert leaves funds available, and overlapping reservations cannot overspend a bucket.
- Malformed successful supplier responses and schema errors do not count as definitive order rejection; ambiguous budget reservations remain held.
- Reproduced two notifications from overlapping daily continuations. Daily start/continuation now share a database lease; known financial contention retains a running daily state for the next tick instead of prematurely ending the batch. A stable Discord nonce is included for short-window response-loss retries; this is not a promise of indefinite exactly-once delivery.
- Verified public notification fields show available stock only (reserved stock excluded), with no internal target or budget fields.
- Fixed the original reconciliation test fixture to include the real HStora success envelope, and assert the persisted PROCESSING state rather than merely observing that no purchase occurred.

Validation: typecheck passed; all 116 tests passed including 12 Worker/D1 integration cases. External funds and production databases were not touched. Existing ambiguous historical payments still require recipient-side reconciliation.

## 2026-10-01 main統合検証

最新main（29ca976）を統合。通知再送が18時に重なった際の開始取りこぼしを修正し、18時以降の当日未実行バッチを開始可能にした。日付ごとの重複開始防止は維持。入荷時のみ通知する仕様に統合テストを対応。typecheck・123テスト成功。
実送金・本番デプロイの検証は実施していない。
