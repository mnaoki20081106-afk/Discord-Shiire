import type { Env } from "./types";
import { HstoraApiError, verifyHstoraWebhook } from "./providers/hstora";
import {
  auditX,
  claimHstoraWebhookDelivery,
  setCircuitBreaker
} from "./x-db";
import { reconcilePendingXOrders } from "./x-engine";
import { notifyDiscord } from "./x-alerts";

function json(data:unknown,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store"
    }
  });
}

const ORDER_RECONCILE_EVENTS=new Set([
  "order.created",
  "order.updated",
  "order.delivered",
  "order.completed",
  "order.refunded",
  "order.disputed"
]);

export async function handleHstoraWebhook(
  request:Request,
  env:Env
):Promise<Response>{
  if(request.method!=="POST"){
    return json({error:"METHOD_NOT_ALLOWED"},405);
  }

  const rawBody=await request.text();
  let verification;
  try{
    verification=await verifyHstoraWebhook(env,request,rawBody);
  }catch(error){
    const status=error instanceof HstoraApiError
      ?Math.max(400,Math.min(599,error.status||401))
      :401;
    return json({
      error:error instanceof HstoraApiError?error.code:"HSTORA_WEBHOOK_REJECTED"
    },status);
  }

  let payload:unknown={};
  if(rawBody){
    try{
      payload=JSON.parse(rawBody);
    }catch{
      return json({error:"INVALID_JSON"},400);
    }
  }

  if(payload&&typeof payload==="object"){
    const bodyType=(payload as Record<string,unknown>).type;
    if(
      typeof bodyType==="string"&&
      bodyType.length>0&&
      bodyType!==verification.eventType
    ){
      return json({error:"EVENT_TYPE_MISMATCH"},400);
    }
  }

  const claimed=await claimHstoraWebhookDelivery(
    env,
    verification.deliveryId,
    verification.eventId,
    verification.eventType
  );
  if(!claimed){
    return json({ok:true,duplicate:true});
  }

  await auditX(env,{
    kind:"HSTORA_WEBHOOK",
    message:"Verified HStora webhook received.",
    details:{
      deliveryId:verification.deliveryId,
      eventId:verification.eventId,
      eventType:verification.eventType
    }
  });

  if(ORDER_RECONCILE_EVENTS.has(verification.eventType)){
    await reconcilePendingXOrders(env);
  }

  if(
    verification.eventType==="order.refunded"||
    verification.eventType==="order.disputed"
  ){
    await setCircuitBreaker(
      env,
      "hstora_order_alert",
      "OPEN",
      verification.eventType.toUpperCase()
    );
    await notifyDiscord(env,{
      title:"HStora注文アラート",
      message:"返金またはdisputeイベントを受信したため、自動仕入れを停止しました。",
      level:"error",
      details:{
        eventType:verification.eventType,
        eventId:verification.eventId
      }
    }).catch(()=>undefined);
  }

  if(
    verification.eventType==="product.price_changed"||
    verification.eventType==="product.stock_changed"||
    verification.eventType==="product.tiers_changed"
  ){
    await auditX(env,{
      kind:"HSTORA_PRODUCT_CHANGE",
      message:"HStora product change event received; next procurement run will re-fetch product details.",
      details:{
        eventType:verification.eventType,
        eventId:verification.eventId
      }
    });
  }

  return json({ok:true});
}
