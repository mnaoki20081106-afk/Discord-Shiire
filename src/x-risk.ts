export type FundingLimits={
  reserveJpy:number;
  maxPurchaseJpy:number;
  dailyRemainingJpy:number;
  weeklyRemainingJpy:number;
  monthlyRemainingJpy:number;
  minPurchaseJpy:number;
  paypayBalanceJpy:number;
  currentLtc:number;
  targetLtcBalance:number;
  maxLtcBalance:number;
  ltcJpy:number;
};

export type FundingAllowance={
  allowedJpy:number;
  components:Record<string,number>;
  blockedReason:string|null;
};

function finiteNonNegative(value:number):number{
  return Number.isFinite(value)?Math.max(0,value):0;
}

/**
 * Fail-closed funding cap.
 * Every component is a ceiling; the smallest positive allowance wins.
 */
export function calculateFundingAllowance(input:FundingLimits):FundingAllowance{
  const spendablePayPay=finiteNonNegative(input.paypayBalanceJpy-input.reserveJpy);
  const maxPurchase=finiteNonNegative(input.maxPurchaseJpy);
  const daily=finiteNonNegative(input.dailyRemainingJpy);
  const weekly=finiteNonNegative(input.weeklyRemainingJpy);
  const monthly=finiteNonNegative(input.monthlyRemainingJpy);

  const ltcPrice=finiteNonNegative(input.ltcJpy);
  const targetGapLtc=finiteNonNegative(input.targetLtcBalance-input.currentLtc);
  const maxGapLtc=finiteNonNegative(input.maxLtcBalance-input.currentLtc);
  const targetGapJpy=ltcPrice>0?Math.floor(targetGapLtc*ltcPrice):0;
  const maxGapJpy=ltcPrice>0?Math.floor(maxGapLtc*ltcPrice):0;

  const components={
    spendable_paypay_jpy:Math.floor(spendablePayPay),
    max_purchase_jpy:Math.floor(maxPurchase),
    daily_remaining_jpy:Math.floor(daily),
    weekly_remaining_jpy:Math.floor(weekly),
    monthly_remaining_jpy:Math.floor(monthly),
    target_ltc_gap_jpy:targetGapJpy,
    max_ltc_gap_jpy:maxGapJpy
  };

  if(ltcPrice<=0) return {allowedJpy:0,components,blockedReason:"LTC_PRICE_UNAVAILABLE"};
  if(input.maxLtcBalance<=0) return {allowedJpy:0,components,blockedReason:"MAX_LTC_BALANCE_NOT_CONFIGURED"};
  if(input.currentLtc>=input.maxLtcBalance){
    return {allowedJpy:0,components,blockedReason:"MAX_LTC_BALANCE_REACHED"};
  }
  if(input.targetLtcBalance<=input.currentLtc){
    return {allowedJpy:0,components,blockedReason:"TARGET_LTC_BALANCE_REACHED"};
  }

  const allowed=Math.floor(Math.min(
    spendablePayPay,maxPurchase,daily,weekly,monthly,targetGapJpy,maxGapJpy
  ));
  if(allowed<=0) return {allowedJpy:0,components,blockedReason:"NO_FUNDING_ALLOWANCE"};
  if(allowed<finiteNonNegative(input.minPurchaseJpy)){
    return {allowedJpy:0,components,blockedReason:"BELOW_MIN_PURCHASE"};
  }
  return {allowedJpy:allowed,components,blockedReason:null};
}

export function calculateLtcPurchaseAllowance(
  input:Omit<FundingLimits,"reserveJpy"|"paypayBalanceJpy">
):FundingAllowance{
  const maxPurchase=finiteNonNegative(input.maxPurchaseJpy);
  const daily=finiteNonNegative(input.dailyRemainingJpy);
  const weekly=finiteNonNegative(input.weeklyRemainingJpy);
  const monthly=finiteNonNegative(input.monthlyRemainingJpy);
  const ltcPrice=finiteNonNegative(input.ltcJpy);
  const targetGapLtc=finiteNonNegative(input.targetLtcBalance-input.currentLtc);
  const maxGapLtc=finiteNonNegative(input.maxLtcBalance-input.currentLtc);
  const targetGapJpy=ltcPrice>0?Math.floor(targetGapLtc*ltcPrice):0;
  const maxGapJpy=ltcPrice>0?Math.floor(maxGapLtc*ltcPrice):0;
  const components={
    max_purchase_jpy:Math.floor(maxPurchase),
    daily_remaining_jpy:Math.floor(daily),
    weekly_remaining_jpy:Math.floor(weekly),
    monthly_remaining_jpy:Math.floor(monthly),
    target_ltc_gap_jpy:targetGapJpy,
    max_ltc_gap_jpy:maxGapJpy
  };

  if(ltcPrice<=0) return {allowedJpy:0,components,blockedReason:"LTC_PRICE_UNAVAILABLE"};
  if(input.maxLtcBalance<=0) return {allowedJpy:0,components,blockedReason:"MAX_LTC_BALANCE_NOT_CONFIGURED"};
  if(input.currentLtc>=input.maxLtcBalance){
    return {allowedJpy:0,components,blockedReason:"MAX_LTC_BALANCE_REACHED"};
  }
  if(input.targetLtcBalance<=input.currentLtc){
    return {allowedJpy:0,components,blockedReason:"TARGET_LTC_BALANCE_REACHED"};
  }

  const allowed=Math.floor(Math.min(
    maxPurchase,daily,weekly,monthly,targetGapJpy,maxGapJpy
  ));
  if(allowed<=0) return {allowedJpy:0,components,blockedReason:"NO_PURCHASE_ALLOWANCE"};
  if(allowed<finiteNonNegative(input.minPurchaseJpy)){
    return {allowedJpy:0,components,blockedReason:"BELOW_MIN_PURCHASE"};
  }
  return {allowedJpy:allowed,components,blockedReason:null};
}

export function calculateSpendablePayPayJpy(input:{
  observedBalanceJpy:number;
  reserveJpy:number;
  pendingReservationJpy?:number;
}):number{
  return Math.floor(Math.max(
    0,
    finiteNonNegative(input.observedBalanceJpy)-
    finiteNonNegative(input.reserveJpy)-
    finiteNonNegative(input.pendingReservationJpy??0)
  ));
}

export function splitPurchaseBatches(quantity:number,maxBatch:number):number[]{
  const total=Math.max(0,Math.floor(quantity));
  const cap=Math.max(1,Math.floor(maxBatch));
  const out:number[]=[];
  let remaining=total;
  while(remaining>0){
    const next=Math.min(cap,remaining);
    out.push(next);
    remaining-=next;
  }
  return out;
}


export type ManualPayPayCompletion="NONE"|"JPY_FUNDED"|"LTC_PURCHASED";

export function detectManualPayPayCompletion(input:{
  pendingReservationJpy:number;
  jpyCreditRequiredJpy:number;
  binanceJpyBaseline:number;
  binanceLtcBaseline:number;
  ltcBaselineCaptured:boolean;
  currentBinanceJpy:number;
  currentBinanceLtc:number;
  requiredLtcAtRequest:number;
}):ManualPayPayCompletion{
  const reserved=Math.max(0,input.pendingReservationJpy);
  if(reserved<=0) return "NONE";

  const requiredLtcAtRequest=Math.max(0,input.requiredLtcAtRequest);
  const ltcBaseline=Math.max(0,input.binanceLtcBaseline);
  const currentLtc=Math.max(0,input.currentBinanceLtc);
  const ltcIncreased=currentLtc>ltcBaseline+1e-12;

  // Fail closed for legacy pending requests that were created before an LTC
  // baseline was persisted. A changing LTC/JPY price or HStora requirement
  // must never make an unchanged pre-existing LTC balance look like a newly
  // completed PayPay -> LTC purchase.
  if(
    input.ltcBaselineCaptured&&
    requiredLtcAtRequest>0&&
    ltcIncreased&&
    currentLtc>=requiredLtcAtRequest
  ){
    return "LTC_PURCHASED";
  }

  const jpyNeeded=Math.max(0,input.jpyCreditRequiredJpy);
  if(jpyNeeded>0){
    const expectedJpy=Math.max(0,input.binanceJpyBaseline)+jpyNeeded;
    if(input.currentBinanceJpy>=expectedJpy){
      return "JPY_FUNDED";
    }
  }

  return "NONE";
}
