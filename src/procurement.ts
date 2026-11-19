// 仕入れ品 (procurement items) and 仕入れ先 (suppliers created from templates).
//
// A 仕入れ品 is a row of the generic `products` table extended with the
// columns below. Its destination is an existing Xaccount-Bot vending product
// (main_product_id). Suppliers are rows of `suppliers` whose kind is a
// template id; secrets entered on the dashboard are stored encrypted in
// suppliers.secrets_enc and are never returned to the dashboard.
//
// HSTORA items are executed by the existing HSTORA engine (x-engine): one
// item per procurement class, and purchased accounts are transferred to the
// item's destination product by transferHstoraAccounts().

import type { Env, ProductRow, SupplierRow } from "./types";
import { ensureSchema, getProduct, getSupplier, logEvent } from "./db";
import { randomId, sha256Hex } from "./crypto";
import { decryptSensitive, encryptSensitive, type EncryptedSecret } from "./x-crypto";
import { deliverToMain, getMainCatalog, getMainStock } from "./main-bot";
import { getXSetting, setXSetting, ensureXSchema, auditX, rebalanceProcurementBudgets } from "./x-db";
import { getHstoraBalance } from "./providers/hstora";
import { saveDailyRestockConfig } from "./x-daily-restock-state";
import { loadXSettings, saveXSettings } from "./x-settings";
import { normalizeHstoraDeliveryForVending, DeliveryFormatError } from "./shiire-delivery-format";

export class ProcurementError extends Error{
  constructor(public status:number,public code:string,message?:string){super(message??code);}
}

// ---------------------------------------------------------------------------
// Templates. Adding a supplier site later = adding one entry here (fields)
// plus its adapter. The dashboard renders the fields generically.
// ---------------------------------------------------------------------------

export type TemplateField={
  key:string;
  label:string;
  type:"text"|"url"|"secret"|"select"|"number";
  required?:boolean;
  placeholder?:string;
  help?:string;
  options?:Array<{value:string;label:string}>;
};

export type SupplierTemplate={
  id:"hstora"|"custom_api"|"manual";
  label:string;
  description:string;
  // Saved on the supplier (shared by every item using it).
  fields:TemplateField[];
  // Saved on each item (what to buy from this supplier).
  conditionFields:TemplateField[];
  // The supplier reports unit prices, so 1回/1日/単価 caps can be enforced.
  supportsAmountCaps:boolean;
};

export const HSTORA_CLASSES=[
  {value:"TOP_SEARCH",label:"検索上位（検索に載る）"},
  {value:"NO_SHADOWBAN",label:"シャドバンなし"}
] as const;
export type HstoraClass=typeof HSTORA_CLASSES[number]["value"];

export const SUPPLIER_TEMPLATES:SupplierTemplate[]=[
  {
    id:"hstora",
    supportsAmountCaps:true,
    label:"HSTORA",
    description:"Xアカウントの仕入れ先。API KeyとAPI Secretを入れるだけで使えます。支払いはHSTORAの残高から行います。",
    fields:[
      {key:"apiKey",label:"API Key",type:"secret",required:true},
      {key:"apiSecret",label:"API Secret",type:"secret",required:true}
    ],
    conditionFields:[
      {key:"class",label:"仕入れ条件",type:"select",required:true,options:[...HSTORA_CLASSES]}
    ]
  },
  {
    id:"custom_api",
    supportsAmountCaps:false,
    label:"カスタムAPI",
    description:"「数量を送ると在庫の文字列が返る」形のHTTP APIを持つ仕入れ先。URL・APIキー・レスポンス内の場所を設定します。",
    fields:[
      {key:"baseUrl",label:"APIのURL（https://〜）",type:"url",required:true,placeholder:"https://supplier.example"},
      {key:"acquirePath",label:"注文のパス",type:"text",placeholder:"/api/acquire",help:"POST {sku, quantity} を送るパス"},
      {key:"apiKey",label:"APIキー",type:"secret"},
      {key:"authHeader",label:"APIキーを送るヘッダー",type:"text",placeholder:"Authorization"},
      {key:"authScheme",label:"キーの前に付ける文字",type:"text",placeholder:"Bearer",help:"不要なら空欄"},
      {key:"responseItemsPath",label:"商品一覧の場所（JSON）",type:"text",placeholder:"items",help:"例: data.items"}
    ],
    conditionFields:[
      {key:"sku",label:"仕入れ先の商品コード（SKU）",type:"text",required:true}
    ]
  },
  {
    id:"manual",
    supportsAmountCaps:false,
    label:"手動投入",
    description:"自分で用意した在庫を貼り付けて補充先へ流します。",
    fields:[],
    conditionFields:[
      {key:"sku",label:"区分名",type:"text",required:true,placeholder:"default"}
    ]
  }
];

const LEGACY_KIND:Record<string,SupplierTemplate["id"]>={pool:"manual",http_json:"custom_api"};

export function templateOf(kind:string):SupplierTemplate|null{
  const id=LEGACY_KIND[kind]??kind;
  return SUPPLIER_TEMPLATES.find(template=>template.id===id)??null;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ITEM_COLUMNS:Array<[string,string]>=[
  ["condition_json","TEXT NOT NULL DEFAULT '{}'"],
  ["destination_machine_id","TEXT"],
  ["destination_label","TEXT"],
  ["max_stock","INTEGER NOT NULL DEFAULT 0"],
  ["budget_percent","REAL NOT NULL DEFAULT 0"],
  ["max_purchase_jpy","INTEGER NOT NULL DEFAULT 0"],
  ["daily_limit_jpy","INTEGER NOT NULL DEFAULT 0"],
  ["max_unit_price_jpy","INTEGER NOT NULL DEFAULT 0"],
  ["stockless_enabled","INTEGER NOT NULL DEFAULT 0"],
  ["last_daily_run_on","TEXT"]
];

let procurementReady=false;

// Concurrent requests (cron + dashboard) may run the migration at the same time:
// a column that another request just added is fine.
async function addColumn(env:Env,table:string,name:string,type:string){
  try{
    await env.DB.prepare("ALTER TABLE "+table+" ADD COLUMN "+name+" "+type).run();
  }catch(error){
    if(!/duplicate column/i.test(error instanceof Error?error.message:String(error))) throw error;
  }
}

export async function ensureProcurementSchema(env:Env){
  if(procurementReady) return;
  await ensureSchema(env);
  await ensureXSchema(env);
  const supplierColumns=(await env.DB.prepare("PRAGMA table_info(suppliers)").all<{name:string}>()).results;
  if(!supplierColumns.some(column=>column.name==="secrets_enc")){
    await addColumn(env,"suppliers","secrets_enc","TEXT");
  }
  const productColumns=(await env.DB.prepare("PRAGMA table_info(products)").all<{name:string}>()).results;
  for(const [name,type] of ITEM_COLUMNS){
    if(!productColumns.some(column=>column.name===name)){
      await addColumn(env,"products",name,type);
    }
  }
  procurementReady=true;
  await migrateLegacyHstora(env);
}

export type ItemRow=ProductRow&{
  condition_json:string;
  destination_machine_id:string|null;
  destination_label:string|null;
  max_stock:number;
  budget_percent:number;
  max_purchase_jpy:number;
  daily_limit_jpy:number;
  max_unit_price_jpy:number;
  stockless_enabled:number;
  last_daily_run_on:string|null;
};

type SupplierWithSecrets=SupplierRow&{secrets_enc?:string|null};

function parseJson<T>(raw:string|null|undefined,fallback:T):T{
  if(!raw) return fallback;
  try{return JSON.parse(raw) as T;}catch{return fallback;}
}

// ---------------------------------------------------------------------------
// Supplier secrets
// ---------------------------------------------------------------------------

export async function supplierSecrets(env:Env,supplier:SupplierWithSecrets):Promise<Record<string,string>>{
  if(!supplier.secrets_enc) return {};
  const encrypted=parseJson<EncryptedSecret|null>(supplier.secrets_enc,null);
  if(!encrypted) return {};
  return parseJson<Record<string,string>>(await decryptSensitive(env,encrypted),{});
}

/** Env with HSTORA credentials from the saved HSTORA supplier (falls back to Worker secrets). */
export async function hstoraEnv(env:Env):Promise<Env>{
  await ensureProcurementSchema(env);
  const supplier=await env.DB.prepare(
    "SELECT * FROM suppliers WHERE kind='hstora' AND enabled=1 ORDER BY created_at ASC LIMIT 1"
  ).first<SupplierWithSecrets>();
  if(!supplier) return env;
  const secrets=await supplierSecrets(env,supplier).catch(()=>({} as Record<string,string>));
  if(!secrets.apiKey||!secrets.apiSecret) return env;
  return {...env,HSTORA_API_KEY:secrets.apiKey,HSTORA_API_SECRET:secrets.apiSecret} as Env;
}

// ---------------------------------------------------------------------------
// Dashboard views (secrets are reported only as "configured")
// ---------------------------------------------------------------------------

export async function supplierView(env:Env,supplier:SupplierWithSecrets){
  const template=templateOf(supplier.kind);
  const secrets=await supplierSecrets(env,supplier).catch(()=>({} as Record<string,string>));
  const config=parseJson<Record<string,unknown>>(supplier.config_json,{});
  const configuredSecrets=Object.keys(secrets).filter(key=>secrets[key]);
  // HSTORA keys may still come from the Worker secrets set by Bot-Factory.
  if(template?.id==="hstora"&&env.HSTORA_API_KEY&&env.HSTORA_API_SECRET){
    for(const key of ["apiKey","apiSecret"]) if(!configuredSecrets.includes(key)) configuredSecrets.push(key);
  }
  const publicConfig:Record<string,unknown>={};
  for(const field of template?.fields??[]){
    if(field.type!=="secret"&&config[field.key]!==undefined) publicConfig[field.key]=config[field.key];
  }
  return {
    id:supplier.id,
    name:supplier.name,
    template:template?.id??supplier.kind,
    templateLabel:template?.label??supplier.kind,
    config:publicConfig,
    configuredSecrets,
    enabled:Boolean(supplier.enabled),
    createdAt:supplier.created_at
  };
}

export async function listSupplierViews(env:Env){
  await ensureProcurementSchema(env);
  const rows=(await env.DB.prepare("SELECT * FROM suppliers ORDER BY created_at ASC").all<SupplierWithSecrets>()).results;
  return Promise.all(rows.map(row=>supplierView(env,row)));
}

function cleanText(value:unknown,max:number){
  return String(value??"").trim().slice(0,max);
}

function validateSupplierConfig(template:SupplierTemplate,input:Record<string,unknown>){
  const config:Record<string,unknown>={};
  const secrets:Record<string,string>={};
  for(const field of template.fields){
    const raw=input[field.key];
    if(raw===undefined||raw===null||raw==="") continue;
    const value=cleanText(raw,field.type==="secret"?4096:500);
    if(field.type==="url"){
      let url:URL;
      try{url=new URL(value);}catch{throw new ProcurementError(400,"SUPPLIER_URL_INVALID",field.label+"が正しいURLではありません");}
      if(url.protocol!=="https:") throw new ProcurementError(400,"SUPPLIER_HTTPS_REQUIRED",field.label+"はhttps://で始まるURLにしてください");
      if(url.username||url.password) throw new ProcurementError(400,"SUPPLIER_URL_INVALID",field.label+"に認証情報を含めないでください");
    }
    if(field.type==="text"&&field.key.endsWith("Path")&&field.key!=="responseItemsPath"&&!value.startsWith("/")){
      throw new ProcurementError(400,"SUPPLIER_PATH_INVALID",field.label+"は / から始めてください");
    }
    if(field.type==="secret") secrets[field.key]=value;
    else config[field.key]=value;
  }
  return {config,secrets};
}

export async function saveSupplier(
  env:Env,
  input:{id?:string;name?:unknown;template?:unknown;config?:unknown;secrets?:unknown;enabled?:unknown}
){
  await ensureProcurementSchema(env);
  const existing=input.id?await env.DB.prepare("SELECT * FROM suppliers WHERE id=?").bind(input.id).first<SupplierWithSecrets>():null;
  if(input.id&&!existing) throw new ProcurementError(404,"SUPPLIER_NOT_FOUND","仕入れ先が見つかりません");
  const template=templateOf(existing?.kind??String(input.template??""));
  if(!template) throw new ProcurementError(400,"SUPPLIER_TEMPLATE_INVALID","仕入れ先のテンプレートを選んでください");
  const name=cleanText(input.name??existing?.name,80);
  if(!name) throw new ProcurementError(400,"SUPPLIER_NAME_REQUIRED","仕入れ先の名前を入力してください");
  const incoming={...(input.config&&typeof input.config==="object"?input.config as Record<string,unknown>:{}),
    ...(input.secrets&&typeof input.secrets==="object"?input.secrets as Record<string,unknown>:{})};
  const {config,secrets}=validateSupplierConfig(template,incoming);
  const previousConfig=parseJson<Record<string,unknown>>(existing?.config_json,{});
  const previousSecrets=existing?await supplierSecrets(env,existing):{};
  // Blank secret inputs keep the stored value (secrets are never sent back to the UI).
  const nextConfig={...(input.config!==undefined?{}:previousConfig),...config};
  if(input.config!==undefined){
    for(const field of template.fields) if(field.type!=="secret"&&!(field.key in config)&&field.key in previousConfig&&incoming[field.key]===undefined) nextConfig[field.key]=previousConfig[field.key];
  }
  const nextSecrets={...previousSecrets,...secrets};
  for(const field of template.fields){
    if(!field.required) continue;
    const present=field.type==="secret"
      ?Boolean(nextSecrets[field.key])||(template.id==="hstora"&&Boolean(env.HSTORA_API_KEY&&env.HSTORA_API_SECRET))
      :Boolean(nextConfig[field.key]);
    if(!present) throw new ProcurementError(400,"SUPPLIER_FIELD_REQUIRED",field.label+"を入力してください");
  }
  const secretsEnc=Object.keys(nextSecrets).length?JSON.stringify(await encryptSensitive(env,JSON.stringify(nextSecrets))):null;
  const enabled=input.enabled===undefined?(existing?existing.enabled:1):(input.enabled?1:0);
  const now=Date.now();
  if(existing){
    await env.DB.prepare("UPDATE suppliers SET name=?,config_json=?,secrets_enc=?,enabled=?,updated_at=? WHERE id=?")
      .bind(name,JSON.stringify(nextConfig),secretsEnc,enabled,now,existing.id).run();
    return supplierView(env,(await env.DB.prepare("SELECT * FROM suppliers WHERE id=?").bind(existing.id).first<SupplierWithSecrets>())!);
  }
  if(template.id==="hstora"){
    const other=await env.DB.prepare("SELECT id FROM suppliers WHERE kind='hstora' LIMIT 1").first<{id:string}>();
    if(other) throw new ProcurementError(409,"HSTORA_SUPPLIER_EXISTS","HSTORAの仕入れ先は1つだけ登録できます。既存の仕入れ先を編集してください");
  }
  const id=randomId();
  await env.DB.prepare("INSERT INTO suppliers(id,name,kind,config_json,secrets_enc,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(id,name,template.id,JSON.stringify(nextConfig),secretsEnc,enabled,now,now).run();
  return supplierView(env,(await env.DB.prepare("SELECT * FROM suppliers WHERE id=?").bind(id).first<SupplierWithSecrets>())!);
}

export async function deleteSupplier(env:Env,id:string){
  await ensureProcurementSchema(env);
  const used=await env.DB.prepare("SELECT COUNT(*) AS n FROM products WHERE supplier_id=?").bind(id).first<{n:number}>();
  if(Number(used?.n??0)>0) throw new ProcurementError(409,"SUPPLIER_IN_USE","この仕入れ先を使っている仕入れ品があります。先に仕入れ品を削除してください");
  const result=await env.DB.prepare("DELETE FROM suppliers WHERE id=?").bind(id).run();
  return (result.meta.changes??0)>0;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export type ItemInput={
  name?:unknown;
  supplierId?:unknown;
  condition?:unknown;
  mainProductId?:unknown;
  minStock?:unknown;
  targetStock?:unknown;
  maxStock?:unknown;
  maxBatch?:unknown;
  budgetPercent?:unknown;
  maxPurchaseJpy?:unknown;
  dailyLimitJpy?:unknown;
  maxUnitPriceJpy?:unknown;
  stocklessEnabled?:unknown;
  enabled?:unknown;
};

function intIn(value:unknown,label:string,min:number,max:number,fallback:number){
  if(value===undefined||value===null||value==="") return fallback;
  const number=Number(value);
  if(!Number.isInteger(number)||number<min||number>max){
    throw new ProcurementError(400,"ITEM_NUMBER_INVALID",`${label}は${min}〜${max}の整数で入力してください`);
  }
  return number;
}

export async function itemView(env:Env,item:ItemRow,supplier:SupplierWithSecrets|null){
  const template=supplier?templateOf(supplier.kind):null;
  return {
    id:item.id,
    name:item.name,
    supplierId:item.supplier_id,
    supplierName:supplier?.name??null,
    template:template?.id??null,
    templateLabel:template?.label??null,
    condition:parseJson<Record<string,unknown>>(item.condition_json,{}),
    mainProductId:item.main_product_id||null,
    destinationMachineId:item.destination_machine_id,
    destinationLabel:item.destination_label,
    minStock:item.min_stock,
    targetStock:item.target_stock,
    maxStock:item.max_stock,
    maxBatch:item.max_batch,
    budgetPercent:Number(item.budget_percent),
    maxPurchaseJpy:item.max_purchase_jpy,
    dailyLimitJpy:item.daily_limit_jpy,
    maxUnitPriceJpy:item.max_unit_price_jpy,
    stocklessEnabled:Boolean(item.stockless_enabled),
    enabled:Boolean(item.enabled),
    lastDailyRunOn:item.last_daily_run_on,
    createdAt:item.created_at
  };
}

export async function listItems(env:Env){
  await ensureProcurementSchema(env);
  return (await env.DB.prepare("SELECT * FROM products ORDER BY created_at ASC").all<ItemRow>()).results;
}

export async function getItem(env:Env,id:string){
  await ensureProcurementSchema(env);
  return await env.DB.prepare("SELECT * FROM products WHERE id=?").bind(id).first<ItemRow>()??null;
}

async function destinationFor(env:Env,mainProductId:string){
  const catalog=await getMainCatalog(env);
  const product=catalog.products.find(row=>row.product_id===mainProductId);
  if(!product) throw new ProcurementError(400,"DESTINATION_NOT_FOUND","補充先の商品が見つかりません（無限在庫の商品は選べません）");
  return {machineId:product.vending_machine_id,label:product.vending_machine_name+" / "+product.product_name};
}

export async function saveItem(env:Env,id:string|null,input:ItemInput){
  await ensureProcurementSchema(env);
  const existing=id?await getItem(env,id):null;
  if(id&&!existing) throw new ProcurementError(404,"ITEM_NOT_FOUND","仕入れ品が見つかりません");

  const name=cleanText(input.name??existing?.name,80);
  if(!name) throw new ProcurementError(400,"ITEM_NAME_REQUIRED","仕入れ品の名前を入力してください");
  const supplierId=cleanText(input.supplierId??existing?.supplier_id,64);
  const supplier=supplierId?await env.DB.prepare("SELECT * FROM suppliers WHERE id=?").bind(supplierId).first<SupplierWithSecrets>():null;
  if(!supplier) throw new ProcurementError(400,"ITEM_SUPPLIER_REQUIRED","仕入れ先を選んでください");
  const template=templateOf(supplier.kind);
  if(!template) throw new ProcurementError(400,"SUPPLIER_TEMPLATE_INVALID","この仕入れ先の種類には対応していません");

  const rawCondition=input.condition&&typeof input.condition==="object"
    ?input.condition as Record<string,unknown>
    :parseJson<Record<string,unknown>>(existing?.condition_json,{});
  const condition:Record<string,string>={};
  for(const field of template.conditionFields){
    const value=cleanText(rawCondition[field.key],200);
    if(field.required&&!value) throw new ProcurementError(400,"ITEM_CONDITION_REQUIRED",field.label+"を入力してください");
    if(field.options&&value&&!field.options.some(option=>option.value===value)){
      throw new ProcurementError(400,"ITEM_CONDITION_INVALID",field.label+"が正しくありません");
    }
    if(value) condition[field.key]=value;
  }
  if(template.id==="hstora"){
    // One HSTORA item per class: the HSTORA engine buys and classifies per class.
    const same=(await listItems(env)).find(row=>row.id!==existing?.id&&row.supplier_id===supplier.id&&
      parseJson<Record<string,string>>(row.condition_json,{}).class===condition.class);
    if(same) throw new ProcurementError(409,"HSTORA_CLASS_TAKEN",`「${same.name}」が同じ仕入れ条件を使っています。HSTORAの仕入れ条件は1つの仕入れ品にだけ設定できます`);
  }

  const minStock=intIn(input.minStock,"最低在庫",0,10000,existing?.min_stock??1);
  const targetStock=intIn(input.targetStock,"目標在庫",1,10000,existing?.target_stock??Math.max(1,minStock));
  const maxStock=intIn(input.maxStock,"上限在庫",0,10000,existing?.max_stock??0);
  const maxBatch=intIn(input.maxBatch,"1回の最大仕入れ数",1,500,existing?.max_batch??10);
  if(targetStock<minStock) throw new ProcurementError(400,"ITEM_TARGET_BELOW_MIN","目標在庫は最低在庫以上にしてください");
  if(maxStock>0&&maxStock<targetStock) throw new ProcurementError(400,"ITEM_MAX_BELOW_TARGET","上限在庫は目標在庫以上にしてください（0は上限なし）");
  // Whole percent: the HSTORA engine requires its shares to add up to exactly 100.
  const budgetPercent=intIn(input.budgetPercent,"資金配分",0,100,Number(existing?.budget_percent??0));
  const otherBudget=(await listItems(env)).filter(row=>row.id!==existing?.id).reduce((sum,row)=>sum+Number(row.budget_percent||0),0);
  if(otherBudget+budgetPercent>100) throw new ProcurementError(400,"ITEM_BUDGET_OVER","資金配分の合計が100%を超えます（他の仕入れ品で"+otherBudget+"%使用中）");
  const maxPurchaseJpy=intIn(input.maxPurchaseJpy,"1回の金額上限",0,10_000_000,existing?.max_purchase_jpy??0);
  const dailyLimitJpy=intIn(input.dailyLimitJpy,"1日の金額上限",0,100_000_000,existing?.daily_limit_jpy??0);
  const maxUnitPriceJpy=intIn(input.maxUnitPriceJpy,"単価の上限",0,10_000_000,existing?.max_unit_price_jpy??0);
  if(!template.supportsAmountCaps&&(maxPurchaseJpy>0||dailyLimitJpy>0||maxUnitPriceJpy>0)){
    // Without unit prices a cap could not be checked; refusing beats a cap that silently does nothing.
    throw new ProcurementError(400,"ITEM_CAPS_UNSUPPORTED","この仕入れ先は価格を返さないため、金額上限は設定できません");
  }
  const stocklessEnabled=input.stocklessEnabled===undefined?Boolean(existing?.stockless_enabled):Boolean(input.stocklessEnabled);

  const mainProductId=cleanText(input.mainProductId===undefined?existing?.main_product_id:input.mainProductId,64);
  let destinationMachineId=existing?.destination_machine_id??null;
  let destinationLabel=existing?.destination_label??null;
  if(mainProductId&&mainProductId!==existing?.main_product_id){
    const destination=await destinationFor(env,mainProductId);
    destinationMachineId=destination.machineId;
    destinationLabel=destination.label;
  }
  if(!mainProductId){ destinationMachineId=null; destinationLabel=null; }
  let enabled=input.enabled===undefined?Boolean(existing?.enabled??0):Boolean(input.enabled);
  if(enabled&&!mainProductId) throw new ProcurementError(400,"ITEM_DESTINATION_REQUIRED","有効にするには補充先の商品を選んでください");
  if(!mainProductId) enabled=false;

  const now=Date.now();
  const sku=condition.sku??condition.class??"";
  if(existing){
    await env.DB.prepare(`UPDATE products SET name=?,supplier_id=?,supplier_sku=?,main_product_id=?,min_stock=?,target_stock=?,max_batch=?,
      enabled=?,updated_at=?,condition_json=?,destination_machine_id=?,destination_label=?,max_stock=?,budget_percent=?,
      max_purchase_jpy=?,daily_limit_jpy=?,max_unit_price_jpy=?,stockless_enabled=? WHERE id=?`)
      .bind(name,supplier.id,sku,mainProductId,minStock,targetStock,maxBatch,enabled?1:0,now,JSON.stringify(condition),
        destinationMachineId,destinationLabel,maxStock,budgetPercent,maxPurchaseJpy,dailyLimitJpy,maxUnitPriceJpy,stocklessEnabled?1:0,existing.id).run();
  }else{
    id=randomId();
    await env.DB.prepare(`INSERT INTO products(id,name,supplier_id,supplier_sku,main_product_id,min_stock,target_stock,max_batch,processor_kind,
      processor_config_json,enabled,created_at,updated_at,condition_json,destination_machine_id,destination_label,max_stock,budget_percent,
      max_purchase_jpy,daily_limit_jpy,max_unit_price_jpy,stockless_enabled) VALUES (?,?,?,?,?,?,?,?,'identity','{}',?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id,name,supplier.id,sku,mainProductId,minStock,targetStock,maxBatch,enabled?1:0,now,now,JSON.stringify(condition),
        destinationMachineId,destinationLabel,maxStock,budgetPercent,maxPurchaseJpy,dailyLimitJpy,maxUnitPriceJpy,stocklessEnabled?1:0).run();
  }
  const saved=(await getItem(env,id!))!;
  if(template.id==="hstora") await syncHstoraSettings(env);
  return itemView(env,saved,supplier);
}

export async function deleteItem(env:Env,id:string){
  await ensureProcurementSchema(env);
  const item=await getItem(env,id);
  if(!item) return false;
  const supplier=await getSupplier(env,item.supplier_id);
  await env.DB.prepare("DELETE FROM products WHERE id=?").bind(id).run();
  if(supplier&&templateOf(supplier.kind)?.id==="hstora") await syncHstoraSettings(env);
  return true;
}

// ---------------------------------------------------------------------------
// HSTORA: items drive the HSTORA engine's per-class targets
// ---------------------------------------------------------------------------

export type HstoraTarget={
  item:ItemRow;
  procurementClass:HstoraClass;
};

export async function hstoraTargets(env:Env):Promise<HstoraTarget[]>{
  await ensureProcurementSchema(env);
  const rows=(await env.DB.prepare(
    "SELECT p.* FROM products p JOIN suppliers s ON s.id=p.supplier_id WHERE s.kind='hstora' ORDER BY p.created_at ASC"
  ).all<ItemRow>()).results;
  return rows.flatMap(item=>{
    const procurementClass=parseJson<Record<string,string>>(item.condition_json,{}).class as HstoraClass|undefined;
    return procurementClass&&HSTORA_CLASSES.some(row=>row.value===procurementClass)?[{item,procurementClass}]:[];
  });
}

/**
 * Stock that counts for a class: accounts still waiting in Shiire plus what the
 * destination Xaccount-Bot product already holds. Without the destination part
 * the daily batch would see 0 after every transfer and buy the target again.
 */
export async function stockForClass(env:Env,procurementClass:HstoraClass):Promise<number>{
  await ensureProcurementSchema(env);
  const ready=await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM purchased_accounts WHERE procurement_class=? AND status IN ('READY_FOR_DELIVERY','VENDING_RESERVED')"
  ).bind(procurementClass).first<{n:number}>();
  let destination=0;
  const target=(await hstoraTargets(env)).find(row=>row.procurementClass===procurementClass);
  if(target?.item.main_product_id){
    // A failed lookup must not look like "empty" (that would trigger buying).
    destination=(await getMainStock(env,target.item.main_product_id)).available;
  }
  return Math.max(0,Number(ready?.n??0))+destination;
}

/** Keep the HSTORA engine settings in line with the HSTORA items. */
export async function syncHstoraSettings(env:Env){
  const targets=await hstoraTargets(env);
  const top=targets.find(row=>row.procurementClass==="TOP_SEARCH")?.item;
  const noShadow=targets.find(row=>row.procurementClass==="NO_SHADOWBAN")?.item;
  const settings=await loadXSettings(env);
  const patch:Record<string,unknown>={};
  if(top){
    patch.reorder_point=Math.max(0,top.min_stock-1);
    patch.target_stock=top.max_stock>0?Math.min(top.target_stock,top.max_stock):top.target_stock;
    patch.top_search_budget_percent=top.enabled?Number(top.budget_percent):0;
  }
  if(noShadow){
    patch.no_shadowban_reorder_point=Math.max(0,noShadow.min_stock-1);
    patch.no_shadowban_target_stock=noShadow.max_stock>0?Math.min(noShadow.target_stock,noShadow.max_stock):noShadow.target_stock;
    patch.no_shadowban_budget_percent=noShadow.enabled?Number(noShadow.budget_percent):0;
  }
  const maxBatch=Math.max(1,...targets.filter(row=>row.item.enabled).map(row=>row.item.max_batch),1);
  patch.max_batch_purchase=Math.min(maxBatch,Number(settings.max_batch_purchase)||maxBatch);
  // The HSTORA shares must add up to exactly 100: the rest goes to the invite campaign.
  const sum=Number(patch.top_search_budget_percent??settings.top_search_budget_percent)+
    Number(patch.no_shadowban_budget_percent??settings.no_shadowban_budget_percent);
  patch.invite_campaign_budget_percent=Math.max(0,100-sum);
  const saved=await saveXSettings(env,patch as never);
  // The daily batch reads its own targets; keep them in line with the items.
  await saveDailyRestockConfig(env,{
    enabled:targets.some(row=>row.item.enabled&&Boolean(row.item.main_product_id)),
    ...(top?{top_search_target_stock:Number(patch.target_stock)}:{}),
    ...(noShadow?{no_shadowban_target_stock:Number(patch.no_shadowban_target_stock)}:{})
  },{top_search_target_stock:saved.target_stock,no_shadowban_target_stock:saved.no_shadowban_target_stock});
  const changed=saved.top_search_budget_percent!==settings.top_search_budget_percent||
    saved.no_shadowban_budget_percent!==settings.no_shadowban_budget_percent;
  if(!changed) return;
  // Re-split the current HSTORA balance with the new shares. If HSTORA cannot be
  // reached the shares are saved and applied on the next balance sync.
  try{
    const balance=await getHstoraBalance(await hstoraEnv(env));
    if(String(balance.currency).toUpperCase()!=="USD") return;
    await rebalanceProcurementBudgets(env,Number(balance.balance),{
      INVITE_CAMPAIGN:saved.invite_campaign_budget_percent,
      NO_SHADOWBAN:saved.no_shadowban_budget_percent,
      TOP_SEARCH:saved.top_search_budget_percent
    });
    await setXSetting(env,"x_hstora_balance_guard",{hstoraUsd:Math.max(0,Number(balance.balance)),allowedDecreaseUsd:0,updatedAt:Date.now()});
    await auditX(env,{kind:"PROCUREMENT_BUDGET_ALLOCATION_CHANGED",message:"仕入れ品の資金配分を変更しました。",details:{
      TOP_SEARCH:saved.top_search_budget_percent,NO_SHADOWBAN:saved.no_shadowban_budget_percent,INVITE_CAMPAIGN:saved.invite_campaign_budget_percent
    }});
  }catch(error){
    await auditX(env,{level:"warn",kind:"PROCUREMENT_BUDGET_REBALANCE_DEFERRED",message:"HSTORA残高を取得できないため、資金配分の再配分を保留しました。",
      details:{error:error instanceof Error?error.message:String(error)}}).catch(()=>undefined);
  }
}

// ---------------------------------------------------------------------------
// Transfer purchased HSTORA accounts to each item's destination product
// ---------------------------------------------------------------------------

export async function transferHstoraAccounts(env:Env,limitPerItem=50){
  const results:Array<{itemId:string;transferred:number;skipped:number;error?:string}>=[];
  for(const {item,procurementClass} of await hstoraTargets(env)){
    if(!item.enabled||!item.main_product_id) continue;
    const rows=(await env.DB.prepare(
      "SELECT id,supplier_product_id,credentials_ciphertext FROM purchased_accounts WHERE procurement_class=? AND status='READY_FOR_DELIVERY' ORDER BY created_at ASC LIMIT ?"
    ).bind(procurementClass,limitPerItem).all<{id:string;supplier_product_id:string;credentials_ciphertext:string}>()).results;
    if(rows.length===0) continue;
    const lines:string[]=[];
    const ids:string[]=[];
    const review:string[]=[];
    for(const row of rows){
      try{
        const encrypted=parseJson<EncryptedSecret|null>(row.credentials_ciphertext,null);
        if(!encrypted) throw new DeliveryFormatError("CREDENTIAL_CIPHERTEXT_INVALID");
        lines.push(normalizeHstoraDeliveryForVending(await decryptSensitive(env,encrypted),row.supplier_product_id));
        ids.push(row.id);
      }catch(error){
        if(error instanceof DeliveryFormatError) review.push(row.id);
        else throw error;
      }
    }
    if(review.length){
      // Unknown formats are held for manual review instead of being sold broken.
      await env.DB.batch(review.map(accountId=>env.DB.prepare(
        "UPDATE purchased_accounts SET status='FORMAT_REVIEW' WHERE id=? AND status='READY_FOR_DELIVERY'"
      ).bind(accountId)));
      await auditX(env,{kind:"HSTORA_FORMAT_REVIEW",message:"配送形式を判別できないアカウントを確認待ちにしました。",details:{count:review.length,itemId:item.id}}).catch(()=>undefined);
    }
    if(ids.length===0){ results.push({itemId:item.id,transferred:0,skipped:review.length}); continue; }
    // Deterministic key: a retry after a crash re-sends the same batch, and the
    // supply bridge (receipt + fingerprints) turns it into a no-op.
    const idempotencyKey="hstora-transfer:"+(await sha256Hex([...ids].sort().join(","))).slice(0,48);
    try{
      const delivered=await deliverToMain(env,{mainProductId:item.main_product_id,items:lines,idempotencyKey});
      const now=Date.now();
      await env.DB.batch(ids.map(accountId=>env.DB.prepare(
        "UPDATE purchased_accounts SET status='TRANSFERRED_TO_MAIN',delivered_at=? WHERE id=? AND status='READY_FOR_DELIVERY'"
      ).bind(now,accountId)));
      results.push({itemId:item.id,transferred:delivered.added,skipped:ids.length-delivered.added+review.length});
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      await logEvent(env,{level:"error",kind:"hstora_transfer_failed",productId:item.id,message}).catch(()=>undefined);
      results.push({itemId:item.id,transferred:0,skipped:0,error:message});
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Daily schedule (one shared time, JST)
// ---------------------------------------------------------------------------

const RESTOCK_TIME_KEY="procurement_restock_time";

export async function getRestockTime(env:Env):Promise<string>{
  const value=await getXSetting<string>(env,RESTOCK_TIME_KEY).catch(()=>null);
  return typeof value==="string"&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value)?value:"18:00";
}

export async function setRestockTime(env:Env,value:unknown){
  const time=String(value??"");
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new ProcurementError(400,"RESTOCK_TIME_INVALID","時刻は HH:MM（例 18:00）で入力してください");
  await setXSetting(env,RESTOCK_TIME_KEY,time);
  return time;
}

export function jstDate(now:number){ return new Date(now+9*3600_000).toISOString().slice(0,10); }

export function isRestockWindow(now:number,time:string){
  const jst=new Date(now+9*3600_000);
  const [hour,minute]=time.split(":").map(Number) as [number,number];
  return jst.getUTCHours()*60+jst.getUTCMinutes()>=hour*60+minute;
}

/** Generic (non-HSTORA) items due for today's run. */
export async function dueGenericItems(env:Env,now=Date.now()){
  const time=await getRestockTime(env);
  if(!isRestockWindow(now,time)) return [];
  const today=jstDate(now);
  return (await env.DB.prepare(
    "SELECT p.* FROM products p JOIN suppliers s ON s.id=p.supplier_id WHERE p.enabled=1 AND s.kind!='hstora' AND p.main_product_id!='' AND (p.last_daily_run_on IS NULL OR p.last_daily_run_on<?) ORDER BY p.created_at ASC"
  ).bind(today).all<ItemRow>()).results;
}

export async function markItemRan(env:Env,itemId:string,now=Date.now()){
  await env.DB.prepare("UPDATE products SET last_daily_run_on=? WHERE id=?").bind(jstDate(now),itemId).run();
}

// ---------------------------------------------------------------------------
// One-time migration of the legacy HSTORA settings into 仕入れ品
// ---------------------------------------------------------------------------

const MIGRATION_KEY="procurement_migrated_v1";

async function migrateLegacyHstora(env:Env){
  if(await getXSetting<boolean>(env,MIGRATION_KEY).catch(()=>false)) return;
  const now=Date.now();
  // Fixed ids + INSERT OR IGNORE: concurrent first requests create each row once.
  // Credentials stay in the Worker secrets until they are entered on the dashboard.
  await env.DB.prepare("INSERT OR IGNORE INTO suppliers(id,name,kind,config_json,secrets_enc,enabled,created_at,updated_at) SELECT 'hstora-default','HSTORA','hstora','{}',NULL,1,?,? WHERE NOT EXISTS (SELECT 1 FROM suppliers WHERE kind='hstora')")
    .bind(now,now).run();
  const supplierId=(await env.DB.prepare("SELECT id FROM suppliers WHERE kind='hstora' ORDER BY created_at ASC LIMIT 1").first<{id:string}>())!.id;
  const settings=await loadXSettings(env);
  const legacy:Array<{cls:HstoraClass;name:string;min:number;target:number;budget:number}>=[
    {cls:"TOP_SEARCH",name:"検索上位 Xアカウント",min:Number(settings.reorder_point)+1,target:Number(settings.target_stock),budget:Number(settings.top_search_budget_percent)},
    {cls:"NO_SHADOWBAN",name:"シャドバンなし Xアカウント",min:Number(settings.no_shadowban_reorder_point)+1,target:Number(settings.no_shadowban_target_stock),budget:Number(settings.no_shadowban_budget_percent)}
  ];
  const items=(await env.DB.prepare("SELECT condition_json FROM products WHERE supplier_id=?").bind(supplierId).all<{condition_json:string}>()).results;
  for(const row of legacy){
    if(items.some(item=>parseJson<Record<string,string>>(item.condition_json,{}).class===row.cls)) continue;
    const target=Math.max(1,Math.floor(row.target)||1);
    const min=Math.min(target,Math.max(0,Math.floor(row.min)||0));
    // Disabled until a destination product is chosen on the dashboard.
    await env.DB.prepare(`INSERT OR IGNORE INTO products(id,name,supplier_id,supplier_sku,main_product_id,min_stock,target_stock,max_batch,processor_kind,
      processor_config_json,enabled,created_at,updated_at,condition_json,max_stock,budget_percent) VALUES (?,?,?,?,'',?,?,?,'identity','{}',0,?,?,?,0,?)`)
      .bind("hstora-"+row.cls.toLowerCase(),row.name,supplierId,row.cls,min,target,Math.max(1,Math.min(500,Number(settings.max_batch_purchase)||10)),now,now,
        JSON.stringify({class:row.cls}),Math.max(0,Math.min(100,Math.round(Number(row.budget)||0)))).run();
  }
  await setXSetting(env,MIGRATION_KEY,true);
}

export function destinationsFromCatalog(catalog:Awaited<ReturnType<typeof getMainCatalog>>){
  const machines=new Map<string,{id:string;name:string;products:Array<{id:string;name:string;available:number}>}>();
  for(const row of catalog.products){
    const machine=machines.get(row.vending_machine_id)??{id:row.vending_machine_id,name:row.vending_machine_name,products:[]};
    machine.products.push({id:row.product_id,name:row.product_name,available:Number(row.available)});
    machines.set(row.vending_machine_id,machine);
  }
  return [...machines.values()];
}

export { getProduct };

// ---------------------------------------------------------------------------
// Per-item amount caps (1回 / 1日 / 単価, JPY; 0 = no cap)

export type ItemCaps={maxPurchaseJpy:number;dailyLimitJpy:number;maxUnitPriceJpy:number};
export type ClassCapState={procurementClass:HstoraClass;caps:ItemCaps;spentSourceToday:number};

export function jstDayStart(now:number){
  const shifted=now+9*3600_000;
  return shifted-(shifted%86_400_000)-9*3600_000;
}

/** Caps of the HSTORA item for each class plus what that class spent today (order currency). */
export async function hstoraClassCaps(env:Env,now=Date.now()):Promise<Map<HstoraClass,ClassCapState>>{
  await ensureXSchema(env);
  const targets=await hstoraTargets(env);
  const out=new Map<HstoraClass,ClassCapState>();
  for(const {item,procurementClass} of targets){
    const caps={
      maxPurchaseJpy:Math.max(0,Number(item.max_purchase_jpy??0)),
      dailyLimitJpy:Math.max(0,Number(item.daily_limit_jpy??0)),
      maxUnitPriceJpy:Math.max(0,Number(item.max_unit_price_jpy??0))
    };
    // Orders not known to have failed count (pending ones may still be charged).
    // A split order is charged half to each class, as the budget does.
    const row=await env.DB.prepare(
      "SELECT COALESCE(SUM(CASE WHEN delivery_split_mode IS NOT NULL THEN total_amount/2.0 ELSE total_amount END),0) AS spent "+
      "FROM purchase_orders WHERE supplier='hstora' AND dry_run=0 AND created_at>=? "+
      "AND status NOT IN ('FAILED','CANCELED','CANCELLED','REJECTED','REFUNDED') "+
      "AND (procurement_class=? OR delivery_split_mode IS NOT NULL)"
    ).bind(jstDayStart(now),procurementClass).first<{spent:number}>();
    out.set(procurementClass,{procurementClass,caps,spentSourceToday:Math.max(0,Number(row?.spent??0))});
  }
  return out;
}

export type CapDecision={quantity:number;limitedBy:null|"UNIT_PRICE"|"PER_RUN"|"DAILY"};

/**
 * Largest quantity ≤ requested that keeps every charged class inside its caps.
 * unitPriceJpy / unitPriceSource are for the same unit; the source currency is
 * what purchase_orders.total_amount is stored in.
 */
export function capQuantity(input:{
  requested:number;
  unitPriceJpy:number;
  unitPriceSource:number;
  charged:{state:ClassCapState|undefined;share:number}[];
  evenOnly:boolean;
}):CapDecision{
  let quantity=Math.max(0,Math.floor(input.requested));
  let limitedBy:CapDecision["limitedBy"]=null;
  const unitJpy=Number(input.unitPriceJpy);
  const unitSource=Number(input.unitPriceSource);
  const anyCap=input.charged.some(row=>row.state&&(row.state.caps.maxPurchaseJpy>0||row.state.caps.dailyLimitJpy>0||row.state.caps.maxUnitPriceJpy>0));
  if(!anyCap) return {quantity,limitedBy};
  // A cap that cannot be evaluated must block, not pass.
  if(!(unitJpy>0)||!(unitSource>0)) return {quantity:0,limitedBy:"UNIT_PRICE"};
  for(const {state,share} of input.charged){
    if(!state) continue;
    const {caps}=state;
    if(caps.maxUnitPriceJpy>0&&unitJpy>caps.maxUnitPriceJpy) return {quantity:0,limitedBy:"UNIT_PRICE"};
    if(caps.maxPurchaseJpy>0){
      const allowed=Math.floor(caps.maxPurchaseJpy/(unitJpy*share)+1e-9);
      if(allowed<quantity){quantity=allowed;limitedBy="PER_RUN";}
    }
    if(caps.dailyLimitJpy>0){
      const limitSource=caps.dailyLimitJpy*(unitSource/unitJpy);
      const remaining=Math.max(0,limitSource-state.spentSourceToday);
      const allowed=Math.floor(remaining/(unitSource*share)+1e-9);
      if(allowed<quantity){quantity=allowed;limitedBy="DAILY";}
    }
  }
  if(input.evenOnly) quantity=quantity<2?0:quantity-(quantity%2);
  return {quantity:Math.max(0,quantity),limitedBy};
}
