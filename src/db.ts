import type {
  Env, JobRow, JobStatus, ProductRow, SupplierKind, SupplierRow, ProcessorKind
} from "./types";
import { randomId, sha256Hex } from "./crypto";

let ready=false;

const schema=[
  "CREATE TABLE IF NOT EXISTS suppliers (id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,config_json TEXT NOT NULL DEFAULT '{}',enabled INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY,name TEXT NOT NULL,supplier_id TEXT NOT NULL,supplier_sku TEXT NOT NULL,main_product_id TEXT NOT NULL,min_stock INTEGER NOT NULL,target_stock INTEGER NOT NULL,max_batch INTEGER NOT NULL,processor_kind TEXT NOT NULL DEFAULT 'identity',processor_config_json TEXT NOT NULL DEFAULT '{}',enabled INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS products_enabled_idx ON products(enabled,created_at)",
  "CREATE TABLE IF NOT EXISTS supply_jobs (id TEXT PRIMARY KEY,product_id TEXT NOT NULL,status TEXT NOT NULL,requested_qty INTEGER NOT NULL,acquired_qty INTEGER NOT NULL DEFAULT 0,delivered_qty INTEGER NOT NULL DEFAULT 0,attempt_count INTEGER NOT NULL DEFAULT 0,next_retry_at INTEGER,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS supply_jobs_product_idx ON supply_jobs(product_id,created_at DESC)",
  "CREATE INDEX IF NOT EXISTS supply_jobs_retry_idx ON supply_jobs(status,next_retry_at)",
  "CREATE TABLE IF NOT EXISTS supply_items (id TEXT PRIMARY KEY,job_id TEXT NOT NULL,product_id TEXT NOT NULL,fingerprint TEXT NOT NULL,content TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'acquired',created_at INTEGER NOT NULL,delivered_at INTEGER,UNIQUE(product_id,fingerprint))",
  "CREATE INDEX IF NOT EXISTS supply_items_job_idx ON supply_items(job_id,state)",
  "CREATE TABLE IF NOT EXISTS supplier_pool (id TEXT PRIMARY KEY,supplier_id TEXT NOT NULL,sku TEXT NOT NULL,fingerprint TEXT NOT NULL,content TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'available',created_at INTEGER NOT NULL,taken_at INTEGER,UNIQUE(supplier_id,sku,fingerprint))",
  "CREATE INDEX IF NOT EXISTS supplier_pool_lookup_idx ON supplier_pool(supplier_id,sku,state,created_at)",
  "CREATE TABLE IF NOT EXISTS supply_events (id TEXT PRIMARY KEY,level TEXT NOT NULL,kind TEXT NOT NULL,product_id TEXT,job_id TEXT,message TEXT NOT NULL,created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS supply_events_recent_idx ON supply_events(created_at DESC)"
];

export async function ensureSchema(env:Env){
  if(ready) return;
  for(const sql of schema) await env.DB.prepare(sql).run();
  ready=true;
}

export async function logEvent(
  env:Env,
  input:{level?:"info"|"warn"|"error";kind:string;productId?:string|null;jobId?:string|null;message:string}
){
  await env.DB.prepare(
    "INSERT INTO supply_events(id,level,kind,product_id,job_id,message,created_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(
    randomId(),input.level??"info",input.kind,input.productId??null,input.jobId??null,
    input.message.slice(0,1000),Date.now()
  ).run();
}

export async function recentEvents(env:Env,limit=100){
  return (await env.DB.prepare(
    "SELECT * FROM supply_events ORDER BY created_at DESC LIMIT ?"
  ).bind(Math.max(1,Math.min(200,limit))).all()).results;
}

export async function listSuppliers(env:Env){
  return (await env.DB.prepare(
    "SELECT * FROM suppliers ORDER BY created_at ASC"
  ).all<SupplierRow>()).results;
}

export async function getSupplier(env:Env,id:string){
  return await env.DB.prepare(
    "SELECT * FROM suppliers WHERE id=?"
  ).bind(id).first<SupplierRow>()??null;
}

export async function createSupplier(
  env:Env,
  input:{name:string;kind:SupplierKind;config?:unknown;enabled?:boolean}
){
  const now=Date.now();
  const row:SupplierRow={
    id:randomId(),
    name:input.name.trim(),
    kind:input.kind,
    config_json:JSON.stringify(input.config??{}),
    enabled:input.enabled===false?0:1,
    created_at:now,
    updated_at:now
  };
  await env.DB.prepare(
    "INSERT INTO suppliers(id,name,kind,config_json,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(
    row.id,row.name,row.kind,row.config_json,row.enabled,row.created_at,row.updated_at
  ).run();
  return row;
}

export async function listProducts(env:Env){
  return (await env.DB.prepare(
    "SELECT * FROM products ORDER BY created_at ASC"
  ).all<ProductRow>()).results;
}

export async function listEnabledProducts(env:Env){
  return (await env.DB.prepare(
    "SELECT * FROM products WHERE enabled=1 ORDER BY created_at ASC"
  ).all<ProductRow>()).results;
}

export async function getProduct(env:Env,id:string){
  return await env.DB.prepare(
    "SELECT * FROM products WHERE id=?"
  ).bind(id).first<ProductRow>()??null;
}

export async function createProduct(
  env:Env,
  input:{
    name:string;
    supplierId:string;
    supplierSku:string;
    mainProductId:string;
    minStock:number;
    targetStock:number;
    maxBatch:number;
    processorKind?:ProcessorKind;
    processorConfig?:unknown;
    enabled?:boolean;
  }
){
  const now=Date.now();
  const row:ProductRow={
    id:randomId(),
    name:input.name.trim(),
    supplier_id:input.supplierId,
    supplier_sku:input.supplierSku,
    main_product_id:input.mainProductId,
    min_stock:input.minStock,
    target_stock:input.targetStock,
    max_batch:input.maxBatch,
    processor_kind:input.processorKind??"identity",
    processor_config_json:JSON.stringify(input.processorConfig??{}),
    enabled:input.enabled===false?0:1,
    created_at:now,
    updated_at:now
  };
  await env.DB.prepare(
    "INSERT INTO products(id,name,supplier_id,supplier_sku,main_product_id,min_stock,target_stock,max_batch,processor_kind,processor_config_json,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(
    row.id,row.name,row.supplier_id,row.supplier_sku,row.main_product_id,
    row.min_stock,row.target_stock,row.max_batch,row.processor_kind,
    row.processor_config_json,row.enabled,row.created_at,row.updated_at
  ).run();
  return row;
}

export async function latestJob(env:Env,productId:string){
  return await env.DB.prepare(
    "SELECT * FROM supply_jobs WHERE product_id=? ORDER BY created_at DESC LIMIT 1"
  ).bind(productId).first<JobRow>()??null;
}

export async function getJob(env:Env,id:string){
  return await env.DB.prepare(
    "SELECT * FROM supply_jobs WHERE id=?"
  ).bind(id).first<JobRow>()??null;
}

export async function findRecoverableJob(env:Env,productId:string){
  return await env.DB.prepare(
    "SELECT * FROM supply_jobs WHERE product_id=? AND status IN ('acquired','delivery_failed') AND (next_retry_at IS NULL OR next_retry_at<=?) ORDER BY created_at ASC LIMIT 1"
  ).bind(productId,Date.now()).first<JobRow>()??null;
}

export async function hasBlockedJob(env:Env,productId:string){
  return Boolean(await env.DB.prepare(
    "SELECT id FROM supply_jobs WHERE product_id=? AND status IN ('acquiring','out_of_stock','failed','delivery_failed') AND next_retry_at>? ORDER BY created_at DESC LIMIT 1"
  ).bind(productId,Date.now()).first<{id:string}>());
}

export async function createJob(env:Env,productId:string,requestedQty:number){
  const now=Date.now();
  const row:JobRow={
    id:randomId(),
    product_id:productId,
    status:"acquiring",
    requested_qty:requestedQty,
    acquired_qty:0,
    delivered_qty:0,
    attempt_count:0,
    next_retry_at:null,
    error:null,
    created_at:now,
    updated_at:now
  };
  await env.DB.prepare(
    "INSERT INTO supply_jobs(id,product_id,status,requested_qty,acquired_qty,delivered_qty,attempt_count,next_retry_at,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(
    row.id,row.product_id,row.status,row.requested_qty,row.acquired_qty,row.delivered_qty,
    row.attempt_count,row.next_retry_at,row.error,row.created_at,row.updated_at
  ).run();
  return row;
}

export async function updateJob(
  env:Env,
  id:string,
  patch:Partial<{
    status:JobStatus;
    acquiredQty:number;
    deliveredQty:number;
    attemptCount:number;
    nextRetryAt:number|null;
    error:string|null;
  }>
){
  const cur=await getJob(env,id);
  if(!cur) return null;
  await env.DB.prepare(
    "UPDATE supply_jobs SET status=?,acquired_qty=?,delivered_qty=?,attempt_count=?,next_retry_at=?,error=?,updated_at=? WHERE id=?"
  ).bind(
    patch.status??cur.status,
    patch.acquiredQty??cur.acquired_qty,
    patch.deliveredQty??cur.delivered_qty,
    patch.attemptCount??cur.attempt_count,
    patch.nextRetryAt===undefined?cur.next_retry_at:patch.nextRetryAt,
    patch.error===undefined?cur.error:patch.error,
    Date.now(),
    id
  ).run();
  return getJob(env,id);
}

export async function addPoolItems(
  env:Env,
  supplierId:string,
  sku:string,
  contents:string[]
){
  const clean=[...new Set(contents.map(v=>v.trim()).filter(Boolean))];
  const rows=await Promise.all(clean.map(async content=>({
    id:randomId(),
    content,
    fingerprint:await sha256Hex(content)
  })));
  let added=0;
  const now=Date.now();
  for(let i=0;i<rows.length;i+=50){
    const chunk=rows.slice(i,i+50);
    const results=await env.DB.batch(chunk.map(row=>
      env.DB.prepare(
        "INSERT OR IGNORE INTO supplier_pool(id,supplier_id,sku,fingerprint,content,state,created_at) VALUES (?,?,?,?,?,'available',?)"
      ).bind(row.id,supplierId,sku,row.fingerprint,row.content,now)
    ));
    added+=results.reduce((sum,result)=>sum+Number(result.meta.changes??0),0);
  }
  return added;
}

export async function takePoolItems(
  env:Env,
  supplierId:string,
  sku:string,
  quantity:number
){
  const rows=(await env.DB.prepare(
    "SELECT id,content FROM supplier_pool WHERE supplier_id=? AND sku=? AND state='available' ORDER BY created_at ASC LIMIT ?"
  ).bind(supplierId,sku,quantity).all<{id:string;content:string}>()).results;
  if(rows.length===0) return [];
  const taken:string[]=[];
  const now=Date.now();
  for(const row of rows){
    const result=await env.DB.prepare(
      "UPDATE supplier_pool SET state='taken',taken_at=? WHERE id=? AND state='available'"
    ).bind(now,row.id).run();
    if((result.meta.changes??0)>0) taken.push(row.content);
  }
  return taken;
}

export async function storeJobItems(
  env:Env,
  jobId:string,
  productId:string,
  contents:string[]
){
  const clean=[...new Set(contents.map(v=>v.trim()).filter(Boolean))];
  const rows=await Promise.all(clean.map(async content=>({
    id:randomId(),
    content,
    fingerprint:await sha256Hex(content)
  })));
  let added=0;
  const now=Date.now();
  for(let i=0;i<rows.length;i+=50){
    const chunk=rows.slice(i,i+50);
    const results=await env.DB.batch(chunk.map(row=>
      env.DB.prepare(
        "INSERT OR IGNORE INTO supply_items(id,job_id,product_id,fingerprint,content,state,created_at) VALUES (?,?,?,?,?,'acquired',?)"
      ).bind(row.id,jobId,productId,row.fingerprint,row.content,now)
    ));
    added+=results.reduce((sum,result)=>sum+Number(result.meta.changes??0),0);
  }
  return added;
}

export async function jobItems(env:Env,jobId:string){
  return (await env.DB.prepare(
    "SELECT id,content FROM supply_items WHERE job_id=? AND state='acquired' ORDER BY created_at ASC"
  ).bind(jobId).all<{id:string;content:string}>()).results;
}

export async function markJobItemsDelivered(env:Env,jobId:string){
  await env.DB.prepare(
    "UPDATE supply_items SET state='delivered',delivered_at=? WHERE job_id=? AND state='acquired'"
  ).bind(Date.now(),jobId).run();
}

export async function dashboardSnapshot(env:Env){
  const [products,jobs,events]=await Promise.all([
    listProducts(env),
    env.DB.prepare("SELECT * FROM supply_jobs ORDER BY created_at DESC LIMIT 50").all<JobRow>(),
    recentEvents(env,50)
  ]);
  return {products,jobs:jobs.results,events};
}
