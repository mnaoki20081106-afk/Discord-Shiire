import type { Env, ProcessorKind } from "./types";

export class ProcessorError extends Error{
  constructor(
    public code:string,
    public retryable:boolean,
    message?:string
  ){super(message??code);}
}

type HttpProcessorConfig={
  baseUrl?:string;
  path?:string;
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

function deepGet(value:unknown,path:string):unknown{
  let current:unknown=value;
  for(const part of path.split(".").filter(Boolean)){
    if(!current||typeof current!=="object") return undefined;
    current=(current as Record<string,unknown>)[part];
  }
  return current;
}

function envSecret(env:Env,name?:string):string|null{
  if(!name) return null;
  const value=(env as unknown as Record<string,unknown>)[name];
  return typeof value==="string"&&value.trim()?value.trim():null;
}

export async function processItems(
  env:Env,
  kind:ProcessorKind,
  rawConfig:string,
  items:string[],
  idempotencyKey:string
):Promise<string[]>{
  if(kind==="identity") return items;
  if(kind!=="http_json") throw new ProcessorError("PROCESSOR_UNSUPPORTED",false);

  const config=parseConfig<HttpProcessorConfig>(rawConfig);
  if(!config.baseUrl) throw new ProcessorError("PROCESSOR_CONFIG_INVALID",false);
  let base:URL;
  try{base=new URL(config.baseUrl);}catch{
    throw new ProcessorError("PROCESSOR_CONFIG_INVALID",false);
  }
  if(base.protocol!=="https:"&&base.hostname!=="localhost"&&base.hostname!=="127.0.0.1"){
    throw new ProcessorError("PROCESSOR_HTTPS_REQUIRED",false);
  }
  const url=new URL(config.path??"/process",base);
  const headers=new Headers({"Content-Type":"application/json",...(config.headers??{})});
  const idempotencyHeader=config.idempotencyHeader===null
    ?null
    :(config.idempotencyHeader??"Idempotency-Key");
  if(idempotencyHeader) headers.set(idempotencyHeader,idempotencyKey);
  if(config.tokenBinding){
    const token=envSecret(env,config.tokenBinding);
    if(!token) throw new ProcessorError("PROCESSOR_SECRET_MISSING",false);
    headers.set(
      config.authHeader??"Authorization",
      (config.authScheme??"Bearer")+" "+token
    );
  }

  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),20_000);
  let response:Response;
  try{
    const requestBody:Record<string,unknown>={items};
    if(config.idempotencyBodyField){
      requestBody[config.idempotencyBodyField]=idempotencyKey;
    }
    response=await fetch(url.toString(),{
      method:"POST",
      headers,
      body:JSON.stringify(requestBody),
      signal:controller.signal
    });
  }catch(error){
    throw new ProcessorError(
      "PROCESSOR_NETWORK_ERROR",
      true,
      error instanceof Error?error.message:"Processor network error"
    );
  }finally{
    clearTimeout(timer);
  }

  const text=await response.text();
  let payload:unknown=null;
  try{payload=text?JSON.parse(text):null;}catch{}
  if(!response.ok){
    throw new ProcessorError(
      "PROCESSOR_HTTP_"+response.status,
      response.status===429||response.status>=500,
      text.slice(0,300)
    );
  }
  const raw=deepGet(payload,config.responseItemsPath??"items");
  if(!Array.isArray(raw)) throw new ProcessorError("PROCESSOR_RESPONSE_INVALID",false);
  return raw.map(value=>String(value).trim()).filter(Boolean);
}
