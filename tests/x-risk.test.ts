import test from "node:test";
import assert from "node:assert/strict";
import { calculateFundingAllowance, splitPurchaseBatches } from "../src/x-risk.ts";

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
