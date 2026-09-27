import type { Env } from "./types";
import { randomId } from "./crypto";
import { encryptSensitive, decryptSensitive, type EncryptedSecret } from "./x-crypto";
import { ensureXSchema } from "./x-db";

export type ShiireVendingMachine={
  id:string;
  guild_id:string;
  name:string;
  public_log_channel_id:string|null;
  private_log_channel_id:string|null;
  role_id:string|null;
  panel_title:string|null;
  panel_description:string|null;
  active:number;
  created_at:number;
  updated_at:number;
};

export type ShiireVendingProduct={
  id:string;
  vending_machine_id:string;
  supplier_product_id:string;
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
};

let ready=false;

const SCHEMA=[
  "CREATE TABLE IF NOT EXISTS shiire_vending_machines (id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,name TEXT NOT NULL,public_log_channel_id TEXT,private_log_channel_id TEXT,role_id TEXT,panel_title TEXT,panel_description TEXT,active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS shiire_vending_machines_guild_idx ON shiire_vending_machines(guild_id,active)",
  "CREATE TABLE IF NOT EXISTS shiire_vending_products (id TEXT PRIMARY KEY,vending_machine_id TEXT NOT NULL,supplier_product_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',price_paypay INTEGER NOT NULL DEFAULT 0,price_kyash INTEGER NOT NULL DEFAULT 0,emoji TEXT,sales_count INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS shiire_vending_products_vm_idx ON shiire_vending_products(vending_machine_id,active)",
  "CREATE INDEX IF NOT EXISTS shiire_vending_products_supplier_idx ON shiire_vending_products(supplier_product_id,active)",
  "CREATE TABLE IF NOT EXISTS shiire_vending_coupons (code TEXT NOT NULL,vending_machine_id TEXT NOT NULL,discount INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,PRIMARY KEY(vending_machine_id,code))",
  "CREATE TABLE IF NOT EXISTS shiire_vending_stock_notifications (vending_machine_id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,role_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS shiire_vending_orders (id TEXT PRIMARY KEY,vending_machine_id TEXT NOT NULL,product_id TEXT NOT NULL,guild_id TEXT NOT NULL,user_id TEXT NOT NULL,payment_method TEXT NOT NULL,quantity INTEGER NOT NULL,unit_price INTEGER NOT NULL,discount_each INTEGER NOT NULL DEFAULT 0,total_amount INTEGER NOT NULL,status TEXT NOT NULL,payment_link_ciphertext TEXT,reserved_until INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,paid_at INTEGER,delivered_at INTEGER)",
  "CREATE INDEX IF NOT EXISTS shiire_vending_orders_status_idx ON shiire_vending_orders(status,reserved_until,created_at)",
  "CREATE TABLE IF NOT EXISTS shiire_vending_reservations (account_id TEXT PRIMARY KEY,order_id TEXT NOT NULL,product_id TEXT NOT NULL,reserved_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS shiire_vending_reservations_order_idx ON shiire_vending_reservations(order_id)",
  "CREATE TABLE IF NOT EXISTS shiire_vending_panels (vending_machine_id TEXT NOT NULL,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,message_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(vending_machine_id,channel_id,message_id))"
];

export async function ensureShiireVendingSchema(env:Env){
  if(ready) return;
  await ensureXSchema(env);
  for(const sql of SCHEMA) await env.DB.prepare(sql).run();
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
  }>
){
  const current=await getShiireMachine(env,id);
  if(!current) return false;
  const result=await env.DB.prepare(
    "UPDATE shiire_vending_machines SET name=?,public_log_channel_id=?,private_log_channel_id=?,role_id=?,panel_title=?,panel_description=?,updated_at=? WHERE id=? AND active=1"
  ).bind(
    input.name??current.name,
    input.publicLogChannelId===undefined?current.public_log_channel_id:input.publicLogChannelId,
    input.privateLogChannelId===undefined?current.private_log_channel_id:input.privateLogChannelId,
    input.roleId===undefined?current.role_id:input.roleId,
    input.panelTitle===undefined?current.panel_title:input.panelTitle,
    input.panelDescription===undefined?current.panel_description:input.panelDescription,
    Date.now(),id
  ).run();
  return Number(result.meta.changes??0)>0;
}

export async function deleteShiireMachine(env:Env,id:string){
  await ensureShiireVendingSchema(env);
  const result=await env.DB.prepare(
    "UPDATE shiire_vending_machines SET active=0,updated_at=? WHERE id=? AND active=1"
  ).bind(Date.now(),id).run();
  return Number(result.meta.changes??0)>0;
}

export async function listShiireSourceProducts(env:Env){
  await ensureShiireVendingSchema(env);
  return (await env.DB.prepare(
    "SELECT supplier_product_id,title,currency,unit_price,stock_available,qualified,last_seen_at FROM supplier_products WHERE supplier='hstora' ORDER BY updated_at DESC LIMIT 500"
  ).all()).results;
}

export async function availableShiireAccounts(env:Env,supplierProductId:string):Promise<number>{
  await ensureShiireVendingSchema(env);
  const row=await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM purchased_accounts WHERE supplier_product_id=? AND status='READY_FOR_DELIVERY'"
  ).bind(supplierProductId).first<{count:number}>();
  return Math.max(0,Number(row?.count??0));
}

export async function listShiireProducts(env:Env,machineId:string){
  await ensureShiireVendingSchema(env);
  const products=(await env.DB.prepare(
    "SELECT * FROM shiire_vending_products WHERE vending_machine_id=? AND active=1 ORDER BY created_at ASC"
  ).bind(machineId).all<ShiireVendingProduct>()).results;
  return Promise.all(products.map(async product=>({
    ...product,
    stock_count:await availableShiireAccounts(env,product.supplier_product_id)
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

export async function createShiireProduct(
  env:Env,
  machineId:string,
  input:{
    supplierProductId:string;
    name:string;
    description:string;
    pricePayPay:number;
    priceKyash:number;
    emoji:string|null;
  }
){
  await ensureShiireVendingSchema(env);
  await requireSourceProduct(env,input.supplierProductId);
  const id=randomId(),now=Date.now();
  await env.DB.prepare(
    "INSERT INTO shiire_vending_products(id,vending_machine_id,supplier_product_id,name,description,price_paypay,price_kyash,emoji,sales_count,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,0,1,?,?)"
  ).bind(
    id,machineId,input.supplierProductId,input.name,input.description,
    input.pricePayPay,input.priceKyash,input.emoji,now,now
  ).run();
  return getShiireProduct(env,id);
}

export async function updateShiireProduct(
  env:Env,
  id:string,
  input:Partial<{
    supplierProductId:string;
    name:string;
    description:string;
    pricePayPay:number;
    priceKyash:number;
    emoji:string|null;
  }>
){
  const current=await getShiireProduct(env,id);
  if(!current) return false;
  if(input.supplierProductId&&input.supplierProductId!==current.supplier_product_id){
    await requireSourceProduct(env,input.supplierProductId);
  }
  const result=await env.DB.prepare(
    "UPDATE shiire_vending_products SET supplier_product_id=?,name=?,description=?,price_paypay=?,price_kyash=?,emoji=?,updated_at=? WHERE id=? AND active=1"
  ).bind(
    input.supplierProductId??current.supplier_product_id,
    input.name??current.name,
    input.description??current.description,
    input.pricePayPay??current.price_paypay,
    input.priceKyash??current.price_kyash,
    input.emoji===undefined?current.emoji:input.emoji,
    Date.now(),id
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

async function moveInventory(
  env:Env,
  supplierProductId:string,
  from:string,
  to:string|null,
  quantity:number
){
  const q=Math.max(0,Math.floor(quantity));
  if(q===0) return;
  const now=Date.now();
  const source=await env.DB.prepare(
    "UPDATE inventory SET quantity=MAX(0,quantity-?),updated_at=? WHERE supplier_product_id=? AND status=?"
  ).bind(q,now,supplierProductId,from).run();
  if(Number(source.meta.changes??0)!==1){
    throw new Error("INVENTORY_AGGREGATE_MISSING");
  }
  if(to){
    await env.DB.prepare(
      "INSERT INTO inventory(id,supplier_product_id,status,quantity,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(supplier_product_id,status) DO UPDATE SET quantity=quantity+excluded.quantity,updated_at=excluded.updated_at"
    ).bind(randomId(),supplierProductId,to,q,now).run();
  }
}

async function reserveAccounts(
  env:Env,
  orderId:string,
  product:ShiireVendingProduct,
  quantity:number
){
  const rows=(await env.DB.prepare(
    "SELECT id FROM purchased_accounts WHERE supplier_product_id=? AND status='READY_FOR_DELIVERY' ORDER BY purchased_at ASC,id ASC LIMIT ?"
  ).bind(product.supplier_product_id,quantity).all<{id:string}>()).results;
  if(rows.length<quantity) throw new Error("OUT_OF_STOCK");

  const reserved:string[]=[];
  try{
    for(const row of rows){
      const updated=await env.DB.prepare(
        "UPDATE purchased_accounts SET status='VENDING_RESERVED' WHERE id=? AND status='READY_FOR_DELIVERY'"
      ).bind(row.id).run();
      if(Number(updated.meta.changes??0)!==1) throw new Error("STOCK_RACE");
      await env.DB.prepare(
        "INSERT INTO shiire_vending_reservations(account_id,order_id,product_id,reserved_at) VALUES (?,?,?,?)"
      ).bind(row.id,orderId,product.id,Date.now()).run();
      reserved.push(row.id);
    }
    await moveInventory(env,product.supplier_product_id,"READY_FOR_DELIVERY","VENDING_RESERVED",reserved.length);
    return reserved;
  }catch(error){
    for(const accountId of reserved){
      await env.DB.prepare(
        "UPDATE purchased_accounts SET status='READY_FOR_DELIVERY' WHERE id=? AND status='VENDING_RESERVED'"
      ).bind(accountId).run().catch(()=>undefined);
      await env.DB.prepare(
        "DELETE FROM shiire_vending_reservations WHERE account_id=? AND order_id=?"
      ).bind(accountId,orderId).run().catch(()=>undefined);
    }
    if(reserved.length){
      await moveInventory(env,product.supplier_product_id,"VENDING_RESERVED","READY_FOR_DELIVERY",reserved.length).catch(()=>undefined);
    }
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
  const unit=input.method==="kyash"?input.product.price_kyash:input.product.price_paypay;
  const discount=Math.max(0,Math.floor(input.discount));
  const total=Math.max(0,(unit-discount)*quantity);
  const now=Date.now(),orderId=randomId(),until=now+10*60_000;

  await env.DB.prepare(
    "INSERT INTO shiire_vending_orders(id,vending_machine_id,product_id,guild_id,user_id,payment_method,quantity,unit_price,discount_each,total_amount,status,reserved_until,created_at,updated_at,paid_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(
    orderId,input.machine.id,input.product.id,input.guildId,input.userId,
    total===0?"free":input.method,quantity,unit,discount,total,
    "reserving",until,now,now,total===0?now:null
  ).run();

  try{
    await reserveAccounts(env,orderId,input.product,quantity);
  }catch(error){
    await env.DB.prepare(
      "UPDATE shiire_vending_orders SET status='failed',updated_at=? WHERE id=?"
    ).bind(Date.now(),orderId).run();
    throw error;
  }

  await env.DB.prepare(
    "UPDATE shiire_vending_orders SET status=?,updated_at=? WHERE id=?"
  ).bind(total===0?"paid":"awaiting_payment",Date.now(),orderId).run();
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
  await env.DB.prepare(
    "UPDATE shiire_vending_orders SET payment_link_ciphertext=?,updated_at=? WHERE id=? AND status='awaiting_payment'"
  ).bind(JSON.stringify(encrypted),Date.now(),orderId).run();
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
    "UPDATE shiire_vending_orders SET status='paid',paid_at=?,updated_at=? WHERE id=? AND status='awaiting_payment'"
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

  for(const row of rows){
    const result=await env.DB.prepare(
      "UPDATE purchased_accounts SET status='DELIVERED',delivered_at=? WHERE id=? AND status='VENDING_RESERVED'"
    ).bind(now,row.id).run();
    if(Number(result.meta.changes??0)!==1) throw new Error("DELIVERY_STATE_RACE");
  }

  await moveInventory(
    env,
    product.supplier_product_id,
    "VENDING_RESERVED",
    null,
    order.quantity
  );

  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM shiire_vending_reservations WHERE order_id=?"
    ).bind(order.id),
    env.DB.prepare(
      "UPDATE shiire_vending_orders SET status='delivered',delivered_at=?,updated_at=? WHERE id=? AND status='delivering'"
    ).bind(now,now,order.id),
    env.DB.prepare(
      "UPDATE shiire_vending_products SET sales_count=sales_count+?,updated_at=? WHERE id=?"
    ).bind(order.quantity,now,order.product_id)
  ]);
}

export async function releaseShiireOrder(env:Env,orderId:string){
  const order=await getShiireOrder(env,orderId);
  if(!order) return 0;
  const product=await getShiireProduct(env,order.product_id);
  if(!product) return 0;
  const rows=(await env.DB.prepare(
    "SELECT account_id FROM shiire_vending_reservations WHERE order_id=?"
  ).bind(orderId).all<{account_id:string}>()).results;

  let released=0;
  for(const row of rows){
    const result=await env.DB.prepare(
      "UPDATE purchased_accounts SET status='READY_FOR_DELIVERY' WHERE id=? AND status='VENDING_RESERVED'"
    ).bind(row.account_id).run();
    if(Number(result.meta.changes??0)===1) released++;
  }
  await env.DB.prepare(
    "DELETE FROM shiire_vending_reservations WHERE order_id=?"
  ).bind(orderId).run();
  if(released){
    await moveInventory(
      env,
      product.supplier_product_id,
      "VENDING_RESERVED",
      "READY_FOR_DELIVERY",
      released
    );
  }
  return released;
}

export async function cleanShiireVendingExpired(env:Env){
  await ensureShiireVendingSchema(env);
  const now=Date.now();
  const expired=(await env.DB.prepare(
    "SELECT id FROM shiire_vending_orders WHERE status='awaiting_payment' AND reserved_until IS NOT NULL AND reserved_until<? ORDER BY reserved_until ASC LIMIT 50"
  ).bind(now).all<{id:string}>()).results;
  for(const row of expired){
    await releaseShiireOrder(env,row.id);
    await env.DB.prepare(
      "UPDATE shiire_vending_orders SET status='expired',updated_at=? WHERE id=? AND status='awaiting_payment'"
    ).bind(now,row.id).run();
  }
  await env.DB.prepare(
    "UPDATE shiire_vending_orders SET status='paid',updated_at=? WHERE status='delivering' AND delivered_at IS NULL AND updated_at<?"
  ).bind(now,now-5*60_000).run();
}

export async function listPendingShiirePayments(env:Env,limit=8){
  await ensureShiireVendingSchema(env);
  const safe=Math.max(1,Math.min(20,Math.floor(limit)));
  return (await env.DB.prepare(
    "SELECT * FROM shiire_vending_orders WHERE status='awaiting_payment' AND payment_link_ciphertext IS NOT NULL ORDER BY updated_at ASC LIMIT ?"
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

export async function machinesForSupplierProduct(env:Env,supplierProductId:string){
  await ensureShiireVendingSchema(env);
  return (await env.DB.prepare(
    "SELECT p.id AS product_id,p.name AS product_name,m.* FROM shiire_vending_products p JOIN shiire_vending_machines m ON m.id=p.vending_machine_id WHERE p.supplier_product_id=? AND p.active=1 AND m.active=1"
  ).bind(supplierProductId).all<any>()).results;
}
