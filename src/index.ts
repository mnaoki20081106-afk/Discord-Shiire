import type { Env, ProcessorKind, SupplierKind } from "./types";
import {
  addPoolItems,
  createProduct,
  createSupplier,
  dashboardSnapshot,
  ensureSchema,
  getProduct,
  getSupplier,
  latestJob,
  listProducts,
  listSuppliers
} from "./db";
import { getMainCatalog, getMainStock } from "./main-bot";
import { runAllProducts, runProduct } from "./engine";
import { handleXAdminApi, xAdminPage } from "./x-admin";
import { runLtcAutoPurchase, runXProcurement } from "./x-engine";
import { loadXSettings } from "./x-settings";
import { handleHstoraWebhook } from "./x-webhooks";
import {
  handleShiireVendingInteraction,
  handleShiireMainBridge,
  handleShiireVendingMedia,
  shiireVendingSweep,
  ShiireVendingError
} from "./shiire-vending";

class HttpError extends Error{
  constructor(public status:number,message:string){super(message);}
}

function json(data:unknown,status=200):Response{
  return new Response(JSON.stringify(data),{
    status,
    headers:{
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store"
    }
  });
}

function requireAdmin(request:Request,env:Env){
  const expected=env.ADMIN_TOKEN?.trim()??"";
  if(expected.length<32) throw new HttpError(503,"ADMIN_TOKEN_NOT_CONFIGURED");
  const auth=request.headers.get("Authorization")??"";
  if(auth!==`Bearer ${expected}`) throw new HttpError(401,"UNAUTHORIZED");
}

async function body<T>(request:Request):Promise<T>{
  try{return await request.json() as T;}
  catch{throw new HttpError(400,"INVALID_JSON");}
}

function positiveInt(value:unknown,name:string){
  const n=Number(value);
  if(!Number.isInteger(n)||n<0) throw new HttpError(400,"INVALID_"+name.toUpperCase());
  return n;
}

function option(interaction:any,name:string):string|null{
  const found=interaction?.data?.options?.find((item:any)=>item?.name===name);
  return found?.value==null?null:String(found.value);
}

function canManage(interaction:any):boolean{
  try{
    const permissions=BigInt(interaction?.member?.permissions??"0");
    return (permissions&8n)===8n||(permissions&32n)===32n;
  }catch{return false;}
}

function hexBytes(value:string):Uint8Array|null{
  if(!/^[0-9a-f]+$/i.test(value)||value.length%2!==0) return null;
  const out=new Uint8Array(value.length/2);
  for(let i=0;i<out.length;i++) out[i]=parseInt(value.slice(i*2,i*2+2),16);
  return out;
}

async function verifyInteraction(
  request:Request,
  env:Env,
  text:string
):Promise<boolean>{
  const publicKey=env.DISCORD_PUBLIC_KEY?.trim();
  const signature=request.headers.get("X-Signature-Ed25519")??"";
  const timestamp=request.headers.get("X-Signature-Timestamp")??"";
  if(!publicKey||!signature||!timestamp) return false;
  const keyBytes=hexBytes(publicKey);
  const sigBytes=hexBytes(signature);
  if(!keyBytes||!sigBytes) return false;
  const key=await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    {name:"Ed25519"} as AlgorithmIdentifier,
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    {name:"Ed25519"} as AlgorithmIdentifier,
    key,
    sigBytes.buffer as ArrayBuffer,
    new TextEncoder().encode(timestamp+text)
  );
}

function interactionResponse(content:string){
  return json({
    type:4,
    data:{content,flags:64}
  });
}

function deferredInteraction(){
  return json({type:5,data:{flags:64}});
}

async function editInteractionOriginal(
  interaction:any,
  content:string
){
  const applicationId=String(interaction.application_id??"");
  const token=String(interaction.token??"");
  if(!applicationId||!token) return;
  const response=await fetch(
    "https://discord.com/api/v10/webhooks/"+
      encodeURIComponent(applicationId)+"/"+
      encodeURIComponent(token)+
      "/messages/@original",
    {
      method:"PATCH",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({content:content.slice(0,2000)})
    }
  );
  if(!response.ok){
    console.error(
      "Discord interaction edit failed",
      response.status,
      (await response.text()).slice(0,300)
    );
  }
}

async function handleInteraction(
  request:Request,
  env:Env,
  ctx:ExecutionContext
):Promise<Response>{
  const raw=await request.text();
  if(!(await verifyInteraction(request,env,raw))){
    return new Response("invalid signature",{status:401});
  }
  const interaction=JSON.parse(raw);
  if(interaction.type===1) return json({type:1});
  if(interaction.type===3||interaction.type===5){
    const vending=await handleShiireVendingInteraction(interaction,env);
    if(vending) return vending;
    return interactionResponse("未対応の操作です。");
  }
  if(interaction.type!==2) return interactionResponse("未対応の操作です。");
  if(!canManage(interaction)){
    return interactionResponse("このコマンドには「サーバー管理」権限が必要です。");
  }

  const name=String(interaction.data?.name??"");
  if(name==="shiire-status"){
    ctx.waitUntil((async()=>{
      try{
        const products=await listProducts(env);
        if(products.length===0){
          await editInteractionOriginal(interaction,"仕入れ商品がまだ登録されていません。");
          return;
        }
        const lines:string[]=[];
        for(const product of products.slice(0,15)){
          let stockText="取得失敗";
          try{
            const stock=await getMainStock(env,product.main_product_id);
            stockText=String(stock.available);
          }catch{}
          const job=await latestJob(env,product.id);
          lines.push(
            `**${product.name}** 在庫 ${stockText} / 下限 ${product.min_stock} / 目標 ${product.target_stock}`+
            (job?`\n└ 最終ジョブ: ${job.status}`:"")
          );
        }
        await editInteractionOriginal(interaction,lines.join("\n"));
      }catch(error){
        await editInteractionOriginal(
          interaction,
          "状態確認に失敗しました: "+(error instanceof Error?error.message:String(error))
        );
      }
    })());
    return deferredInteraction();
  }

  if(name==="shiire-run"){
    const productId=option(interaction,"product_id");
    if(!productId) return interactionResponse("product_id を指定してください。");
    ctx.waitUntil((async()=>{
      try{
        const result=await runProduct(env,productId);
        await editInteractionOriginal(
          interaction,
          `仕入れ処理: **${result.action}**\n商品ID: ${productId}`+
          (result.delivered!==undefined?`\n納品: ${result.delivered}件`:"")
        );
      }catch(error){
        await editInteractionOriginal(
          interaction,
          "仕入れ処理に失敗しました: "+(error instanceof Error?error.message:String(error))
        );
      }
    })());
    return deferredInteraction();
  }

  return interactionResponse("未登録のコマンドです。");
}

async function registerCommands(env:Env){
  const applicationId=env.DISCORD_APPLICATION_ID?.trim();
  const token=env.DISCORD_BOT_TOKEN?.trim();
  if(!applicationId||!token) throw new HttpError(503,"DISCORD_BOT_NOT_CONFIGURED");
  const commands=[
    {
      name:"shiire-status",
      description:"自動仕入れ商品の在庫と最終ジョブを確認します"
    },
    {
      name:"shiire-run",
      description:"指定商品の仕入れ判定を今すぐ実行します",
      options:[
        {
          type:3,
          name:"product_id",
          description:"Discord-Shiireの商品ID",
          required:true
        }
      ]
    }
  ];
  const response=await fetch(
    `https://discord.com/api/v10/applications/${applicationId}/commands`,
    {
      method:"PUT",
      headers:{
        Authorization:"Bot "+token,
        "Content-Type":"application/json"
      },
      body:JSON.stringify(commands)
    }
  );
  if(!response.ok){
    throw new HttpError(502,"DISCORD_COMMAND_REGISTER_"+response.status+":"+(await response.text()).slice(0,300));
  }
  return response.json();
}

async function handleApi(request:Request,env:Env,url:URL):Promise<Response>{
  requireAdmin(request,env);

  const xAdminResponse=await handleXAdminApi(request,env,url);
  if(xAdminResponse) return xAdminResponse;

  if(url.pathname==="/api/state"&&request.method==="GET"){
    return json(await dashboardSnapshot(env));
  }

  if(url.pathname==="/api/main-catalog"&&request.method==="GET"){
    return json(await getMainCatalog(env));
  }

  if(url.pathname==="/api/suppliers"){
    if(request.method==="GET") return json(await listSuppliers(env));
    if(request.method==="POST"){
      const input=await body<{
        name?:unknown;
        kind?:unknown;
        config?:unknown;
        enabled?:unknown;
      }>(request);
      const name=String(input.name??"").trim();
      const kind=String(input.kind??"") as SupplierKind;
      if(!name||name.length>100) throw new HttpError(400,"INVALID_SUPPLIER_NAME");
      if(!["pool","http_json"].includes(kind)) throw new HttpError(400,"INVALID_SUPPLIER_KIND");
      return json(await createSupplier(env,{
        name,
        kind,
        config:input.config??{},
        enabled:input.enabled!==false
      }),201);
    }
  }

  const intake=url.pathname.match(/^\/api\/suppliers\/([^/]+)\/intake$/);
  if(intake&&request.method==="POST"){
    const supplierId=decodeURIComponent(intake[1]!);
    const supplier=await getSupplier(env,supplierId);
    if(!supplier) throw new HttpError(404,"SUPPLIER_NOT_FOUND");
    if(supplier.kind!=="pool") throw new HttpError(409,"INTAKE_ONLY_FOR_POOL_SUPPLIER");
    const input=await body<{sku?:unknown;items?:unknown}>(request);
    const sku=String(input.sku??"").trim();
    const items=Array.isArray(input.items)?input.items.map(String):[];
    if(!sku||items.length===0||items.length>1000) throw new HttpError(400,"INVALID_INTAKE");
    const added=await addPoolItems(env,supplierId,sku,items);
    return json({ok:true,added});
  }

  if(url.pathname==="/api/products"){
    if(request.method==="GET") return json(await listProducts(env));
    if(request.method==="POST"){
      const input=await body<{
        name?:unknown;
        supplierId?:unknown;
        supplierSku?:unknown;
        mainProductId?:unknown;
        minStock?:unknown;
        targetStock?:unknown;
        maxBatch?:unknown;
        processorKind?:unknown;
        processorConfig?:unknown;
        enabled?:unknown;
      }>(request);
      const name=String(input.name??"").trim();
      const supplierId=String(input.supplierId??"").trim();
      const supplierSku=String(input.supplierSku??"").trim();
      const mainProductId=String(input.mainProductId??"").trim();
      const minStock=positiveInt(input.minStock,"min_stock");
      const targetStock=positiveInt(input.targetStock,"target_stock");
      const maxBatch=positiveInt(input.maxBatch,"max_batch");
      const processorKind=String(input.processorKind??"identity") as ProcessorKind;
      if(!name||!supplierId||!supplierSku||!mainProductId){
        throw new HttpError(400,"MISSING_PRODUCT_FIELDS");
      }
      if(!await getSupplier(env,supplierId)) throw new HttpError(404,"SUPPLIER_NOT_FOUND");
      if(targetStock<minStock||maxBatch<1) throw new HttpError(400,"INVALID_STOCK_POLICY");
      if(!["identity","http_json"].includes(processorKind)){
        throw new HttpError(400,"INVALID_PROCESSOR_KIND");
      }
      return json(await createProduct(env,{
        name,
        supplierId,
        supplierSku,
        mainProductId,
        minStock,
        targetStock,
        maxBatch,
        processorKind,
        processorConfig:input.processorConfig??{},
        enabled:input.enabled!==false
      }),201);
    }
  }

  const productStatus=url.pathname.match(/^\/api\/products\/([^/]+)\/status$/);
  if(productStatus&&request.method==="GET"){
    const productId=decodeURIComponent(productStatus[1]!);
    const product=await getProduct(env,productId);
    if(!product) throw new HttpError(404,"PRODUCT_NOT_FOUND");
    const [stock,job]=await Promise.all([
      getMainStock(env,product.main_product_id),
      latestJob(env,product.id)
    ]);
    return json({product,stock,lastJob:job});
  }

  const productRun=url.pathname.match(/^\/api\/products\/([^/]+)\/run$/);
  if(productRun&&request.method==="POST"){
    return json(await runProduct(env,decodeURIComponent(productRun[1]!)));
  }

  if(url.pathname==="/api/run-all"&&request.method==="POST"){
    return json({results:await runAllProducts(env)});
  }

  if(url.pathname==="/api/discord/register"&&request.method==="POST"){
    return json({ok:true,commands:await registerCommands(env)});
  }

  throw new HttpError(404,"NOT_FOUND");
}

export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    try{
      await ensureSchema(env);
      const url=new URL(request.url);
      if(url.pathname==="/"||url.pathname==="/health"){
        return json({
          ok:true,
          service:"Discord-Shiire",
          legacyMainBotConfigured:Boolean(env.MAIN_BOT_BASE_URL),
          xaccountBotConfigured:Boolean(env.XACCOUNT_BOT_BASE_URL),
          bridgeConfigured:Boolean(
            env.SHIIRE_BRIDGE_SECRET?.trim()&&
            env.SHIIRE_BRIDGE_SECRET.trim().length>=32
          ),
          discordConfigured:Boolean(
            env.DISCORD_APPLICATION_ID&&
            env.DISCORD_PUBLIC_KEY&&
            env.DISCORD_BOT_TOKEN
          ),
          binanceTradeConfigured:Boolean(
            env.BINANCE_API_KEY&&env.BINANCE_API_SECRET
          ),
          hstoraConfigured:Boolean(
            env.HSTORA_API_KEY&&env.HSTORA_API_SECRET
          ),
          credentialsEncryptionConfigured:Boolean(
            env.CREDENTIALS_ENCRYPTION_KEY
          )
        });
      }
      if(url.pathname==="/webhooks/hstora"){
        return handleHstoraWebhook(request,env);
      }
      if(url.pathname.startsWith("/media/shiire-vending/")){
        const media=await handleShiireVendingMedia(request,env,url);
        if(media) return media;
      }
      if(url.pathname.startsWith("/bridge/main/")){
        const bridge=await handleShiireMainBridge(request,env,url);
        if(bridge) return bridge;
      }
      if(url.pathname==="/interactions"&&request.method==="POST"){
        return handleInteraction(request,env,ctx);
      }
      if(url.pathname==="/x-admin"&&request.method==="GET"){
        return xAdminPage();
      }
      if(url.pathname.startsWith("/api/")){
        return handleApi(request,env,url);
      }
      throw new HttpError(404,"NOT_FOUND");
    }catch(error){
      const status=
        error instanceof HttpError?error.status:
        error instanceof ShiireVendingError?error.status:
        500;
      const message=error instanceof Error?error.message:String(error);
      console.error(error);
      return json({error:status>=500?"server_error":"request_error",message},status);
    }
  },

  async scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext){
    ctx.waitUntil((async()=>{
      try{
        await runAllProducts(env);
      }catch(error){
        console.error("scheduled generic procurement failed",error);
      }

      try{
        const settings=await loadXSettings(env);
        if(settings.auto_purchase_enabled){
          try{
            await runLtcAutoPurchase(env);
          }catch(error){
            console.error("scheduled LTC auto-purchase failed",error);
          }
        }
        if(settings.auto_procurement_enabled){
          try{
            await runXProcurement(env);
          }catch(error){
            console.error("scheduled X procurement failed",error);
          }
        }
      }catch(error){
        console.error("scheduled X automation settings load failed",error);
      }

      try{
        await shiireVendingSweep(env);
      }catch(error){
        console.error("scheduled Shiire vending sweep failed",error);
      }
    })());
  }
} satisfies ExportedHandler<Env>;
