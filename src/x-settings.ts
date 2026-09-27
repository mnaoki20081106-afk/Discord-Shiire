import type { Env } from "./types";
import { getXSetting, setXSetting } from "./x-db";

export type XSettings={
  dry_run:boolean;
  emergency_stop:boolean;
  auto_purchase_enabled:boolean;
  auto_procurement_enabled:boolean;

  reserve_jpy:number;
  max_purchase_jpy:number;
  daily_purchase_limit_jpy:number;
  weekly_purchase_limit_jpy:number;
  monthly_purchase_limit_jpy:number;
  min_purchase_jpy:number;

  target_ltc_balance:number;
  max_ltc_balance:number;
  wallet_target_ltc:number;
  wallet_max_ltc:number;

  max_unit_price_jpy:number;
  reorder_point:number;
  target_stock:number;
  max_batch_purchase:number;

  min_seller_rating:number;
  min_product_reviews:number;
  min_sales_count:number;
  max_dispute_rate:number;
  minimum_stock:number;
  trial_purchase_count:number;
  seller_quality_mode:"strict_api"|"manual_product_approval";
  approved_hstora_product_ids:number[];

  observed_paypay_balance_jpy:number;
  observed_paypay_balance_at:number;
  max_paypay_balance_age_ms:number;
  usd_jpy_rate:number;
  usd_jpy_rate_updated_at:number;
  max_fx_age_ms:number;
  max_paypay_observation_age_ms:number;

  auto_ltc_withdraw_enabled:boolean;
  max_single_withdraw_ltc:number;

  max_price_jump_percent:number;
  max_ltc_price_jump_percent:number;
  max_consecutive_failures:number;

  require_bulk_confirmation:boolean;
  bulk_confirmation_threshold:number;
  bulk_approval_until:number;

  hstora_ltc_deposit_address:string;
  hstora_ltc_network:string;
};

export const DEFAULT_X_SETTINGS:XSettings={
  dry_run:true,
  emergency_stop:false,
  auto_purchase_enabled:false,
  auto_procurement_enabled:false,

  reserve_jpy:0,
  max_purchase_jpy:0,
  daily_purchase_limit_jpy:0,
  weekly_purchase_limit_jpy:0,
  monthly_purchase_limit_jpy:0,
  min_purchase_jpy:0,

  target_ltc_balance:0,
  max_ltc_balance:0,
  wallet_target_ltc:0,
  wallet_max_ltc:0,

  max_unit_price_jpy:100,
  reorder_point:10,
  target_stock:50,
  max_batch_purchase:20,

  min_seller_rating:0,
  min_product_reviews:0,
  min_sales_count:0,
  max_dispute_rate:0,
  minimum_stock:1,
  trial_purchase_count:10,
  seller_quality_mode:"strict_api",
  approved_hstora_product_ids:[],

  observed_paypay_balance_jpy:0,
  observed_paypay_balance_at:0,
  max_paypay_balance_age_ms:24*60*60*1000,
  usd_jpy_rate:0,
  usd_jpy_rate_updated_at:0,
  max_fx_age_ms:6*60*60*1000,
  max_paypay_observation_age_ms:60*60*1000,

  auto_ltc_withdraw_enabled:false,
  max_single_withdraw_ltc:0,

  max_price_jump_percent:25,
  max_ltc_price_jump_percent:15,
  max_consecutive_failures:3,

  require_bulk_confirmation:true,
  bulk_confirmation_threshold:20,
  bulk_approval_until:0,

  hstora_ltc_deposit_address:"",
  hstora_ltc_network:"LTC"
};

export async function loadXSettings(env:Env):Promise<XSettings>{
  const stored=await getXSetting<Partial<XSettings>>(env,"x_procurement");
  return {...DEFAULT_X_SETTINGS,...(stored??{})};
}

export async function saveXSettings(env:Env,patch:Partial<XSettings>):Promise<XSettings>{
  const current=await loadXSettings(env);
  const next={...current,...patch};
  if(next.target_stock<next.reorder_point) throw new Error("TARGET_STOCK_BELOW_REORDER_POINT");
  if(next.max_batch_purchase<1) throw new Error("MAX_BATCH_PURCHASE_INVALID");
  if(next.reserve_jpy<0||next.max_purchase_jpy<0) throw new Error("FUNDING_LIMIT_INVALID");
  if(next.max_unit_price_jpy<=0) throw new Error("MAX_UNIT_PRICE_INVALID");
  if(next.bulk_confirmation_threshold<1) throw new Error("BULK_CONFIRMATION_THRESHOLD_INVALID");
  if(next.max_paypay_balance_age_ms<60_000) throw new Error("PAYPAY_BALANCE_AGE_INVALID");
  if(next.max_fx_age_ms<60_000) throw new Error("FX_AGE_INVALID");
  if(next.max_ltc_balance<0||next.target_ltc_balance<0||next.target_ltc_balance>next.max_ltc_balance){
    throw new Error("LTC_BALANCE_LIMIT_INVALID");
  }
  if(next.wallet_target_ltc<0||next.wallet_max_ltc<0||next.wallet_target_ltc>next.wallet_max_ltc){
    throw new Error("WALLET_BALANCE_LIMIT_INVALID");
  }
  if(next.max_single_withdraw_ltc<0) throw new Error("MAX_SINGLE_WITHDRAW_INVALID");
  if(next.max_paypay_observation_age_ms<60_000) throw new Error("PAYPAY_OBSERVATION_AGE_INVALID");
  next.approved_hstora_product_ids=[...new Set(
    (next.approved_hstora_product_ids??[])
      .map(Number)
      .filter(v=>Number.isInteger(v)&&v>0)
  )];
  await setXSetting(env,"x_procurement",next);
  return next;
}
