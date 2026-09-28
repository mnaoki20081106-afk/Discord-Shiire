import type { Env } from "./types";
import {
  calculateLtcPurchaseAllowance,
  calculateSpendablePayPayJpy,
  nextObservedPayPayBalance
} from "./x-risk";
import { auditX, fundingSpendSince, recordFundingEvent } from "./x-db";
import { loadXSettings, saveXSettings } from "./x-settings";
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

  const allowance=calculateLtcPurchaseAllowance({
    maxPurchaseJpy:settings.max_purchase_jpy,
    dailyRemainingJpy:Math.max(0,settings.daily_purchase_limit_jpy-today),
    weeklyRemainingJpy:Math.max(0,settings.weekly_purchase_limit_jpy-week),
    monthlyRemainingJpy:Math.max(0,settings.monthly_purchase_limit_jpy-month),
    minPurchaseJpy:settings.min_purchase_jpy,
    currentLtc:ltc.free+ltc.locked,
    targetLtcBalance:settings.target_ltc_balance,
    maxLtcBalance:settings.max_ltc_balance,
    ltcJpy:market.priceJpy
  });
  const spendablePayPayJpy=observedFresh
    ?calculateSpendablePayPayJpy({
      observedBalanceJpy:settings.observed_paypay_balance_jpy,
      reserveJpy:settings.reserve_jpy,
      pendingReservationJpy:settings.pending_paypay_funding_jpy
    })
    :0;

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
      spendableNewFundingJpy:spendablePayPayJpy,
      source:"manual_observation" as const
    },
    pendingManualFunding:settings.pending_paypay_funding_jpy>0?{
      amountJpy:settings.pending_paypay_funding_jpy,
      jpyDepositGrossJpy:settings.pending_paypay_path_amounts_captured
        ?settings.pending_paypay_jpy_deposit_required_jpy
        :settings.pending_paypay_funding_jpy,
      expectedJpyCreditJpy:settings.pending_paypay_path_amounts_captured
        ?settings.pending_paypay_jpy_credit_required_jpy
        :settings.pending_paypay_funding_jpy,
      directLtcBudgetJpy:settings.pending_paypay_path_amounts_captured
        ?settings.pending_paypay_direct_ltc_budget_jpy
        :0,
      pathAmountsCaptured:settings.pending_paypay_path_amounts_captured,
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
    allowance,
    paypayFunding:{
      fresh:observedFresh,
      spendableJpy:spendablePayPayJpy,
      blockedReason:observedFresh?null:"PAYPAY_BALANCE_MISSING_OR_STALE"
    }
  };
}


export async function confirmPendingDirectLtcFunding(env:Env){
  const settings=await loadXSettings(env);
  if(
    settings.pending_paypay_funding_jpy<=0||
    settings.pending_paypay_direct_ltc_budget_jpy<=0||
    !settings.pending_paypay_ltc_baseline_captured
  ){
    throw new Error("NO_PENDING_DIRECT_LTC_CONFIRMATION");
  }

  const ltc=await getBinanceBalance(env,"LTC");
  const currentTotal=Math.max(0,ltc.free+ltc.locked);
  const baseline=Math.max(0,settings.pending_paypay_binance_ltc_baseline);
  const increase=Math.max(0,currentTotal-baseline);
  if(increase<=1e-12){
    throw new Error("LTC_BALANCE_INCREASE_NOT_DETECTED");
  }

  const confirmedSpend=settings.pending_paypay_direct_ltc_budget_jpy;
  const nextObserved=nextObservedPayPayBalance({
    observedBalanceJpy:settings.observed_paypay_balance_jpy,
    observedAt:settings.observed_paypay_balance_at,
    pendingRequestedAt:settings.pending_paypay_requested_at,
    confirmedSpendJpy:confirmedSpend
  });

  const next=await saveXSettings(env,{
    observed_paypay_balance_jpy:nextObserved,
    pending_paypay_funding_jpy:0,
    pending_paypay_jpy_deposit_required_jpy:0,
    pending_paypay_jpy_credit_required_jpy:0,
    pending_paypay_direct_ltc_budget_jpy:0,
    pending_paypay_path_amounts_captured:false,
    pending_paypay_binance_jpy_baseline:0,
    pending_paypay_binance_ltc_baseline:0,
    pending_paypay_required_ltc:0,
    pending_paypay_ltc_baseline_captured:false,
    pending_paypay_requested_at:0
  });

  await recordFundingEvent(env,{
    provider:"paypay_manual",
    kind:"DIRECT_LTC_PURCHASE_CONFIRMED",
    amountJpy:confirmedSpend,
    asset:"LTC",
    assetAmount:increase,
    status:"COMPLETED",
    metadata:{
      binanceLtcBaseline:baseline,
      binanceLtcTotal:currentTotal,
      detectedLtcIncrease:increase,
      confirmation:"admin"
    }
  });
  await auditX(env,{
    kind:"PAYPAY_DIRECT_LTC_CONFIRMED",
    message:"Admin confirmed the detected Binance LTC increase as the pending PayPay direct purchase.",
    details:{
      confirmedSpendJpy:confirmedSpend,
      binanceLtcBaseline:baseline,
      binanceLtcTotal:currentTotal,
      detectedLtcIncrease:increase
    }
  });

  return {
    ok:true,
    confirmedSpendJpy:confirmedSpend,
    detectedLtcIncrease:increase,
    binanceLtcTotal:currentTotal,
    settings:next
  };
}
