import type { Env } from "./types";
import { getMainPaymentStatus } from "./main-bot";
import { luckyBalance, luckyPanelConfigured, type LuckyService } from "./smm-luckypanel";
import {
  SMM_SNS_LABEL,
  createSmmMachine,
  createSmmProduct,
  defaultMachineTexts,
  deleteSmmMachine,
  deleteSmmPanelRecord,
  deleteSmmProduct,
  ensureSmmSchema,
  getSmmMachine,
  getSmmOrder,
  getSmmProduct,
  getSmmSettings,
  listSmmMachines,
  listSmmOrders,
  listSmmPanels,
  listSmmProducts,
  saveSmmPanel,
  saveSmmSettings,
  smmOrderSummary,
  updateSmmMachine,
  updateSmmProduct,
  type SmmMachine,
  type SmmOrder,
  type SmmProduct,
  type SmmProductInput,
  type SmmSettings
} from "./smm-db";
import {
  SmmError,
  productPer1000,
  smmDiscordFetch,
  smmDiscordJson,
  smmPanelPayload,
  smmRequireChannelInGuild,
  smmSendMessage
} from "./smm-discord";
import {
  smmAdminAction,
  smmServicesMap,
  type SmmAdminAction
} from "./smm-orders";
import {
  SMM_LINK_KINDS_BY_SNS,
  SMM_PANEL_PRODUCT_LIMIT,
  SMM_SNS,
  isSmmSns,
  isSupportedSmmServiceType,
  isJpyCurrency,
  smmQuantityBounds,
  smmQuote,
  smmQuoteIsProfitable,
  type SmmLinkKind
} from "./smm-policy";

function responseJson(data:unknown,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store"
    }
  });
}

function parseBody(rawBody:string):Record<string,unknown>{
  if(!rawBody.trim()) return {};
  try{
    const parsed=JSON.parse(rawBody);
    if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed)){
      return parsed as Record<string,unknown>;
    }
  }catch{}
  throw new SmmError(400,"INVALID_JSON");
}

function text(value:unknown,name:string,max:number,options:{required?:boolean}={}):string{
  const v=String(value??"").trim();
  if(options.required&&!v) throw new SmmError(400,name.toUpperCase()+"_REQUIRED");
  if(v.length>max) throw new SmmError(400,name.toUpperCase()+"_TOO_LONG");
  return v;
}

function number(value:unknown,name:string,min:number,max:number,integer=false):number{
  const n=Number(value);
  if(!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isInteger(n))){
    throw new SmmError(400,name.toUpperCase()+"_INVALID");
  }
  return n;
}

async function enrichProducts(
  env:Env,
  products:SmmProduct[],
  services:Map<string,LuckyService>|null
){
  return products.map(product=>{
    const service=services?.get(product.service_id)??null;
    const bounds=service?smmQuantityBounds(service,product):null;
    return {
      ...product,
      price_percent:Math.round((100+product.markup_percent)*100)/100,
      live:service?{
        found:true,
        type:service.type,
        rate:service.rate,
        min:service.min,
        max:service.max,
        refill:service.refill,
        cancel:service.cancel,
        supported:isSupportedSmmServiceType(service.type)
      }:{found:false},
      per1000:service?smmQuote(service.rate,1000,product):null,
      per1000Label:service?productPer1000(product,service.rate):null,
      bounds
    };
  });
}

async function cachedServices(env:Env):Promise<{map:Map<string,LuckyService>;cachedAt:number}|null>{
  try{
    return await smmServicesMap(env,{maxAgeMs:Number.MAX_SAFE_INTEGER});
  }catch{
    return null;
  }
}

async function refreshMachinePanels(env:Env,machine:SmmMachine):Promise<boolean>{
  const panels=await listSmmPanels(env,machine.id);
  if(!panels.length) return true;
  const settings=await getSmmSettings(env,machine.guild_id);
  const products=await listSmmProducts(env,machine.guild_id,{machineId:machine.id,activeOnly:true});
  const services=(await cachedServices(env))?.map??new Map<string,LuckyService>();
  const payload=smmPanelPayload(settings,machine,products,services);
  let ok=true;
  for(const panel of panels){
    try{
      await smmDiscordJson(
        env,
        "/channels/"+panel.channel_id+"/messages/"+panel.message_id,
        {method:"PATCH",body:JSON.stringify(payload)}
      );
    }catch(error){
      ok=false;
      console.error("smm panel refresh failed",machine.id,panel,error);
      if(error instanceof SmmError&&error.message.startsWith("DISCORD_404")){
        await deleteSmmPanelRecord(env,machine.guild_id,panel.channel_id,panel.message_id).catch(()=>undefined);
      }
    }
  }
  return ok;
}

async function refreshGuildPanels(env:Env,guildId:string):Promise<boolean>{
  let ok=true;
  for(const machine of await listSmmMachines(env,guildId)){
    if(!(await refreshMachinePanels(env,machine))) ok=false;
  }
  return ok;
}

async function refreshProductPanels(env:Env,machineIds:string[]):Promise<boolean>{
  let ok=true;
  for(const id of new Set(machineIds)){
    const machine=await getSmmMachine(env,id);
    if(machine&&!(await refreshMachinePanels(env,machine))) ok=false;
  }
  return ok;
}

function sanitizeOrder(order:SmmOrder){
  const {payment_link_ciphertext:_ignored,...rest}=order;
  return rest;
}

function pricePercent(body:Record<string,unknown>,current:SmmProduct|null):number{
  if(body.price_percent===undefined&&current) return Math.round((100+current.markup_percent)*100)/100;
  return number(body.price_percent??130,"price_percent",101,1000);
}

async function parseProductInput(
  env:Env,
  guildId:string,
  body:Record<string,unknown>,
  current:SmmProduct|null
):Promise<SmmProductInput>{
  const pick=<K extends keyof SmmProduct>(key:K)=>(
    body[key as string]!==undefined?body[key as string]:current?.[key]
  );
  const serviceId=text(pick("service_id"),"service_id",64,{required:true});
  const serviceChanged=!current||current.service_id!==serviceId;

  let service:LuckyService|undefined;
  if(serviceChanged||body.price_percent!==undefined||body.min_qty!==undefined){
    const loaded=await smmServicesMap(env,{maxAgeMs:10*60_000}).catch(()=>{
      throw new SmmError(503,"LUCKYPANEL_SERVICES_UNAVAILABLE");
    });
    service=loaded.map.get(serviceId);
    if(!service) throw new SmmError(400,"SERVICE_NOT_FOUND");
    if(!isSupportedSmmServiceType(service.type)){
      throw new SmmError(400,"SERVICE_TYPE_UNSUPPORTED:"+service.type);
    }
    if(!Number.isFinite(service.rate)) throw new SmmError(400,"SERVICE_RATE_INVALID");
  }

  const machineId=text(pick("machine_id"),"machine_id",64,{required:true});
  const machine=await getSmmMachine(env,machineId);
  if(!machine||machine.guild_id!==guildId) throw new SmmError(400,"MACHINE_NOT_FOUND");

  const linkKind=String(pick("link_kind")??"url") as SmmLinkKind;
  if(!SMM_LINK_KINDS_BY_SNS[machine.sns].includes(linkKind)) throw new SmmError(400,"LINK_KIND_INVALID");

  const input:SmmProductInput={
    machine_id:machine.id,
    name:text(pick("name")||service?.name,"name",80,{required:true}),
    description:text(pick("description")??"","description",200),
    emoji:text(pick("emoji")??"","emoji",16)||null,
    service_id:serviceId,
    service_name:service?.name??current?.service_name??"",
    service_category:service?.category??current?.service_category??"",
    markup_percent:pricePercent(body,current)-100,
    fee_jpy:0,
    min_qty:number(pick("min_qty")??1,"min_qty",1,10_000_000,true),
    max_qty:number(pick("max_qty")??0,"max_qty",0,10_000_000,true),
    link_kind:linkKind,
    active:body.active===undefined?(current?current.active===1:true):Boolean(body.active)
  };
  if(input.max_qty>0&&input.max_qty<input.min_qty) throw new SmmError(400,"MAX_QTY_BELOW_MIN");

  if(service){
    const settings=await getSmmSettings(env,guildId);
    const bounds=smmQuantityBounds(service,input);
    for(const quantity of new Set([bounds.min,Math.min(bounds.max,1000)])){
      const total=smmQuote(service.rate,quantity,input);
      if(!smmQuoteIsProfitable(total,service.rate,quantity,settings.min_margin_percent)){
        throw new SmmError(400,"MARGIN_BELOW_FLOOR");
      }
    }
  }
  return input;
}

async function parseSettingsPatch(
  env:Env,
  guildId:string,
  body:Record<string,unknown>
):Promise<Partial<Omit<SmmSettings,"guild_id"|"updated_at">>>{
  const patch:Partial<Omit<SmmSettings,"guild_id"|"updated_at">>={};
  for(const key of ["public_log_channel_id","private_log_channel_id"] as const){
    if(body[key]===undefined) continue;
    const id=text(body[key],key,25);
    if(id){
      if(!/^\d{17,20}$/.test(id)) throw new SmmError(400,key.toUpperCase()+"_INVALID");
      await smmRequireChannelInGuild(env,guildId,id);
    }
    patch[key]=id||null;
  }
  if(body.paused!==undefined) patch.paused=body.paused?1:0;
  if(body.min_margin_percent!==undefined) patch.min_margin_percent=number(body.min_margin_percent,"min_margin_percent",0,90);
  if(body.max_open_orders_per_user!==undefined) patch.max_open_orders_per_user=number(body.max_open_orders_per_user,"max_open_orders_per_user",1,50,true);
  if(body.min_supplier_balance_jpy!==undefined) patch.min_supplier_balance_jpy=number(body.min_supplier_balance_jpy,"min_supplier_balance_jpy",0,10_000_000,true);
  return patch;
}

function parseImageUrl(value:unknown):string|null{
  const url=text(value,"panel_image_url",500);
  if(!url) return null;
  let parsed:URL;
  try{parsed=new URL(url);}catch{throw new SmmError(400,"PANEL_IMAGE_URL_INVALID");}
  if(parsed.protocol!=="https:") throw new SmmError(400,"PANEL_IMAGE_URL_MUST_BE_HTTPS");
  return url;
}

function machinePatch(body:Record<string,unknown>){
  const patch:{name?:string;panel_title?:string;panel_description?:string;panel_color?:number;panel_image_url?:string|null}={};
  if(body.name!==undefined) patch.name=text(body.name,"name",40,{required:true});
  if(body.panel_title!==undefined) patch.panel_title=text(body.panel_title,"panel_title",80,{required:true});
  if(body.panel_description!==undefined) patch.panel_description=text(body.panel_description,"panel_description",1500);
  if(body.panel_color!==undefined) patch.panel_color=number(body.panel_color,"panel_color",0,0xffffff,true);
  if(body.panel_image_url!==undefined) patch.panel_image_url=parseImageUrl(body.panel_image_url);
  return patch;
}

export async function handleSmmBridge(
  env:Env,
  method:string,
  guildId:string,
  suffix:string,
  url:URL,
  rawBody:string
):Promise<Response>{
  try{
    await ensureSmmSchema(env);

    if(suffix===""&&method==="GET"){
      const cached=await cachedServices(env);
      const [settings,products,machines,summary,payment]=await Promise.all([
        getSmmSettings(env,guildId),
        listSmmProducts(env,guildId),
        listSmmMachines(env,guildId),
        smmOrderSummary(env,guildId),
        getMainPaymentStatus(env).catch(()=>({paypay:false,kyash:false}))
      ]);
      let balance:{ok:true;balance:number;currency:string;currencyOk:boolean}|{ok:false;error:string}={
        ok:false,error:"LUCKYPANEL_API_KEY_NOT_CONFIGURED"
      };
      if(luckyPanelConfigured(env)){
        try{
          const result=await luckyBalance(env);
          balance={
            ok:true,
            balance:result.balance,
            currency:result.currency,
            currencyOk:isJpyCurrency(result.currency)
          };
        }catch(error){
          balance={ok:false,error:(error instanceof Error?error.message:String(error)).slice(0,200)};
        }
      }
      return responseJson({
        configured:luckyPanelConfigured(env),
        balance,
        payment,
        settings,
        products:await enrichProducts(env,products,cached?.map??null),
        machines:await Promise.all(machines.map(async machine=>({
          ...machine,
          snsLabel:SMM_SNS_LABEL[machine.sns],
          linkKinds:SMM_LINK_KINDS_BY_SNS[machine.sns],
          panels:await listSmmPanels(env,machine.id),
          activeProducts:products.filter(p=>p.machine_id===machine.id&&p.active===1).length,
          totalProducts:products.filter(p=>p.machine_id===machine.id).length
        }))),
        snsOptions:SMM_SNS.map(id=>({id,label:SMM_SNS_LABEL[id]})),
        summary,
        servicesCachedAt:cached?.cachedAt??null,
        limits:{panelProductLimit:SMM_PANEL_PRODUCT_LIMIT}
      });
    }

    if(suffix==="/settings"&&method==="POST"){
      const patch=await parseSettingsPatch(env,guildId,parseBody(rawBody));
      const settings=await saveSmmSettings(env,guildId,patch);
      const panelsRefreshed=await refreshGuildPanels(env,guildId);
      return responseJson({ok:true,settings,panelsRefreshed});
    }

    if(suffix==="/services"&&method==="GET"){
      const refresh=url.searchParams.get("refresh")==="1";
      let loaded:Awaited<ReturnType<typeof smmServicesMap>>;
      try{
        loaded=await smmServicesMap(env,{maxAgeMs:refresh?0:10*60_000,forceRefresh:refresh});
      }catch(error){
        throw new SmmError(502,"LUCKYPANEL_SERVICES_UNAVAILABLE:"+(error instanceof Error?error.message:String(error)).slice(0,200));
      }
      return responseJson({
        cachedAt:loaded.cachedAt,
        stale:loaded.stale,
        services:[...loaded.map.values()].map(service=>({
          ...service,
          supported:isSupportedSmmServiceType(service.type)&&Number.isFinite(service.rate)
        }))
      });
    }

    if(suffix==="/products"&&method==="POST"){
      const input=await parseProductInput(env,guildId,parseBody(rawBody),null);
      let product:SmmProduct;
      try{
        product=await createSmmProduct(env,guildId,input);
      }catch(error){
        if(error instanceof Error&&error.message==="TOO_MANY_ACTIVE_PRODUCTS"){
          throw new SmmError(409,"TOO_MANY_ACTIVE_PRODUCTS");
        }
        throw error;
      }
      return responseJson({ok:true,product,panelsRefreshed:await refreshProductPanels(env,[input.machine_id])});
    }

    const productMatch=suffix.match(/^\/products\/([^/]+)$/);
    if(productMatch){
      const current=await getSmmProduct(env,productMatch[1]!);
      if(!current||current.guild_id!==guildId) throw new SmmError(404,"PRODUCT_NOT_FOUND");
      if(method==="PATCH"){
        const input=await parseProductInput(env,guildId,parseBody(rawBody),current);
        let product:SmmProduct|null;
        try{
          product=await updateSmmProduct(env,current.id,input);
        }catch(error){
          if(error instanceof Error&&error.message==="TOO_MANY_ACTIVE_PRODUCTS"){
            throw new SmmError(409,"TOO_MANY_ACTIVE_PRODUCTS");
          }
          throw error;
        }
        return responseJson({ok:true,product,panelsRefreshed:await refreshProductPanels(env,[current.machine_id,input.machine_id])});
      }
      if(method==="DELETE"){
        await deleteSmmProduct(env,current.id);
        return responseJson({ok:true,panelsRefreshed:await refreshProductPanels(env,[current.machine_id])});
      }
    }

    if(suffix==="/orders"&&method==="GET"){
      const status=url.searchParams.get("status")||undefined;
      const orders=await listSmmOrders(env,guildId,{limit:Number(url.searchParams.get("limit")??100),status});
      return responseJson({orders:orders.map(sanitizeOrder),summary:await smmOrderSummary(env,guildId)});
    }

    const orderAction=suffix.match(/^\/orders\/([^/]+)\/action$/);
    if(orderAction&&method==="POST"){
      const order=await getSmmOrder(env,orderAction[1]!);
      if(!order||order.guild_id!==guildId) throw new SmmError(404,"ORDER_NOT_FOUND");
      const body=parseBody(rawBody);
      const action=String(body.action??"");
      let input:SmmAdminAction;
      switch(action){
        case "retry": input={action,confirmNotPlaced:body.confirmNotPlaced===true};break;
        case "link_supplier": input={action,supplierOrderId:String(body.supplierOrderId??"")};break;
        case "cancel_supplier":
        case "fail_refund":
        case "refund_done": input={action};break;
        default: throw new SmmError(400,"ACTION_INVALID");
      }
      const result=await smmAdminAction(env,order,input);
      return responseJson(
        {...result,order:sanitizeOrder((await getSmmOrder(env,order.id))!)},
        result.ok?200:409
      );
    }

    if(suffix==="/machines"&&method==="POST"){
      const body=parseBody(rawBody);
      const sns=String(body.sns??"");
      if(!isSmmSns(sns)) throw new SmmError(400,"SNS_INVALID");
      const defaults=defaultMachineTexts(sns);
      const patch=machinePatch(body);
      let machine:SmmMachine;
      try{
        machine=await createSmmMachine(env,guildId,{
          sns,
          name:patch.name??defaults.name,
          panel_title:patch.panel_title??defaults.panel_title,
          panel_description:patch.panel_description??defaults.panel_description,
          panel_color:patch.panel_color??defaults.panel_color,
          panel_image_url:patch.panel_image_url??null
        });
      }catch(error){
        if(error instanceof Error&&error.message==="TOO_MANY_MACHINES") throw new SmmError(409,"TOO_MANY_MACHINES");
        throw error;
      }
      return responseJson({ok:true,machine});
    }

    const machineMatch=suffix.match(/^\/machines\/([^/]+)(\/panel(?:\/refresh)?)?$/);
    if(machineMatch){
      const machine=await getSmmMachine(env,machineMatch[1]!);
      if(!machine||machine.guild_id!==guildId) throw new SmmError(404,"MACHINE_NOT_FOUND");
      const sub=machineMatch[2]??"";

      if(sub===""&&method==="PATCH"){
        const updated=await updateSmmMachine(env,machine.id,machinePatch(parseBody(rawBody)));
        return responseJson({ok:true,machine:updated,panelsRefreshed:await refreshMachinePanels(env,updated!)});
      }

      if(sub===""&&method==="DELETE"){
        try{
          await deleteSmmMachine(env,machine.id);
        }catch(error){
          if(error instanceof Error&&error.message==="MACHINE_HAS_PRODUCTS") throw new SmmError(409,"MACHINE_HAS_PRODUCTS");
          throw error;
        }
        return responseJson({ok:true});
      }

      if(sub==="/panel"&&method==="POST"){
        const body=parseBody(rawBody);
        const channelId=text(body.channelId,"channel_id",25,{required:true});
        await smmRequireChannelInGuild(env,guildId,channelId);
        const settings=await getSmmSettings(env,guildId);
        const products=await listSmmProducts(env,guildId,{machineId:machine.id,activeOnly:true});
        const services=(await cachedServices(env))?.map??new Map<string,LuckyService>();
        const message=await smmSendMessage(
          env,channelId,smmPanelPayload(settings,machine,products,services)
        );
        await saveSmmPanel(env,guildId,machine.id,channelId,message.id);
        return responseJson({ok:true,messageId:message.id});
      }

      if(sub==="/panel/refresh"&&method==="POST"){
        return responseJson({ok:true,panelsRefreshed:await refreshMachinePanels(env,machine)});
      }
    }

    const panelRemove=suffix.match(/^\/machines\/([^/]+)\/panels\/(\d+)\/(\d+)$/);
    if(panelRemove&&method==="DELETE"){
      const machine=await getSmmMachine(env,panelRemove[1]!);
      if(!machine||machine.guild_id!==guildId) throw new SmmError(404,"MACHINE_NOT_FOUND");
      const [,,channelId,messageId]=panelRemove;
      const known=(await listSmmPanels(env,machine.id)).some(
        panel=>panel.channel_id===channelId&&panel.message_id===messageId
      );
      if(!known) throw new SmmError(404,"PANEL_NOT_FOUND");
      await smmDiscordFetch(env,"/channels/"+channelId+"/messages/"+messageId,{method:"DELETE"}).catch(()=>undefined);
      await deleteSmmPanelRecord(env,guildId,channelId!,messageId!);
      return responseJson({ok:true});
    }

    throw new SmmError(404,"NOT_FOUND");
  }catch(error){
    if(error instanceof SmmError){
      return responseJson({error:error.message.split(":")[0],message:error.message},error.status);
    }
    console.error("smm bridge failed",error);
    return responseJson({error:"server_error",message:error instanceof Error?error.message:String(error)},500);
  }
}
