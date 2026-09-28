import test from "node:test";
import assert from "node:assert/strict";
import { calculateFundingAllowance, splitPurchaseBatches, detectManualPayPayCompletion } from "../src/x-risk.ts";

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
    pendingJpy:7_000,
    binanceJpyBaseline:1_000,
    binanceLtcBaseline:0.1,
    ltcBaselineCaptured:true,
    currentBinanceJpy:1_000,
    currentBinanceLtc:0.5,
    requiredLtcAtRequest:0.4
  }),"LTC_PURCHASED");
});

test("detects PayPay-funded Binance JPY increase",()=>{
  assert.equal(detectManualPayPayCompletion({
    pendingJpy:7_000,
    binanceJpyBaseline:1_000,
    binanceLtcBaseline:0.1,
    ltcBaselineCaptured:true,
    currentBinanceJpy:8_000,
    currentBinanceLtc:0.1,
    requiredLtcAtRequest:0.4
  }),"JPY_FUNDED");
});

test("does not resume before either manual completion condition is met",()=>{
  assert.equal(detectManualPayPayCompletion({
    pendingJpy:7_000,
    binanceJpyBaseline:1_000,
    binanceLtcBaseline:0.1,
    ltcBaselineCaptured:true,
    currentBinanceJpy:7_999,
    currentBinanceLtc:0.399,
    requiredLtcAtRequest:0.4
  }),"NONE");
});


test("does not false-detect LTC purchase when requirement falls below the old balance",()=>{
  assert.equal(detectManualPayPayCompletion({
    pendingJpy:7_000,
    binanceJpyBaseline:1_000,
    binanceLtcBaseline:0.5,
    ltcBaselineCaptured:true,
    currentBinanceJpy:1_000,
    currentBinanceLtc:0.5,
    requiredLtcAtRequest:0.6
  }),"NONE");
});

test("legacy pending request without captured LTC baseline fails closed",()=>{
  assert.equal(detectManualPayPayCompletion({
    pendingJpy:7_000,
    binanceJpyBaseline:1_000,
    binanceLtcBaseline:0,
    ltcBaselineCaptured:false,
    currentBinanceJpy:1_000,
    currentBinanceLtc:1,
    requiredLtcAtRequest:0
  }),"NONE");
});
