import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareStocklessFunding,advanceFundingDraft,simulateStocklessFunding,
  fundingOperationKey,stocklessFundingReadiness,type FundingDraftInput
} from '../src/stockless-funding-preparation.ts';
const base:FundingDraftInput={orderId:'order_1',quantity:5,reservedQuantity:2,saleAmountJpy:1500,confirmedPayPayMoneyJpy:1500,directPurchaseJpy:1000,minimumPurchaseJpy:1000};
test('simulation uses this orders proceeds, procures the shortfall and delivers all units',()=>{
  const result=simulateStocklessFunding(base);
  assert.equal(result.live,false);assert.equal(result.providerCalls,0);
  assert.equal(result.draft.directPurchaseJpy,1000);
  assert.deepEqual(result.stages,['direct_purchase','transfer','supplier_credit','procurement','delivery']);
  assert.equal(result.draft.receipts.procurement?.quantity,3);
  assert.equal(result.draft.receipts.delivery?.quantity,5);
  assert.equal(result.draft.next,'complete');
});
test('sufficient stock bypasses the entire funding route',()=>{
  const result=simulateStocklessFunding({...base,reservedQuantity:5});
  assert.deepEqual(result.stages,[]);assert.equal(result.draft.next,'not_required');
});
test('cannot fund a small sale by borrowing unrelated PayPay balance',()=>{
  const result=simulateStocklessFunding({...base,saleAmountJpy:200,confirmedPayPayMoneyJpy:10000});
  assert.equal(result.draft.reason,'SALE_PROCEEDS_INSUFFICIENT');assert.deepEqual(result.stages,[]);
});
test('provider minimum and PayPay money receipt are enforced before any stage',()=>{
  assert.equal(prepareStocklessFunding({...base,directPurchaseJpy:500}).reason,'BELOW_PROVIDER_MINIMUM');
  assert.equal(prepareStocklessFunding({...base,confirmedPayPayMoneyJpy:0}).reason,'PAYPAY_MONEY_RECEIPT_REQUIRED');
});
test('replays are idempotent but changed receipt data is rejected',()=>{
  const draft=prepareStocklessFunding(base);
  const receipt={operationKey:fundingOperationKey(base.orderId,'direct_purchase'),providerReference:'simulation:direct_purchase:1',spentJpy:1000,acquiredLtcAtomic:1};
  const next=advanceFundingDraft(draft,'direct_purchase',receipt);
  assert.equal(advanceFundingDraft(next,'direct_purchase',{...receipt}),next);
  assert.throws(()=>advanceFundingDraft(next,'direct_purchase',{...receipt,acquiredLtcAtomic:2}),/FUNDING_REPLAY_CONFLICT/);
});
test('other order receipts and out of sequence confirmations cannot advance an order',()=>{
  const draft=prepareStocklessFunding(base);
  assert.throws(()=>advanceFundingDraft(draft,'direct_purchase',{operationKey:fundingOperationKey('order_2','direct_purchase'),providerReference:'simulation:direct_purchase:2'}),/FUNDING_ORDER_REFERENCE_MISMATCH/);
  assert.throws(()=>advanceFundingDraft(draft,'supplier_credit',{operationKey:fundingOperationKey(base.orderId,'supplier_credit'),providerReference:'simulation:credit:1'}),/FUNDING_STAGE_MISMATCH/);
});
test('direct purchase must match the quote and remain within the sale proceeds',()=>{
  const draft=prepareStocklessFunding(base);
  const receipt={operationKey:fundingOperationKey(base.orderId,'direct_purchase'),providerReference:'simulation:buy:1',spentJpy:1000,acquiredLtcAtomic:1};
  assert.throws(()=>advanceFundingDraft(draft,'direct_purchase',{...receipt,spentJpy:1600}),/SALE_PROCEEDS_LIMIT_EXCEEDED/);
  assert.throws(()=>advanceFundingDraft(draft,'direct_purchase',{...receipt,spentJpy:890}),/DIRECT_PURCHASE_AMOUNT_MISMATCH/);
  assert.throws(()=>advanceFundingDraft(draft,'direct_purchase',{...receipt,acquiredLtcAtomic:0}),/INVALID_FUNDING_INPUT/);
});
test('real provider references and live mode are not accepted by preparation code',()=>{
  const draft=prepareStocklessFunding(base);
  assert.throws(()=>advanceFundingDraft(draft,'direct_purchase',{operationKey:fundingOperationKey(base.orderId,'direct_purchase'),providerReference:'real-provider-id'}),/SIMULATED_REFERENCE_REQUIRED/);
  assert.throws(()=>advanceFundingDraft({...draft,mode:'live' as any},'direct_purchase',{} as any),/LIVE_FUNDING_NOT_IMPLEMENTED/);
});
test('adding all credentials does not misreport live readiness',()=>{
  const result=stocklessFundingReadiness({BINANCE_API_KEY:'test',BINANCE_API_SECRET:'test',BINANCE_WITHDRAW_API_KEY:'test',BINANCE_WITHDRAW_API_SECRET:'test',HSTORA_API_KEY:'test',HSTORA_API_SECRET:'test'} as any);
  assert.equal(result.liveReady,false);assert.equal(result.accountConnectionAloneIsSufficient,false);
  assert.equal(result.route,'paypay_direct_ltc');assert.equal(result.requiresJpyDeposit,false);
  assert.equal('paypayToBinanceDeposit' in result.capabilities,false);
  assert.ok(result.blockers.includes('LTC_PAYPAY_ELIGIBILITY_UNVERIFIED'));
  assert.ok(result.blockers.includes('PAYPAY_DIRECT_LTC_PURCHASE_API_UNVERIFIED'));
});
test('invalid quantities and noninteger yen are rejected',()=>{
  for(const patch of [{quantity:101},{reservedQuantity:6},{saleAmountJpy:1.5},{directPurchaseJpy:-1},{orderId:123}]){
    assert.throws(()=>prepareStocklessFunding({...base,...patch} as FundingDraftInput));
  }
});
