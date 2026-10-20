import type { Env } from "./types";
import { randomId } from "./crypto";
import { encryptSensitive, decryptSensitive, type EncryptedSecret } from "./x-crypto";
import {
  SMM_PAYMENT_WINDOW_MS,
  SMM_PANEL_PRODUCT_LIMIT,
  SMM_PLACING_STALE_MS,
  type SmmLinkKind,
  type SmmOrderStatus,
  type SmmRefundState,
  type SmmSns
} from "./smm-policy";
import { luckyServices, type LuckyService } from "./smm-luckypanel";

export type SmmSettings={
  guild_id:string;
  public_log_channel_id:string|null;
  private_log_channel_id:string|null;
  paused:number;
  min_margin_percent:number;
  max_open_orders_per_user:number;
  min_supplier_balance_jpy:number;
  updated_at:number;
};

export type SmmMachine={
  id:string;
  guild_id:string;
  sns:SmmSns;
  name:string;
  panel_title:string;
  panel_description:string;
  panel_color:number;
  panel_image_url:string|null;
  sort_order:number;
  created_at:number;
  updated_at:number;
};

export type SmmProduct={
  id:string;
  guild_id:string;
  machine_id:string;
  name:string;
  description:string;
  emoji:string|null;
  service_id:string;
  service_name:string;
  service_category:string;
  markup_percent:number;
  fee_jpy:number;
  min_qty:number;
  max_qty:number;
  link_kind:SmmLinkKind;
  active:number;
  sales_count:number;
  created_at:number;
  updated_at:number;
};

export type SmmOrder={
  id:string;
  guild_id:string;
  user_id:string;
  product_id:string;
  product_name:string;
  service_id:string;
  link:string;
  quantity:number;
  rate_snapshot:number;
  total_amount:number;
  status:SmmOrderStatus;
  payment_link_ciphertext:string|null;
  reserved_until:number|null;
  supplier_order_id:string|null;
  supplier_status:string|null;
  start_count:number|null;
  remains:number|null;
  supplier_charge:number|null;
  attempts:number;
  next_attempt_at:number|null;
  last_error:string|null;
  refund_state:SmmRefundState;
  refund_amount:number;
  buyer_notified_at:number|null;
  notify_attempts:number;
  admin_alerted_at:number|null;
  created_at:number;
  updated_at:number;
  paid_at:number|null;
  placed_at:number|null;
  finished_at:number|null;
};

export const DEFAULT_SMM_DESCRIPTION=
  "購入したい商品を下のボタンから選択してください。\n"+
  "・代行サービスのため反映まで時間がかかる場合があります\n"+
  "・フォロワー数などは増減する場合があります\n"+
  "・非公開アカウントや誤ったリンクは対応できません";

export const SMM_SNS_LABEL:Record<SmmSns,string>={
  x:"X(Twitter)",
  instagram:"Instagram",
  tiktok:"TikTok",
  youtube:"YouTube",
  other:"その他"
};

export const SMM_SNS_COLOR:Record<SmmSns,number>={
  x:0x1d9bf0,
  instagram:0xe1306c,
  tiktok:0x25f4ee,
  youtube:0xff0000,
  other:0x5865f2
};

export const SMM_MAX_MACHINES_PER_GUILD=20;

const SCHEMA=[
  "CREATE TABLE IF NOT EXISTS smm_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS smm_guild_settings (guild_id TEXT PRIMARY KEY,public_log_channel_id TEXT,private_log_channel_id TEXT,paused INTEGER NOT NULL DEFAULT 1,min_margin_percent REAL NOT NULL DEFAULT 0,max_open_orders_per_user INTEGER NOT NULL DEFAULT 5,min_supplier_balance_jpy INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS smm_machines (id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,sns TEXT NOT NULL,name TEXT NOT NULL,panel_title TEXT NOT NULL,panel_description TEXT NOT NULL,panel_color INTEGER NOT NULL,panel_image_url TEXT,sort_order INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS smm_machines_guild_idx ON smm_machines(guild_id,sort_order,created_at)",
  "CREATE TABLE IF NOT EXISTS smm_products (id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,machine_id TEXT NOT NULL DEFAULT '',name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',emoji TEXT,service_id TEXT NOT NULL,service_name TEXT NOT NULL DEFAULT '',service_category TEXT NOT NULL DEFAULT '',markup_percent REAL NOT NULL DEFAULT 30,fee_jpy INTEGER NOT NULL DEFAULT 0,min_qty INTEGER NOT NULL DEFAULT 1,max_qty INTEGER NOT NULL DEFAULT 0,link_kind TEXT NOT NULL DEFAULT 'url',active INTEGER NOT NULL DEFAULT 1,sales_count INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS smm_products_guild_idx ON smm_products(guild_id,active)",
  "CREATE TABLE IF NOT EXISTS smm_panels (guild_id TEXT NOT NULL,machine_id TEXT NOT NULL DEFAULT '',channel_id TEXT NOT NULL,message_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,channel_id,message_id))",
  "CREATE TABLE IF NOT EXISTS smm_orders (id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,user_id TEXT NOT NULL,product_id TEXT NOT NULL,product_name TEXT NOT NULL,service_id TEXT NOT NULL,link TEXT NOT NULL,quantity INTEGER NOT NULL,rate_snapshot REAL NOT NULL,total_amount INTEGER NOT NULL,status TEXT NOT NULL,payment_link_ciphertext TEXT,reserved_until INTEGER,supplier_order_id TEXT,supplier_status TEXT,start_count INTEGER,remains INTEGER,supplier_charge REAL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER,last_error TEXT,refund_state TEXT NOT NULL DEFAULT 'none',refund_amount INTEGER NOT NULL DEFAULT 0,buyer_notified_at INTEGER,notify_attempts INTEGER NOT NULL DEFAULT 0,admin_alerted_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,paid_at INTEGER,placed_at INTEGER,finished_at INTEGER)",
  "CREATE INDEX IF NOT EXISTS smm_orders_status_idx ON smm_orders(status,updated_at)",
  "CREATE INDEX IF NOT EXISTS smm_orders_user_idx ON smm_orders(guild_id,user_id,created_at DESC)",
  "CREATE INDEX IF NOT EXISTS smm_orders_guild_idx ON smm_orders(guild_id,created_at DESC)"
];

let ready=false;

async function columnNames(env:Env,table:string){
  return (await env.DB.prepare("PRAGMA table_info("+table+")").all<{name:string}>()).results.map(row=>row.name);
}

export function defaultMachineTexts(sns:SmmSns){
  const label=SMM_SNS_LABEL[sns];
  return {
    name:label,
    panel_title:(sns==="other"?"フォロ爆":label+" フォロ爆")+" 自販機",
    panel_description:DEFAULT_SMM_DESCRIPTION,
    panel_color:SMM_SNS_COLOR[sns]
  };
}

// Earlier builds had one guild-wide panel. Fold that data into an "X" machine.
async function migrateLegacy(env:Env){
  const legacy=await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='smm_settings'"
  ).first();
  let legacyRows:Array<Record<string,unknown>>=[];
  if(legacy){
    await env.DB.prepare(
      "INSERT OR IGNORE INTO smm_guild_settings(guild_id,public_log_channel_id,private_log_channel_id,paused,min_margin_percent,max_open_orders_per_user,min_supplier_balance_jpy,updated_at) "+
      "SELECT guild_id,public_log_channel_id,private_log_channel_id,paused,min_margin_percent,max_open_orders_per_user,min_supplier_balance_jpy,updated_at FROM smm_settings"
    ).run();
    legacyRows=(await env.DB.prepare("SELECT * FROM smm_settings").all<Record<string,unknown>>()).results;
  }
  const guilds=(await env.DB.prepare(
    "SELECT guild_id FROM smm_products WHERE machine_id='' UNION SELECT guild_id FROM smm_panels WHERE machine_id=''"
  ).all<{guild_id:string}>()).results;
  for(const {guild_id} of guilds){
    const old=legacyRows.find(row=>row.guild_id===guild_id);
    const defaults=defaultMachineTexts("x");
    const now=Date.now();
    const id=randomId("smmm");
    await env.DB.prepare(
      "INSERT INTO smm_machines(id,guild_id,sns,name,panel_title,panel_description,panel_color,panel_image_url,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,0,?,?)"
    ).bind(
      id,guild_id,"x",defaults.name,
      String(old?.panel_title??defaults.panel_title),
      String(old?.panel_description??defaults.panel_description),
      Number(old?.panel_color??defaults.panel_color),
      (old?.panel_image_url as string|null|undefined)??null,
      now,now
    ).run();
    await env.DB.prepare("UPDATE smm_products SET machine_id=? WHERE guild_id=? AND machine_id=''").bind(id,guild_id).run();
    await env.DB.prepare("UPDATE smm_panels SET machine_id=? WHERE guild_id=? AND machine_id=''").bind(id,guild_id).run();
  }
}

export async function ensureSmmSchema(env:Env){
  if(ready) return;
  for(const sql of SCHEMA) await env.DB.prepare(sql).run();
  if(!(await columnNames(env,"smm_products")).includes("machine_id")){
    await env.DB.prepare("ALTER TABLE smm_products ADD COLUMN machine_id TEXT NOT NULL DEFAULT ''").run();
  }
  if(!(await columnNames(env,"smm_panels")).includes("machine_id")){
    await env.DB.prepare("ALTER TABLE smm_panels ADD COLUMN machine_id TEXT NOT NULL DEFAULT ''").run();
  }
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS smm_products_machine_idx ON smm_products(machine_id,active)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS smm_panels_machine_idx ON smm_panels(machine_id)").run();
  await migrateLegacy(env);
  ready=true;
}

function changed(result:D1Result):boolean{
  return Number(result.meta.changes??0)===1;
}

/* ---------------- meta / services cache ---------------- */

export async function getSmmMeta(env:Env,key:string):Promise<{value:string;updated_at:number}|null>{
  await ensureSmmSchema(env);
  return await env.DB.prepare(
    "SELECT value,updated_at FROM smm_meta WHERE key=?"
  ).bind(key).first<{value:string;updated_at:number}>()??null;
}

export async function setSmmMeta(env:Env,key:string,value:string){
  await ensureSmmSchema(env);
  await env.DB.prepare(
    "INSERT INTO smm_meta(key,value,updated_at) VALUES (?,?,?) "+
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at"
  ).bind(key,value,Date.now()).run();
}

const SERVICES_KEY="services_json";
const SERVICES_MAX_BYTES=1_800_000;

export async function loadSmmServices(
  env:Env,
  options:{maxAgeMs:number;forceRefresh?:boolean}
):Promise<{services:LuckyService[];cachedAt:number;stale:boolean}>{
  await ensureSmmSchema(env);
  const cached=await getSmmMeta(env,SERVICES_KEY);
  const now=Date.now();
  if(cached&&!options.forceRefresh&&now-cached.updated_at<=options.maxAgeMs){
    return {services:JSON.parse(cached.value) as LuckyService[],cachedAt:cached.updated_at,stale:false};
  }
  try{
    const services=await luckyServices(env);
    const json=JSON.stringify(services);
    if(json.length>SERVICES_MAX_BYTES) throw new Error("SMM_SERVICES_TOO_LARGE");
    await setSmmMeta(env,SERVICES_KEY,json);
    return {services,cachedAt:Date.now(),stale:false};
  }catch(error){
    if(cached&&!options.forceRefresh){
      return {services:JSON.parse(cached.value) as LuckyService[],cachedAt:cached.updated_at,stale:true};
    }
    throw error;
  }
}

/* ---------------- settings ---------------- */

export async function getSmmSettings(env:Env,guildId:string):Promise<SmmSettings>{
  await ensureSmmSchema(env);
  const row=await env.DB.prepare(
    "SELECT * FROM smm_guild_settings WHERE guild_id=?"
  ).bind(guildId).first<SmmSettings>();
  if(row) return row;
  return {
    guild_id:guildId,
    public_log_channel_id:null,
    private_log_channel_id:null,
    paused:1,
    min_margin_percent:0,
    max_open_orders_per_user:5,
    min_supplier_balance_jpy:0,
    updated_at:0
  };
}

export async function saveSmmSettings(
  env:Env,
  guildId:string,
  patch:Partial<Omit<SmmSettings,"guild_id"|"updated_at">>
):Promise<SmmSettings>{
  const current=await getSmmSettings(env,guildId);
  const next:SmmSettings={...current,...patch,guild_id:guildId,updated_at:Date.now()};
  await env.DB.prepare(
    "INSERT INTO smm_guild_settings(guild_id,public_log_channel_id,private_log_channel_id,paused,min_margin_percent,max_open_orders_per_user,min_supplier_balance_jpy,updated_at) "+
    "VALUES (?,?,?,?,?,?,?,?) "+
    "ON CONFLICT(guild_id) DO UPDATE SET public_log_channel_id=excluded.public_log_channel_id,private_log_channel_id=excluded.private_log_channel_id,paused=excluded.paused,min_margin_percent=excluded.min_margin_percent,max_open_orders_per_user=excluded.max_open_orders_per_user,min_supplier_balance_jpy=excluded.min_supplier_balance_jpy,updated_at=excluded.updated_at"
  ).bind(
    next.guild_id,next.public_log_channel_id,next.private_log_channel_id,
    next.paused,next.min_margin_percent,next.max_open_orders_per_user,
    next.min_supplier_balance_jpy,next.updated_at
  ).run();
  return next;
}

export async function listSmmGuildIds(env:Env):Promise<string[]>{
  await ensureSmmSchema(env);
  return (await env.DB.prepare(
    "SELECT guild_id FROM smm_guild_settings"
  ).all<{guild_id:string}>()).results.map(row=>row.guild_id);
}

/* ---------------- machines (one panel family per SNS) ---------------- */

export async function listSmmMachines(env:Env,guildId:string){
  await ensureSmmSchema(env);
  return (await env.DB.prepare(
    "SELECT * FROM smm_machines WHERE guild_id=? ORDER BY sort_order ASC,created_at ASC"
  ).bind(guildId).all<SmmMachine>()).results;
}

export async function getSmmMachine(env:Env,id:string){
  await ensureSmmSchema(env);
  return await env.DB.prepare(
    "SELECT * FROM smm_machines WHERE id=?"
  ).bind(id).first<SmmMachine>()??null;
}

export type SmmMachineInput={
  sns:SmmSns;
  name:string;
  panel_title:string;
  panel_description:string;
  panel_color:number;
  panel_image_url:string|null;
};

export async function createSmmMachine(env:Env,guildId:string,input:SmmMachineInput){
  await ensureSmmSchema(env);
  const count=await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM smm_machines WHERE guild_id=?"
  ).bind(guildId).first<{n:number}>();
  if(Number(count?.n??0)>=SMM_MAX_MACHINES_PER_GUILD) throw new Error("TOO_MANY_MACHINES");
  const now=Date.now();
  const id=randomId("smmm");
  await env.DB.prepare(
    "INSERT INTO smm_machines(id,guild_id,sns,name,panel_title,panel_description,panel_color,panel_image_url,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(
    id,guildId,input.sns,input.name,input.panel_title,input.panel_description,
    input.panel_color,input.panel_image_url,Number(count?.n??0),now,now
  ).run();
  return (await getSmmMachine(env,id))!;
}

export async function updateSmmMachine(
  env:Env,
  id:string,
  patch:Partial<Omit<SmmMachineInput,"sns">>
){
  const current=await getSmmMachine(env,id);
  if(!current) return null;
  const next={...current,...patch};
  await env.DB.prepare(
    "UPDATE smm_machines SET name=?,panel_title=?,panel_description=?,panel_color=?,panel_image_url=?,updated_at=? WHERE id=?"
  ).bind(
    next.name,next.panel_title,next.panel_description,next.panel_color,
    next.panel_image_url,Date.now(),id
  ).run();
  return getSmmMachine(env,id);
}

export async function deleteSmmMachine(env:Env,id:string){
  await ensureSmmSchema(env);
  const products=await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM smm_products WHERE machine_id=?"
  ).bind(id).first<{n:number}>();
  if(Number(products?.n??0)>0) throw new Error("MACHINE_HAS_PRODUCTS");
  await env.DB.prepare("DELETE FROM smm_panels WHERE machine_id=?").bind(id).run();
  await env.DB.prepare("DELETE FROM smm_machines WHERE id=?").bind(id).run();
}

/* ---------------- products ---------------- */

export async function listSmmProducts(
  env:Env,
  guildId:string,
  options:{machineId?:string;activeOnly?:boolean}={}
){
  await ensureSmmSchema(env);
  const where=["guild_id=?"];
  const binds:unknown[]=[guildId];
  if(options.machineId){where.push("machine_id=?");binds.push(options.machineId);}
  if(options.activeOnly) where.push("active=1");
  return (await env.DB.prepare(
    "SELECT * FROM smm_products WHERE "+where.join(" AND ")+" ORDER BY created_at ASC"
  ).bind(...binds).all<SmmProduct>()).results;
}

export async function getSmmProduct(env:Env,id:string){
  await ensureSmmSchema(env);
  return await env.DB.prepare(
    "SELECT * FROM smm_products WHERE id=?"
  ).bind(id).first<SmmProduct>()??null;
}

async function activeProductCount(env:Env,machineId:string,exceptId?:string){
  const row=await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM smm_products WHERE machine_id=? AND active=1"+(exceptId?" AND id<>?":"")
  ).bind(...(exceptId?[machineId,exceptId]:[machineId])).first<{n:number}>();
  return Number(row?.n??0);
}

export type SmmProductInput={
  machine_id:string;
  name:string;
  description:string;
  emoji:string|null;
  service_id:string;
  service_name:string;
  service_category:string;
  markup_percent:number;
  fee_jpy:number;
  min_qty:number;
  max_qty:number;
  link_kind:SmmLinkKind;
  active:boolean;
};

export async function createSmmProduct(env:Env,guildId:string,input:SmmProductInput){
  await ensureSmmSchema(env);
  if(input.active&&await activeProductCount(env,input.machine_id)>=SMM_PANEL_PRODUCT_LIMIT){
    throw new Error("TOO_MANY_ACTIVE_PRODUCTS");
  }
  const now=Date.now();
  const id=randomId("smmp");
  await env.DB.prepare(
    "INSERT INTO smm_products(id,guild_id,machine_id,name,description,emoji,service_id,service_name,service_category,markup_percent,fee_jpy,min_qty,max_qty,link_kind,active,sales_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)"
  ).bind(
    id,guildId,input.machine_id,input.name,input.description,input.emoji,input.service_id,
    input.service_name,input.service_category,input.markup_percent,input.fee_jpy,
    input.min_qty,input.max_qty,input.link_kind,input.active?1:0,now,now
  ).run();
  return (await getSmmProduct(env,id))!;
}

export async function updateSmmProduct(
  env:Env,
  id:string,
  patch:Partial<SmmProductInput>
){
  const current=await getSmmProduct(env,id);
  if(!current) return null;
  const next={...current,...patch,active:patch.active===undefined?current.active:(patch.active?1:0)};
  const activating=next.active===1&&(current.active===0||next.machine_id!==current.machine_id);
  if(activating&&await activeProductCount(env,next.machine_id,id)>=SMM_PANEL_PRODUCT_LIMIT){
    throw new Error("TOO_MANY_ACTIVE_PRODUCTS");
  }
  await env.DB.prepare(
    "UPDATE smm_products SET machine_id=?,name=?,description=?,emoji=?,service_id=?,service_name=?,service_category=?,markup_percent=?,fee_jpy=?,min_qty=?,max_qty=?,link_kind=?,active=?,updated_at=? WHERE id=?"
  ).bind(
    next.machine_id,next.name,next.description,next.emoji,next.service_id,next.service_name,
    next.service_category,next.markup_percent,next.fee_jpy,next.min_qty,next.max_qty,
    next.link_kind,next.active,Date.now(),id
  ).run();
  return getSmmProduct(env,id);
}

export async function deleteSmmProduct(env:Env,id:string){
  await ensureSmmSchema(env);
  await env.DB.prepare("DELETE FROM smm_products WHERE id=?").bind(id).run();
}

/* ---------------- panels ---------------- */

export type SmmPanelRow={
  guild_id:string;machine_id:string;channel_id:string;message_id:string;
  created_at:number;updated_at:number;
};

export async function saveSmmPanel(
  env:Env,
  guildId:string,
  machineId:string,
  channelId:string,
  messageId:string
){
  await ensureSmmSchema(env);
  const now=Date.now();
  await env.DB.prepare(
    "INSERT INTO smm_panels(guild_id,machine_id,channel_id,message_id,created_at,updated_at) VALUES (?,?,?,?,?,?) "+
    "ON CONFLICT(guild_id,channel_id,message_id) DO UPDATE SET machine_id=excluded.machine_id,updated_at=excluded.updated_at"
  ).bind(guildId,machineId,channelId,messageId,now,now).run();
}

export async function listSmmPanels(env:Env,machineId:string){
  await ensureSmmSchema(env);
  return (await env.DB.prepare(
    "SELECT * FROM smm_panels WHERE machine_id=? ORDER BY created_at DESC"
  ).bind(machineId).all<SmmPanelRow>()).results;
}

export async function deleteSmmPanelRecord(env:Env,guildId:string,channelId:string,messageId:string){
  await ensureSmmSchema(env);
  await env.DB.prepare(
    "DELETE FROM smm_panels WHERE guild_id=? AND channel_id=? AND message_id=?"
  ).bind(guildId,channelId,messageId).run();
}

/* ---------------- orders ---------------- */

const OPEN_STATUS_SQL="('awaiting_payment','payment_pending','paid','placing','placed','hold')";

export async function countOpenSmmOrders(env:Env,guildId:string,userId:string){
  await ensureSmmSchema(env);
  const row=await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM smm_orders WHERE guild_id=? AND user_id=? AND status IN "+OPEN_STATUS_SQL
  ).bind(guildId,userId).first<{n:number}>();
  return Number(row?.n??0);
}

export async function createSmmOrder(
  env:Env,
  input:{
    guildId:string;userId:string;product:SmmProduct;link:string;
    quantity:number;rateSnapshot:number;total:number;
  }
):Promise<SmmOrder>{
  await ensureSmmSchema(env);
  const now=Date.now();
  const id=randomId("smmo");
  await env.DB.prepare(
    "INSERT INTO smm_orders(id,guild_id,user_id,product_id,product_name,service_id,link,quantity,rate_snapshot,total_amount,status,reserved_until,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'awaiting_payment',?,?,?)"
  ).bind(
    id,input.guildId,input.userId,input.product.id,input.product.name,
    input.product.service_id,input.link,input.quantity,input.rateSnapshot,
    input.total,now+SMM_PAYMENT_WINDOW_MS,now,now
  ).run();
  return (await getSmmOrder(env,id))!;
}

export async function getSmmOrder(env:Env,id:string){
  await ensureSmmSchema(env);
  return await env.DB.prepare(
    "SELECT * FROM smm_orders WHERE id=?"
  ).bind(id).first<SmmOrder>()??null;
}

export async function listSmmOrders(
  env:Env,
  guildId:string,
  options:{limit?:number;userId?:string;status?:string}={}
){
  await ensureSmmSchema(env);
  const where=["guild_id=?"];
  const binds:unknown[]=[guildId];
  if(options.userId){where.push("user_id=?");binds.push(options.userId);}
  if(options.status){where.push("status=?");binds.push(options.status);}
  binds.push(Math.max(1,Math.min(300,Math.floor(options.limit??100))));
  return (await env.DB.prepare(
    "SELECT * FROM smm_orders WHERE "+where.join(" AND ")+" ORDER BY created_at DESC LIMIT ?"
  ).bind(...binds).all<SmmOrder>()).results;
}

export async function smmOrderSummary(env:Env,guildId:string){
  await ensureSmmSchema(env);
  const rows=(await env.DB.prepare(
    "SELECT status,COUNT(*) AS n,COALESCE(SUM(total_amount),0) AS amount FROM smm_orders WHERE guild_id=? GROUP BY status"
  ).bind(guildId).all<{status:string;n:number;amount:number}>()).results;
  const refund=await env.DB.prepare(
    "SELECT COUNT(*) AS n,COALESCE(SUM(refund_amount),0) AS amount FROM smm_orders WHERE guild_id=? AND refund_state='required'"
  ).bind(guildId).first<{n:number;amount:number}>();
  return {
    byStatus:Object.fromEntries(rows.map(row=>[row.status,{count:row.n,amount:row.amount}])),
    refundRequired:{count:Number(refund?.n??0),amount:Number(refund?.amount??0)}
  };
}

export async function attachSmmPaymentLink(env:Env,orderId:string,link:string){
  const encrypted=await encryptSensitive(env,link);
  const result=await env.DB.prepare(
    "UPDATE smm_orders SET payment_link_ciphertext=?,status='payment_pending',reserved_until=NULL,updated_at=? WHERE id=? AND status='awaiting_payment'"
  ).bind(JSON.stringify(encrypted),Date.now(),orderId).run();
  if(!changed(result)) throw new Error("PAYMENT_ORDER_NOT_AVAILABLE");
}

export async function clearSmmPaymentLink(env:Env,orderId:string){
  const now=Date.now();
  await env.DB.prepare(
    "UPDATE smm_orders SET payment_link_ciphertext=NULL,status='awaiting_payment',reserved_until=?,updated_at=? WHERE id=? AND status='payment_pending'"
  ).bind(now+SMM_PAYMENT_WINDOW_MS,now,orderId).run();
}

export async function readSmmPaymentLink(env:Env,order:SmmOrder):Promise<string|null>{
  if(!order.payment_link_ciphertext) return null;
  try{
    return await decryptSensitive(env,JSON.parse(order.payment_link_ciphertext) as EncryptedSecret);
  }catch{
    return null;
  }
}

export async function markSmmPaid(env:Env,order:SmmOrder):Promise<boolean>{
  const now=Date.now();
  const result=await env.DB.prepare(
    "UPDATE smm_orders SET status='paid',paid_at=?,reserved_until=NULL,payment_link_ciphertext=NULL,next_attempt_at=NULL,updated_at=? WHERE id=? AND status IN ('awaiting_payment','payment_pending')"
  ).bind(now,now,order.id).run();
  if(!changed(result)) return false;
  await env.DB.prepare(
    "UPDATE smm_products SET sales_count=sales_count+1 WHERE id=?"
  ).bind(order.product_id).run();
  return true;
}

export async function expireSmmUnpaid(env:Env){
  await ensureSmmSchema(env);
  const now=Date.now();
  await env.DB.prepare(
    "UPDATE smm_orders SET status='expired',finished_at=?,updated_at=? WHERE status='awaiting_payment' AND reserved_until IS NOT NULL AND reserved_until<?"
  ).bind(now,now,now).run();
}

export async function listSmmPendingPayments(env:Env,limit=8){
  await ensureSmmSchema(env);
  return (await env.DB.prepare(
    "SELECT * FROM smm_orders WHERE status='payment_pending' ORDER BY updated_at ASC LIMIT ?"
  ).bind(limit).all<SmmOrder>()).results;
}

export async function listSmmReadyToPlace(env:Env,limit=10){
  await ensureSmmSchema(env);
  const now=Date.now();
  return (await env.DB.prepare(
    "SELECT * FROM smm_orders WHERE status='paid' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY paid_at ASC LIMIT ?"
  ).bind(now,limit).all<SmmOrder>()).results;
}

export async function claimSmmPlacing(env:Env,orderId:string):Promise<boolean>{
  const now=Date.now();
  const result=await env.DB.prepare(
    "UPDATE smm_orders SET status='placing',attempts=attempts+1,updated_at=? WHERE id=? AND status='paid' AND (next_attempt_at IS NULL OR next_attempt_at<=?)"
  ).bind(now,orderId,now).run();
  return changed(result);
}

export async function markSmmPlaced(env:Env,orderId:string,supplierOrderId:string):Promise<boolean>{
  const now=Date.now();
  const result=await env.DB.prepare(
    "UPDATE smm_orders SET status='placed',supplier_order_id=?,placed_at=?,last_error=NULL,next_attempt_at=NULL,updated_at=? WHERE id=? AND status IN ('placing','hold')"
  ).bind(supplierOrderId,now,now,orderId).run();
  return changed(result);
}

export async function markSmmRetry(env:Env,orderId:string,error:string,nextAttemptAt:number){
  await env.DB.prepare(
    "UPDATE smm_orders SET status='paid',next_attempt_at=?,last_error=?,updated_at=? WHERE id=? AND status='placing'"
  ).bind(nextAttemptAt,error.slice(0,300),Date.now(),orderId).run();
}

export async function markSmmHold(env:Env,orderId:string,reason:string):Promise<boolean>{
  const result=await env.DB.prepare(
    "UPDATE smm_orders SET status='hold',last_error=?,admin_alerted_at=NULL,updated_at=? WHERE id=? AND status IN ('placing','paid','placed')"
  ).bind(reason.slice(0,300),Date.now(),orderId).run();
  return changed(result);
}

export async function markSmmFailed(
  env:Env,
  orderId:string,
  error:string,
  refundAmount:number
):Promise<boolean>{
  const now=Date.now();
  const result=await env.DB.prepare(
    "UPDATE smm_orders SET status='failed',refund_state=CASE WHEN ?>0 THEN 'required' ELSE 'none' END,refund_amount=?,last_error=?,finished_at=?,admin_alerted_at=NULL,buyer_notified_at=NULL,updated_at=? WHERE id=? AND status IN ('placing','paid','hold','placed')"
  ).bind(refundAmount,refundAmount,error.slice(0,300),now,now,orderId).run();
  return changed(result);
}

export async function releaseSmmHold(env:Env,orderId:string):Promise<boolean>{
  const result=await env.DB.prepare(
    "UPDATE smm_orders SET status='paid',next_attempt_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND status='hold' AND supplier_order_id IS NULL"
  ).bind(Date.now(),orderId).run();
  return changed(result);
}

export async function listSmmStalePlacing(env:Env){
  await ensureSmmSchema(env);
  return (await env.DB.prepare(
    "SELECT * FROM smm_orders WHERE status='placing' AND updated_at<? LIMIT 20"
  ).bind(Date.now()-SMM_PLACING_STALE_MS).all<SmmOrder>()).results;
}

export async function listSmmPlaced(env:Env,limit=100){
  await ensureSmmSchema(env);
  return (await env.DB.prepare(
    "SELECT * FROM smm_orders WHERE status='placed' AND supplier_order_id IS NOT NULL ORDER BY updated_at ASC LIMIT ?"
  ).bind(limit).all<SmmOrder>()).results;
}

export async function updateSmmTracking(
  env:Env,
  orderId:string,
  tracking:{supplier_status:string;start_count:number|null;remains:number|null;charge:number}
){
  await env.DB.prepare(
    "UPDATE smm_orders SET supplier_status=?,start_count=?,remains=?,supplier_charge=?,updated_at=? WHERE id=? AND status='placed'"
  ).bind(
    tracking.supplier_status,tracking.start_count,tracking.remains,tracking.charge,
    Date.now(),orderId
  ).run();
}

export async function finalizeSmmOrder(
  env:Env,
  orderId:string,
  status:"completed"|"partial"|"canceled",
  refundAmount:number,
  supplierStatus:string
):Promise<boolean>{
  const now=Date.now();
  const result=await env.DB.prepare(
    "UPDATE smm_orders SET status=?,supplier_status=?,refund_state=CASE WHEN ?>0 THEN 'required' ELSE 'none' END,refund_amount=?,finished_at=?,admin_alerted_at=NULL,buyer_notified_at=NULL,updated_at=? WHERE id=? AND status IN ('placed','hold')"
  ).bind(status,supplierStatus,refundAmount,refundAmount,now,now,orderId).run();
  return changed(result);
}

export async function markSmmRefundDone(env:Env,orderId:string):Promise<boolean>{
  const result=await env.DB.prepare(
    "UPDATE smm_orders SET refund_state='done',updated_at=? WHERE id=? AND refund_state='required'"
  ).bind(Date.now(),orderId).run();
  return changed(result);
}

export async function listSmmUnnotified(env:Env,limit=10){
  await ensureSmmSchema(env);
  return (await env.DB.prepare(
    "SELECT * FROM smm_orders WHERE status IN ('completed','partial','canceled','failed') AND buyer_notified_at IS NULL AND notify_attempts<5 AND finished_at>? ORDER BY finished_at ASC LIMIT ?"
  ).bind(Date.now()-24*60*60_000,limit).all<SmmOrder>()).results;
}

export async function markSmmNotified(env:Env,orderId:string,success:boolean){
  await env.DB.prepare(
    success
      ?"UPDATE smm_orders SET buyer_notified_at=?,notify_attempts=notify_attempts+1 WHERE id=?"
      :"UPDATE smm_orders SET notify_attempts=notify_attempts+1 WHERE id=?"
  ).bind(...(success?[Date.now(),orderId]:[orderId])).run();
}

export async function listSmmNeedingAdminAlert(env:Env,limit=10){
  await ensureSmmSchema(env);
  return (await env.DB.prepare(
    "SELECT * FROM smm_orders WHERE (status='hold' OR refund_state='required') AND admin_alerted_at IS NULL ORDER BY updated_at ASC LIMIT ?"
  ).bind(limit).all<SmmOrder>()).results;
}

export async function markSmmAdminAlerted(env:Env,orderId:string){
  await env.DB.prepare(
    "UPDATE smm_orders SET admin_alerted_at=? WHERE id=?"
  ).bind(Date.now(),orderId).run();
}
