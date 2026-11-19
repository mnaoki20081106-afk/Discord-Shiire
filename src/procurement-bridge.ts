// Dashboard API for 仕入れ品 / 仕入れ先 (called through the signed main bridge:
// /bridge/main/guilds/:guildId/procurement/...).

import type { Env } from "./types";
import { addPoolItems, latestJob } from "./db";
import { runProduct } from "./engine";
import { getMainCatalog } from "./main-bot";
import { runXProcurement } from "./x-engine";
import {
  ProcurementError,
  SUPPLIER_TEMPLATES,
  deleteItem,
  deleteSupplier,
  destinationsFromCatalog,
  ensureProcurementSchema,
  getItem,
  getRestockTime,
  hstoraEnv,
  itemView,
  listItems,
  listSupplierViews,
  saveItem,
  saveSupplier,
  setRestockTime,
  templateOf,
  transferHstoraAccounts,
  type HstoraClass
} from "./procurement";

function respond(data:unknown,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}
  });
}

function body(raw:string):Record<string,unknown>{
  if(!raw) return {};
  try{
    const parsed=JSON.parse(raw);
    return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{};
  }catch{
    throw new ProcurementError(400,"INVALID_JSON","リクエストの形式が正しくありません");
  }
}

async function itemsWithStatus(env:Env){
  const [items,suppliers]=await Promise.all([listItems(env),env.DB.prepare("SELECT * FROM suppliers").all<any>()]);
  const supplierById=new Map(suppliers.results.map(row=>[row.id,row]));
  // One catalog read for every destination; failure is reported, not hidden.
  let catalog:Awaited<ReturnType<typeof getMainCatalog>>|null=null;
  let catalogError:string|null=null;
  try{catalog=await getMainCatalog(env);}catch(error){catalogError=error instanceof Error?error.message:String(error);}
  const available=new Map((catalog?.products??[]).map(row=>[row.product_id,Number(row.available)]));
  const rows=await Promise.all(items.map(async item=>{
    const supplier=supplierById.get(item.supplier_id)??null;
    const view=await itemView(env,item,supplier);
    const job=await latestJob(env,item.id).catch(()=>null);
    let waiting:number|null=null;
    if(view.template==="hstora"&&view.condition.class){
      const row=await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM purchased_accounts WHERE procurement_class=? AND status='READY_FOR_DELIVERY'"
      ).bind(view.condition.class).first<{n:number}>();
      waiting=Number(row?.n??0);
    }
    return {
      ...view,
      destinationAvailable:item.main_product_id?available.get(item.main_product_id)??null:null,
      destinationMissing:Boolean(item.main_product_id&&catalog&&!available.has(item.main_product_id)),
      waitingTransfer:waiting,
      lastJob:job?{status:job.status,requested:job.requested_qty,delivered:job.delivered_qty,error:job.error,updatedAt:job.updated_at}:null
    };
  }));
  return {items:rows,catalogError};
}

export async function handleProcurementBridge(
  env:Env,
  method:string,
  suffix:string,
  rawBody:string
):Promise<Response|null>{
  if(suffix!=="/procurement"&&!suffix.startsWith("/procurement/")) return null;
  const path=suffix.slice("/procurement".length)||"/";
  try{
    await ensureProcurementSchema(env);

    if(path==="/"&&method==="GET"){
      const [{items,catalogError},suppliers,restockTime]=await Promise.all([
        itemsWithStatus(env),listSupplierViews(env),getRestockTime(env)
      ]);
      return respond({templates:SUPPLIER_TEMPLATES,suppliers,items,restockTime,catalogError});
    }

    if(path==="/destinations"&&method==="GET"){
      return respond({machines:destinationsFromCatalog(await getMainCatalog(env))});
    }

    if(path==="/restock-time"&&method==="POST"){
      return respond({restockTime:await setRestockTime(env,body(rawBody).restockTime)});
    }

    if(path==="/suppliers"&&method==="POST"){
      const input=body(rawBody);
      return respond(await saveSupplier(env,{name:input.name,template:input.template,config:input.config,secrets:input.secrets,enabled:input.enabled}),201);
    }
    const supplierMatch=path.match(/^\/suppliers\/([^/]+)$/);
    if(supplierMatch){
      const id=decodeURIComponent(supplierMatch[1]!);
      if(method==="PATCH"){
        const input=body(rawBody);
        return respond(await saveSupplier(env,{id,name:input.name,config:input.config,secrets:input.secrets,enabled:input.enabled}));
      }
      if(method==="DELETE") return respond({ok:await deleteSupplier(env,id)});
    }
    const intakeMatch=path.match(/^\/suppliers\/([^/]+)\/intake$/);
    if(intakeMatch&&method==="POST"){
      const id=decodeURIComponent(intakeMatch[1]!);
      const supplier=await env.DB.prepare("SELECT * FROM suppliers WHERE id=?").bind(id).first<any>();
      if(!supplier||templateOf(supplier.kind)?.id!=="manual") throw new ProcurementError(404,"SUPPLIER_NOT_FOUND","手動投入の仕入れ先が見つかりません");
      const input=body(rawBody);
      const sku=String(input.sku??"").trim();
      const lines=Array.isArray(input.items)?input.items.map(String):String(input.text??"").split(/\r?\n/);
      if(!sku) throw new ProcurementError(400,"SKU_REQUIRED","区分名を指定してください");
      if(lines.filter(line=>line.trim()).length>1000) throw new ProcurementError(413,"TOO_MANY_ITEMS","1回に投入できるのは1000件までです");
      return respond(await addPoolItems(env,id,sku,lines));
    }

    if(path==="/items"&&method==="POST"){
      return respond(await saveItem(env,null,body(rawBody)),201);
    }
    const itemMatch=path.match(/^\/items\/([^/]+)$/);
    if(itemMatch){
      const id=decodeURIComponent(itemMatch[1]!);
      if(method==="PATCH") return respond(await saveItem(env,id,body(rawBody)));
      if(method==="DELETE") return respond({ok:await deleteItem(env,id)});
    }
    const runMatch=path.match(/^\/items\/([^/]+)\/run$/);
    if(runMatch&&method==="POST"){
      const item=await getItem(env,decodeURIComponent(runMatch[1]!));
      if(!item) throw new ProcurementError(404,"ITEM_NOT_FOUND","仕入れ品が見つかりません");
      if(!item.enabled||!item.main_product_id) throw new ProcurementError(409,"ITEM_DISABLED","有効化して補充先を選んでから実行してください");
      const supplier=await env.DB.prepare("SELECT kind FROM suppliers WHERE id=?").bind(item.supplier_id).first<{kind:string}>();
      if(supplier&&templateOf(supplier.kind)?.id==="hstora"){
        const procurementClass=JSON.parse(item.condition_json||"{}").class as HstoraClass;
        const target=item.max_stock>0?Math.min(item.target_stock,item.max_stock):item.target_stock;
        const env2=await hstoraEnv(env);
        const result=await runXProcurement(env2,{targetClasses:[procurementClass],targetStockOverride:{[procurementClass]:target}});
        const transfer=await transferHstoraAccounts(env2);
        return respond({ok:true,result,transfer});
      }
      return respond({ok:true,result:await runProduct(env,item)});
    }

    return respond({error:"NOT_FOUND"},404);
  }catch(error){
    if(error instanceof ProcurementError) return respond({error:error.code,message:error.message},error.status);
    const message=error instanceof Error?error.message:String(error);
    return respond({error:"PROCUREMENT_FAILED",message:message.slice(0,300)},message.startsWith("MAIN_BOT_")?502:500);
  }
}
