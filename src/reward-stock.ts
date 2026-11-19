import type { Env } from "./types";
import { ensureXSchema, getXSetting, setXSetting } from "./x-db";
import { hmacHex, randomId } from "./crypto";
import { encryptSensitive } from "./x-crypto";
import { getMainCatalog, getMainStock, withdrawFromMain } from "./main-bot";
import {
  getShiireMachine,
  getShiireProduct,
  type ShiireVendingProduct
} from "./shiire-vending-db";

// Where the affiliate rewards (invite campaign and free giveaway) take their
// accounts from.
//
//  - "product": the same stock as one vending-machine product. A reward and a
//    sale of that product draw from one shared pool, so nothing has to be
//    topped up twice.
//  - "xaccount": one Xaccount-Bot vending product. Accounts are withdrawn from
//    that product's stock one at a time when a reward is delivered (the
//    Discord-Shiire vending machine is being retired).
//  - "dedicated": the legacy separate pool (procurement_class INVITE_CAMPAIGN /
//    FREE_GIVEAWAY). Used until a product is chosen, so stock that already sits
//    in those pools is not stranded.

export type RewardKind="invite"|"giveaway";

const SETTING_KEYS:Record<RewardKind,string>={
  invite:"invite_reward_product_id",
  giveaway:"giveaway_reward_product_id"
};
const XACCOUNT_KEYS:Record<RewardKind,string>={
  invite:"invite_reward_xaccount_product_id",
  giveaway:"giveaway_reward_xaccount_product_id"
};
// Withdrawn accounts that are not delivered yet (e.g. the DM failed) wait here,
// filed under this supplier_product_id, and are used before withdrawing again.
export function xaccountBucket(productId:string){ return "xaccount:"+productId; }
const DEDICATED_CLASS:Record<RewardKind,string>={
  invite:"INVITE_CAMPAIGN",
  giveaway:"FREE_GIVEAWAY"
};
// Dedicated pools never count towards a plain (non-class) product's stock.
const DEDICATED_CLASSES_SQL="('INVITE_CAMPAIGN','FREE_GIVEAWAY')";

export type RewardSource={
  kind:RewardKind;
  mode:"dedicated"|"product"|"xaccount";
  productId:string|null;
  productName:string|null;
  machineName:string|null;
  // The chosen product was deleted or switched off: no stock until re-chosen.
  unavailable:boolean;
  // SQL condition over purchased_accounts (status is added by the caller).
  where:string;
  binds:string[];
  // Where a newly generated account should be filed to land in this source.
  // Set only when mode==="product" and the product still exists.
  fillSupplierProductId:string|null;
  fillProcurementClass:"TOP_SEARCH"|"NO_SHADOWBAN"|"INVITE_CAMPAIGN"|"FREE_GIVEAWAY"|null;
};

export function productStockCondition(
  product:Pick<ShiireVendingProduct,"supplier_product_id"|"procurement_class">
):{where:string;binds:string[]}{
  if(product.procurement_class){
    return {where:"procurement_class=?",binds:[product.procurement_class]};
  }
  return {
    where:"supplier_product_id=? AND COALESCE(procurement_class,'') NOT IN "+DEDICATED_CLASSES_SQL,
    binds:[product.supplier_product_id]
  };
}

export async function getRewardProductId(env:Env,kind:RewardKind):Promise<string|null>{
  const value=await getXSetting<string>(env,SETTING_KEYS[kind]);
  return typeof value==="string"&&value?value:null;
}

// productId=null goes back to the dedicated pool. Otherwise productId is an
// Xaccount-Bot product of this guild (the legacy Shiire-product choice is cleared).
export async function setRewardProductId(
  env:Env,
  kind:RewardKind,
  productId:string|null,
  guildId:string
):Promise<void>{
  if(productId===null){
    await setXSetting(env,XACCOUNT_KEYS[kind],null);
    await setXSetting(env,SETTING_KEYS[kind],null);
    return;
  }
  const catalog=await getMainCatalog(env);
  const product=catalog.products.find(row=>row.product_id===productId);
  if(!product||product.guild_id!==guildId) throw new Error("REWARD_PRODUCT_NOT_FOUND");
  await setXSetting(env,XACCOUNT_KEYS[kind],productId);
  await setXSetting(env,SETTING_KEYS[kind],null);
}

export async function resolveRewardSource(env:Env,kind:RewardKind):Promise<RewardSource>{
  const xaccountProductId=await getXSetting<string>(env,XACCOUNT_KEYS[kind]);
  if(typeof xaccountProductId==="string"&&xaccountProductId){
    return {
      kind,mode:"xaccount",productId:xaccountProductId,productName:null,machineName:null,
      unavailable:false,
      where:"supplier_product_id=? AND COALESCE(procurement_class,'') NOT IN "+DEDICATED_CLASSES_SQL,
      binds:[xaccountBucket(xaccountProductId)],
      fillSupplierProductId:null,fillProcurementClass:null
    };
  }
  const productId=await getRewardProductId(env,kind);
  if(!productId){
    return {
      kind,mode:"dedicated",productId:null,productName:null,machineName:null,
      unavailable:false,where:"procurement_class=?",binds:[DEDICATED_CLASS[kind]],
      fillSupplierProductId:"generator",fillProcurementClass:DEDICATED_CLASS[kind] as "INVITE_CAMPAIGN"|"FREE_GIVEAWAY"
    };
  }
  const product=await getShiireProduct(env,productId);
  const machine=product?await getShiireMachine(env,product.vending_machine_id):null;
  if(!product||!machine){
    return {
      kind,mode:"product",productId,productName:null,machineName:null,
      unavailable:true,where:"0=1",binds:[],
      fillSupplierProductId:null,fillProcurementClass:null
    };
  }
  return {
    kind,mode:"product",productId,productName:product.name,machineName:machine.name,
    unavailable:false,...productStockCondition(product),
    fillSupplierProductId:product.supplier_product_id,
    fillProcurementClass:validFillClass(product.procurement_class)
  };
}

function validFillClass(
  value:string|null
):"TOP_SEARCH"|"NO_SHADOWBAN"|"INVITE_CAMPAIGN"|"FREE_GIVEAWAY"|null{
  return value==="TOP_SEARCH"||value==="NO_SHADOWBAN"||value==="INVITE_CAMPAIGN"||value==="FREE_GIVEAWAY"
    ?value
    :null;
}

async function localRewardStock(env:Env,source:RewardSource):Promise<number>{
  if(source.unavailable) return 0;
  await ensureXSchema(env);
  const row=await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM purchased_accounts WHERE "+source.where+
    " AND status='READY_FOR_DELIVERY'"
  ).bind(...source.binds).first<{count:number}>();
  return Math.max(0,Number(row?.count??0));
}

/** For display. In xaccount mode a failed lookup shows only what waits here. */
export async function rewardStockCount(env:Env,source:RewardSource):Promise<number>{
  const local=await localRewardStock(env,source);
  if(source.mode!=="xaccount"||!source.productId) return local;
  try{return local+Number((await getMainStock(env,source.productId)).available??0);}
  catch{return local;}
}

export async function describeRewardSource(env:Env,kind:RewardKind){
  const source=await resolveRewardSource(env,kind);
  let productName=source.productName;
  let machineName=source.machineName;
  let unavailable=source.unavailable;
  if(source.mode==="xaccount"&&source.productId){
    try{
      const product=(await getMainCatalog(env)).products.find(row=>row.product_id===source.productId);
      productName=product?.product_name??null;
      machineName=product?.vending_machine_name??null;
      unavailable=!product;
    }catch{ /* catalog down: names unknown, stock below falls back to local */ }
  }
  return {
    mode:source.mode,
    productId:source.productId,
    productName,
    machineName,
    unavailable,
    stockCount:await rewardStockCount(env,source)
  };
}

const WITHDRAW_SCHEMA=`CREATE TABLE IF NOT EXISTS reward_withdrawals (
  idempotency_key TEXT PRIMARY KEY,
  reward_kind TEXT NOT NULL,
  reward_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
)`;

/**
 * xaccount mode: make sure one account waits locally for this reward, taking
 * it from the Xaccount-Bot product if none does. The withdrawal is recorded
 * before the request, so a crash or lost response is retried with the same
 * key and never takes a second account. Returns false when the product has
 * no stock or the bridge is unreachable (the reward then waits for stock).
 */
export async function ensureXaccountRewardStock(
  env:Env,
  source:RewardSource,
  rewardId:string
):Promise<boolean>{
  if(source.mode!=="xaccount"||!source.productId) return true;
  if(await localRewardStock(env,source)>0) return true;
  await env.DB.prepare(WITHDRAW_SCHEMA).run();
  const pending=await env.DB.prepare(
    "SELECT idempotency_key,product_id FROM reward_withdrawals WHERE reward_kind=? AND reward_id=? AND completed_at IS NULL ORDER BY created_at ASC LIMIT 1"
  ).bind(source.kind,rewardId).first<{idempotency_key:string;product_id:string}>();
  const key=pending?.idempotency_key??("reward:"+source.kind+":"+rewardId+":"+randomId()).slice(0,150);
  const productId=pending?.product_id??source.productId;
  if(!pending){
    await env.DB.prepare(
      "INSERT INTO reward_withdrawals(idempotency_key,reward_kind,reward_id,product_id,created_at) VALUES (?,?,?,?,?)"
    ).bind(key,source.kind,rewardId,productId,Date.now()).run();
  }
  let items:string[];
  try{
    items=(await withdrawFromMain(env,{mainProductId:productId,quantity:1,idempotencyKey:key})).items??[];
  }catch(error){
    console.error("reward withdraw failed",source.kind,rewardId,error instanceof Error?error.message:error);
    return false;
  }
  const secret=env.CREDENTIALS_ENCRYPTION_KEY?.trim()??"";
  if(!secret) throw new Error("CREDENTIALS_ENCRYPTION_KEY_NOT_CONFIGURED");
  const now=Date.now();
  // Own fingerprint namespace: the same text may already exist here (e.g. an
  // HSTORA account that was moved to Xaccount-Bot); it must not be dropped.
  for(const [index,raw] of items.entries()){
    const fingerprint=await hmacHex(secret,"xaccount-withdraw\n"+key+"\n"+index);
    await env.DB.prepare(`INSERT OR IGNORE INTO purchased_accounts(
      id,supplier,supplier_product_id,purchase_order_id,purchase_price,purchased_at,
      credentials_ciphertext,email_ciphertext,two_factor_ciphertext,credential_fingerprint,procurement_class,status,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      randomId(),"xaccount",xaccountBucket(productId),key,0,now,
      JSON.stringify(await encryptSensitive(env,raw)),null,null,fingerprint,null,"READY_FOR_DELIVERY",now
    ).run();
  }
  await env.DB.prepare("UPDATE reward_withdrawals SET completed_at=? WHERE idempotency_key=?").bind(now,key).run();
  // A replayed key returns items that are already here (and maybe already
  // delivered), so success means "something waits locally now".
  return await localRewardStock(env,source)>0;
}

// Xaccount-Bot products of this guild, for the reward-product picker.
export async function listRewardCandidateProducts(env:Env,guildId:string){
  const catalog=await getMainCatalog(env);
  return catalog.products.filter(row=>row.guild_id===guildId).map(row=>({
    id:row.product_id,
    name:row.product_name,
    machineId:row.vending_machine_id,
    machineName:row.vending_machine_name,
    procurementClass:null as string|null,
    stockCount:Number(row.available)
  }));
}
