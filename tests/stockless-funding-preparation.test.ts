import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareStocklessFunding,advanceFundingDraft,simulateStocklessFunding,
  fundingOperationKey,stocklessFundingReadiness,type FundingDraftInput
} from '../src/stockless-funding-preparation.ts';
const base:FundingDraftInput={orderId:'order_1',quantity:5,reservedQuantity:2,saleAmountJpy:1500,confirmedPayPayMoneyJpy:1500,requiredFundingJpy:1000,fundingFeeJpy:110,minimumFundingJpy:1000};
test('simulation uses this orders proceeds, procures the shortfall and delivers all units',()=>{
  const result=simulateStocklessFunding(base);
  assert.equal(result.live,false);assert.equal(result.providerCalls,0);
  assert.equal(result.draft.fundingNetJpy,890);
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
  assert.equal(prepareStocklessFunding({...base,requiredFundingJpy:500}).reason,'BELOW_PROVIDER_MINIMUM');
  assert.equal(prepareStocklessFunding({...base,confirmedPayPayMoneyJpy:0}).reason,'PAYPAY_MONEY_RECEIPT_REQUIRED');
});
test('replays are idempotent but changed receipt data is rejected',()=>{
  const draft=prepareStocklessFunding(base);
  const receipt={operationKey:fundingOperationKey(base.orderId,'deposit'),providerReference:'simulation:deposit:1',spentJpy:1000,creditedJpy:890};
  const next=advanceFundingDraft(draft,'deposit',receipt);
  assert.equal(advanceFundingDraft(next,'deposit',{...receipt}),next);
  assert.throws(()=>advanceFundingDraft(next,'deposit',{...receipt,creditedJpy:1000}),/FUNDING_REPLAY_CONFLICT/);
});
test('other order receipts and out of sequence confirmations cannot advance an order',()=>{
  const draft=prepareStocklessFunding(base);
  assert.throws(()=>advanceFundingDraft(draft,'deposit',{operationKey:fundingOperationKey('order_2','deposit'),providerReference:'simulation:deposit:2'}),/FUNDING_ORDER_REFERENCE_MISMATCH/);
  assert.throws(()=>advanceFundingDraft(draft,'supplier_credit',{operationKey:fundingOperationKey(base.orderId,'supplier_credit'),providerReference:'simulation:credit:1'}),/FUNDING_STAGE_MISMATCH/);
});
test('gross receipt must account for fees and conversion cannot exceed its net credit',()=>{
  const draft=prepareStocklessFunding(base);
  const receipt={operationKey:fundingOperationKey(base.orderId,'deposit'),providerReference:'simulation:deposit:1',spentJpy:1000,creditedJpy:890};
  assert.throws(()=>advanceFundingDraft(draft,'deposit',{...receipt,creditedJpy:1000}),/FUNDING_DEPOSIT_AMOUNT_MISMATCH/);
  const next=advanceFundingDraft(draft,'deposit',receipt);
  assert.throws(()=>advanceFundingDraft(next,'conversion',{operationKey:fundingOperationKey(base.orderId,'conversion'),providerReference:'simulation:buy:1',spentJpy:891}),/SALE_PROCEEDS_LIMIT_EXCEEDED/);
});
test('real provider references and live mode are not accepted by preparation code',()=>{
  const draft=prepareStocklessFunding(base);
  assert.throws(()=>advanceFundingDraft(draft,'deposit',{operationKey:fundingOperationKey(base.orderId,'deposit'),providerReference:'real-provider-id'}),/SIMULATED_REFERENCE_REQUIRED/);
  assert.throws(()=>advanceFundingDraft({...draft,mode:'live' as any},'deposit',{} as any),/LIVE_FUNDING_NOT_IMPLEMENTED/);
});
test('adding all credentials does not misreport live readiness',()=>{
  const result=stocklessFundingReadiness({BINANCE_API_KEY:'test',BINANCE_API_SECRET:'test',BINANCE_WITHDRAW_API_KEY:'test',BINANCE_WITHDRAW_API_SECRET:'test',HSTORA_API_KEY:'test',HSTORA_API_SECRET:'test'} as any);
  assert.equal(result.liveReady,false);assert.equal(result.accountConnectionAloneIsSufficient,false);
  assert.ok(result.blockers.includes('PAYPAY_JPY_DEPOSIT_API_UNVERIFIED'));
});
test('invalid quantities and noninteger yen are rejected',()=>{
  for(const patch of [{quantity:101},{reservedQuantity:6},{saleAmountJpy:1.5},{fundingFeeJpy:-1},{orderId:123}]){
    assert.throws(()=>prepareStocklessFunding({...base,...patch} as FundingDraftInput));
  }
});
