import { DEFAULT_PANEL_COLOR, isPanelColor } from "./shiire-panel-payload";
import type { Env } from "./types";
import { randomId } from "./crypto";
import { encryptSensitive, decryptSensitive, type EncryptedSecret } from "./x-crypto";
import { ensureXSchema } from "./x-db";
import { paymentPrice } from "./shiire-vending-policy";
import { SHIIRE_VENDING_SALES_COPY } from "./shiire-vending-sales-copy";

export type ShiireVendingMachine={
  id:string;
  guild_id:string;
  name:string;
  public_log_channel_id:string|null;
  private_log_channel_id:string|null;
  role_id:string|null;
  panel_title:string|null;
  panel_description:string|null;
  panel_image_url:string|null;
  panel_color?:number;
  active:number;
  created_at:number;
  updated_at:number;
};

export type ShiireVendingProduct={
  id:string;
  vending_machine_id:string;
  supplier_product_id:string;
  procurement_class:"TOP_SEARCH"|"NO_SHADOWBAN"|null;
  name:string;
  description:string;
  price_paypay:number;
  price_kyash:number;
  emoji:string|null;
  sales_count:number;
  active:number;
  created_at:number;
  updated_at:number;
};

export type ShiireVendingOrder={
  id:string;
  vending_machine_id:string;
  product_id:string;
  guild_id:string;
  user_id:string;
  payment_method:"paypay"|"kyash"|"free";
  quantity:number;
  unit_price:number;
  discount_each:number;
  total_amount:number;
  status:string;
  payment_link_ciphertext:string|null;
  reserved_until:number|null;
  created_at:number;
  updated_at:number;
  paid_at:number|null;
  delivered_at:number|null;
  delivery_channel_id:string|null;
  delivery_message_id:string|null;
};

let ready=false;

const SCHEMA=[
  "CREATE TABLE IF NOT EXISTS shiire_vending_machines (id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,name TEXT NOT NULL,public_log_channel_id TEXT,private_log_channel_id TEXT,role_id TEXT,panel_title TEXT,panel_description TEXT,panel_color INTEGER NOT NULL DEFAULT 5763719,panel_image_url TEXT,panel_image_mime TEXT,panel_image_base64 TEXT,active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS shiire_vending_machines_guild_idx ON shiire_vending_machines(guild_id,active)",
  "CREATE TABLE IF NOT EXISTS shiire_vending_products (id TEXT PRIMARY KEY,vending_machine_id TEXT NOT NULL,supplier_product_id TEXT NOT NULL,procurement_class TEXT,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',price_paypay INTEGER NOT NULL DEFAULT 0,price_kyash INTEGER NOT NULL DEFAULT 0,emoji TEXT,sales_count INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS shiire_vending_products_vm_idx ON shiire_vending_products(vending_machine_id,active)",
  "CREATE INDEX IF NOT EXISTS shiire_vending_products_supplier_idx ON shiire_vending_products(supplier_product_id,active)",
  "CREATE TABLE IF NOT EXISTS shiire_vending_coupons (code TEXT NOT NULL,vending_machine_id TEXT NOT NULL,discount INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,PRIMARY KEY(vending_machine_id,code))",
  "CREATE TABLE IF NOT EXISTS shiire_vending_stock_notifications (vending_machine_id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,role_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS shiire_vending_orders (id TEXT PRIMARY KEY,vending_machine_id TEXT NOT NULL,product_id TEXT NOT NULL,guild_id TEXT NOT NULL,user_id TEXT NOT NULL,payment_method TEXT NOT NULL,quantity INTEGER NOT NULL,unit_price INTEGER NOT NULL,discount_each INTEGER NOT NULL DEFAULT 0,total_amount INTEGER NOT NULL,status TEXT NOT NULL,payment_link_ciphertext TEXT,reserved_until INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,paid_at INTEGER,delivered_at INTEGER,delivery_channel_id TEXT,delivery_message_id TEXT)",
  "CREATE INDEX IF NOT EXISTS shiire_vending_orders_status_idx ON shiire_vending_orders(status,reserved_until,created_at)",
  "CREATE TABLE IF NOT EXISTS shiire_vending_reservations (account_id TEXT PRIMARY KEY,order_id TEXT NOT NULL,product_id TEXT NOT NULL,reserved_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS shiire_vending_reservations_order_idx ON shiire_vending_reservations(order_id)",
  "CREATE TABLE IF NOT EXISTS shiire_vending_panels (vending_machine_id TEXT NOT NULL,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,message_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(vending_machine_id,channel_id,message_id))"
];

export async function ensureShiireVendingSchema(env:Env){
  if(ready) return;
  await ensureXSchema(env);
  for(const sql of SCHEMA) await env.DB.prepare(sql).run();
  const machineColumns=(await env.DB.prepare(
    "PRAGMA table_info(shiire_vending_machines)"
  ).all<{name:string}>()).results.map(row=>row.name);
  for(const [name,type] of [
    ["panel_color","INTEGER NOT NULL DEFAULT 5763719"],
    ["panel_image_url","TEXT"],
    ["panel_image_mime","TEXT"],
    ["panel_image_base64","TEXT"]
  ] as const){
    if(!machineColumns.includes(name)){
      await env.DB.prepare(
        "ALTER TABLE shiire_vending_machines ADD COLUMN "+name+" "+type
      ).run();
    }
  }

  const productColumns=(await env.DB.prepare(
    "PRAGMA table_info(shiire_vending_products)"
  ).all<{name:string}>()).results.map(row=>row.name);
  if(!productColumns.includes("procurement_class")){
    await env.DB.prepare(
      "ALTER TABLE shiire_vending_products ADD COLUMN procurement_class TEXT"
    ).run();
  }

  const orderColumns=(await env.DB.prepare(
    "PRAGMA table_info(shiire_vending_orders)"
  ).all<{name:string}>()).results.map(row=>row.name);
  for(const [name,type] of [
    ["delivery_channel_id","TEXT"],
    ["delivery_message_id","TEXT"]
  ] as const){
    if(!orderColumns.includes(name)){
      await env.DB.prepare(
        "ALTER TABLE shiire_vending_orders ADD COLUMN "+name+" "+type
      ).run();
    }
  }
  ready=true;
}

export async function listShiireMachines(env:Env,guildId:string){
  await ensureShiireVendingSchema(env);
  return (await env.DB.prepare(
    "SELECT * FROM shiire_vending_machines WHERE guild_id=? AND active=1 ORDER BY created_at DESC"
  ).bind(guildId).all<ShiireVendingMachine>()).results;
}

export async function getShiireMachine(env:Env,id:string){
  await ensureShiireVendingSchema(env);
  return await env.DB.prepare(
    "SELECT * FROM shiire_vending_machines WHERE id=? AND active=1"
  ).bind(id).first<ShiireVendingMachine>()??null;
}

export async function createShiireMachine(env:Env,guildId:string,name:string){
  await ensureShiireVendingSchema(env);
  const id=randomId(),now=Date.now();
  await env.DB.prepare(
    "INSERT INTO shiire_vending_machines(id,guild_id,name,active,created_at,updated_at) VALUES (?,?,?,1,?,?)"
  ).bind(id,guildId,name,now,now).run();
  await ensureShiireDefaultProducts(env,id);
  return getShiireMachine(env,id);
}

export async function updateShiireMachine(
  env:Env,
  id:string,
  input:Partial<{
    name:string;
    publicLogChannelId:string|null;
    privateLogChannelId:string|null;
    roleId:string|null;
    panelTitle:string|null;
    panelDescription:string|null;
    panelColor:number;
  }>
){
  if(input.panelColor!==undefined&&!isPanelColor(input.panelColor)) throw new Error("INVALID_PANEL_COLOR");
  const current=await getShiireMachine(env,id);
  if(!current) return false;
  const result=await env.DB.prepare(
    "UPDATE shiire_vending_machines SET name=?,public_log_channel_id=?,private_log_channel_id=?,role_id=?,panel_title=?,panel_description=?,panel_color=?,updated_at=? WHERE id=? AND active=1"
  ).bind(
    input.name??current.name,
    input.publicLogChannelId===undefined?current.public_log_channel_id:input.publicLogChannelId,
    input.privateLogChannelId===undefined?current.private_log_channel_id:input.privateLogChannelId,
    input.roleId===undefined?current.role_id:input.roleId,
    input.panelTitle===undefined?current.panel_title:input.panelTitle,
    input.panelDescription===undefined?current.panel_description:input.panelDescription,
    input.panelColor===undefined?(current.panel_color??DEFAULT_PANEL_COLOR):input.panelColor,
    Date.now(),id
  ).run();
  return Number(result.meta.changes??0)>0;
}

export async function saveShiirePanelImage(
  env:Env,
  machineId:string,
  url:string,
  mime:string,
  base64:string
){
  await ensureShiireVendingSchema(env);
  const result=await env.DB.prepare(
    "UPDATE shiire_vending_machines SET panel_image_url=?,panel_image_mime=?,panel_image_base64=?,updated_at=? WHERE id=? AND active=1"
  ).bind(url,mime,base64,Date.now(),machineId).run();
  return Number(result.meta.changes??0)===1;
}

export async function deleteShiirePanelImage(env:Env,machineId:string){
  await ensureShiireVendingSchema(env);
  const result=await env.DB.prepare(
    "UPDATE shiire_vending_machines SET panel_image_url=NULL,panel_image_mime=NULL,panel_image_base64=NULL,updated_at=? WHERE id=? AND active=1"
  ).bind(Date.now(),machineId).run();
  return Number(result.meta.changes??0)===1;
}

export async function getShiirePanelImage(env:Env,machineId:string){
  await ensureShiireVendingSchema(env);
  return await env.DB.prepare(
    "SELECT panel_image_mime,panel_image_base64 FROM shiire_vending_machines WHERE id=? AND active=1"
  ).bind(machineId).first<{panel_image_mime:string|null;panel_image_base64:string|null}>()??null;
}

export async function ensureShiireDefaultProducts(env:Env,machineId:string){
  await ensureShiireVendingSchema(env);
  const now=Date.now();
  const results=await env.DB.batch(Object.entries(SHIIRE_VENDING_SALES_COPY).map(([procurementClass,preset])=>
    env.DB.prepare(
      "INSERT OR IGNORE INTO shiire_vending_products(id,vending_machine_id,supplier_product_id,procurement_class,name,description,price_paypay,price_kyash,active,created_at,updated_at) "+
      "SELECT ?,?,'',?,?,?,?,?,1,?,? WHERE EXISTS (SELECT 1 FROM shiire_vending_machines WHERE id=? AND active=1) "+
      "AND NOT EXISTS (SELECT 1 FROM shiire_vending_products WHERE vending_machine_id=? AND procurement_class=?)"
    ).bind("default:"+machineId+":"+procurementClass,machineId,procurementClass,preset.name,preset.description,preset.priceJpy,preset.priceJpy,now,now,machineId,machineId,procurementClass)
  ));
  // An inactive product records an intentional deletion; never recreate it on GET.
  return results.reduce((sum,result)=>sum+Number(result.meta.changes??0),0);
}

export async function deleteShiireMachine(env:Env,id:string){
  await ensureShiireVendingSchema(env);
  const result=await env.DB.prepare(
    "UPDATE shiire_vending_machines SET active=0,updated_at=? WHERE id=? AND active=1 "+
    "AND NOT EXISTS (SELECT 1 FROM shiire_vending_orders WHERE vending_machine_id=? AND status IN ('reserving','awaiting_payment','payment_pending','paid','delivering','delivery_sent'))"
  ).bind(Date.now(),id,id).run();
  if(Number(result.meta.changes??0)>0) return true;
  if(await getShiireMachine(env,id)) throw new Error("SHIIRE_MACHINE_HAS_OPEN_ORDERS");
  return false;
}

export async function listShiireSourceProducts(env:Env){
  await ensureShiireVendingSchema(env);
  return (await env.DB.prepare(
    "SELECT supplier_product_id,title,currency,unit_price,stock_available,procurement_class,qualified,last_seen_at FROM supplier_products WHERE supplier='hstora' ORDER BY updated_at DESC LIMIT 500"
  ).all()).results;
}

export async function availableShiireAccounts(
  env:Env,
  product:Pick<ShiireVendingProduct,"supplier_product_id"|"procurement_class">
):Promise<number>{
  await ensureShiireVendingSchema(env);
  if(product.procurement_class){
    const row=await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM purchased_accounts "+
      "WHERE procurement_class=? AND status='READY_FOR_DELIVERY'"
    ).bind(product.procurement_class).first<{count:number}>();
    return Math.max(0,Number(row?.count??0));
  }
  const row=await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM purchased_accounts "+
    "WHERE supplier_product_id=? AND status='READY_FOR_DELIVERY' "+
    "AND COALESCE(procurement_class,'')<>'INVITE_CAMPAIGN'"
  ).bind(product.supplier_product_id).first<{count:number}>();
  return Math.max(0,Number(row?.count??0));
}
export async function listShiireProducts(env:Env,machineId:string){
  await ensureShiireVendingSchema(env);
  const products=(await env.DB.prepare(
    "SELECT * FROM shiire_vending_products WHERE vending_machine_id=? AND active=1 ORDER BY created_at ASC"
  ).bind(machineId).all<ShiireVendingProduct>()).results;
  return Promise.all(products.map(async product=>({
    ...product,
    stock_count:await availableShiireAccounts(env,product)
  })));
}

export async function getShiireProduct(env:Env,id:string){
  await ensureShiireVendingSchema(env);
  return await env.DB.prepare(
    "SELECT * FROM shiire_vending_products WHERE id=? AND active=1"
  ).bind(id).first<ShiireVendingProduct>()??null;
}

async function requireSourceProduct(env:Env,supplierProductId:string){
  const source=await env.DB.prepare(
    "SELECT supplier_product_id FROM supplier_products WHERE supplier='hstora' AND supplier_product_id=?"
  ).bind(supplierProductId).first();
  if(!source) throw new Error("SUPPLIER_PRODUCT_NOT_FOUND");
}

function validProcurementClass(value:unknown):value is "TOP_SEARCH"|"NO_SHADOWBAN"{
  return value==="TOP_SEARCH"||value==="NO_SHADOWBAN";
}

export async function createShiireProduct(
  env:Env,
  machineId:string,
  input:{
    supplierProductId?:string;
    procurementClass?:"TOP_SEARCH"|"NO_SHADOWBAN"|null;
    name:string;
    description:string;
    pricePayPay:number;
    priceKyash:number;
    emoji:string|null;
  }
){
  await ensureShiireVendingSchema(env);
  const procurementClass=
    validProcurementClass(input.procurementClass)
      ?input.procurementClass
      :null;
  const supplierProductId=String(input.supplierProductId??"").trim();

  if(procurementClass){
    // Class-backed products aggregate stock across changing HStora listing IDs.
  }else{
    if(!supplierProductId) throw new Error("SUPPLIER_PRODUCT_REQUIRED");
    await requireSourceProduct(env,supplierProductId);
  }

  const id=randomId(),now=Date.now();
  await env.DB.prepare(
    "INSERT INTO shiire_vending_products("+
    "id,vending_machine_id,supplier_product_id,procurement_class,name,description,"+
    "price_paypay,price_kyash,emoji,sales_count,active,created_at,updated_at"+
    ") VALUES (?,?,?,?,?,?,?,?,?,0,1,?,?)"
  ).bind(
    id,
    machineId,
    procurementClass?"":supplierProductId,
    procurementClass,
    input.name,
    input.description,
    input.pricePayPay,
    input.priceKyash,
    input.emoji,
    now,
    now
  ).run();
  return getShiireProduct(env,id);
}

export async function updateShiireProduct(
  env:Env,
  id:string,
  input:Partial<{
    supplierProductId:string;
    procurementClass:"TOP_SEARCH"|"NO_SHADOWBAN"|null;
    name:string;
    description:string;
    pricePayPay:number;
    priceKyash:number;
    emoji:string|null;
  }>
){
  const current=await getShiireProduct(env,id);
  if(!current) return false;

  let nextClass=current.procurement_class;
  let nextSupplier=current.supplier_product_id;

  if(input.procurementClass!==undefined){
    if(input.procurementClass!==null&&!validProcurementClass(input.procurementClass)){
      throw new Error("PROCUREMENT_CLASS_INVALID");
    }
    nextClass=input.procurementClass;
    if(nextClass) nextSupplier="";
  }
  if(input.supplierProductId!==undefined){
    const supplierProductId=String(input.supplierProductId).trim();
    if(!supplierProductId) throw new Error("SUPPLIER_PRODUCT_REQUIRED");
    await requireSourceProduct(env,supplierProductId);
    nextSupplier=supplierProductId;
    nextClass=null;
  }
  if(!nextClass&&!nextSupplier) throw new Error("VENDING_SOURCE_REQUIRED");

  const result=await env.DB.prepare(
    "UPDATE shiire_vending_products SET supplier_product_id=?,procurement_class=?,"+
    "name=?,description=?,price_paypay=?,price_kyash=?,emoji=?,updated_at=? "+
    "WHERE id=? AND active=1"
  ).bind(
    nextSupplier,
    nextClass,
    input.name??current.name,
    input.description??current.description,
    input.pricePayPay??current.price_paypay,
    input.priceKyash??current.price_kyash,
    input.emoji===undefined?current.emoji:input.emoji,
    Date.now(),
    id
  ).run();
  return Number(result.meta.changes??0)>0;
}

export async function deleteShiireProduct(env:Env,id:string){
  await ensureShiireVendingSchema(env);
  const result=await env.DB.prepare(
    "UPDATE shiire_vending_products SET active=0,updated_at=? WHERE id=? AND active=1"
  ).bind(Date.now(),id).run();
  return Number(result.meta.changes??0)>0;
}

export async function listShiireCoupons(env:Env,machineId:string){
  await ensureShiireVendingSchema(env);
  return (await env.DB.prepare(
    "SELECT code,discount,created_at FROM shiire_vending_coupons WHERE vending_machine_id=? AND active=1 ORDER BY created_at DESC"
  ).bind(machineId).all<{code:string;discount:number;created_at:number}>()).results;
}

export async function getShiireCoupon(env:Env,machineId:string,code:string){
  await ensureShiireVendingSchema(env);
  return await env.DB.prepare(
    "SELECT code,discount FROM shiire_vending_coupons WHERE vending_machine_id=? AND code=? AND active=1"
  ).bind(machineId,code).first<{code:string;discount:number}>()??null;
}

export async function createShiireCoupon(env:Env,machineId:string,code:string,discount:number){
  await ensureShiireVendingSchema(env);
  await env.DB.prepare(
    "INSERT INTO shiire_vending_coupons(code,vending_machine_id,discount,active,created_at) VALUES (?,?,?,1,?)"
  ).bind(code,machineId,discount,Date.now()).run();
}

export async function deleteShiireCoupon(env:Env,machineId:string,code:string){
  await ensureShiireVendingSchema(env);
  const result=await env.DB.prepare(
    "UPDATE shiire_vending_coupons SET active=0 WHERE vending_machine_id=? AND code=? AND active=1"
  ).bind(machineId,code).run();
  return Number(result.meta.changes??0)>0;
}

export async function getShiireStockNotification(env:Env,machineId:string){
  await ensureShiireVendingSchema(env);
  return await env.DB.prepare(
    "SELECT guild_id,channel_id,role_id,enabled FROM shiire_vending_stock_notifications WHERE vending_machine_id=?"
  ).bind(machineId).first<{
    guild_id:string;channel_id:string;role_id:string;enabled:number;
  }>()??null;
}

export async function saveShiireStockNotification(
  env:Env,
  machineId:string,
  guildId:string,
  channelId:string,
  roleId:string,
  enabled:boolean
){
  await ensureShiireVendingSchema(env);
  await env.DB.prepare(
    "INSERT INTO shiire_vending_stock_notifications(vending_machine_id,guild_id,channel_id,role_id,enabled,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(vending_machine_id) DO UPDATE SET guild_id=excluded.guild_id,channel_id=excluded.channel_id,role_id=excluded.role_id,enabled=excluded.enabled,updated_at=excluded.updated_at"
  ).bind(machineId,guildId,channelId,roleId,enabled?1:0,Date.now()).run();
}

export async function deleteShiireStockNotification(env:Env,machineId:string){
  await ensureShiireVendingSchema(env);
  await env.DB.prepare(
    "DELETE FROM shiire_vending_stock_notifications WHERE vending_machine_id=?"
  ).bind(machineId).run();
}

async function reserveAccounts(
  env:Env,
  orderId:string,
  product:ShiireVendingProduct,
  quantity:number
){
  const rows=product.procurement_class
    ?(await env.DB.prepare(
      "SELECT id FROM purchased_accounts "+
      "WHERE procurement_class=? AND status='READY_FOR_DELIVERY' "+
      "ORDER BY purchased_at ASC,id ASC LIMIT ?"
    ).bind(product.procurement_class,quantity).all<{id:string}>()).results
    :(await env.DB.prepare(
      "SELECT id FROM purchased_accounts "+
      "WHERE supplier_product_id=? AND status='READY_FOR_DELIVERY' "+
      "AND COALESCE(procurement_class,'')<>'INVITE_CAMPAIGN' "+
      "ORDER BY purchased_at ASC,id ASC LIMIT ?"
    ).bind(product.supplier_product_id,quantity).all<{id:string}>()).results;
  if(rows.length<quantity) throw new Error("OUT_OF_STOCK");

  const reserved:string[]=[];
  try{
    for(const row of rows){
      const results=await env.DB.batch([
        env.DB.prepare(
          "UPDATE purchased_accounts SET status='VENDING_RESERVED' WHERE id=? AND status='READY_FOR_DELIVERY' AND EXISTS (SELECT 1 FROM shiire_vending_orders WHERE id=? AND status='reserving')"
        ).bind(row.id,orderId),
        env.DB.prepare(
          "INSERT INTO shiire_vending_reservations(account_id,order_id,product_id,reserved_at) SELECT ?,?,?,? WHERE changes()=1"
        ).bind(row.id,orderId,product.id,Date.now())
      ]);
      if(Number(results[0]?.meta.changes??0)!==1) throw new Error("STOCK_RACE");
      reserved.push(row.id);
    }
    return reserved;
  }catch(error){
    await releaseShiireOrder(env,orderId);
    throw error;
  }
}

export async function reserveShiireOrder(
  env:Env,
  input:{
    machine:ShiireVendingMachine;
    product:ShiireVendingProduct;
    guildId:string;
    userId:string;
    method:"paypay"|"kyash";
    quantity:number;
    discount:number;
  }
){
  await ensureShiireVendingSchema(env);
  const quantity=Math.max(1,Math.floor(input.quantity));
  const unit=paymentPrice(input.product,input.method);
  if(unit<1) throw new Error("PAYMENT_METHOD_DISABLED_FOR_PRODUCT");
  const discount=Math.max(0,Math.floor(input.discount));
  const total=Math.max(0,(unit-discount)*quantity);
  const now=Date.now(),orderId=randomId(),until=now+10*60_000;

  const inserted=await env.DB.prepare(
    "INSERT INTO shiire_vending_orders(id,vending_machine_id,product_id,guild_id,user_id,payment_method,quantity,unit_price,discount_each,total_amount,status,reserved_until,created_at,updated_at,paid_at) "+
    "SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM shiire_vending_machines WHERE id=? AND active=1)"
  ).bind(
    orderId,input.machine.id,input.product.id,input.guildId,input.userId,
    total===0?"free":input.method,quantity,unit,discount,total,
    "reserving",until,now,now,total===0?now:null,input.machine.id
  ).run();
  if(Number(inserted.meta.changes??0)!==1) throw new Error("VENDING_MACHINE_NOT_AVAILABLE");

  try{
    await reserveAccounts(env,orderId,input.product,quantity);
  }catch(error){
    await env.DB.prepare(
      "UPDATE shiire_vending_orders SET status='failed',updated_at=? WHERE id=?"
    ).bind(Date.now(),orderId).run();
    throw error;
  }

  const finalized=await env.DB.prepare(
    "UPDATE shiire_vending_orders SET status=?,updated_at=? WHERE id=? AND status='reserving'"
  ).bind(total===0?"paid":"awaiting_payment",Date.now(),orderId).run();
  if(Number(finalized.meta.changes??0)!==1) throw new Error("ORDER_RESERVATION_EXPIRED");
  return getShiireOrder(env,orderId);
}

export async function getShiireOrder(env:Env,id:string){
  await ensureShiireVendingSchema(env);
  return await env.DB.prepare(
    "SELECT * FROM shiire_vending_orders WHERE id=?"
  ).bind(id).first<ShiireVendingOrder>()??null;
}

export async function attachShiirePaymentLink(env:Env,orderId:string,link:string){
  const encrypted=await encryptSensitive(env,link);
  const now=Date.now();
  const result=await env.DB.prepare(
    "UPDATE shiire_vending_orders SET payment_link_ciphertext=?,status='payment_pending',reserved_until=NULL,updated_at=? WHERE id=? AND status='awaiting_payment'"
  ).bind(JSON.stringify(encrypted),now,orderId).run();
  if(Number(result.meta.changes??0)!==1) throw new Error("PAYMENT_ORDER_NOT_AVAILABLE");
}

export async function clearShiirePaymentLink(env:Env,orderId:string){
  const now=Date.now();
  await env.DB.prepare(
    "UPDATE shiire_vending_orders SET payment_link_ciphertext=NULL,status='awaiting_payment',reserved_until=?,updated_at=? WHERE id=? AND status='payment_pending'"
  ).bind(now+10*60_000,now,orderId).run();
}

export async function readShiirePaymentLink(
  env:Env,
  order:ShiireVendingOrder
):Promise<string|null>{
  if(!order.payment_link_ciphertext) return null;
  try{
    return decryptSensitive(
      env,
      JSON.parse(order.payment_link_ciphertext) as EncryptedSecret
    );
  }catch{
    return null;
  }
}

export async function markShiirePaid(env:Env,orderId:string){
  const now=Date.now();
  await env.DB.prepare(
    "UPDATE shiire_vending_orders SET status='paid',paid_at=?,reserved_until=NULL,updated_at=? WHERE id=? AND status IN ('awaiting_payment','payment_pending')"
  ).bind(now,now,orderId).run();
}

export async function claimShiireDelivery(env:Env,orderId:string){
  const result=await env.DB.prepare(
    "UPDATE shiire_vending_orders SET status='delivering',updated_at=? WHERE id=? AND status='paid' AND delivered_at IS NULL"
  ).bind(Date.now(),orderId).run();
  return Number(result.meta.changes??0)===1;
}

export async function resetShiireDelivery(env:Env,orderId:string){
  await env.DB.prepare(
    "UPDATE shiire_vending_orders SET status='paid',updated_at=? WHERE id=? AND status='delivering' AND delivered_at IS NULL"
  ).bind(Date.now(),orderId).run();
}

export async function markShiireDeliverySent(
  env:Env,
  orderId:string,
  channelId:string,
  messageId:string
){
  const result=await env.DB.prepare(
    "UPDATE shiire_vending_orders SET status='delivery_sent',delivery_channel_id=?,delivery_message_id=?,updated_at=? WHERE id=? AND status='delivering' AND delivered_at IS NULL"
  ).bind(channelId,messageId,Date.now(),orderId).run();
  if(Number(result.meta.changes??0)!==1){
    const current=await getShiireOrder(env,orderId);
    if(current?.status!=="delivery_sent"&&current?.status!=="delivered"){
      throw new Error("DELIVERY_SENT_STATE_WRITE_FAILED");
    }
  }
}

export async function listShiireDeliverySent(env:Env,limit=20){
  await ensureShiireVendingSchema(env);
  const safe=Math.max(1,Math.min(50,Math.floor(limit)));
  return (await env.DB.prepare(
    "SELECT * FROM shiire_vending_orders WHERE status='delivery_sent' AND delivered_at IS NULL ORDER BY updated_at ASC LIMIT ?"
  ).bind(safe).all<ShiireVendingOrder>()).results;
}

export async function reservedShiireAccounts(env:Env,orderId:string){
  await ensureShiireVendingSchema(env);
  return (await env.DB.prepare(
    "SELECT a.id,a.credentials_ciphertext,a.supplier_product_id FROM shiire_vending_reservations r JOIN purchased_accounts a ON a.id=r.account_id WHERE r.order_id=? AND a.status='VENDING_RESERVED' ORDER BY r.reserved_at ASC,a.id ASC"
  ).bind(orderId).all<{
    id:string;credentials_ciphertext:string;supplier_product_id:string;
  }>()).results;
}

export async function decryptReservedShiireAccounts(env:Env,orderId:string){
  const rows=await reservedShiireAccounts(env,orderId);
  const output:Array<{id:string;content:string}>= [];
  for(const row of rows){
    let encrypted:EncryptedSecret;
    try{encrypted=JSON.parse(row.credentials_ciphertext) as EncryptedSecret;}
    catch{throw new Error("CREDENTIAL_CIPHERTEXT_INVALID");}
    output.push({id:row.id,content:await decryptSensitive(env,encrypted)});
  }
  return output;
}

export async function finishShiireDelivery(env:Env,order:ShiireVendingOrder){
  const product=await getShiireProduct(env,order.product_id);
  if(!product) throw new Error("PRODUCT_NOT_FOUND");
  const rows=await reservedShiireAccounts(env,order.id);
  if(rows.length!==order.quantity) throw new Error("RESERVED_STOCK_MISSING");
  const now=Date.now();

  const statements=[
    ...rows.map(row=>env.DB.prepare(
      "UPDATE purchased_accounts SET status='DELIVERED',delivered_at=? WHERE id=? AND status='VENDING_RESERVED'"
    ).bind(now,row.id)),
    env.DB.prepare(
      "DELETE FROM shiire_vending_reservations WHERE order_id=?"
    ).bind(order.id),
    env.DB.prepare(
      "UPDATE shiire_vending_products SET sales_count=sales_count+?,updated_at=? "+
      "WHERE id=? AND EXISTS ("+
      "SELECT 1 FROM shiire_vending_orders WHERE id=? AND status IN ('delivering','delivery_sent')"+
      ")"
    ).bind(order.quantity,now,order.product_id,order.id),
    env.DB.prepare(
      "UPDATE shiire_vending_orders SET status='delivered',delivered_at=?,updated_at=? WHERE id=? AND status IN ('delivering','delivery_sent')"
    ).bind(now,now,order.id)
  ];
  const results=await env.DB.batch(statements);
  for(let i=0;i<rows.length;i++){
    if(Number(results[i]?.meta?.changes??0)!==1){
      throw new Error("DELIVERY_STATE_RACE");
    }
  }
}

export async function releaseShiireOrder(env:Env,orderId:string){
  const releasable="SELECT id FROM shiire_vending_orders WHERE id=? AND status IN ('awaiting_payment','reserving','failed')";
  const results=await env.DB.batch([
    env.DB.prepare(
      "UPDATE purchased_accounts SET status='READY_FOR_DELIVERY' WHERE status='VENDING_RESERVED' AND id IN (SELECT account_id FROM shiire_vending_reservations WHERE order_id IN ("+releasable+"))"
    ).bind(orderId),
    env.DB.prepare(
      "DELETE FROM shiire_vending_reservations WHERE order_id IN ("+releasable+")"
    ).bind(orderId)
  ]);
  return Number(results[0]?.meta.changes??0);
}

export async function cleanShiireVendingExpired(env:Env){
  await ensureShiireVendingSchema(env);
  const now=Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE shiire_vending_orders SET status='expired',updated_at=? WHERE id IN (SELECT id FROM shiire_vending_orders WHERE status='awaiting_payment' AND reserved_until IS NOT NULL AND reserved_until<? ORDER BY reserved_until ASC LIMIT 50) AND status='awaiting_payment'").bind(now,now),
    env.DB.prepare("UPDATE purchased_accounts SET status='READY_FOR_DELIVERY' WHERE status='VENDING_RESERVED' AND id IN (SELECT r.account_id FROM shiire_vending_reservations r JOIN shiire_vending_orders o ON o.id=r.order_id WHERE o.status='expired')"),
    env.DB.prepare("DELETE FROM shiire_vending_reservations WHERE order_id IN (SELECT id FROM shiire_vending_orders WHERE status='expired')")
  ]);

  const abandoned=(await env.DB.prepare(
    "SELECT id FROM shiire_vending_orders WHERE status IN ('reserving','failed') AND updated_at<? ORDER BY updated_at ASC LIMIT 50"
  ).bind(now-5*60_000).all<{id:string}>()).results;
  for(const row of abandoned){
    const failed=await env.DB.prepare(
      "UPDATE shiire_vending_orders SET status='failed',updated_at=? WHERE id=? AND status IN ('reserving','failed') AND updated_at<?"
    ).bind(now,row.id,now-5*60_000).run();
    if(Number(failed.meta.changes??0)===1) await releaseShiireOrder(env,row.id);
  }

  // Never auto-reset a stale delivering order to paid. A Discord DM may already
  // have been accepted while the following D1 write failed; automatically
  // returning to paid could resend sensitive account credentials.
  
}

export async function listPendingShiirePayments(env:Env,limit=8){
  await ensureShiireVendingSchema(env);
  const safe=Math.max(1,Math.min(20,Math.floor(limit)));
  return (await env.DB.prepare(
    "SELECT * FROM shiire_vending_orders WHERE status='payment_pending' AND payment_link_ciphertext IS NOT NULL ORDER BY updated_at ASC LIMIT ?"
  ).bind(safe).all<ShiireVendingOrder>()).results;
}

export async function listShiireOrders(env:Env,guildId:string,limit=100){
  await ensureShiireVendingSchema(env);
  const safe=Math.max(1,Math.min(500,Math.floor(limit)));
  return (await env.DB.prepare(
    "SELECT * FROM shiire_vending_orders WHERE guild_id=? ORDER BY created_at DESC LIMIT ?"
  ).bind(guildId,safe).all<ShiireVendingOrder>()).results;
}

export async function saveShiirePanel(
  env:Env,
  machineId:string,
  guildId:string,
  channelId:string,
  messageId:string
){
  await ensureShiireVendingSchema(env);
  const now=Date.now();
  await env.DB.prepare(
    "INSERT INTO shiire_vending_panels(vending_machine_id,guild_id,channel_id,message_id,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(vending_machine_id,channel_id,message_id) DO UPDATE SET updated_at=excluded.updated_at"
  ).bind(machineId,guildId,channelId,messageId,now,now).run();
}

export async function listShiirePanels(env:Env,machineId:string){
  await ensureShiireVendingSchema(env);
  return (await env.DB.prepare(
    "SELECT vending_machine_id,guild_id,channel_id,message_id,created_at,updated_at "+
    "FROM shiire_vending_panels WHERE vending_machine_id=? ORDER BY created_at ASC"
  ).bind(machineId).all<{
    vending_machine_id:string;
    guild_id:string;
    channel_id:string;
    message_id:string;
    created_at:number;
    updated_at:number;
  }>()).results;
}

export async function deleteShiirePanelRecord(
  env:Env,
  machineId:string,
  channelId:string,
  messageId:string
){
  await ensureShiireVendingSchema(env);
  const result=await env.DB.prepare(
    "DELETE FROM shiire_vending_panels "+
    "WHERE vending_machine_id=? AND channel_id=? AND message_id=?"
  ).bind(machineId,channelId,messageId).run();
  return Number(result.meta.changes??0)>0;
}

export async function machinesForSupplierProduct(env:Env,supplierProductId:string){
  await ensureShiireVendingSchema(env);

  return (await env.DB.prepare(
    "SELECT p.id AS product_id,p.name AS product_name,p.procurement_class,m.* "+
    "FROM shiire_vending_products p "+
    "JOIN shiire_vending_machines m ON m.id=p.vending_machine_id "+
    "WHERE p.active=1 AND m.active=1 AND ("+
    "p.supplier_product_id=? OR p.procurement_class IN ("+
      "SELECT DISTINCT procurement_class FROM purchased_accounts "+
      "WHERE supplier_product_id=? "+
      "AND procurement_class IN ('TOP_SEARCH','NO_SHADOWBAN')"+
    ")"+
    ")"
  ).bind(
    supplierProductId,
    supplierProductId
  ).all<any>()).results;
}
