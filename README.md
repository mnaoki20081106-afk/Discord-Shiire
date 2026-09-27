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

