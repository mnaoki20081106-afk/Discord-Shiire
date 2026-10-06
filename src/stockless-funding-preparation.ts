import type { Env } from './types';

// Preparation only: no provider client, account login, money movement, cron
// registration, or production order mutation is reachable from this module.
export type FundingStep='deposit'|'conversion'|'transfer'|'supplier_credit'|'procurement'|'delivery';
const STEPS:readonly FundingStep[]=['deposit','conversion','transfer','supplier_credit','procurement','delivery'];

export type FundingDraft={
  mode:'simulation';
  orderId:string;
  quantity:number;
  reservedQuantity:number;
  missingQuantity:number;
  saleAmountJpy:number;
  fundingGrossJpy:number;
  fundingFeeJpy:number;
  fundingNetJpy:number;
  next:FundingStep|'complete'|'not_required'|'blocked';
  reason:string|null;
  receipts:Partial<Record<FundingStep,FundingEvidence>>;
};
export type FundingEvidence={
  operationKey:string;
  providerReference:string;
  spentJpy?:number;
  creditedJpy?:number;
  quantity?:number;
};
export type FundingDraftInput={
  orderId:string;
  quantity:number;
  reservedQuantity:number;
  saleAmountJpy:number;
  confirmedPayPayMoneyJpy:number;
  requiredFundingJpy:number;
  fundingFeeJpy:number;
  minimumFundingJpy:number;
};
function integer(value:number,minimum=0){
  if(!Number.isSafeInteger(value)||value<minimum) throw new Error('INVALID_FUNDING_INPUT');
  return value;
}
export function fundingOperationKey(orderId:string,step:FundingStep){
  return `simulation:${orderId}:${step}`;
}
export function prepareStocklessFunding(input:FundingDraftInput):FundingDraft{
  if(typeof input.orderId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(input.orderId)) throw new Error('INVALID_ORDER_ID');
  const quantity=integer(input.quantity,1),reserved=integer(input.reservedQuantity);
  if(reserved>quantity||quantity>100) throw new Error('INVALID_FUNDING_INPUT');
  const sale=integer(input.saleAmountJpy),money=integer(input.confirmedPayPayMoneyJpy);
  const gross=integer(input.requiredFundingJpy),fee=integer(input.fundingFeeJpy);
  const minimum=integer(input.minimumFundingJpy,1);
  const missing=quantity-reserved;
  let reason:string|null=null;
  if(missing>0){
    if(money<sale||sale<1) reason='PAYPAY_MONEY_RECEIPT_REQUIRED';
    else if(gross<minimum) reason='BELOW_PROVIDER_MINIMUM';
    else if(gross>sale) reason='SALE_PROCEEDS_INSUFFICIENT';
    else if(fee>=gross) reason='FEES_EXCEED_FUNDING';
  }
  return {
    mode:'simulation',orderId:input.orderId,quantity,reservedQuantity:reserved,
    missingQuantity:missing,saleAmountJpy:sale,fundingGrossJpy:gross,
    fundingFeeJpy:fee,fundingNetJpy:Math.max(0,gross-fee),
    next:missing===0?'not_required':reason?'blocked':'deposit',reason,receipts:{}
  };
}

export function advanceFundingDraft(
  draft:FundingDraft,step:FundingStep,evidence:FundingEvidence
):FundingDraft{
  if(draft.mode!=='simulation') throw new Error('LIVE_FUNDING_NOT_IMPLEMENTED');
  if(evidence.operationKey!==fundingOperationKey(draft.orderId,step)){
    throw new Error('FUNDING_ORDER_REFERENCE_MISMATCH');
  }
  if(!/^simulation:[A-Za-z0-9:_-]{1,120}$/.test(evidence.providerReference)){
    throw new Error('SIMULATED_REFERENCE_REQUIRED');
  }
  const old=draft.receipts[step];
  if(old){
    if(old.operationKey!==evidence.operationKey||old.providerReference!==evidence.providerReference||
      old.spentJpy!==evidence.spentJpy||old.creditedJpy!==evidence.creditedJpy||old.quantity!==evidence.quantity){
      throw new Error('FUNDING_REPLAY_CONFLICT');
    }
    return draft;
  }
  if(draft.next!==step) throw new Error('FUNDING_STAGE_MISMATCH');
  if(step==='deposit'){
    if(evidence.spentJpy!==draft.fundingGrossJpy||evidence.creditedJpy!==draft.fundingNetJpy){
      throw new Error('FUNDING_DEPOSIT_AMOUNT_MISMATCH');
    }
  }
  if(step==='conversion'){
    const spend=integer(evidence.spentJpy??-1,1);
    if(spend>draft.fundingNetJpy) throw new Error('SALE_PROCEEDS_LIMIT_EXCEEDED');
  }
  if(step==='procurement'&&evidence.quantity!==draft.missingQuantity){
    throw new Error('PROCUREMENT_SHORTFALL_MISMATCH');
  }
  if(step==='delivery'&&evidence.quantity!==draft.quantity){
    throw new Error('DELIVERY_QUANTITY_MISMATCH');
  }
  const index=STEPS.indexOf(step);
  return {...draft,receipts:{...draft.receipts,[step]:{...evidence}},next:STEPS[index+1]??'complete'};
}

export function simulateStocklessFunding(input:FundingDraftInput){
  let draft=prepareStocklessFunding(input);
  const stages:FundingStep[]=[];
  for(const step of STEPS){
    if(draft.next!==step) break;
    const evidence:FundingEvidence={
      operationKey:fundingOperationKey(draft.orderId,step),
      providerReference:`simulation:${draft.orderId}:${step}:receipt`,
      ...(step==='deposit'?{spentJpy:draft.fundingGrossJpy,creditedJpy:draft.fundingNetJpy}:{}),
      ...(step==='conversion'?{spentJpy:draft.fundingNetJpy}:{}),
      ...(step==='procurement'?{quantity:draft.missingQuantity}:{}),
      ...(step==='delivery'?{quantity:draft.quantity}:{})
    };
    draft=advanceFundingDraft(draft,step,evidence);
    stages.push(step);
  }
  return {simulation:true,live:false,providerCalls:0,stages,draft};
}

export function stocklessFundingReadiness(env:Env){
  return {
    mode:'preparation',liveReady:false,liveExecutionImplemented:false,
    accountConnectionAloneIsSufficient:false,
    capabilities:{
      paypayMoneyReceipt:{existingAdapter:true,configured:Boolean(env.XACCOUNT_BOT_BASE_URL&&env.SHIIRE_BRIDGE_SECRET)},
      paypayToBinanceDeposit:{implemented:false,reason:'PAYPAY_JPY_DEPOSIT_API_UNVERIFIED'},
      binanceLtcPurchase:{existingAdapter:true,configured:Boolean(env.BINANCE_API_KEY&&env.BINANCE_API_SECRET)},
      binanceLtcWithdrawal:{existingAdapter:true,configured:Boolean(env.BINANCE_WITHDRAW_API_KEY&&env.BINANCE_WITHDRAW_API_SECRET)},
      hstoraDepositDestination:{implemented:false,reason:'HSTORA_DEPOSIT_DESTINATION_UNVERIFIED'},
      hstoraProcurement:{existingAdapter:true,configured:Boolean(env.HSTORA_API_KEY&&env.HSTORA_API_SECRET)},
      buyerDelivery:{existingAdapter:true,configured:Boolean(env.DISCORD_BOT_TOKEN&&env.CREDENTIALS_ENCRYPTION_KEY)}
    },
    blockers:['PAYPAY_JPY_DEPOSIT_API_UNVERIFIED','HSTORA_DEPOSIT_DESTINATION_UNVERIFIED','LIVE_ORDER_FUNDING_ORCHESTRATION_NOT_CONNECTED'],
    sources:{
      depositApi:'https://developers.binance.com/en/docs/catalog/investment-and-services-fiat/api/rest-api/~',
      paypayDeposit:'https://www.binance.com/ja/support/faq/detail/cc74057cc86f4b569d23b3de3d82edd4'
    }
  };
}
