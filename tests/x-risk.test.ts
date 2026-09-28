import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateFundingAllowance,
  calculateLtcPurchaseAllowance,
  calculateSpendablePayPayJpy,
  planManualPayPayPaths,
  splitPurchaseBatches,
  detectManualPayPayCompletion
} from "../src/x-risk.ts";

function base(){
  return {
    reserveJpy:20_000,
    maxPurchaseJpy:10_000,
    dailyRemainingJpy:100_000,
    weeklyRemainingJpy:100_000,
    monthlyRemainingJpy:100_000,
    minPurchaseJpy:1_000,
    paypayBalanceJpy:50_000,
    currentLtc:0,
    targetLtcBalance:10,
    maxLtcBalance:20,
    ltcJpy:10_000
  };
}

test("uses the smallest funding ceiling",()=>{
  const result=calculateFundingAllowance({
    ...base(),
    dailyRemainingJpy:7_000
  });
  assert.equal(result.allowedJpy,7_000);
  assert.equal(result.blockedReason,null);
});

test("reserve_jpy is never spendable",()=>{
  const result=calculateFundingAllowance({
    ...base(),
    paypayBalanceJpy:30_000,
    reserveJpy:20_000,
    maxPurchaseJpy:50_000
  });
  assert.equal(result.allowedJpy,10_000);
  assert.equal(result.components.spendable_paypay_jpy,10_000);
});

test("below minimum purchase blocks the buy",()=>{
  const result=calculateFundingAllowance({
    ...base(),
    dailyRemainingJpy:500,
    minPurchaseJpy:1_000
  });
  assert.equal(result.allowedJpy,0);
  assert.equal(result.blockedReason,"BELOW_MIN_PURCHASE");
});

test("target LTC balance stops further purchases",()=>{
  const result=calculateFundingAllowance({
    ...base(),
    currentLtc:10,
    targetLtcBalance:10
  });
  assert.equal(result.allowedJpy,0);
  assert.equal(result.blockedReason,"TARGET_LTC_BALANCE_REACHED");
});

test("max LTC balance stops further purchases",()=>{
  const result=calculateFundingAllowance({
    ...base(),
    currentLtc:20,
    targetLtcBalance:30,
    maxLtcBalance:20
  });
  assert.equal(result.allowedJpy,0);
  assert.equal(result.blockedReason,"MAX_LTC_BALANCE_REACHED");
});

test("splits 42 units into 20, 20, 2",()=>{
  assert.deepEqual(splitPurchaseBatches(42,20),[20,20,2]);
});


test("detects direct LTC purchase after a pending PayPay action",()=>{
  assert.equal(detectManualPayPayCompletion({
    pendingReservationJpy:7_000,
    jpyCreditRequiredJpy:7_000,
    binanceJpyBaseline:1_000,
    binanceLtcBaseline:0.1,
    ltcBaselineCaptured:true,
    currentBinanceJpy:1_000,
    currentBinanceLtc:0.5,
    directLtcBudgetJpy:7_000
  }),"LTC_PURCHASED");
});

test("detects PayPay-funded Binance JPY increase",()=>{
  assert.equal(detectManualPayPayCompletion({
    pendingReservationJpy:7_000,
    jpyCreditRequiredJpy:7_000,
    binanceJpyBaseline:1_000,
    binanceLtcBaseline:0.1,
    ltcBaselineCaptured:true,
    currentBinanceJpy:8_000,
    currentBinanceLtc:0.1,
    directLtcBudgetJpy:7_000
  }),"JPY_FUNDED");
});

test("does not resume before either manual completion condition is met",()=>{
  assert.equal(detectManualPayPayCompletion({
    pendingReservationJpy:7_000,
    jpyCreditRequiredJpy:7_000,
    binanceJpyBaseline:1_000,
    binanceLtcBaseline:0.1,
    ltcBaselineCaptured:true,
    currentBinanceJpy:7_999,
    currentBinanceLtc:0.399,
    directLtcBudgetJpy:7_000
  }),"NONE");
});


test("does not false-detect LTC purchase when the balance did not increase",()=>{
  assert.equal(detectManualPayPayCompletion({
    pendingReservationJpy:7_000,
    jpyCreditRequiredJpy:7_000,
    binanceJpyBaseline:1_000,
    binanceLtcBaseline:0.5,
    ltcBaselineCaptured:true,
    currentBinanceJpy:1_000,
    currentBinanceLtc:0.5,
    directLtcBudgetJpy:7_000
  }),"NONE");
});

test("legacy pending request without captured LTC baseline fails closed",()=>{
  assert.equal(detectManualPayPayCompletion({
    pendingReservationJpy:7_000,
    jpyCreditRequiredJpy:7_000,
    binanceJpyBaseline:1_000,
    binanceLtcBaseline:0,
    ltcBaselineCaptured:false,
    currentBinanceJpy:1_000,
    currentBinanceLtc:1,
    directLtcBudgetJpy:0
  }),"NONE");
});


test("partial Binance JPY uses only the explicit deposit requirement for JPY completion",()=>{
  assert.equal(detectManualPayPayCompletion({
    pendingReservationJpy:7_000,
    jpyCreditRequiredJpy:5_000,
    binanceJpyBaseline:2_000,
    binanceLtcBaseline:0.1,
    ltcBaselineCaptured:true,
    currentBinanceJpy:7_000,
    currentBinanceLtc:0.1,
    directLtcBudgetJpy:0.5
  }),"JPY_FUNDED");
});

test("partial Binance JPY does not reduce the direct-LTC PayPay accounting path",()=>{
  assert.equal(detectManualPayPayCompletion({
    pendingReservationJpy:7_000,
    jpyCreditRequiredJpy:5_000,
    binanceJpyBaseline:2_000,
    binanceLtcBaseline:0.1,
    ltcBaselineCaptured:true,
    currentBinanceJpy:2_000,
    currentBinanceLtc:0.5,
    directLtcBudgetJpy:0.5
  }),"LTC_PURCHASED");
});


test("existing Binance JPY purchase allowance is independent of PayPay balance",()=>{
  const result=calculateLtcPurchaseAllowance({
    maxPurchaseJpy:10_000,
    dailyRemainingJpy:7_000,
    weeklyRemainingJpy:20_000,
    monthlyRemainingJpy:50_000,
    minPurchaseJpy:1_000,
    currentLtc:0,
    targetLtcBalance:10,
    maxLtcBalance:20,
    ltcJpy:10_000
  });
  assert.equal(result.allowedJpy,7_000);
});

test("spendable PayPay subtracts reserve and pending reservation",()=>{
  assert.equal(calculateSpendablePayPayJpy({
    observedBalanceJpy:50_000,
    reserveJpy:20_000,
    pendingReservationJpy:7_000
  }),23_000);
});


test("PayPay path planner accounts for the 110 JPY deposit fee",()=>{
  assert.deepEqual(planManualPayPayPaths({
    desiredPurchaseJpy:7_000,
    currentBinanceJpy:2_000,
    spendablePayPayJpy:10_000,
    directPurchaseMinJpy:1_000,
    jpyDepositMinGrossJpy:1_000,
    jpyDepositFeeJpy:110
  }),{
    desiredPurchaseJpy:7_000,
    expectedNetJpyCredit:5_000,
    grossJpyDepositRequired:5_110,
    jpyDepositAvailable:true,
    directLtcAvailable:true,
    paypayReservationJpy:7_000
  });
});

test("PayPay path planner can offer JPY deposit when direct LTC exceeds spendable cash",()=>{
  const result=planManualPayPayPaths({
    desiredPurchaseJpy:7_000,
    currentBinanceJpy:2_000,
    spendablePayPayJpy:6_000,
    directPurchaseMinJpy:1_000,
    jpyDepositMinGrossJpy:1_000,
    jpyDepositFeeJpy:110
  });
  assert.equal(result.grossJpyDepositRequired,5_110);
  assert.equal(result.jpyDepositAvailable,true);
  assert.equal(result.directLtcAvailable,false);
  assert.equal(result.paypayReservationJpy,5_110);
});

test("PayPay path planner honors the official 1000 JPY gross deposit minimum",()=>{
  const result=planManualPayPayPaths({
    desiredPurchaseJpy:500,
    currentBinanceJpy:0,
    spendablePayPayJpy:1_000,
    directPurchaseMinJpy:1_000,
    jpyDepositMinGrossJpy:1_000,
    jpyDepositFeeJpy:110
  });
  assert.equal(result.expectedNetJpyCredit,500);
  assert.equal(result.grossJpyDepositRequired,1_000);
  assert.equal(result.jpyDepositAvailable,true);
  assert.equal(result.directLtcAvailable,false);
  assert.equal(result.paypayReservationJpy,1_000);
});


test("detects a capped direct LTC tranche before the full HStora target is reached",()=>{
  assert.equal(detectManualPayPayCompletion({
    pendingReservationJpy:3_000,
    jpyCreditRequiredJpy:0,
    binanceJpyBaseline:0,
    binanceLtcBaseline:0.1,
    ltcBaselineCaptured:true,
    directLtcBudgetJpy:3_000,
    currentBinanceJpy:0,
    currentBinanceLtc:0.2
  }),"LTC_PURCHASED");
});

test("does not treat an LTC increase as PayPay completion when direct LTC was not offered",()=>{
  assert.equal(detectManualPayPayCompletion({
    pendingReservationJpy:5_110,
    jpyCreditRequiredJpy:5_000,
    binanceJpyBaseline:2_000,
    binanceLtcBaseline:0.1,
    ltcBaselineCaptured:true,
    directLtcBudgetJpy:0,
    currentBinanceJpy:2_000,
    currentBinanceLtc:0.2
  }),"NONE");
});
