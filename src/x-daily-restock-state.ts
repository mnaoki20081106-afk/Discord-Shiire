import type { Env } from "./types";
import { getXSetting, setXSetting } from "./x-db";
import { jstDateKey } from "./x-daily-restock-policy";
export { jstDateKey } from "./x-daily-restock-policy";

export const DAILY_RESTOCK_CONFIG_KEY="x_daily_restock_config";
export const DAILY_RESTOCK_STATE_KEY="x_daily_restock_state";

export type DailyRestockStatus=
  |"running"
  |"completed"
  |"partial"
  |"failed";

export type DailyRestockConfig={
  enabled:boolean;
  top_search_target_stock:number;
  no_shadowban_target_stock:number;
  notification_channel_id:string;
  notification_message:string;
  panel_channel_id:string;
  panel_message_id:string;
};

export type DailyRestockState={
  date_key:string;
  status:DailyRestockStatus;
  started_at:number;
  completed_at:number;
  notified_at:number;
  notification_skipped_reason?:string;
  initial_top_search:number;
  initial_no_shadowban:number;
  target_top_search:number;
  target_no_shadowban:number;
  final_top_search:number;
  final_no_shadowban:number;
  added_top_search:number;
  added_no_shadowban:number;
  last_action:string;
  error:string;
};

export const DEFAULT_DAILY_RESTOCK_CONFIG:DailyRestockConfig={
  enabled:true,
  top_search_target_stock:50,
  no_shadowban_target_stock:50,
  notification_channel_id:"",
  notification_message:"本日の在庫を入荷しました！",
  panel_channel_id:"",
  panel_message_id:""
};

function safeNonNegativeInt(value:unknown,fallback:number){
  const n=Number(value);
  return Number.isSafeInteger(n)&&n>=0?n:fallback;
}

function safeSnowflake(value:unknown){
  const text=String(value??"").trim();
  return /^\d{15,22}$/.test(text)?text:"";
}

export function sanitizeDailyRestockConfig(
  value:unknown,
  fallback:DailyRestockConfig=DEFAULT_DAILY_RESTOCK_CONFIG
):DailyRestockConfig{
  if(!value||typeof value!=="object"||Array.isArray(value)) return {...fallback};
  const input=value as Record<string,unknown>;
  return {
    enabled:
      typeof input.enabled==="boolean"
        ?input.enabled
        :fallback.enabled,
    top_search_target_stock:safeNonNegativeInt(
      input.top_search_target_stock,
      fallback.top_search_target_stock
    ),
    no_shadowban_target_stock:safeNonNegativeInt(
      input.no_shadowban_target_stock,
      fallback.no_shadowban_target_stock
    ),
    notification_channel_id:safeSnowflake(
      input.notification_channel_id
    ),
    notification_message:String(
      input.notification_message??fallback.notification_message
    ).trim().slice(0,2000),
    panel_channel_id:safeSnowflake(input.panel_channel_id),
    panel_message_id:safeSnowflake(input.panel_message_id)
  };
}

export async function loadDailyRestockConfig(
  env:Env,
  fallback?:Partial<Pick<
    DailyRestockConfig,
    "top_search_target_stock"|"no_shadowban_target_stock"
  >>
):Promise<DailyRestockConfig>{
  const base={
    ...DEFAULT_DAILY_RESTOCK_CONFIG,
    ...fallback
  };
  return sanitizeDailyRestockConfig(
    await getXSetting<unknown>(env,DAILY_RESTOCK_CONFIG_KEY),
    base
  );
}

export async function saveDailyRestockConfig(
  env:Env,
  patch:Partial<DailyRestockConfig>,
  fallback?:Partial<Pick<
    DailyRestockConfig,
    "top_search_target_stock"|"no_shadowban_target_stock"
  >>
):Promise<DailyRestockConfig>{
  const current=await loadDailyRestockConfig(env,fallback);
  const next=sanitizeDailyRestockConfig({...current,...patch},current);
  if(next.top_search_target_stock>10000||next.no_shadowban_target_stock>10000){
    throw new Error("DAILY_RESTOCK_TARGET_OUT_OF_RANGE");
  }
  if(!next.notification_message){
    throw new Error("DAILY_RESTOCK_MESSAGE_REQUIRED");
  }
  await setXSetting(env,DAILY_RESTOCK_CONFIG_KEY,next);
  return next;
}

export async function loadDailyRestockState(env:Env){
  return getXSetting<DailyRestockState>(env,DAILY_RESTOCK_STATE_KEY);
}

export async function saveDailyRestockState(
  env:Env,
  state:DailyRestockState
){
  await setXSetting(env,DAILY_RESTOCK_STATE_KEY,state);
}

export async function isDailyRestockBatchActive(env:Env){
  const state=await loadDailyRestockState(env);
  return state?.status==="running";
}
