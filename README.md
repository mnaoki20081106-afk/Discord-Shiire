# Discord-Shiire

Main Bot の有限在庫を自動補充する、仕入れ専用 Cloudflare Worker / Discord Bot です。

## Architecture

```text
Supplier
  ├─ pool       既に取得済みの在庫を取り込む
  └─ http_json  正規のHTTP APIを持つ仕入先から自動取得
       |
       v
Discord-Shiire
  Supplier Adapter
       |
       v
  Raw item persistence
       |
       v
  Processor
  ├─ identity   取得内容をそのまま商品にする
  └─ http_json  キー→リンク等の変換サービスを別レイヤーで呼ぶ
       |
       v
  Dedupe / retry / product lock
       |
       v
HMAC signed bridge
       |
       v
Discord-Bot vending_stock
       |
       v
Buyer delivery
```

仕入先と Processor は別物です。たとえば「仕入先からキーを取得し、別サービスでギフトリンクへ変換する」商品は、キー取得を Supplier、リンク化を Processor に設定します。

## Automatic restock

各商品に以下を設定します。

- `minStock`: この在庫数を下回ると補充開始
- `targetStock`: 補充後に目指す在庫数
- `maxBatch`: 1回の最大仕入れ数
- `supplierId` / `supplierSku`: 仕入先とSKU
- `mainProductId`: Main Bot 側の有限在庫商品ID
- `processorKind`: `identity` または `http_json`

Cron は1分ごとに Main Bot の実在庫を確認します。必要なときだけ仕入れを開始し、取得済み原料をD1へ先に保存してから Processor と納品を行います。

外部処理や Main Bot が一時的に失敗しても、取得済み商品を保存したまま再試行するため、同じ商品を不用意に再仕入れしません。

## Duplicate / concurrency protection

- 商品単位のD1ロックで同時仕入れを抑止
- Shiire内で商品内容をSHA-256 fingerprint化
- Main Bot側でもfingerprintを保持
- Main Botへの納品は `idempotencyKey` 付き
- HMAC-SHA256 + timestamp + nonce で内部APIを認証
- 無限在庫商品には仕入れBotから納品不可

## Required secrets

Discord-Shiire Worker:

```text
ADMIN_TOKEN
SHIIRE_BRIDGE_SECRET
```

Discordコマンドも使う場合:

```text
DISCORD_APPLICATION_ID
DISCORD_PUBLIC_KEY
DISCORD_BOT_TOKEN
```

Main Bot Workerにも、**Discord-Shiireと同一の**値を設定します。

```text
SHIIRE_BRIDGE_SECRET
```

`SHIIRE_BRIDGE_SECRET` と `ADMIN_TOKEN` は32文字以上のランダム値を推奨します。仕入先APIのトークンは Supplier の `tokenBinding` に書いた名前の Cloudflare Worker Secret として保存し、GitHubやD1の設定JSONには直接保存しません。

## Main Bot bridge

Discord-Bot 側に以下の内部APIを追加しています。

```text
GET  /api/vending/supply/products/:productId/stock
POST /api/vending/supply/deliver
```

Dashboardセッションは使いません。Shiire専用HMAC署名でのみアクセスします。

## Main Bot catalog

`GET /api/main-catalog` で、Main Botに現在存在する有限在庫商品・自販機名・guild ID・販売可能在庫数を取得できます。Shiireの商品作成時は、ここで返る `product_id` を `mainProductId` に指定します。

## Supplier: pool

外部の取得処理や人手で確保した在庫を安全に取り込む入口です。

```http
POST /api/suppliers/:supplierId/intake
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{
  "sku": "example-sku",
  "items": ["CODE-1", "CODE-2"]
}
```

## Supplier: http_json

正規のHTTP APIを持つ仕入先向けの共通アダプタです。Shiireは次のJSONをPOSTします。

```json
{
  "sku": "example-sku",
  "quantity": 10
}
```

デフォルトではレスポンスの `items` 配列を商品として受け取ります。

設定例:

```json
{
  "baseUrl": "https://supplier.example",
  "acquirePath": "/api/acquire",
  "tokenBinding": "SUPPLIER_A_TOKEN",
  "responseItemsPath": "items"
}
```

## Processor: http_json

仕入れた値を最終商品の文字列へ変換するための共通レイヤーです。

Shiireから:

```json
{
  "items": ["RAW-KEY-1", "RAW-KEY-2"]
}
```

Processorから:

```json
{
  "items": ["https://example.test/redeem/1", "https://example.test/redeem/2"]
}
```

実際のサービス固有通信は仕様確認後、このProcessor Adapter側に追加します。捨てメールを使ったアカウント大量作成、CAPTCHA・レート制限等の回避処理は含めません。

## Admin API

```text
GET  /api/state
GET  /api/main-catalog
GET  /api/suppliers
POST /api/suppliers
GET  /api/products
POST /api/products
GET  /api/products/:id/status
POST /api/products/:id/run
POST /api/run-all
POST /api/discord/register
```

すべて `Authorization: Bearer <ADMIN_TOKEN>` が必要です。

## Discord commands

`POST /api/discord/register` を一度実行すると:

- `/shiire-status` — 商品ごとのMain Bot在庫と最終ジョブ
- `/shiire-run product_id:<id>` — 指定商品の補充判定を即時実行

どちらも Discord の「サーバー管理」または Administrator 権限を持つユーザーだけが利用できます。

## Cloudflare

Worker: `src/index.ts`

D1 binding:

```text
DB
```

`MAIN_BOT_BASE_URL` はXアカウント以外の従来型商品をMain Bot有限在庫へ自動納品する場合だけ設定します。Factory利用時はフォームの「旧Main Bot Worker URL（汎用仕入れ用）」へ実際のWorker HTTPS originを入力してください。使用しない場合は未設定で構いません。


## X account procurement

The X account procurement flow is implemented as a separate, fail-closed pipeline inside Discord-Shiire.

```text
Current default:
LTC manual top-up
  -> HStora Main Wallet
  -> HStora balance credit detected by the 1-minute Cron
  -> HStora official API purchase

Future optional funding path:
Binance Japan JPY
  -> LTC/JPY Spot
  -> HStora Main Wallet funding boundary
  -> HStora official API purchase
  -> encrypted D1 inventory
  -> READY_FOR_DELIVERY
  -> Discord-Shiire vending reservation
  -> buyer DM delivery
  -> DELIVERED
```

The admin page is available at:

```text
/x-admin
```

and contains:

```text
Dashboard
Funding
Binance
LTC Wallet
HStora
Inventory
Orders
Logs
Settings
```

All `/api/x/*` endpoints require the existing `ADMIN_TOKEN`.

### Safety defaults

The defaults are intentionally non-live:

```text
funding_mode = manual_hstora
dry_run = true
auto_purchase_enabled = false
auto_procurement_enabled = false
dedicated_ltc_wallet = disabled (no signer connected)
BINANCE_AUTO_FUNDING_ENABLED = false / unset
emergency_stop = false
seller_quality_mode = trial_only
```

Turning Dry Run off through the admin API requires an explicit live-mode confirmation.
Emergency Stop disables both automatic purchase and automatic procurement.

The current default funding mode is `manual_hstora`. In this mode Discord-Shiire never calls the Binance market-buy path. When the HStora Main Wallet is short, it sends a rate-limited notice, waits for an LTC top-up made through HStora's Wallet UI, and automatically resumes procurement after the official HStora balance API reflects the credit.

The existing Binance purchase code is preserved for later use. Selecting `binance_auto` is rejected unless the Worker environment also has `BINANCE_AUTO_FUNDING_ENABLED=true`. Live Binance market buys perform the same hard server-side check again, so changing D1 settings alone cannot unlock trading.

Funding limits for `binance_auto` are calculated fail-closed, and existing Binance JPY and new PayPay outflow are treated separately.

The LTC purchase ceiling is the minimum of:

- `max_purchase_jpy`
- remaining daily limit
- remaining weekly limit
- remaining monthly limit
- remaining LTC target balance capacity
- remaining LTC maximum balance capacity

If the existing Binance JPY balance is sufficient, the bot can use that balance without consuming the configured PayPay reserve.

Only when additional PayPay funding is required does the bot calculate spendable PayPay as:

- observed PayPay balance
- minus `reserve_jpy`

A stale PayPay observation blocks only a new PayPay funding step; it does not block use of already-funded Binance JPY.

For the current Binance Japan PayPay flow, the code distinguishes the two manual paths:

- PayPay -> Binance JPY instant deposit: minimum gross deposit 1,000 JPY, 110 JPY fee deducted from the specified amount
- PayPay -> direct crypto purchase: minimum purchase 1,000 JPY; the direct purchase path does not add the JPY-deposit fee

The pending state persists both the gross PayPay deposit amount and the expected net Binance JPY increase so the 110 JPY fee cannot cause a false wait or false completion.

### PayPay boundary

No browser automation, login bypass, or guessed PayPay/Binance funding endpoint is used.

PayPay funding is a manual boundary:

1. Discord-Shiire calculates the maximum permitted JPY spend.
2. It creates one pending manual PayPay action.
3. The user uses Binance Japan's official UI to either:
   - fund Binance JPY from PayPay, or
   - buy LTC directly with PayPay when LTC is shown as an eligible PayPay purchase asset.
4. Discord-Shiire checks official Binance account balances.
5. A sufficient JPY increase causes the bot to continue with the LTC/JPY Spot purchase path.
6. A sufficient LTC increase means the manual direct-LTC purchase already satisfied the requirement, so the bot does not submit a duplicate LTC order.

The pending request is persisted so the one-minute Cron does not repeatedly create the same funding request.

### Binance Japan

The Binance adapter uses documented Binance Spot/Wallet endpoints only, including:

- `GET /api/v3/exchangeInfo`
- `GET /api/v3/ticker/price`
- `GET /api/v3/account`
- `POST /api/v3/order`
- `GET /api/v3/order`
- `GET /sapi/v1/account/apiRestrictions`
- `GET /sapi/v1/capital/config/getall`
- `GET /sapi/v1/capital/withdraw/address/list`
- `GET /sapi/v1/capital/withdraw/quota`
- `GET /sapi/v1/localentity/questionnaire-requirements`
- `POST /sapi/v1/capital/withdraw/apply`
- `POST /sapi/v1/localentity/withdraw/apply` when Travel Rule data is required

Before live withdrawals, the adapter requires:

- IP restriction enabled on the Binance API key
- withdrawal permission enabled
- destination address present in the Binance withdrawal allowlist
- LTC network withdrawal enabled and not busy
- amount within the current network minimum/maximum
- accurate Travel Rule questionnaire data when required

An ambiguous LTC order submission is reconciled with the same `clientOrderId` before any retry decision.

#### Independent LTC auto-purchase

`auto_purchase_enabled` is independent from `auto_procurement_enabled`, but it is active only when both of these conditions are also true:

- `funding_mode = binance_auto`
- `BINANCE_AUTO_FUNDING_ENABLED=true`

When LTC auto-purchase is enabled, the one-minute Cron checks the live Binance LTC/JPY market and the Binance JPY/LTC balances even when HStora procurement itself is disabled. If the LTC balance is below `target_ltc_balance`, the Worker can submit a Binance Spot `MARKET BUY` using `quoteOrderQty`, bounded by:

- current Binance JPY free balance
- `max_purchase_jpy`
- remaining daily / weekly / monthly purchase limits
- `target_ltc_balance`
- `max_ltc_balance`
- the current Binance `MIN_NOTIONAL` / `NOTIONAL` market filters

The same durable funding event, `newClientOrderId`, ambiguous-result reconciliation, and circuit-breaker path is used by both independent target rebalancing and HStora-shortfall purchases.

A manual diagnostic trigger is also available:

```text
POST /api/x/funding/auto-purchase/run
```

PayPay funding remains a separate boundary. Binance Japan currently documents PayPay funding/purchases through its official website/app flow; Discord-Shiire does not invent an undocumented PayPay API or automate the Binance website.

### HStora

The HStora adapter uses the documented v1 catalog/product/balance/order APIs.
Purchase calls use both an external order ID and an idempotency key.
If an order POST has an ambiguous result, Discord-Shiire performs the official external-order lookup instead of blindly submitting another purchase.

The current HStora product schema does not expose the requested seller rating, review count, sales count, and dispute-rate fields. Therefore:

- `seller_quality_mode = strict_api` blocks automatic purchasing.
- `seller_quality_mode = manual_product_approval` only allows explicitly approved HStora product IDs.

No seller quality value is fabricated.

HStora wallet deposit-address automation is not guessed. The official v1 API currently used by this project exposes balance/catalog/order operations but no deposit-address or deposit-execution endpoint. Therefore the default `manual_hstora` flow deliberately stops only at the HStora Wallet top-up action. After the balance increase is detected, procurement and vending delivery continue automatically. Discord-Shiire does not store a self-custody LTC private key in the Worker for this flow.

### Credential storage

HStora delivery data is never stored in plaintext.

- payload encryption: AES-GCM
- key source: `CREDENTIALS_ENCRYPTION_KEY` Worker Secret
- duplicate fingerprint: keyed HMAC
- DB state after purchase: `READY_FOR_DELIVERY`

X-account credentials stay encrypted while they are in stock. Discord-Shiire's own vending flow reserves encrypted records, decrypts only for the final buyer DM, and then changes the account state to `DELIVERED`. The main Xaccount-Bot does not receive or store these X-account credentials.

### Required Worker Secrets for X procurement

Store these with Cloudflare Worker Secret management, never in GitHub or `wrangler.jsonc`:

```text
HSTORA_API_KEY
HSTORA_API_SECRET
CREDENTIALS_ENCRYPTION_KEY
```

Optional / feature-specific:

```text
HSTORA_WEBHOOK_SECRET
DISCORD_NOTIFY_WEBHOOK_URL

# Only for future Binance auto-funding
BINANCE_API_KEY
BINANCE_API_SECRET
BINANCE_AUTO_FUNDING_ENABLED
BINANCE_TRAVEL_RULE_QUESTIONNAIRE
```

Leave `BINANCE_AUTO_FUNDING_ENABLED` unset or false while using the default manual HStora LTC top-up mode.

`HSTORA_WEBHOOK_SECRET` はWebhook即時反映を使う場合に設定します。未設定でも1分Cronの注文照合は動作します。

For live withdrawal support, use a **separate** Binance API key rather than expanding the trading key:

```text
BINANCE_WITHDRAW_API_KEY
BINANCE_WITHDRAW_API_SECRET
BINANCE_FIXED_EGRESS_CONFIRMED=true
```

The withdrawal key is rejected by the adapter unless Binance reports IP restriction enabled, withdrawal permission enabled, the LTC destination is in the official withdrawal allowlist, the network is available, the amount is within current limits, and fixed outbound egress has been explicitly confirmed.

`BINANCE_TRAVEL_RULE_QUESTIONNAIRE` is only used when Binance reports that the API key/entity requires the Travel Rule questionnaire. Do not generate or guess its contents.

`CREDENTIALS_ENCRYPTION_KEY` must decode to exactly 32 bytes. One way to create a suitable value locally is:

```bash
openssl rand -base64 32
```

### Circuit breakers

Automatic processing stops on conditions including:

- HStora API/order ambiguity that cannot be reconciled
- Binance API/order ambiguity that cannot be reconciled
- HStora product price jump beyond the configured threshold
- LTC/JPY price jump beyond the configured threshold
- unexpected HStora balance decrease beyond known bot purchases
- delivery-count mismatch
- authentication/API failures

The default manual USD/JPY observation jump threshold is `max_fx_jump_percent = 10`. A fresh prior rate followed by a larger percentage jump opens the `fx_rate` breaker instead of accepting the new rate.

Circuit breakers are visible from the X admin dashboard and require an explicit admin reset.

### Tests

CI runs both TypeScript build/typecheck and the procurement safety tests.
The tests include the funding-cap example:

```text
PayPay balance: 50,000 JPY
reserve_jpy: 20,000 JPY
max_purchase_jpy: 10,000 JPY
remaining daily allowance: 7,000 JPY
=> maximum automated purchase: 7,000 JPY
```

and verifies that 42 requested accounts with `max_batch_purchase = 20` split as:

```text
20, 20, 2
```


### HStora webhooks

Discord-Shiire exposes the signed webhook receiver:

```text
POST /webhooks/hstora
```

Configure the HStora webhook destination to the public Worker URL plus this path and store the webhook signing secret as:

```text
HSTORA_WEBHOOK_SECRET
```

The receiver verifies the official HStora v1 signature headers and canonical body hash. It never logs the webhook payload. `X-HStore-Delivery-Id` is stored for idempotency so webhook retries cannot process the same delivery twice.

Order events trigger reconciliation through the official HStora Order Lookup API. `order.refunded` and `order.disputed` open a circuit breaker and stop further automatic procurement until an admin explicitly resets it.


### Discord-Shiire vending

X-account inventory can now be sold directly by Discord-Shiire instead of being copied into the main bot's plaintext vending stock.

State flow:

```text
READY_FOR_DELIVERY
  -> VENDING_RESERVED
  -> payment_pending
  -> paid
  -> delivering
  -> delivery_sent
  -> DELIVERED
```

Important properties:

- X-account credentials remain AES-GCM encrypted while in stock or reserved.
- A buyer receives plaintext credentials only in the final Discord DM.
- Public/private purchase logs never contain the purchased credentials.
- Order reservations count toward the procurement stock target, so temporary checkout reservations do not trigger unnecessary additional HStora purchases.
- A submitted payment link changes the order to `payment_pending`; the 10-minute unpaid-order expiry no longer releases stock while payment receipt is unresolved.
- Delivery uses Discord message `nonce` + `enforce_nonce` and also persists `delivery_sent` before final stock state changes.
- Final delivery state changes are grouped through D1 batch execution.
- Stock-arrival notifications are sent only when newly procured accounts are actually inserted.
- Panel images are uploaded to Discord-Shiire and can be managed from the main dashboard.

The main Xaccount-Bot dashboard exposes this as the completely separate **仕入れbot** tab. Its existing **自販機** tab is unchanged.

The main bot is used only for:

- dashboard authentication / management proxy
- the existing seller PayPay/Kyash payment profiles

Payment credentials are **not copied** into Discord-Shiire. Payment receipt is delegated through the existing HMAC bridge.

### Main dashboard bridge for vending

Set the same strong value on both Workers:

```text
SHIIRE_BRIDGE_SECRET
```

On Xaccount-Bot, also set:

```text
SHIIRE_API_BASE_URL=https://<actual-discord-shiire-worker-origin>
```

On Discord-Shiire, set the actual current Xaccount-Bot Worker origin separately:

```text
XACCOUNT_BOT_BASE_URL=https://<actual-xaccount-bot-worker-origin>
```

`XACCOUNT_BOT_BASE_URL` is used only for Shiire vending payment delegation. The older `MAIN_BOT_BASE_URL` remains separate so existing legacy supply-bridge behavior is not silently redirected.

Use real deployed Worker origins. Both sides fail closed when their required URL is missing; neither side guesses a workers.dev hostname.

For the Discord-Shiire vending panel and buyer delivery, configure these Worker secrets:

```text
DISCORD_APPLICATION_ID
DISCORD_PUBLIC_KEY
DISCORD_BOT_TOKEN
CREDENTIALS_ENCRYPTION_KEY
```

The main dashboard can then manage:

- Shiire vending machines
- HStora source-product mapping
- PayPay/Kyash sales prices
- panel title / description / uploaded image
- Discord panel deployment / update
- buyer role
- public/private purchase logs
- stock-arrival channel + mention role
- coupons
- order history


### Procurement classes

HStora X-account procurement is separated into two independent inventory classes.

#### TOP_SEARCH

Requirements:

- the listing must be an X/Twitter account product
- the HStora listing text must explicitly state `TOP Search`, `TOP+Latest`, or equivalent TOP+Latest wording
- the effective price for the quantity actually being ordered must be at or below `max_unit_price_jpy`
- default ceiling: `80 JPY / account`

`Search Visible`, `Latest Search`, or `No Shadowban` alone do not qualify an item as TOP_SEARCH.

#### NO_SHADOWBAN

Requirements:

- the listing must be an X/Twitter account product
- it must explicitly state `No Shadowban` / `No Shadow Ban`
- ordinary listings remain exclusive to this class only when they do **not** contain TOP Search / TOP+Latest evidence
- the effective HStora USD unit price must be at or below `max_no_shadowban_unit_price_usd`
- default ceiling: `0.60 USD / account`
- the configurable ceiling is restricted to `0.50 - 0.60 USD`

### Dynamic cheapest TOP-search source selection

No HStora product ID is hard-coded as the preferred source.

On every procurement scan, Discord-Shiire fetches the HStora catalog and product details and applies a fail-closed qualification pass before price ranking:

- the listing must be an X/Twitter account product
- `TOP Search` or `TOP+Latest` evidence must be explicitly present for TOP-search procurement
- price alone can never make a listing qualify as TOP-search
- negated TOP wording such as `No TOP Search` / `TOP Search unavailable` is removed from positive evidence
- the live product detail is re-qualified again immediately before an order is created
- only after qualification succeeds are candidates ordered by effective unit price

A listing that explicitly proves **both TOP-search and No Shadowban** is treated as a dual-capability source. These listings are preferred when replenishing the No-Shadowban inventory, so a cheaper No-Shadowban-only listing does not displace an available qualifying TOP-search source.

For every dual-capability source, regardless of HStora product ID:

- new purchase quantities are forced to an even number
- delivered credentials are stored **50% as `TOP_SEARCH` and 50% as `NO_SHADOWBAN`**
- delayed/retried HStora delivery reconciliation continues from the already-stored class counts so the final split does not drift
- class-backed vending products receive only the stock count actually added to their class

If no qualifying dual-capability listing is available, the existing No-Shadowban-only candidates remain a fallback rather than causing an unnecessary stock outage.

Each class has independent inventory controls:

```text
TOP_SEARCH
  reorder_point
  target_stock

NO_SHADOWBAN
  no_shadowban_reorder_point
  no_shadowban_target_stock
```

When both classes are below their reorder points, TOP_SEARCH is replenished first.

Within each class, qualified HStora listings are sorted cheapest-first. TOP_SEARCH is sorted by effective JPY unit price and NO_SHADOWBAN is sorted by effective USD unit price. The price tier is recalculated using the quantity that will actually be ordered, including first-product trial limits.

Existing purchased accounts are backfilled into the new procurement classes when their HStora product is re-evaluated. The engine recounts class inventory after this backfill before placing a new order, preventing a migration-time extra batch.


## Production deployment checklist

現在、このリポジトリの GitHub Actions は CI（typecheck / test）のみで、Cloudflare Worker の本番デプロイは自動ではありません。

初回に必要な外部設定:

1. 推奨: `Discord-Bot-Factory` でこのリポジトリを選び、`bot-factory.json` のフォームから起動する。Factoryを使わない場合だけ `npm run deploy` または Cloudflare Workers Builds でデプロイする。デプロイ後、実際の Worker HTTPS origin を確認する。
2. Xaccount-Bot Worker に `SHIIRE_API_BASE_URL=<Discord-Shiireの実URL>` を設定する。
3. Discord-Shiire Worker に `XACCOUNT_BOT_BASE_URL=<Xaccount-Botの実URL>` を設定する。
4. 両Workerに同一の32文字以上の `SHIIRE_BRIDGE_SECRET` を Secret として設定する。
5. Factoryフォームから Discord-Shiire Worker に `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `HSTORA_API_KEY`, `HSTORA_API_SECRET` を設定する。将来Binance自動補充を使う場合だけ `BINANCE_API_KEY` / `BINANCE_API_SECRET` を追加し、正規の利用条件とAPI設定を満たした後に `BINANCE_AUTO_FUNDING_ENABLED=true` を設定する。`ADMIN_TOKEN` と `CREDENTIALS_ENCRYPTION_KEY` はFactoryが自動生成する。従来型の汎用仕入れも使う場合だけ `MAIN_BOT_BASE_URL` を追加する。
6. Discord Developer Portal の Interactions Endpoint URL を `https://<Discord-Shiire Worker>/interactions` に設定する。
7. HStora Webhook を使う場合だけ、Webhook URLを `https://<Discord-Shiire Worker>/webhooks/hstora` に設定し、同じ署名Secretを `HSTORA_WEBHOOK_SECRET` として保存する。
8. Xaccount-Bot の GitHub Repository Variable `VITE_API_BASE_URL` を実際の Xaccount-Bot Worker origin に設定する。

なお、現在の標準フローでは HStora Main Wallet へのLTC入金だけが手動境界です。入金反映後は1分Cronで残高増加を検知し、仕入れ・在庫保存・自販機納品へ自動復帰します。Binance出金APIの安全チェック実装は残していますが、HStoraの入金先を公式APIから取得できないため、自動仕入れエンジンから出金関数を呼びません。専用LTC Walletも未接続です。


### Discord-Bot-Factory

`bot-factory.json` を追加済みです。Factoryフォームでは、Discord-ShiireのDiscord資格情報、Xaccount-Bot Worker URL、共通Bridge Secret、Binance取引API、HStora APIを入力します。

`ADMIN_TOKEN` と `CREDENTIALS_ENCRYPTION_KEY` はFactoryが安全なランダム値を生成し、同じリポジトリ + Cloudflareアカウントへの再デプロイ時にも再利用します。

Binance出金用APIキー・固定送信元IP確認・Travel Rule JSONは現在の仕入れフローでは任意です。HStoraへのLTC入金が手動境界のため、出金自動化を接続するまでは設定しないでください。


## Main dashboard operations

通常運用では Discord-Shiire の `/x-admin` に ADMIN_TOKEN を入力する必要はありません。Xaccount-Bot の「仕入れbot > 資金・LTC / ログ・障害」から、署名付きBridge経由で次を操作できます。

- LTC補充モード（HStora手動補充 / 将来のBinance自動補充）
- reserve_jpy / 1回・日・週・月のLTC購入上限 / 最低購入額
- Binance LTC目標残高 / 最大残高
- PayPay残高の手動観測
- USD/JPYの手動観測
- Dry Run / LTC自動購入 / 自動仕入れ
- LTC自動購入の即時判定（自動仕入れOFFでも実行可能）
- Emergency Stop / 解除
- PayPay手動操作待ちの取消
- Circuit Breaker解除
- 大量購入の10分間一時承認

`/x-admin` は低レベル診断用として残します。Settings JSONからは、pending PayPayスナップショット、観測時刻、FX観測値、大量購入承認期限などのruntime-owned状態を直接編集できないよう制限しています。


### PayPay手動操作の再開判定

- PayPay -> Binance JPY即時入金は、保留開始時のBinance JPY残高と、公式手数料を考慮した期待純増額を比較し、十分なJPY増加を確認できた場合だけ自動再開します。
- PayPayでLTCを直接購入した場合は、BinanceのLTC総残高（free + locked）の増加をBOTが検知しても自動確定しません。通常ユーザー向け公開APIで「そのLTC増加がPayPay販売所購入由来」と確定照合できる仕様を確認できないため、Main BOT管理画面の「このLTC購入を確認して再開」を管理者が押した時だけ確定します。
- 確認ボタンを押した時点でもBinance LTC総残高を再取得し、保留開始時より増えていなければ確定を拒否します。
- 保留開始後にPayPay残高の観測値を手動更新した場合、その新しい観測値を優先し、購入額を二重に差し引きません。
