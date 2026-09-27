import type { Env } from "./types";
import { hmacHex, randomId } from "./crypto";

function baseUrl(env:Env):URL{
  const raw=env.MAIN_BOT_BASE_URL?.trim();
  if(!raw) throw new Error("MAIN_BOT_BASE_URL_NOT_CONFIGURED");
  return new URL(raw.endsWith("/")?raw:raw+"/");
}

async function signedFetch(
  env:Env,
  path:string,
  init:RequestInit={}
):Promise<Response>{
  const secret=env.SHIIRE_BRIDGE_SECRET?.trim()??"";
  if(secret.length<32) throw new Error("SHIIRE_BRIDGE_SECRET_NOT_CONFIGURED");
  const url=new URL(path.replace(/^\//,""),baseUrl(env));
  const method=String(init.method??"GET").toUpperCase();
  const body=typeof init.body==="string"?init.body:"";
  const timestamp=String(Date.now());
  const nonce=randomId();
  const canonical=
    timestamp+"\n"+
    nonce+"\n"+
    method+"\n"+
    url.pathname+url.search+"\n"+
    body;
  const signature=await hmacHex(secret,canonical);
  const headers=new Headers(init.headers);
  headers.set("X-Shiire-Timestamp",timestamp);
  headers.set("X-Shiire-Nonce",nonce);
  headers.set("X-Shiire-Signature",signature);
  if(body&&!headers.has("Content-Type")) headers.set("Content-Type","application/json");

  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15_000);
  try{
    return await fetch(url.toString(),{
      ...init,
      method,
      body:body||undefined,
      headers,
      signal:controller.signal
    });
  }finally{
    clearTimeout(timer);
  }
}

async function responseJson<T>(response:Response):Promise<T>{
  const text=await response.text();
  if(!response.ok){
    let message=text;
    try{
      const parsed=JSON.parse(text) as {error?:string;message?:string};
      message=parsed.message??parsed.error??text;
    }catch{}
    throw new Error("MAIN_BOT_"+response.status+":"+message.slice(0,300));
  }
  return (text?JSON.parse(text):{}) as T;
}

export async function getMainStock(env:Env,mainProductId:string){
  const response=await signedFetch(
    env,
    "/api/vending/supply/products/"+encodeURIComponent(mainProductId)+"/stock"
  );
  return responseJson<{
    productId:string;
    name:string;
    available:number;
    infinite:boolean;
  }>(response);
}

export async function deliverToMain(
  env:Env,
  input:{mainProductId:string;items:string[];idempotencyKey:string}
){
  const body=JSON.stringify({
    productId:input.mainProductId,
    items:input.items,
    idempotencyKey:input.idempotencyKey
  });
  const response=await signedFetch(env,"/api/vending/supply/deliver",{
    method:"POST",
    body
  });
  return responseJson<{
    ok:boolean;
    productId:string;
    added:number;
    skipped?:number;
    available?:number;
    duplicateRequest?:boolean;
  }>(response);
}

export async function getMainCatalog(env:Env){
  const response=await signedFetch(env,"/api/vending/supply/catalog");
  return responseJson<{
    products:Array<{
      product_id:string;
      product_name:string;
      vending_machine_id:string;
      vending_machine_name:string;
      guild_id:string;
      available:number;
    }>;
  }>(response);
}
