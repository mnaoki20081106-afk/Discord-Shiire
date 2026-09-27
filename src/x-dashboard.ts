import type { Env } from "./types";
import { loadXSettings } from "./x-settings";
import {
  fundingSpendSince,
  inventorySummary,
  listAuditLogs,
  listOpenCircuitBreakers,
  listPurchaseOrders,
  todayPurchaseStats
} from "./x-db";
import { binanceBalance, binanceLtcJpyPrice, assertLtcJpyTradable, binanceLtcNetwork } from "./x-binance";
import { hstoraBalance } from "./x-hstora";
import { calculateFundingAllowance } from "./x-risk";

function jstStarts(now=Date.now()){
  const offset=9*60*60*1000;
  const local=new Date(now+offset);
  const y=local.getUTCFullYear(),m=local.getUTCMonth(),d=local.getUTCDate();
  const dayStart=Date.UTC(y,m,d)-offset;
  const dow=local.getUTCDay();
  const weekStart=Date.UTC(y,m,d-((dow+6)%7))-offset;
  const monthStart=Date.UTC(y,m,1)-offset;
  return {dayStart,weekStart,monthStart};
}

async function attempt<T>(fn:()=>Promise<T>){
  try{return {ok:true as const,data:await fn()};}
  catch(error){return {ok:false as const,error:error instanceof Error?error.message:String(error)};}
}

export async function xDashboard(env:Env){
  const settings=await loadXSettings(env);
  const {dayStart,weekStart,monthStart}=jstStarts();
  const [
    ltc,
    jpy,
    price,
    hstora,
    inventory,
    today,
    daySpend,
    weekSpend,
    monthSpend,
    errors,
    breakers
  ]=await Promise.all([
    attempt(()=>binanceBalance(env,"LTC")),
    attempt(()=>binanceBalance(env,"JPY")),
    attempt(()=>binanceLtcJpyPrice()),
    attempt(()=>hstoraBalance(env)),
    inventorySummary(env),
    todayPurchaseStats(env,dayStart),
    fundingSpendSince(env,dayStart),
    fundingSpendSince(env,weekStart),
    fundingSpendSince(env,monthStart),
    listAuditLogs(env,20),
    listOpenCircuitBreakers(env)
  ]);

  let paypayAllowance:null|ReturnType<typeof calculateFundingAllowance>=null;
  if(price.ok){
    paypayAllowance=calculateFundingAllowance({
      reserveJpy:settings.reserve_jpy,
      maxPurchaseJpy:settings.max_purchase_jpy,
      dailyRemainingJpy:Math.max(0,settings.daily_purchase_limit_jpy-daySpend),
      weeklyRemainingJpy:Math.max(0,settings.weekly_purchase_limit_jpy-weekSpend),
      monthlyRemainingJpy:Math.max(0,settings.monthly_purchase_limit_jpy-monthSpend),
      minPurchaseJpy:settings.min_purchase_jpy,
      paypayBalanceJpy:settings.observed_paypay_balance_jpy,
      currentLtc:ltc.ok?ltc.data.free:0,
      targetLtcBalance:settings.target_ltc_balance,
      maxLtcBalance:settings.max_ltc_balance,
      ltcJpy:price.data
    });
  }

  return {
    safety:{
      dryRun:settings.dry_run,
      emergencyStop:settings.emergency_stop,
      autoPurchase:settings.auto_purchase_enabled,
      autoProcurement:settings.auto_procurement_enabled,
      openCircuitBreakers:breakers
    },
    paypay:{
      observedBalanceJpy:settings.observed_paypay_balance_jpy,
      observedAt:settings.observed_paypay_balance_at,
      observationFresh:settings.observed_paypay_balance_at>0&&
        Date.now()-settings.observed_paypay_balance_at<=settings.max_paypay_observation_age_ms,
      usableJpy:paypayAllowance?.allowedJpy??0,
      allowance:paypayAllowance
    },
    binance:{
      ltcBalance:ltc,
      jpyBalance:jpy,
      ltcJpyPrice:price
    },
    hstora,
    inventory,
    today:{
      procuredCount:today.count,
      procuredAmount:today.amount,
      averageUnitPrice:today.average,
      ltcPurchaseJpy:daySpend
    },
    recentErrors:(errors as any[]).filter(row=>String(row.level)==="error").slice(0,10)
  };
}

export async function xBinanceStatus(env:Env){
  const [tradable,ltc,jpy,network]=await Promise.all([
    attempt(()=>assertLtcJpyTradable()),
    attempt(()=>binanceBalance(env,"LTC")),
    attempt(()=>binanceBalance(env,"JPY")),
    attempt(()=>binanceLtcNetwork(env,"LTC"))
  ]);
  return {tradable,ltc,jpy,network};
}

export async function xOrders(env:Env){return listPurchaseOrders(env,200);}
