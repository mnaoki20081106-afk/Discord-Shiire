import type { Env } from "./types";
import { calculateFundingAllowance } from "./x-risk";
import { fundingSpendSince } from "./x-db";
import { loadXSettings } from "./x-settings";
import { getBinanceBalance, getLtcJpyMarketStatus } from "./providers/binance";

const JST_OFFSET_MS=9*60*60*1000;

function jstParts(now:number){
  const d=new Date(now+JST_OFFSET_MS);
  return {year:d.getUTCFullYear(),month:d.getUTCMonth(),date:d.getUTCDate(),day:d.getUTCDay()};
}

function jstStartUtcMs(year:number,month:number,date:number){
  return Date.UTC(year,month,date)-JST_OFFSET_MS;
}

export function jstPeriodStarts(now=Date.now()){
  const p=jstParts(now);
  const day=jstStartUtcMs(p.year,p.month,p.date);
  const mondayDelta=(p.day+6)%7;
  const week=jstStartUtcMs(p.year,p.month,p.date-mondayDelta);
  const month=jstStartUtcMs(p.year,p.month,1);
  return {day,week,month};
}

export async function getFundingPlan(env:Env,now=Date.now()){
  const settings=await loadXSettings(env);
  const periods=jstPeriodStarts(now);
  const [today,week,month,market,ltc,jpy]=await Promise.all([
    fundingSpendSince(env,periods.day),
    fundingSpendSince(env,periods.week),
    fundingSpendSince(env,periods.month),
    getLtcJpyMarketStatus(),
    getBinanceBalance(env,"LTC"),
    getBinanceBalance(env,"JPY")
  ]);

  const observedFresh=
    settings.observed_paypay_balance_at>0&&
    now-settings.observed_paypay_balance_at<=settings.max_paypay_balance_age_ms;

  const allowance=calculateFundingAllowance({
    reserveJpy:settings.reserve_jpy,
    maxPurchaseJpy:settings.max_purchase_jpy,
    dailyRemainingJpy:Math.max(0,settings.daily_purchase_limit_jpy-today),
    weeklyRemainingJpy:Math.max(0,settings.weekly_purchase_limit_jpy-week),
    monthlyRemainingJpy:Math.max(0,settings.monthly_purchase_limit_jpy-month),
    minPurchaseJpy:settings.min_purchase_jpy,
    paypayBalanceJpy:observedFresh
      ?Math.max(0,settings.observed_paypay_balance_jpy-settings.pending_paypay_funding_jpy)
      :0,
    currentLtc:ltc.free+ltc.locked,
    targetLtcBalance:settings.target_ltc_balance,
    maxLtcBalance:settings.max_ltc_balance,
    ltcJpy:market.priceJpy
  });

  return {
    observedPayPay:{
      balanceJpy:settings.observed_paypay_balance_jpy,
      reservedForPendingFundingJpy:settings.pending_paypay_funding_jpy,
      effectiveBalanceJpy:Math.max(
        0,
        settings.observed_paypay_balance_jpy-settings.pending_paypay_funding_jpy
      ),
      observedAt:settings.observed_paypay_balance_at,
      fresh:observedFresh,
      source:"manual_observation" as const
    },
    pendingManualFunding:settings.pending_paypay_funding_jpy>0?{
      amountJpy:settings.pending_paypay_funding_jpy,
      binanceJpyBaseline:settings.pending_paypay_binance_jpy_baseline,
      binanceLtcBaseline:settings.pending_paypay_binance_ltc_baseline,
      requiredLtcAtRequest:settings.pending_paypay_required_ltc,
      ltcBaselineCaptured:settings.pending_paypay_ltc_baseline_captured,
      requestedAt:settings.pending_paypay_requested_at
    }:null,
    binance:{
      jpyFree:jpy.free,
      ltcFree:ltc.free,
      ltcLocked:ltc.locked,
      market
    },
    periods:{
      todaySpentJpy:today,
      weekSpentJpy:week,
      monthSpentJpy:month,
      dayRemainingJpy:Math.max(0,settings.daily_purchase_limit_jpy-today),
      weekRemainingJpy:Math.max(0,settings.weekly_purchase_limit_jpy-week),
      monthRemainingJpy:Math.max(0,settings.monthly_purchase_limit_jpy-month)
    },
    allowance:observedFresh
      ?allowance
      :{...allowance,allowedJpy:0,blockedReason:"PAYPAY_BALANCE_MISSING_OR_STALE"}
  };
}
