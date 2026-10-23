import type { Env } from "./types";
import { ensureXSchema, getXSetting, setXSetting } from "./x-db";
import {
  getShiireMachine,
  getShiireProduct,
  listShiireMachines,
  listShiireProducts,
  type ShiireVendingProduct
} from "./shiire-vending-db";

// Where the affiliate rewards (invite campaign and free giveaway) take their
// accounts from.
//
//  - "product": the same stock as one vending-machine product. A reward and a
//    sale of that product draw from one shared pool, so nothing has to be
//    topped up twice.
//  - "dedicated": the legacy separate pool (procurement_class INVITE_CAMPAIGN /
//    FREE_GIVEAWAY). Used until a product is chosen, so stock that already sits
//    in those pools is not stranded.

export type RewardKind="invite"|"giveaway";

const SETTING_KEYS:Record<RewardKind,string>={
  invite:"invite_reward_product_id",
  giveaway:"giveaway_reward_product_id"
};
const DEDICATED_CLASS:Record<RewardKind,string>={
  invite:"INVITE_CAMPAIGN",
  giveaway:"FREE_GIVEAWAY"
};
// Dedicated pools never count towards a plain (non-class) product's stock.
const DEDICATED_CLASSES_SQL="('INVITE_CAMPAIGN','FREE_GIVEAWAY')";

export type RewardSource={
  kind:RewardKind;
  mode:"dedicated"|"product";
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

// productId=null goes back to the dedicated pool.
export async function setRewardProductId(
  env:Env,
  kind:RewardKind,
  productId:string|null,
  guildId:string
):Promise<void>{
  if(productId===null){
    await setXSetting(env,SETTING_KEYS[kind],null);
    return;
  }
  const product=await getShiireProduct(env,productId);
  const machine=product?await getShiireMachine(env,product.vending_machine_id):null;
  if(!product||!machine||machine.guild_id!==guildId){
    throw new Error("REWARD_PRODUCT_NOT_FOUND");
  }
  await setXSetting(env,SETTING_KEYS[kind],productId);
}

export async function resolveRewardSource(env:Env,kind:RewardKind):Promise<RewardSource>{
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

export async function rewardStockCount(env:Env,source:RewardSource):Promise<number>{
  if(source.unavailable) return 0;
  await ensureXSchema(env);
  const row=await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM purchased_accounts WHERE "+source.where+
    " AND status='READY_FOR_DELIVERY'"
  ).bind(...source.binds).first<{count:number}>();
  return Math.max(0,Number(row?.count??0));
}

export async function describeRewardSource(env:Env,kind:RewardKind){
  const source=await resolveRewardSource(env,kind);
  return {
    mode:source.mode,
    productId:source.productId,
    productName:source.productName,
    machineName:source.machineName,
    unavailable:source.unavailable,
    stockCount:await rewardStockCount(env,source)
  };
}

// Products of every machine in the guild, for the reward-product picker.
export async function listRewardCandidateProducts(env:Env,guildId:string){
  const machines=await listShiireMachines(env,guildId);
  const out:Array<{
    id:string;name:string;machineId:string;machineName:string;
    procurementClass:string|null;stockCount:number;
  }>=[];
  for(const machine of machines){
    for(const product of await listShiireProducts(env,machine.id)){
      out.push({
        id:product.id,
        name:product.name,
        machineId:machine.id,
        machineName:machine.name,
        procurementClass:product.procurement_class,
        stockCount:product.stock_count
      });
    }
  }
  return out;
}
