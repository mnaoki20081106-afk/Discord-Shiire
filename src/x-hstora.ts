import type { Env } from "./types";
import { hmacHex, sha256Hex } from "./crypto";

const BASE_URL="https://hstora.com";

export class HStoraError extends Error{
  constructor(
    public code:string,
    public status:number,
    public retryable:boolean,
    message?:string
  ){super(message??code);}
}

export type HStoraCatalogItem={
  id:number;
  name:string;
  slug?:string;
  short_description?:string;
  price:number;
  currency:string;
  delivery_type?:string;
  stock_available:number;
  product_url?:string;
  updated_at?:string;
};

export type HStoraProduct=HStoraCatalogItem&{
  description?:string;
  price_tiers?:Array<{min_quantity:number;unit_price:number}>;
  rules?:{
    delivery_type?:string;
    instant_delivery?:boolean;
    delivery_data_exposed?:boolean;
  };
};

export type HStoraBalance={
  balance:number;
  pending_balance:number;
  currency:string;
};

export type HStoraOrder={
  id:number;
  order_number?:string;
  external_order_id:string;
  status:string;
  quantity:number;
  unit_price:number;
  total_amount:number;
  currency:string;
  delivery_type?:string;
  delivery?:{
    available:boolean;
    items?:unknown[];
  };
  links?:{
    web_url?:string;
    api_url?:string;
  };
};

type Envelope<T>={
  success:boolean;
  data?:T;
  error?:{code?:string;message?:string;status?:number};
};

function requireKeys(env:Env){
  const key=env.HSTORA_API_KEY?.trim()??"";
  const secret=env.HSTORA_API_SECRET?.trim()??"";
  if(!key||!secret) throw new HStoraError("HSTORA_KEYS_NOT_CONFIGURED",503,false);
  return {key,secret};
}

async function signedRequest<T>(
  env:Env,
  method:"GET"|"POST",
  path:string,
  query="",
  payload?:unknown,
  idempotencyKey?:string
):Promise<T>{
  const {key,secret}=requireKeys(env);
  const rawBody=payload===undefined?"":JSON.stringify(payload);
  const timestamp=String(Math.floor(Date.now()/1000));
  const nonce=crypto.randomUUID().replace(/-/g,"");
  const bodyHash=rawBody?await sha256Hex(rawBody):"";
  const canonical=[method,path,query,timestamp,nonce,bodyHash].join("\n");
  const signature=await hmacHex(secret,canonical);

  const headers=new Headers({
    "X-API-Key":key,
    "X-Timestamp":timestamp,
    "X-Nonce":nonce,
    "X-Signature":signature
  });
  if(rawBody) headers.set("Content-Type","application/json");
  if(idempotencyKey) headers.set("Idempotency-Key",idempotencyKey);

  const url=BASE_URL+path+(query?"?"+query:"");
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15_000);
  let response:Response;
  try{
    response=await fetch(url,{
      method,
      headers,
      body:rawBody||undefined,
      signal:controller.signal
    });
  }catch(error){
    throw new HStoraError(
      "HSTORA_NETWORK_ERROR",
      0,
      true,
      error instanceof Error?error.message:"HStora network error"
    );
  }finally{
    clearTimeout(timer);
  }

  const text=await response.text();
  let parsed:Envelope<T>|null=null;
  try{parsed=text?JSON.parse(text) as Envelope<T>:null;}catch{}

  if(!response.ok||!parsed?.success||parsed.data===undefined){
    const code=parsed?.error?.code??("HSTORA_HTTP_"+response.status);
    const message=parsed?.error?.message??("HStora HTTP "+response.status);
    const retryable=response.status===429||response.status>=500||
      code==="request_in_progress"||code==="rate_limited";
    throw new HStoraError(code,response.status,retryable,message);
  }
  return parsed.data;
}

export async function hstoraCatalog(env:Env,input:{
  page?:number;
  limit?:number;
  productId?:number;
}={}){
  const params=new URLSearchParams();
  if(input.productId!==undefined) params.set("product_id",String(input.productId));
  else{
    params.set("page",String(Math.max(1,Math.floor(input.page??1))));
    params.set("limit",String(Math.max(1,Math.min(100,Math.floor(input.limit??50)))));
  }
  return signedRequest<{
    items:HStoraCatalogItem[];
    pagination?:{page:number;limit:number;total:number;pages:number};
  }>(env,"GET","/api/v1/catalog",params.toString());
}

export async function hstoraProduct(env:Env,productId:number){
  if(!Number.isInteger(productId)||productId<=0) throw new HStoraError("INVALID_PRODUCT_ID",400,false);
  return signedRequest<HStoraProduct>(
    env,"GET","/api/v1/products/"+encodeURIComponent(String(productId))
  );
}

export async function hstoraBalance(env:Env){
  return signedRequest<HStoraBalance>(env,"GET","/api/v1/balance");
}

export async function hstoraCreateOrder(env:Env,input:{
  productId:number;
  quantity:number;
  externalOrderId:string;
  idempotencyKey:string;
}){
  if(!Number.isInteger(input.productId)||input.productId<=0) throw new HStoraError("INVALID_PRODUCT_ID",400,false);
  if(!Number.isInteger(input.quantity)||input.quantity<=0) throw new HStoraError("INVALID_QUANTITY",400,false);
  if(!input.externalOrderId.trim()) throw new HStoraError("EXTERNAL_ORDER_ID_REQUIRED",400,false);
  if(!input.idempotencyKey.trim()) throw new HStoraError("IDEMPOTENCY_KEY_REQUIRED",400,false);
  return signedRequest<HStoraOrder>(
    env,
    "POST",
    "/api/v1/orders",
    "",
    {
      product_id:input.productId,
      quantity:input.quantity,
      external_order_id:input.externalOrderId
    },
    input.idempotencyKey
  );
}

export async function hstoraOrder(env:Env,orderId:number){
  if(!Number.isInteger(orderId)||orderId<=0) throw new HStoraError("INVALID_ORDER_ID",400,false);
  return signedRequest<HStoraOrder>(
    env,"GET","/api/v1/orders/"+encodeURIComponent(String(orderId))
  );
}

export async function hstoraLookupOrder(env:Env,externalOrderId:string){
  const id=externalOrderId.trim();
  if(!id) throw new HStoraError("EXTERNAL_ORDER_ID_REQUIRED",400,false);
  const query=new URLSearchParams({external_order_id:id}).toString();
  return signedRequest<HStoraOrder>(
    env,"GET","/api/v1/orders/lookup",query
  );
}

function constantTimeEqualHex(a:string,b:string):boolean{
  const left=a.toLowerCase();
  const right=b.toLowerCase();
  if(left.length!==right.length||left.length===0) return false;
  let diff=0;
  for(let i=0;i<left.length;i++) diff|=left.charCodeAt(i)^right.charCodeAt(i);
  return diff===0;
}

export async function verifyHStoraWebhook(
  env:Env,
  request:Request,
  rawBody:string
):Promise<{eventId:string;deliveryId:string;eventType:string}>{
  const secret=env.HSTORA_WEBHOOK_SECRET?.trim()??"";
  if(!secret) throw new HStoraError("HSTORA_WEBHOOK_SECRET_NOT_CONFIGURED",503,false);

  const timestamp=request.headers.get("X-HStore-Webhook-Timestamp")??"";
  const deliveryId=request.headers.get("X-HStore-Delivery-Id")??"";
  const eventId=request.headers.get("X-HStore-Event-Id")??"";
  const eventType=request.headers.get("X-HStore-Webhook-Event")??"";
  const signature=(request.headers.get("X-HStore-Webhook-Signature")??"").toLowerCase();
  if(!timestamp||!deliveryId||!eventId||!eventType||!signature){
    throw new HStoraError("HSTORA_WEBHOOK_HEADERS_MISSING",401,false);
  }

  const ts=Number(timestamp);
  if(!Number.isFinite(ts)||Math.abs(Date.now()/1000-ts)>300){
    throw new HStoraError("HSTORA_WEBHOOK_TIMESTAMP_INVALID",401,false);
  }

  const bodyHash=await sha256Hex(rawBody);
  const canonical=[timestamp,deliveryId,eventId,eventType,bodyHash].join("\n");
  const expected=await hmacHex(secret,canonical);
  if(!constantTimeEqualHex(expected,signature)){
    throw new HStoraError("HSTORA_WEBHOOK_SIGNATURE_INVALID",401,false);
  }
  return {eventId,deliveryId,eventType};
}
