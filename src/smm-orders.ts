import type { Env } from "./types";
import { sha256Hex } from "./crypto";
import { auditX } from "./x-db";
import { receiveMainPayment } from "./main-bot";
import {
  LuckyPanelError,
  luckyAddOrder,
  luckyBalance,
  luckyCancel,
  luckyOrderStatuses,
  luckyPanelConfigured,
  type LuckyService
} from "./smm-luckypanel";
import {
  clearSmmPaymentLink,
  claimSmmPlacing,
  expireSmmUnpaid,
  finalizeSmmOrder,
  getSmmMeta,
  getSmmOrder,
  getSmmSettings,
  listSmmGuildIds,
  listSmmNeedingAdminAlert,
  listSmmPendingPayments,
  listSmmPlaced,
  listSmmReadyToPlace,
  listSmmStalePlacing,
  listSmmUnnotified,
  loadSmmServices,
  markSmmAdminAlerted,
  markSmmFailed,
  markSmmHold,
  markSmmNotified,
  markSmmPaid,
  markSmmPlaced,
  markSmmRefundDone,
  markSmmRetry,
  readSmmPaymentLink,
  releaseSmmHold,
  setSmmMeta,
  updateSmmTracking,
  type SmmOrder
} from "./smm-db";
import {
  buyerResultMessage,
  smmSendDm,
  smmSendMessage,
  yen
} from "./smm-discord";
import {
  SMM_RETRY_DELAY_MS,
  isJpyCurrency,
  isRetryableSupplierRejection,
  isSupportedSmmServiceType,
  mapSmmSupplierStatus,
  placeRetryDecision,
  smmCost,
  smmQuantityBounds,
  smmQuoteIsProfitable,
  smmRefundAmount
} from "./smm-policy";

const SERVICES_MAX_AGE_MS=5*60_000;
const BALANCE_CHECK_INTERVAL_MS=10*60_000;
const BALANCE_ALERT_INTERVAL_MS=6*60*60_000;

export async function smmServicesMap(
  env:Env,
  options:{maxAgeMs?:number;forceRefresh?:boolean}={}
){
  const loaded=await loadSmmServices(env,{
    maxAgeMs:options.maxAgeMs??SERVICES_MAX_AGE_MS,
    forceRefresh:options.forceRefresh
  });
  return {
    map:new Map<string,LuckyService>(loaded.services.map(service=>[service.service,service])),
    cachedAt:loaded.cachedAt,
    stale:loaded.stale
  };
}

export async function smmSupplierReadiness(env:Env):Promise<{balance:number;currency:string}>{
  if(!luckyPanelConfigured(env)) throw new Error("LUCKYPANEL_API_KEY_NOT_CONFIGURED");
  const balance=await luckyBalance(env);
  if(!isJpyCurrency(balance.currency)) throw new Error("LUCKYPANEL_CURRENCY_NOT_JPY");
  return balance;
}

async function privateLog(env:Env,guildId:string,payload:Record<string,unknown>){
  try{
    const settings=await getSmmSettings(env,guildId);
    if(!settings.private_log_channel_id) return;
    await smmSendMessage(env,settings.private_log_channel_id,{
      allowed_mentions:{parse:[]},
      ...payload
    });
  }catch(error){
    console.error("smm private log failed",guildId,error);
  }
}

async function publicLog(env:Env,guildId:string,payload:Record<string,unknown>){
  try{
    const settings=await getSmmSettings(env,guildId);
    if(!settings.public_log_channel_id) return;
    await smmSendMessage(env,settings.public_log_channel_id,{
      allowed_mentions:{parse:[]},
      ...payload
    });
  }catch(error){
    console.error("smm public log failed",guildId,error);
  }
}

/* ---------------- payment ---------------- */

async function paymentIdempotencyKey(order:SmmOrder,link:string){
  const hash=await sha256Hex(link);
  return "smm-pay:"+order.id+":"+hash.slice(0,16);
}

export type SmmPaymentOutcome=
  |{status:"completed";placed:"placed"|"retry"|"failed"|"hold"|"skipped"}
  |{status:"pending"}
  |{status:"rejected";reason:string};

export async function processSmmPayment(
  env:Env,
  order:SmmOrder,
  link:string
):Promise<SmmPaymentOutcome>{
  const result=await receiveMainPayment(env,{
    method:"paypay",
    link,
    amount:order.total_amount,
    idempotencyKey:await paymentIdempotencyKey(order,link),
    requirePayPayMoney:true
  });
  if(result.status==="completed"||result.ok){
    if(
      !result.ok||result.status!=="completed"||
      !Number.isSafeInteger(result.amount)||result.amount<order.total_amount
    ){
      throw new Error("PAYMENT_COMPLETION_AMOUNT_MISMATCH");
    }
    const first=await markSmmPaid(env,order);
    if(first){
      await privateLog(env,order.guild_id,{
        embeds:[{
          title:"フォロ爆 注文入金",
          color:5763719,
          fields:[
            {name:"注文ID",value:order.id,inline:false},
            {name:"商品",value:order.product_name,inline:true},
            {name:"数量",value:order.quantity.toLocaleString("ja-JP"),inline:true},
            {name:"金額",value:yen(order.total_amount),inline:true},
            {name:"購入者",value:"<@"+order.user_id+">",inline:true},
            {name:"対象",value:order.link.slice(0,1000),inline:false}
          ]
        }]
      });
    }
    const placed=await placeSmmOrder(env,order.id);
    return {status:"completed",placed};
  }
  if(result.status==="pending") return {status:"pending"};
  await clearSmmPaymentLink(env,order.id);
  return {status:"rejected",reason:result.reason};
}

/* ---------------- supplier placement ---------------- */

export type SmmPlaceResult="placed"|"retry"|"failed"|"hold"|"skipped";

async function failWithRefund(env:Env,order:SmmOrder,reason:string):Promise<SmmPlaceResult>{
  await markSmmFailed(env,order.id,reason,order.total_amount);
  await auditX(env,{
    level:"warn",
    kind:"SMM_ORDER_FAILED",
    message:"フォロ爆注文を発注できず失敗にしました。返金対応が必要です。",
    details:{orderId:order.id,reason}
  }).catch(()=>undefined);
  return "failed";
}

export async function placeSmmOrder(env:Env,orderId:string):Promise<SmmPlaceResult>{
  const queued=await getSmmOrder(env,orderId);
  if(!queued||queued.status!=="paid") return "skipped";
  if(!(await claimSmmPlacing(env,queued.id))) return "skipped";
  const order=(await getSmmOrder(env,queued.id))!;

  // 1) Pre-flight. Nothing has been sent to the supplier yet, so every failure
  // here is safe to retry or refund.
  try{
    const {map}=await smmServicesMap(env);
    const service=map.get(order.service_id);
    if(!service||!isSupportedSmmServiceType(service.type)||!Number.isFinite(service.rate)){
      return await failWithRefund(env,order,"SERVICE_UNAVAILABLE");
    }
    const bounds=smmQuantityBounds(service,{min_qty:1,max_qty:0});
    if(order.quantity<bounds.min||order.quantity>bounds.max){
      return await failWithRefund(env,order,"QUANTITY_OUT_OF_SUPPLIER_RANGE");
    }
    const settings=await getSmmSettings(env,order.guild_id);
    if(!smmQuoteIsProfitable(order.total_amount,service.rate,order.quantity,settings.min_margin_percent)){
      await markSmmHold(env,order.id,
        "PRICE_CHANGED: 仕入れ原価 "+yen(smmCost(service.rate,order.quantity))+" が支払額 "+yen(order.total_amount)+" の許容を超えています"
      );
      return "hold";
    }
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    if(placeRetryDecision(order.attempts)==="give_up"){
      return failWithRefund(env,order,"PREFLIGHT_"+message.slice(0,100));
    }
    await markSmmRetry(env,order.id,"PREFLIGHT_"+message,Date.now()+SMM_RETRY_DELAY_MS);
    return "retry";
  }

  // 2) The only call that creates something on the supplier side.
  let supplierOrderId:string;
  try{
    supplierOrderId=(await luckyAddOrder(env,{
      service:order.service_id,
      link:order.link,
      quantity:order.quantity
    })).order;
  }catch(error){
    if(error instanceof LuckyPanelError&&!error.ambiguous){
      if(
        error.code!=="LUCKYPANEL_API_KEY_NOT_CONFIGURED"&&
        isRetryableSupplierRejection(error.message)&&
        placeRetryDecision(order.attempts)==="retry"
      ){
        await markSmmRetry(env,order.id,error.message,Date.now()+SMM_RETRY_DELAY_MS);
        return "retry";
      }
      return failWithRefund(env,order,error.code+":"+error.message);
    }
    // The request may have been accepted. Never resend automatically.
    await markSmmHold(env,order.id,
      "PLACING_AMBIGUOUS: 発注が通ったか不明です。LuckyPanelの注文履歴を確認してください ("+
      (error instanceof Error?error.message:String(error)).slice(0,120)+")"
    );
    return "hold";
  }

  let saved=false;
  for(let attempt=0;attempt<3&&!saved;attempt++){
    try{saved=await markSmmPlaced(env,order.id,supplierOrderId);}catch{}
  }
  if(!saved){
    console.error("smm supplier order created but state write failed",order.id,supplierOrderId);
    await auditX(env,{
      level:"error",
      kind:"SMM_PLACED_STATE_WRITE_FAILED",
      message:"LuckyPanelへ発注済みですが注文状態を保存できませんでした。",
      details:{orderId:order.id,supplierOrderId}
    }).catch(()=>undefined);
    return "hold";
  }
  return "placed";
}

/* ---------------- supplier tracking ---------------- */

export async function trackSmmOrders(env:Env){
  const placed=await listSmmPlaced(env,100);
  if(!placed.length) return;
  const statuses=await luckyOrderStatuses(
    env,
    placed.map(order=>order.supplier_order_id!)
  );
  for(const order of placed){
    const status=statuses.get(order.supplier_order_id!);
    if(!status) continue;
    if("error" in status){
      await markSmmHold(env,order.id,"SUPPLIER_STATUS_ERROR: "+status.error);
      continue;
    }
    const mapped=mapSmmSupplierStatus(status.status);
    if(mapped.kind==="active"||mapped.kind==="unknown"){
      await updateSmmTracking(env,order.id,{
        supplier_status:status.status,
        start_count:status.start_count,
        remains:status.remains,
        charge:status.charge
      });
      continue;
    }
    if(mapped.kind==="completed"){
      await finalizeSmmOrder(env,order.id,"completed",0,status.status);
    }else if(mapped.kind==="partial"){
      if(status.remains===null){
        await markSmmHold(env,order.id,"PARTIAL_WITHOUT_REMAINS");
        continue;
      }
      await finalizeSmmOrder(
        env,order.id,"partial",
        smmRefundAmount(order.total_amount,order.quantity,status.remains,"partial"),
        status.status
      );
    }else{
      await finalizeSmmOrder(
        env,order.id,"canceled",
        smmRefundAmount(order.total_amount,order.quantity,order.quantity,"canceled"),
        status.status
      );
    }
  }
}

/* ---------------- notifications ---------------- */

async function notifyBuyers(env:Env){
  for(const order of await listSmmUnnotified(env,10)){
    try{
      await smmSendDm(env,order.user_id,buyerResultMessage(order));
      await markSmmNotified(env,order.id,true);
      if(order.status==="completed"){
        await publicLog(env,order.guild_id,{
          embeds:[{
            title:"フォロ爆 完了",
            color:5763719,
            fields:[
              {name:"商品",value:order.product_name,inline:true},
              {name:"数量",value:order.quantity.toLocaleString("ja-JP"),inline:true},
              {name:"購入者",value:"<@"+order.user_id+">",inline:true}
            ]
          }]
        });
      }
    }catch(error){
      console.error("smm buyer notification failed",order.id,error);
      await markSmmNotified(env,order.id,false);
    }
  }
}

async function alertAdmins(env:Env){
  for(const order of await listSmmNeedingAdminAlert(env,10)){
    const refund=order.refund_state==="required";
    await privateLog(env,order.guild_id,{
      embeds:[{
        title:refund?"フォロ爆 返金対応が必要です":"フォロ爆 注文の確認が必要です",
        color:refund?15548997:16705372,
        fields:[
          {name:"注文ID",value:order.id,inline:false},
          {name:"状態",value:order.status,inline:true},
          {name:"商品",value:order.product_name,inline:true},
          {name:"購入者",value:"<@"+order.user_id+">",inline:true},
          ...(refund?[{name:"返金額",value:yen(order.refund_amount),inline:true}]:[]),
          ...(order.last_error?[{name:"理由",value:order.last_error.slice(0,500),inline:false}]:[]),
          {name:"対象",value:order.link.slice(0,1000),inline:false}
        ]
      }]
    });
    await markSmmAdminAlerted(env,order.id);
  }
}

async function monitorSupplierBalance(env:Env){
  if(!luckyPanelConfigured(env)) return;
  const last=await getSmmMeta(env,"balance_checked");
  const now=Date.now();
  if(last&&now-last.updated_at<BALANCE_CHECK_INTERVAL_MS) return;
  await setSmmMeta(env,"balance_checked","1");
  let balance:{balance:number;currency:string};
  try{
    balance=await luckyBalance(env);
  }catch(error){
    console.error("smm balance check failed",error);
    return;
  }
  await setSmmMeta(env,"balance_json",JSON.stringify({...balance,at:now}));
  const lastAlert=await getSmmMeta(env,"balance_alert");
  if(lastAlert&&now-lastAlert.updated_at<BALANCE_ALERT_INTERVAL_MS) return;
  let alerted=false;
  for(const guildId of await listSmmGuildIds(env)){
    const settings=await getSmmSettings(env,guildId);
    if(settings.min_supplier_balance_jpy>0&&balance.balance<settings.min_supplier_balance_jpy){
      alerted=true;
      await privateLog(env,guildId,{
        embeds:[{
          title:"LuckyPanel 残高が下限を下回っています",
          color:15548997,
          description:"現在: "+yen(balance.balance)+" / 下限: "+yen(settings.min_supplier_balance_jpy)+
            "\nチャージしないと新規注文の発注ができません。"
        }]
      });
    }
  }
  if(alerted) await setSmmMeta(env,"balance_alert","1");
}

/* ---------------- admin actions ---------------- */

export type SmmAdminAction=
  |{action:"retry";confirmNotPlaced:boolean}
  |{action:"link_supplier";supplierOrderId:string}
  |{action:"cancel_supplier"}
  |{action:"fail_refund"}
  |{action:"refund_done"};

export async function smmAdminAction(
  env:Env,
  order:SmmOrder,
  input:SmmAdminAction
):Promise<{ok:boolean;detail?:string}>{
  switch(input.action){
    case "retry":{
      if(!input.confirmNotPlaced) return {ok:false,detail:"CONFIRM_NOT_PLACED_REQUIRED"};
      const released=await releaseSmmHold(env,order.id);
      if(!released) return {ok:false,detail:"ORDER_NOT_RETRYABLE"};
      await placeSmmOrder(env,order.id);
      return {ok:true};
    }
    case "link_supplier":{
      const id=input.supplierOrderId.trim();
      if(!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return {ok:false,detail:"SUPPLIER_ORDER_ID_INVALID"};
      const done=await markSmmPlaced(env,order.id,id);
      return {ok:done,detail:done?undefined:"ORDER_NOT_LINKABLE"};
    }
    case "cancel_supplier":{
      if(order.status!=="placed"||!order.supplier_order_id){
        return {ok:false,detail:"ORDER_NOT_PLACED"};
      }
      try{
        const canceled=await luckyCancel(env,order.supplier_order_id);
        return {ok:canceled,detail:canceled?"CANCEL_REQUESTED":"SUPPLIER_REFUSED_CANCEL"};
      }catch(error){
        return {ok:false,detail:error instanceof Error?error.message:String(error)};
      }
    }
    case "fail_refund":{
      const done=await markSmmFailed(env,order.id,"ADMIN_MARKED_FAILED",order.total_amount);
      return {ok:done,detail:done?undefined:"ORDER_NOT_FAILABLE"};
    }
    case "refund_done":{
      const done=await markSmmRefundDone(env,order.id);
      return {ok:done,detail:done?undefined:"NO_REFUND_PENDING"};
    }
  }
}

/* ---------------- cron ---------------- */

export async function smmSweep(env:Env){
  await expireSmmUnpaid(env);

  for(const order of await listSmmPendingPayments(env,8)){
    const link=await readSmmPaymentLink(env,order);
    if(!link) continue;
    try{
      await processSmmPayment(env,order,link);
    }catch(error){
      console.error("smm payment sweep failed",order.id,error);
    }
  }

  for(const order of await listSmmStalePlacing(env)){
    await markSmmHold(env,order.id,"PLACING_STALE: 発注処理が中断しました。LuckyPanelの注文履歴を確認してください").catch(()=>undefined);
  }

  for(const order of await listSmmReadyToPlace(env,10)){
    try{
      await placeSmmOrder(env,order.id);
    }catch(error){
      console.error("smm placement sweep failed",order.id,error);
    }
  }

  if(luckyPanelConfigured(env)){
    try{
      await trackSmmOrders(env);
    }catch(error){
      console.error("smm tracking failed",error);
    }
  }

  await notifyBuyers(env);
  await alertAdmins(env);
  await monitorSupplierBalance(env);
}
