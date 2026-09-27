import type { Env, SupplierRow } from "./types";
import { takePoolItems } from "./db";

export class SupplierError extends Error{
  constructor(
    public code:string,
    public retryable:boolean,
    message?:string
  ){super(message??code);}
}

type HttpJsonSupplierConfig={
  baseUrl?:string;
  acquirePath?:string;
  tokenBinding?:string;
  authHeader?:string;
  authScheme?:string;
  headers?:Record<string,string>;
  responseItemsPath?:string;
  idempotencyHeader?:string|null;
  idempotencyBodyField?:string|null;
};

function parseConfig<T>(raw:string):T{
  try{return JSON.parse(raw) as T;}catch{return {} as T;}
}

function secretBinding(env:Env,name?:string):string|null{
  if(!name) return null;
  const value=(env as unknown as Record<string,unknown>)[name];
  return typeof value==="string"&&value.trim()?value.trim():null;
}

function deepGet(value:unknown,path:string):unknown{
  let current:unknown=value;
  for(const part of path.split(".").filter(Boolean)){
    if(!current||typeof current!=="object") return undefined;
    current=(current as Record<string,unknown>)[part];
  }
  return current;
}

async function fetchWithTimeout(url:string,init:RequestInit,timeoutMs=15_000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{return await fetch(url,{...init,signal:controller.signal});}
  finally{clearTimeout(timer);}
}

async function acquireHttpJson(
  env:Env,
  supplier:SupplierRow,
  sku:string,
  quantity:number,
  idempotencyKey:string
):Promise<string[]>{
  const config=parseConfig<HttpJsonSupplierConfig>(supplier.config_json);
  if(!config.baseUrl) throw new SupplierError("SUPPLIER_CONFIG_INVALID",false);
  let base:URL;
  try{base=new URL(config.baseUrl);}catch{
    throw new SupplierError("SUPPLIER_CONFIG_INVALID",false);
  }
  if(base.protocol!=="https:"&&base.hostname!=="localhost"&&base.hostname!=="127.0.0.1"){
    throw new SupplierError("SUPPLIER_HTTPS_REQUIRED",false);
  }
  const url=new URL(config.acquirePath??"/acquire",base);
  const headers=new Headers({"Content-Type":"application/json",...(config.headers??{})});
  const idempotencyHeader=config.idempotencyHeader===null
    ?null
    :(config.idempotencyHeader??"Idempotency-Key");
  if(idempotencyHeader) headers.set(idempotencyHeader,idempotencyKey);
  if(config.tokenBinding){
    const token=secretBinding(env,config.tokenBinding);
    if(!token) throw new SupplierError("SUPPLIER_SECRET_MISSING",false);
    headers.set(
      config.authHeader??"Authorization",
      (config.authScheme??"Bearer")+" "+token
    );
  }

  let response:Response;
  try{
    const requestBody:Record<string,unknown>={sku,quantity};
    if(config.idempotencyBodyField){
      requestBody[config.idempotencyBodyField]=idempotencyKey;
    }
    response=await fetchWithTimeout(url.toString(),{
      method:"POST",
      headers,
      body:JSON.stringify(requestBody)
    });
  }catch(error){
    throw new SupplierError(
      "SUPPLIER_NETWORK_ERROR",
      true,
      error instanceof Error?error.message:"Supplier network error"
    );
  }

  const text=await response.text();
  let payload:unknown=null;
  try{payload=text?JSON.parse(text):null;}catch{}
  if(response.status===409||response.status===423){
    throw new SupplierError("OUT_OF_STOCK",true,"Supplier is out of stock");
  }
  if(!response.ok){
    throw new SupplierError(
      "SUPPLIER_HTTP_"+response.status,
      response.status===429||response.status>=500,
      text.slice(0,300)||("Supplier HTTP "+response.status)
    );
  }
  if(
    payload&&typeof payload==="object"&&
    (payload as Record<string,unknown>).outOfStock===true
  ){
    throw new SupplierError("OUT_OF_STOCK",true,"Supplier is out of stock");
  }

  const raw=deepGet(payload,config.responseItemsPath??"items");
  if(!Array.isArray(raw)){
    throw new SupplierError("SUPPLIER_RESPONSE_INVALID",false);
  }
  return raw.map(value=>String(value).trim()).filter(Boolean).slice(0,quantity);
}

export async function acquireFromSupplier(
  env:Env,
  supplier:SupplierRow,
  sku:string,
  quantity:number,
  idempotencyKey:string
):Promise<string[]>{
  if(!supplier.enabled) throw new SupplierError("SUPPLIER_DISABLED",false);
  if(quantity<=0) return [];
  if(supplier.kind==="pool"){
    const items=await takePoolItems(env,supplier.id,sku,quantity,idempotencyKey);
    if(items.length===0) throw new SupplierError("OUT_OF_STOCK",true);
    return items;
  }
  if(supplier.kind==="http_json"){
    return acquireHttpJson(env,supplier,sku,quantity,idempotencyKey);
  }
  throw new SupplierError("SUPPLIER_KIND_UNSUPPORTED",false);
}
