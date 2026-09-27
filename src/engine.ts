import type { Env, JobRow, ProductRow } from "./types";
import {
  acquireProductLock,
  createJob,
  ensureSchema,
  findRecoverableJob,
  getJob,
  getProduct,
  getSupplier,
  hasBlockedJob,
  jobItems,
  listEnabledProducts,
  logEvent,
  markJobItemsDelivered,
  rawJobItems,
  releaseProductLock,
  storeJobItems,
  storeRawJobItems,
  updateJob
} from "./db";
import { acquireFromSupplier, SupplierError } from "./suppliers";
import { processItems, ProcessorError } from "./processors";
import { deliverToMain, getMainStock } from "./main-bot";

const OUT_OF_STOCK_RETRY_MS=15*60_000;

function retryDelay(attempt:number){
  const minutes=Math.min(60,Math.max(2,2**Math.min(5,Math.max(1,attempt))));
  return minutes*60_000;
}

function isOutOfStock(error:unknown):boolean{
  return error instanceof SupplierError&&error.code==="OUT_OF_STOCK";
}

async function acquireJob(
  env:Env,
  product:ProductRow,
  job:JobRow
):Promise<JobRow>{
  const existingRaw=await rawJobItems(env,job.id);
  if(existingRaw.length>0){
    return await getJob(env,job.id)??job;
  }

  const supplier=await getSupplier(env,product.supplier_id);
  if(!supplier||!supplier.enabled){
    await updateJob(env,job.id,{
      status:"failed",
      error:"SUPPLIER_NOT_FOUND_OR_DISABLED",
      nextRetryAt:null
    });
    throw new Error("SUPPLIER_NOT_FOUND_OR_DISABLED");
  }

  const attempt=job.attempt_count+1;
  try{
    const raw=await acquireFromSupplier(
      env,
      supplier,
      product.supplier_sku,
      job.requested_qty,
      "shiire-acquire:"+job.id
    );
    if(raw.length===0) throw new SupplierError("OUT_OF_STOCK",true);
    await storeRawJobItems(env,job.id,raw);
    return await getJob(env,job.id)??job;
  }catch(error){
    const supplierError=error instanceof SupplierError?error:null;
    const out=supplierError?.code==="OUT_OF_STOCK";
    const retryable=Boolean(supplierError?.retryable);
    const message=error instanceof Error?error.message:String(error);
    await updateJob(env,job.id,{
      status:out
        ?"out_of_stock"
        :retryable
          ?"acquisition_failed"
          :"failed",
      attemptCount:attempt,
      nextRetryAt:out
        ?Date.now()+OUT_OF_STOCK_RETRY_MS
        :retryable
          ?Date.now()+retryDelay(attempt)
          :null,
      error:message
    });
    await logEvent(env,{
      level:out?"warn":"error",
      kind:out?"out_of_stock":"acquire_failed",
      productId:product.id,
      jobId:job.id,
      message
    });
    throw error;
  }
}

async function processJob(
  env:Env,
  product:ProductRow,
  job:JobRow
):Promise<JobRow>{
  const existingFinal=await jobItems(env,job.id);
  if(existingFinal.length>0){
    const updated=await updateJob(env,job.id,{
      status:"acquired",
      acquiredQty:existingFinal.length,
      nextRetryAt:null,
      error:null
    });
    if(!updated) throw new Error("JOB_NOT_FOUND");
    return updated;
  }

  const raw=await rawJobItems(env,job.id);
  if(raw.length===0){
    await updateJob(env,job.id,{
      status:"failed",
      error:"RAW_ITEMS_MISSING",
      nextRetryAt:null
    });
    throw new Error("RAW_ITEMS_MISSING");
  }

  try{
    const processed=await processItems(
      env,
      product.processor_kind,
      product.processor_config_json,
      raw
    );
    if(processed.length===0){
      throw new ProcessorError("PROCESSOR_RETURNED_NO_ITEMS",true);
    }
    const stored=await storeJobItems(env,job.id,product.id,processed);
    if(stored===0){
      const already=await jobItems(env,job.id);
      if(already.length>0){
        const recovered=await updateJob(env,job.id,{
          status:"acquired",
          acquiredQty:already.length,
          nextRetryAt:null,
          error:null
        });
        if(!recovered) throw new Error("JOB_NOT_FOUND");
        return recovered;
      }
      await updateJob(env,job.id,{
        status:"failed",
        acquiredQty:0,
        error:"ALL_ITEMS_DUPLICATE",
        nextRetryAt:null
      });
      throw new Error("ALL_ITEMS_DUPLICATE");
    }
    const updated=await updateJob(env,job.id,{
      status:"acquired",
      acquiredQty:stored,
      nextRetryAt:null,
      error:null
    });
    if(!updated) throw new Error("JOB_NOT_FOUND");
    return updated;
  }catch(error){
    if(error instanceof Error&&error.message==="ALL_ITEMS_DUPLICATE") throw error;
    const retryable=error instanceof ProcessorError?error.retryable:true;
    const attempt=job.attempt_count+1;
    const message=error instanceof Error?error.message:String(error);
    await updateJob(env,job.id,{
      status:retryable?"processing_failed":"failed",
      attemptCount:attempt,
      nextRetryAt:retryable?Date.now()+retryDelay(attempt):null,
      error:message
    });
    await logEvent(env,{
      level:"error",
      kind:"processing_failed",
      productId:product.id,
      jobId:job.id,
      message
    });
    throw error;
  }
}

async function deliverJob(
  env:Env,
  product:ProductRow,
  job:JobRow
){
  const items=(await jobItems(env,job.id)).map(row=>row.content);
  if(items.length===0){
    await updateJob(env,job.id,{
      status:"failed",
      error:"NO_ACQUIRED_ITEMS",
      nextRetryAt:null
    });
    throw new Error("NO_ACQUIRED_ITEMS");
  }

  const attempt=job.attempt_count+1;
  try{
    const result=await deliverToMain(env,{
      mainProductId:product.main_product_id,
      items,
      idempotencyKey:"shiire:"+job.id
    });
    await markJobItemsDelivered(env,job.id);
    await updateJob(env,job.id,{
      status:"delivered",
      deliveredQty:result.added,
      attemptCount:attempt,
      nextRetryAt:null,
      error:null
    });
    await logEvent(env,{
      kind:"delivery",
      productId:product.id,
      jobId:job.id,
      message:`${product.name}: Main Botへ${result.added}件納品（重複スキップ ${result.skipped??0}件）`
    });
    return result;
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    await updateJob(env,job.id,{
      status:"delivery_failed",
      attemptCount:attempt,
      nextRetryAt:Date.now()+retryDelay(attempt),
      error:message
    });
    await logEvent(env,{
      level:"error",
      kind:"delivery_failed",
      productId:product.id,
      jobId:job.id,
      message
    });
    throw error;
  }
}

async function recoverJob(
  env:Env,
  product:ProductRow,
  job:JobRow
){
  let current=job;
  if(current.status==="acquiring"||current.status==="acquisition_failed"){
    current=await acquireJob(env,product,current);
    current=await processJob(env,product,current);
    return deliverJob(env,product,current);
  }
  if(current.status==="processing_failed"){
    current=await processJob(env,product,current);
    return deliverJob(env,product,current);
  }
  return deliverJob(env,product,current);
}

export type RunResult={
  productId:string;
  action:"noop"|"blocked"|"recovered"|"restocked"|"out_of_stock"|"locked";
  available?:number;
  requested?:number;
  delivered?:number;
  jobId?:string;
};

export async function runProduct(
  env:Env,
  productOrId:ProductRow|string
):Promise<RunResult>{
  await ensureSchema(env);
  const product=typeof productOrId==="string"
    ?await getProduct(env,productOrId)
    :productOrId;
  if(!product||!product.enabled){
    throw new Error("PRODUCT_NOT_FOUND_OR_DISABLED");
  }

  const lock=await acquireProductLock(env,product.id,90_000);
  if(!lock) return {productId:product.id,action:"locked"};

  try{
    const recoverable=await findRecoverableJob(env,product.id);
    if(recoverable){
      try{
        const result=await recoverJob(env,product,recoverable);
        return {
          productId:product.id,
          action:"recovered",
          delivered:result.added,
          jobId:recoverable.id
        };
      }catch(error){
        if(isOutOfStock(error)){
          return {
            productId:product.id,
            action:"out_of_stock",
            requested:recoverable.requested_qty,
            jobId:recoverable.id
          };
        }
        throw error;
      }
    }

    if(await hasBlockedJob(env,product.id)){
      return {productId:product.id,action:"blocked"};
    }

    const stock=await getMainStock(env,product.main_product_id);
    if(stock.available>=product.min_stock){
      return {
        productId:product.id,
        action:"noop",
        available:stock.available
      };
    }

    const requested=Math.min(
      product.max_batch,
      Math.max(0,product.target_stock-stock.available)
    );
    if(requested<=0){
      return {
        productId:product.id,
        action:"noop",
        available:stock.available
      };
    }

    const job=await createJob(env,product.id,requested);
    try{
      const result=await recoverJob(env,product,job);
      return {
        productId:product.id,
        action:"restocked",
        available:result.available,
        requested,
        delivered:result.added,
        jobId:job.id
      };
    }catch(error){
      if(isOutOfStock(error)){
        return {
          productId:product.id,
          action:"out_of_stock",
          available:stock.available,
          requested,
          jobId:job.id
        };
      }
      throw error;
    }
  }finally{
    await releaseProductLock(env,product.id,lock).catch(()=>undefined);
  }
}

export async function runAllProducts(env:Env){
  await ensureSchema(env);
  const products=await listEnabledProducts(env);
  const results:RunResult[]=[];
  for(const product of products){
    try{
      results.push(await runProduct(env,product));
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      await logEvent(env,{
        level:"error",
        kind:"product_run_failed",
        productId:product.id,
        message
      }).catch(()=>undefined);
    }
  }
  return results;
}
