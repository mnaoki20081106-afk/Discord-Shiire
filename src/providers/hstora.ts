import type { Env } from "../types";
import { hmacHex, randomId, sha256Hex } from "../crypto";

const BASE_URL="https://hstora.com";

export type HstoraCatalogItem={
  id:number;
  name:string;
  slug:string;
  short_description:string;
  price:number;
  currency:string;
  delivery_type:string;
  stock_available:number;
  product_url:string;
  updated_at:string;
};

export type HstoraProduct=HstoraCatalogItem&{
  description:string;
  price_tiers:Array<{min_quantity:number;unit_price:number}>;
  rules:{
    delivery_type:string;
    instant_delivery:boolean;
    delivery_data_exposed:boolean;
  };
};

export type HstoraCatalogResponse={
  items:HstoraCatalogItem[];
  pagination:{page:number;limit:number;total:number;pages:number};
};

export type HstoraBalance={
  balance:number;
  pending_balance:number;
  currency:string;
};

export type HstoraOrder={
  id:number;
  order_number:string;
  external_order_id:string;
  status:string;
  quantity:number;
  unit_price:number;
  total_amount:number;
  currency:string;
  delivery_type:string;
  delivery?:{available:boolean;items?:unknown[]};
  links?:{web_url?:string;api_url?:string};
};

type ApiEnvelope<T>={
  success:boolean;
  data?:T;
  error?:{code?:string;message?:string;status?:number};
};

export class HstoraApiError extends Error{
  constructor(
    public status:number,
    public code:string,
    public retryable:boolean,
    message:string
  ){super(message);}
}

function credentials(env:Env){
  const key=env.HSTORA_API_KEY?.trim()??"";
  const secret=env.HSTORA_API_SECRET?.trim()??"";
  if(!key||!secret) throw new HstoraApiError(503,"HSTORA_NOT_CONFIGURED",false,"HStora API credentials are not configured");
  return {key,secret};
}

function nonce():string{
  const a=new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map(v=>v.toString(16).padStart(2,"0")).join("");
}

async function signedRequest<T>(
  env:Env,
  method:"GET"|"POST",
  path:string,
  query:string,
  body:unknown|null,
  idempotencyKey?:string
):Promise<T>{
  const {key,secret}=credentials(env);
  if(!path.startsWith("/api/v1/")&&path!=="/api/v1"){
    throw new HstoraApiError(500,"HSTORA_PATH_INVALID",false,"Refusing non-v1 HStora path");
  }

  const rawBody=body===null?"":JSON.stringify(body);
  const timestamp=String(Math.floor(Date.now()/1000));
  const requestNonce=nonce();
  const bodyHash=rawBody?await sha256Hex(rawBody):"";
  const canonical=[method,path,query,timestamp,requestNonce,bodyHash].join("\n");
  const signature=await hmacHex(secret,canonical);

  const headers=new Headers({
    "X-API-Key":key,
    "X-Timestamp":timestamp,
    "X-Nonce":requestNonce,
    "X-Signature":signature,
    "Accept":"application/json"
  });
  if(rawBody) headers.set("Content-Type","application/json");
  if(idempotencyKey) headers.set("Idempotency-Key",idempotencyKey);

  const url=BASE_URL+path+(query?"?"+query:"");
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),20_000);
  let response:Response;
  try{
    response=await fetch(url,{
      method,
      headers,
      body:rawBody||undefined,
      signal:controller.signal
    });
  }catch(error){
    throw new HstoraApiError(
      0,
      "HSTORA_NETWORK_ERROR",
      true,
      error instanceof Error?error.message:"HStora network error"
    );
  }finally{
    clearTimeout(timer);
  }

  const text=await response.text();
  let payload:ApiEnvelope<T>|null=null;
  try{payload=text?JSON.parse(text) as ApiEnvelope<T>:null;}catch{}
  if(!response.ok||!payload?.success){
    const code=String(payload?.error?.code??("HSTORA_HTTP_"+response.status));
    const message=String(payload?.error?.message??"HStora API request failed").slice(0,500);
    const retryable=response.status===409||response.status===429||response.status>=500||response.status===0;
    throw new HstoraApiError(response.status,code,retryable,message);
  }
  if(payload.data===undefined){
    throw new HstoraApiError(response.status,"HSTORA_RESPONSE_INVALID",false,"HStora response did not contain data");
  }
  return payload.data;
}

function positiveId(id:number){
  if(!Number.isInteger(id)||id<=0) throw new HstoraApiError(400,"HSTORA_PRODUCT_ID_INVALID",false,"Invalid HStora product id");
}

function record(value:unknown):value is Record<string,unknown>{
  return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
}

function schemaError(context:string):never{
  throw new HstoraApiError(
    502,
    "HSTORA_SCHEMA_CHANGED",
    false,
    "Unexpected HStora "+context+" response structure"
  );
}

function validateCatalogItem(value:unknown):HstoraCatalogItem{
  if(!record(value)) schemaError("catalog item");
  if(
    !Number.isInteger(Number(value.id))||
    typeof value.name!=="string"||
    typeof value.slug!=="string"||
    typeof value.short_description!=="string"||
    !Number.isFinite(Number(value.price))||
    typeof value.currency!=="string"||
    typeof value.delivery_type!=="string"||
    !Number.isFinite(Number(value.stock_available))||
    typeof value.product_url!=="string"||
    typeof value.updated_at!=="string"
  ) schemaError("catalog item");
  return value as unknown as HstoraCatalogItem;
}

function validateProduct(value:unknown):HstoraProduct{
  const base=validateCatalogItem(value);
  if(
    !record(value)||
    typeof value.description!=="string"||
    !Array.isArray(value.price_tiers)||
    !record(value.rules)
  ) schemaError("product");
  for(const tier of value.price_tiers){
    if(
      !record(tier)||
      !Number.isFinite(Number(tier.min_quantity))||
      !Number.isFinite(Number(tier.unit_price))
    ) schemaError("product price tier");
  }
  if(
    typeof value.rules.delivery_type!=="string"||
    typeof value.rules.instant_delivery!=="boolean"||
    typeof value.rules.delivery_data_exposed!=="boolean"
  ) schemaError("product rules");
  return {...base,...value} as unknown as HstoraProduct;
}

function validateBalance(value:unknown):HstoraBalance{
  if(
    !record(value)||
    !Number.isFinite(Number(value.balance))||
    !Number.isFinite(Number(value.pending_balance))||
    typeof value.currency!=="string"
  ) schemaError("balance");
  return value as unknown as HstoraBalance;
}

function validateOrder(value:unknown):HstoraOrder{
  if(
    !record(value)||
    !Number.isInteger(Number(value.id))||
    typeof value.order_number!=="string"||
    typeof value.external_order_id!=="string"||
    typeof value.status!=="string"||
    !Number.isFinite(Number(value.quantity))||
    !Number.isFinite(Number(value.unit_price))||
    !Number.isFinite(Number(value.total_amount))||
    typeof value.currency!=="string"||
    typeof value.delivery_type!=="string"
  ) schemaError("order");
  if(value.delivery!==undefined){
    if(!record(value.delivery)||typeof value.delivery.available!=="boolean"){
      schemaError("order delivery");
    }
    if(value.delivery.items!==undefined&&!Array.isArray(value.delivery.items)){
      schemaError("order delivery items");
    }
  }
  return value as unknown as HstoraOrder;
}

export async function hstoraMetadata(){
  const response=await fetch(BASE_URL+"/api/v1/",{headers:{Accept:"application/json"}});
  if(!response.ok) throw new HstoraApiError(response.status,"HSTORA_METADATA_FAILED",response.status>=500,"HStora metadata request failed");
  return response.json();
}

export async function listHstoraCatalog(env:Env,page=1,limit=20):Promise<HstoraCatalogResponse>{
  const safePage=Math.max(1,Math.floor(page));
  // 20 is the documented production example. Do not assume an undocumented max.
  const safeLimit=limit===20?20:20;
  const response=await signedRequest<unknown>(
    env,"GET","/api/v1/catalog",`page=${safePage}&limit=${safeLimit}`,null
  );
  if(!record(response)||!Array.isArray(response.items)||!record(response.pagination)){
    schemaError("catalog");
  }
  const pagination=response.pagination;
  if(
    !Number.isFinite(Number(pagination.page))||
    !Number.isFinite(Number(pagination.limit))||
    !Number.isFinite(Number(pagination.total))||
    !Number.isFinite(Number(pagination.pages))
  ) schemaError("catalog pagination");
  return {
    items:response.items.map(validateCatalogItem),
    pagination:pagination as unknown as HstoraCatalogResponse["pagination"]
  };
}

export async function getHstoraProduct(env:Env,id:number):Promise<HstoraProduct>{
  positiveId(id);
  return validateProduct(
    await signedRequest<unknown>(env,"GET",`/api/v1/products/${id}`,"",null)
  );
}

export async function getHstoraBalance(env:Env):Promise<HstoraBalance>{
  return validateBalance(
    await signedRequest<unknown>(env,"GET","/api/v1/balance","",null)
  );
}

export async function createHstoraOrder(env:Env,input:{
  productId:number;
  quantity:number;
  externalOrderId:string;
  idempotencyKey:string;
}):Promise<HstoraOrder>{
  positiveId(input.productId);
  if(!Number.isInteger(input.quantity)||input.quantity<=0){
    throw new HstoraApiError(400,"HSTORA_QUANTITY_INVALID",false,"Invalid HStora quantity");
  }
  if(!input.externalOrderId.trim()||!input.idempotencyKey.trim()){
    throw new HstoraApiError(400,"HSTORA_IDEMPOTENCY_REQUIRED",false,"Stable purchase identifiers are required");
  }
  return validateOrder(await signedRequest<unknown>(
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
  ));
}

export async function getHstoraOrder(env:Env,id:number):Promise<HstoraOrder>{
  if(!Number.isInteger(id)||id<=0) throw new HstoraApiError(400,"HSTORA_ORDER_ID_INVALID",false,"Invalid HStora order id");
  return validateOrder(
    await signedRequest<unknown>(env,"GET",`/api/v1/orders/${id}`,"",null)
  );
}

export async function lookupHstoraOrder(env:Env,externalOrderId:string):Promise<HstoraOrder>{
  const id=externalOrderId.trim();
  if(!id) throw new HstoraApiError(400,"HSTORA_EXTERNAL_ORDER_ID_INVALID",false,"External order id is required");
  return validateOrder(await signedRequest<unknown>(
    env,
    "GET",
    "/api/v1/orders/lookup",
    "external_order_id="+encodeURIComponent(id),
    null
  ));
}

export function newHstoraPurchaseIds(){
  const id=randomId();
  return {
    externalOrderId:"xproc-"+id,
    idempotencyKey:"xproc-idem-"+id
  };
}


export type HstoraWebhookVerification={
  deliveryId:string;
  eventId:string;
  eventType:string;
  timestamp:string;
};

function safeHexEqual(left:string,right:string){
  const a=left.toLowerCase();
  const b=right.toLowerCase();
  if(!/^[0-9a-f]+$/.test(a)||a.length!==b.length) return false;
  let diff=0;
  for(let i=0;i<a.length;i++) diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}

export async function verifyHstoraWebhook(
  env:Env,
  request:Request,
  rawBody:string
):Promise<HstoraWebhookVerification>{
  const secret=env.HSTORA_WEBHOOK_SECRET?.trim()??"";
  if(!secret){
    throw new HstoraApiError(
      503,
      "HSTORA_WEBHOOK_SECRET_NOT_CONFIGURED",
      false,
      "HStora webhook secret is not configured"
    );
  }

  const timestamp=request.headers.get("X-HStore-Webhook-Timestamp")??"";
  const deliveryId=request.headers.get("X-HStore-Delivery-Id")??"";
  const eventId=request.headers.get("X-HStore-Event-Id")??"";
  const eventType=request.headers.get("X-HStore-Webhook-Event")??"";
  const version=request.headers.get("X-HStore-Signature-Version")??"";
  const signature=(request.headers.get("X-HStore-Webhook-Signature")??"").toLowerCase();

  if(!timestamp||!deliveryId||!eventId||!eventType||!signature){
    throw new HstoraApiError(401,"HSTORA_WEBHOOK_HEADERS_MISSING",false,"Missing HStora webhook headers");
  }
  if(version&&version!=="v1"){
    throw new HstoraApiError(401,"HSTORA_WEBHOOK_VERSION_UNSUPPORTED",false,"Unsupported HStora webhook signature version");
  }
  if(!/^\d+$/.test(timestamp)){
    throw new HstoraApiError(401,"HSTORA_WEBHOOK_TIMESTAMP_INVALID",false,"Invalid HStora webhook timestamp");
  }

  const bodyHash=await sha256Hex(rawBody);
  const canonical=[timestamp,deliveryId,eventId,eventType,bodyHash].join("\n");
  const expected=await hmacHex(secret,canonical);
  if(!safeHexEqual(expected,signature)){
    throw new HstoraApiError(401,"HSTORA_WEBHOOK_SIGNATURE_INVALID",false,"Invalid HStora webhook signature");
  }

  return {deliveryId,eventId,eventType,timestamp};
}
