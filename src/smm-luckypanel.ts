import type { Env } from "./types";

export const LUCKYPANEL_DEFAULT_API_URL="https://luckypanel.jp/api/v2";

export type LuckyService={
  service:string;
  name:string;
  type:string;
  category:string;
  rate:number;
  min:number;
  max:number;
  refill:boolean;
  cancel:boolean;
};

export type LuckyOrderStatus={
  charge:number;
  start_count:number|null;
  status:string;
  remains:number|null;
  currency:string;
};

export class LuckyPanelError extends Error{
  constructor(
    public code:string,
    // true when the request may have reached the supplier and succeeded.
    public ambiguous:boolean,
    message?:string
  ){
    super(message??code);
    this.name="LuckyPanelError";
  }
}

export function luckyPanelConfigured(env:Env):boolean{
  return Boolean(env.LUCKYPANEL_API_KEY?.trim());
}

function endpoint(env:Env):string{
  const raw=env.LUCKYPANEL_API_URL?.trim()||LUCKYPANEL_DEFAULT_API_URL;
  let url:URL;
  try{url=new URL(raw);}catch{throw new LuckyPanelError("LUCKYPANEL_API_URL_INVALID",false);}
  if(url.protocol!=="https:"||url.username||url.password){
    throw new LuckyPanelError("LUCKYPANEL_API_URL_MUST_BE_HTTPS",false);
  }
  return url.toString();
}

function toNumber(value:unknown,fallback=0):number{
  const n=Number(value);
  return Number.isFinite(n)?n:fallback;
}

function toNullableNumber(value:unknown):number|null{
  if(value===null||value===undefined||value==="") return null;
  const n=Number(value);
  return Number.isFinite(n)?n:null;
}

async function call(
  env:Env,
  params:Record<string,string>,
  timeoutMs=20_000
):Promise<unknown>{
  const key=env.LUCKYPANEL_API_KEY?.trim();
  if(!key) throw new LuckyPanelError("LUCKYPANEL_API_KEY_NOT_CONFIGURED",false);
  const body=new URLSearchParams({key,...params});
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  let response:Response;
  try{
    response=await fetch(endpoint(env),{
      method:"POST",
      headers:{
        "Content-Type":"application/x-www-form-urlencoded",
        "Accept":"application/json"
      },
      body,
      signal:controller.signal
    });
  }catch(error){
    if(error instanceof LuckyPanelError) throw error;
    throw new LuckyPanelError(
      "LUCKYPANEL_NETWORK_ERROR",
      true,
      error instanceof Error?error.message:"network error"
    );
  }finally{
    clearTimeout(timer);
  }

  const text=await response.text().catch(()=>"");
  let payload:unknown=null;
  try{payload=text?JSON.parse(text):null;}catch{}

  if(payload&&typeof payload==="object"&&!Array.isArray(payload)){
    const error=(payload as Record<string,unknown>).error;
    if(typeof error==="string"&&error){
      // The supplier answered with an explicit rejection, so nothing was created.
      throw new LuckyPanelError("LUCKYPANEL_REJECTED",false,error.slice(0,300));
    }
  }
  if(response.status>=500||response.status===429){
    throw new LuckyPanelError(
      "LUCKYPANEL_HTTP_"+response.status,
      true,
      text.slice(0,200)||("HTTP "+response.status)
    );
  }
  if(!response.ok){
    throw new LuckyPanelError(
      "LUCKYPANEL_HTTP_"+response.status,
      false,
      text.slice(0,200)||("HTTP "+response.status)
    );
  }
  if(payload===null){
    throw new LuckyPanelError("LUCKYPANEL_RESPONSE_INVALID",true,text.slice(0,200));
  }
  return payload;
}

export async function luckyServices(env:Env):Promise<LuckyService[]>{
  const payload=await call(env,{action:"services"},40_000);
  if(!Array.isArray(payload)) throw new LuckyPanelError("LUCKYPANEL_RESPONSE_INVALID",false);
  const services:LuckyService[]=[];
  for(const row of payload as Array<Record<string,unknown>>){
    const id=String(row.service??"").trim();
    if(!id) continue;
    services.push({
      service:id,
      name:String(row.name??"").slice(0,300),
      type:String(row.type??""),
      category:String(row.category??"").slice(0,200),
      rate:toNumber(row.rate,Number.NaN),
      min:Math.max(0,Math.floor(toNumber(row.min))),
      max:Math.max(0,Math.floor(toNumber(row.max))),
      refill:row.refill===true||row.refill===1||row.refill==="1",
      cancel:row.cancel===true||row.cancel===1||row.cancel==="1"
    });
  }
  return services;
}

export async function luckyBalance(env:Env):Promise<{balance:number;currency:string}>{
  const payload=await call(env,{action:"balance"}) as Record<string,unknown>;
  const balance=Number(payload.balance);
  if(!Number.isFinite(balance)) throw new LuckyPanelError("LUCKYPANEL_RESPONSE_INVALID",false);
  return {balance,currency:String(payload.currency??"")};
}

export async function luckyAddOrder(
  env:Env,
  input:{service:string;link:string;quantity:number}
):Promise<{order:string}>{
  const payload=await call(env,{
    action:"add",
    service:input.service,
    link:input.link,
    quantity:String(input.quantity)
  }) as Record<string,unknown>;
  const order=payload.order;
  if(order===undefined||order===null||String(order).trim()===""){
    // A 2xx reply without an order id means we cannot prove whether it was created.
    throw new LuckyPanelError("LUCKYPANEL_ORDER_ID_MISSING",true);
  }
  return {order:String(order)};
}

function parseStatus(raw:unknown):LuckyOrderStatus|{error:string}{
  if(!raw||typeof raw!=="object") return {error:"INVALID_STATUS_ENTRY"};
  const row=raw as Record<string,unknown>;
  if(typeof row.error==="string") return {error:row.error};
  return {
    charge:toNumber(row.charge),
    start_count:toNullableNumber(row.start_count),
    status:String(row.status??""),
    remains:toNullableNumber(row.remains),
    currency:String(row.currency??"")
  };
}

export async function luckyOrderStatuses(
  env:Env,
  orderIds:string[]
):Promise<Map<string,LuckyOrderStatus|{error:string}>>{
  const result=new Map<string,LuckyOrderStatus|{error:string}>();
  for(let i=0;i<orderIds.length;i+=100){
    const chunk=orderIds.slice(i,i+100);
    if(chunk.length===1){
      try{
        const payload=await call(env,{action:"status",order:chunk[0]!});
        result.set(chunk[0]!,parseStatus(payload));
      }catch(error){
        // A single-order query reports an unknown order as a top-level error.
        if(error instanceof LuckyPanelError&&!error.ambiguous&&error.code==="LUCKYPANEL_REJECTED"){
          result.set(chunk[0]!,{error:error.message});
        }else{
          throw error;
        }
      }
      continue;
    }
    const payload=await call(env,{action:"status",orders:chunk.join(",")}) as Record<string,unknown>;
    for(const id of chunk) result.set(id,parseStatus(payload[id]));
  }
  return result;
}

export async function luckyCancel(env:Env,orderId:string):Promise<boolean>{
  const payload=await call(env,{action:"cancel",orders:orderId});
  const first=Array.isArray(payload)?payload[0] as Record<string,unknown>|undefined:undefined;
  const cancel=first?.cancel;
  return cancel===1||cancel==="1"||cancel===true;
}
