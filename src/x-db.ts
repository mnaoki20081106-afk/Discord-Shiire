import type { Env } from "./types";
import { sha256Hex, randomId } from "./crypto";
import { encryptSensitive } from "./x-crypto";

let schemaReady=false;

const SCHEMA=[
`CREATE TABLE IF NOT EXISTS supplier_products (
  id TEXT PRIMARY KEY,
  supplier TEXT NOT NULL,
  supplier_product_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL,
  unit_price REAL NOT NULL,
  stock_available INTEGER NOT NULL DEFAULT 0,
  product_url TEXT,
  seller_id TEXT,
  seller_name TEXT,
  seller_rating REAL,
  product_reviews INTEGER,
  sales_count INTEGER,
  dispute_rate REAL,
  structured_json TEXT NOT NULL DEFAULT '{}',
  qualification_json TEXT NOT NULL DEFAULT '{}',
  qualified INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(supplier, supplier_product_id)
)`,
`CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  supplier TEXT NOT NULL,
  supplier_product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  total_amount REAL NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  external_order_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  supplier_order_id TEXT,
  dry_run INTEGER NOT NULL DEFAULT 1,
  response_meta_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS purchased_accounts (
  id TEXT PRIMARY KEY,
  supplier TEXT NOT NULL,
  supplier_product_id TEXT NOT NULL,
  purchase_order_id TEXT NOT NULL,
  purchase_price REAL NOT NULL,
  purchased_at INTEGER NOT NULL,
  credentials_ciphertext TEXT NOT NULL,
  email_ciphertext TEXT,
  two_factor_ciphertext TEXT,
  credential_fingerprint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS inventory (
  id TEXT PRIMARY KEY,
  supplier_product_id TEXT NOT NULL,
  status TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(supplier_product_id,status)
)`,
`CREATE TABLE IF NOT EXISTS crypto_transactions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  asset TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  fee REAL,
  network TEXT,
  address_hash TEXT,
  provider_transaction_id TEXT,
  status TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS funding_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_jpy INTEGER NOT NULL DEFAULT 0,
  asset TEXT,
  asset_amount REAL,
  status TEXT NOT NULL,
  provider_reference TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS circuit_breakers (
  key TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  reason TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  tripped_at INTEGER,
  updated_at INTEGER NOT NULL
)`,
`CREATE INDEX IF NOT EXISTS idx_purchase_orders_created ON purchase_orders(created_at)`,
`CREATE INDEX IF NOT EXISTS idx_accounts_status ON purchased_accounts(status)`,
`CREATE INDEX IF NOT EXISTS idx_funding_events_created ON funding_events(created_at)`,
`CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at)`
];

export async function ensureXSchema(env:Env){
  if(schemaReady) return;
  for(const sql of SCHEMA) await env.DB.prepare(sql).run();
  schemaReady=true;
}

export async function getXSetting<T>(env:Env,key:string):Promise<T|null>{
  await ensureXSchema(env);
  const row=await env.DB.prepare("SELECT value_json FROM settings WHERE key=?").bind(key).first<{value_json:string}>();
  if(!row) return null;
  try{return JSON.parse(row.value_json) as T;}catch{return null;}
}

export async function setXSetting(env:Env,key:string,value:unknown){
  await ensureXSchema(env);
  const now=Date.now();
  await env.DB.prepare(
    "INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?) "+
    "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at"
  ).bind(key,JSON.stringify(value),now).run();
}

const SECRET_KEY_RE=/(secret|password|credential|token|2fa|api.?key|private.?key|authorization)/i;

function redact(value:unknown,depth=0):unknown{
  if(depth>5) return "[TRUNCATED]";
  if(Array.isArray(value)) return value.slice(0,50).map(v=>redact(v,depth+1));
  if(value&&typeof value==="object"){
    const out:Record<string,unknown>={};
    for(const [key,item] of Object.entries(value as Record<string,unknown>)){
      out[key]=SECRET_KEY_RE.test(key)?"[REDACTED]":redact(item,depth+1);
    }
    return out;
  }
  if(typeof value==="string"&&value.length>2000) return value.slice(0,2000)+"…";
  return value;
}

export async function auditX(env:Env,input:{
  level?:"info"|"warn"|"error";
  kind:string;
  message:string;
  details?:unknown;
}){
  await ensureXSchema(env);
  await env.DB.prepare(
    "INSERT INTO audit_logs(id,level,kind,message,details_json,created_at) VALUES(?,?,?,?,?,?)"
  ).bind(
    randomId(),
    input.level??"info",
    input.kind,
    input.message.slice(0,1000),
    JSON.stringify(redact(input.details??{})),
    Date.now()
  ).run();
}

export async function listAuditLogs(env:Env,limit=100){
  await ensureXSchema(env);
  const safe=Math.max(1,Math.min(500,Math.floor(limit)));
  const result=await env.DB.prepare(
    "SELECT id,level,kind,message,details_json,created_at FROM audit_logs ORDER BY created_at DESC LIMIT ?"
  ).bind(safe).all();
  return result.results;
}

export async function recordFundingEvent(env:Env,input:{
  provider:string;
  kind:string;
  amountJpy?:number;
  asset?:string;
  assetAmount?:number;
  status:string;
  providerReference?:string;
  metadata?:unknown;
}){
  await ensureXSchema(env);
  const now=Date.now();
  const id=randomId();
  await env.DB.prepare(
    `INSERT INTO funding_events(
      id,provider,kind,amount_jpy,asset,asset_amount,status,provider_reference,metadata_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id,input.provider,input.kind,Math.max(0,Math.floor(input.amountJpy??0)),
    input.asset??null,input.assetAmount??null,input.status,input.providerReference??null,
    JSON.stringify(redact(input.metadata??{})),now,now
  ).run();
  return id;
}

export async function fundingSpendSince(env:Env,since:number):Promise<number>{
  await ensureXSchema(env);
  const row=await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_jpy),0) AS total FROM funding_events "+
    "WHERE kind='LTC_PURCHASE' AND status IN ('SUBMITTED','FILLED','COMPLETED') AND created_at>=?"
  ).bind(since).first<{total:number}>();
  return Math.max(0,Number(row?.total??0));
}

export async function upsertSupplierProduct(env:Env,input:{
  supplier:string;
  supplierProductId:string;
  title:string;
  description:string;
  currency:string;
  unitPrice:number;
  stockAvailable:number;
  productUrl?:string;
  structured?:unknown;
  qualification?:unknown;
  qualified:boolean;
  seller?:{
    id?:string;name?:string;rating?:number;reviews?:number;sales?:number;disputeRate?:number;
  }|null;
}){
  await ensureXSchema(env);
  const now=Date.now();
  const id=`${input.supplier}:${input.supplierProductId}`;
  const s=input.seller??{};
  await env.DB.prepare(`INSERT INTO supplier_products(
    id,supplier,supplier_product_id,title,description,currency,unit_price,stock_available,product_url,
    seller_id,seller_name,seller_rating,product_reviews,sales_count,dispute_rate,
    structured_json,qualification_json,qualified,last_seen_at,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(supplier,supplier_product_id) DO UPDATE SET
    title=excluded.title,description=excluded.description,currency=excluded.currency,
    unit_price=excluded.unit_price,stock_available=excluded.stock_available,product_url=excluded.product_url,
    seller_id=excluded.seller_id,seller_name=excluded.seller_name,seller_rating=excluded.seller_rating,
    product_reviews=excluded.product_reviews,sales_count=excluded.sales_count,dispute_rate=excluded.dispute_rate,
    structured_json=excluded.structured_json,qualification_json=excluded.qualification_json,
    qualified=excluded.qualified,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`
  ).bind(
    id,input.supplier,input.supplierProductId,input.title,input.description,input.currency,input.unitPrice,
    Math.max(0,Math.floor(input.stockAvailable)),input.productUrl??null,
    s.id??null,s.name??null,s.rating??null,s.reviews??null,s.sales??null,s.disputeRate??null,
    JSON.stringify(redact(input.structured??{})),JSON.stringify(input.qualification??{}),
    input.qualified?1:0,now,now,now
  ).run();
  return id;
}

export async function listSupplierProducts(env:Env,qualifiedOnly=false){
  await ensureXSchema(env);
  const sql=`SELECT * FROM supplier_products ${qualifiedOnly?"WHERE qualified=1 ":""}ORDER BY updated_at DESC LIMIT 500`;
  const result=await env.DB.prepare(sql).all();
  return result.results;
}

export async function createPurchaseOrderRecord(env:Env,input:{
  supplier:string;
  supplierProductId:string;
  quantity:number;
  unitPrice:number;
  totalAmount:number;
  currency:string;
  externalOrderId:string;
  idempotencyKey:string;
  dryRun:boolean;
}){
  await ensureXSchema(env);
  const now=Date.now();
  const id=randomId();
  await env.DB.prepare(`INSERT INTO purchase_orders(
    id,supplier,supplier_product_id,quantity,unit_price,total_amount,currency,status,
    external_order_id,idempotency_key,dry_run,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id,input.supplier,input.supplierProductId,input.quantity,input.unitPrice,input.totalAmount,input.currency,
    input.dryRun?"DRY_RUN":"CREATED",input.externalOrderId,input.idempotencyKey,input.dryRun?1:0,now,now
  ).run();
  return id;
}

function responseMetadata(response:any){
  if(!response||typeof response!=="object") return {};
  const clone:{[key:string]:unknown}={};
  for(const [key,value] of Object.entries(response)){
    if(key==="delivery") continue;
    clone[key]=redact(value);
  }
  return clone;
}

export async function updatePurchaseOrderRecord(env:Env,id:string,input:{
  status:string;
  supplierOrderId?:string;
  response?:unknown;
  errorCode?:string;
}){
  await ensureXSchema(env);
  await env.DB.prepare(`UPDATE purchase_orders SET
    status=?,supplier_order_id=COALESCE(?,supplier_order_id),response_meta_json=?,
    error_code=?,updated_at=? WHERE id=?`).bind(
    input.status,input.supplierOrderId??null,JSON.stringify(responseMetadata(input.response)),
    input.errorCode??null,Date.now(),id
  ).run();
}

function deliveryItems(response:any):unknown[]{
  const items=response?.delivery?.items;
  return Array.isArray(items)?items:[];
}

export async function storeDeliveredAccounts(env:Env,input:{
  purchaseOrderId:string;
  supplier:string;
  supplierProductId:string;
  purchasePrice:number;
  orderResponse:unknown;
}):Promise<number>{
  await ensureXSchema(env);
  const items=deliveryItems(input.orderResponse);
  let inserted=0;
  const now=Date.now();
  for(const item of items){
    const raw=typeof item==="string"?item:JSON.stringify(item);
    const fingerprint=await sha256Hex(raw);
    const encrypted=await encryptSensitive(env,raw);
    const id=randomId();
    const result=await env.DB.prepare(`INSERT OR IGNORE INTO purchased_accounts(
      id,supplier,supplier_product_id,purchase_order_id,purchase_price,purchased_at,
      credentials_ciphertext,email_ciphertext,two_factor_ciphertext,credential_fingerprint,status,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      id,input.supplier,input.supplierProductId,input.purchaseOrderId,input.purchasePrice,now,
      JSON.stringify(encrypted),null,null,fingerprint,"READY_FOR_DELIVERY",now
    ).run();
    if((result.meta?.changes??0)>0) inserted++;
  }
  if(inserted>0){
    await env.DB.prepare(`INSERT INTO inventory(id,supplier_product_id,status,quantity,updated_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(supplier_product_id,status) DO UPDATE SET
        quantity=quantity+excluded.quantity,updated_at=excluded.updated_at`
    ).bind(randomId(),input.supplierProductId,"READY_FOR_DELIVERY",inserted,now).run();
  }
  return inserted;
}

export async function inventorySummary(env:Env){
  await ensureXSchema(env);
  const rows=await env.DB.prepare(
    "SELECT status,COALESCE(SUM(quantity),0) AS quantity FROM inventory GROUP BY status"
  ).all();
  const out:Record<string,number>={};
  for(const row of rows.results as any[]) out[String(row.status)]=Number(row.quantity??0);
  return out;
}

export async function todayPurchaseStats(env:Env,dayStart:number){
  await ensureXSchema(env);
  const row=await env.DB.prepare(`SELECT
    COALESCE(SUM(CASE WHEN status NOT IN ('DRY_RUN','FAILED') THEN quantity ELSE 0 END),0) AS count,
    COALESCE(SUM(CASE WHEN status NOT IN ('DRY_RUN','FAILED') THEN total_amount ELSE 0 END),0) AS amount,
    COALESCE(AVG(CASE WHEN status NOT IN ('DRY_RUN','FAILED') THEN unit_price END),0) AS avg
    FROM purchase_orders WHERE created_at>=?`).bind(dayStart).first<any>();
  return {count:Number(row?.count??0),amount:Number(row?.amount??0),average:Number(row?.avg??0)};
}

export async function setCircuitBreaker(env:Env,key:string,state:"CLOSED"|"OPEN",reason?:string){
  await ensureXSchema(env);
  const now=Date.now();
  await env.DB.prepare(`INSERT INTO circuit_breakers(key,state,reason,failure_count,tripped_at,updated_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET state=excluded.state,reason=excluded.reason,
      failure_count=CASE WHEN excluded.state='OPEN' THEN circuit_breakers.failure_count+1 ELSE 0 END,
      tripped_at=excluded.tripped_at,updated_at=excluded.updated_at`
  ).bind(key,state,reason??null,state==="OPEN"?1:0,state==="OPEN"?now:null,now).run();
}

export async function circuitState(env:Env,key:string){
  await ensureXSchema(env);
  return env.DB.prepare("SELECT * FROM circuit_breakers WHERE key=?").bind(key).first<any>();
}

export async function listPurchaseOrders(env:Env,limit=100){
  await ensureXSchema(env);
  const safe=Math.max(1,Math.min(500,Math.floor(limit)));
  const result=await env.DB.prepare(
    "SELECT * FROM purchase_orders ORDER BY created_at DESC LIMIT ?"
  ).bind(safe).all();
  return result.results;
}


export async function readyInventoryCount(env:Env):Promise<number>{
  await ensureXSchema(env);
  const row=await env.DB.prepare(
    "SELECT COALESCE(SUM(quantity),0) AS quantity FROM inventory WHERE status='READY_FOR_DELIVERY'"
  ).first<{quantity:number}>();
  return Math.max(0,Number(row?.quantity??0));
}

export async function successfulPurchaseCountForProduct(
  env:Env,
  supplierProductId:string
):Promise<number>{
  await ensureXSchema(env);
  const row=await env.DB.prepare(
    "SELECT COALESCE(SUM(quantity),0) AS quantity FROM purchase_orders "+
    "WHERE supplier='hstora' AND supplier_product_id=? "+
    "AND dry_run=0 AND status IN ('DELIVERED','COMPLETED')"
  ).bind(supplierProductId).first<{quantity:number}>();
  return Math.max(0,Number(row?.quantity??0));
}

export async function pendingPurchaseOrders(env:Env){
  await ensureXSchema(env);
  const result=await env.DB.prepare(
    "SELECT * FROM purchase_orders WHERE supplier='hstora' AND dry_run=0 "+
    "AND status IN ('CREATED','SUBMITTED','PROCESSING','PENDING') "+
    "ORDER BY created_at ASC LIMIT 50"
  ).all<any>();
  return result.results;
}

export async function getPurchaseOrderRecord(env:Env,id:string){
  await ensureXSchema(env);
  return env.DB.prepare("SELECT * FROM purchase_orders WHERE id=?").bind(id).first<any>();
}

export async function getSupplierProductRecord(env:Env,supplierProductId:string){
  await ensureXSchema(env);
  return env.DB.prepare(
    "SELECT * FROM supplier_products WHERE supplier='hstora' AND supplier_product_id=?"
  ).bind(supplierProductId).first<any>();
}
