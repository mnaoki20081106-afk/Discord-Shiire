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

Main Bot URLは `wrangler.jsonc` の `MAIN_BOT_BASE_URL` で設定します。


## X account procurement

The X account procurement flow is implemented as a separate, fail-closed pipeline inside Discord-Shiire.

```text
PayPay (manual official-UI boundary)
  -> Binance Japan JPY instant funding OR direct LTC purchase when offered
  -> LTC/JPY Spot when JPY funding was used
  -> HStora Main Wallet funding boundary
  -> HStora official API purchase
  -> encrypted D1 inventory
  -> READY_FOR_DELIVERY
  -> future Xaccount-Bot DeliveryProvider
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
dry_run = true
auto_purchase_enabled = false
auto_procurement_enabled = false
auto_ltc_withdraw_enabled = false
emergency_stop = false
seller_quality_mode = strict_api
```

Turning Dry Run off through the admin API requires an explicit live-mode confirmation.
Emergency Stop disables both automatic purchase and automatic procurement.

Funding limits are calculated fail-closed. The actual JPY purchase ceiling is the minimum of:

- observed PayPay balance minus `reserve_jpy`
- `max_purchase_jpy`
- remaining daily limit
- remaining weekly limit
- remaining monthly limit
- remaining LTC target balance capacity
- remaining LTC maximum balance capacity

A stale PayPay observation makes the allowable automated purchase amount zero.

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

### HStora

The HStora adapter uses the documented v1 catalog/product/balance/order APIs.
Purchase calls use both an external order ID and an idempotency key.
If an order POST has an ambiguous result, Discord-Shiire performs the official external-order lookup instead of blindly submitting another purchase.

The current HStora product schema does not expose the requested seller rating, review count, sales count, and dispute-rate fields. Therefore:

- `seller_quality_mode = strict_api` blocks automatic purchasing.
- `seller_quality_mode = manual_product_approval` only allows explicitly approved HStora product IDs.

No seller quality value is fabricated.

HStora wallet deposit-address automation is not guessed. If the official API does not expose the required deposit operation, the pipeline stops at the manual HStora LTC deposit boundary and detects the HStora balance increase afterward.

### Credential storage

HStora delivery data is never stored in plaintext.

- payload encryption: AES-GCM
- key source: `CREDENTIALS_ENCRYPTION_KEY` Worker Secret
- duplicate fingerprint: keyed HMAC
- DB state after purchase: `READY_FOR_DELIVERY`

The future Xaccount-Bot delivery contract is intentionally not called yet.

### Required Worker Secrets for X procurement

Store these with Cloudflare Worker Secret management, never in GitHub or `wrangler.jsonc`:

```text
BINANCE_API_KEY
BINANCE_API_SECRET
HSTORA_API_KEY
HSTORA_API_SECRET
HSTORA_WEBHOOK_SECRET
CREDENTIALS_ENCRYPTION_KEY
```

Optional / feature-specific:

```text
BINANCE_TRAVEL_RULE_QUESTIONNAIRE
DISCORD_NOTIFY_WEBHOOK_URL
HSTORA_WEBHOOK_SECRET
```

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
