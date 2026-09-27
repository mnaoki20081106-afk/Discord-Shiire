import type { Env } from "./types";
import { randomId } from "./crypto";
import {
  auditX,
  circuitState,
  createPurchaseOrderRecord,
  fundingSpendSince,
  getSupplierProductRecord,
  pendingPurchaseOrders,
  readyInventoryCount,
  recordFundingEvent,
  setCircuitBreaker,
  storeDeliveredAccounts,
  successfulPurchaseCountForProduct,
  updatePurchaseOrderRecord,
  upsertSupplierProduct
} from "./x-db";
import { loadXSettings } from "./x-settings";
import { calculateFundingAllowance } from "./x-risk";
import {
  getBinanceBalance,
  getLtcJpyMarketStatus,
  placeLtcJpyMarketBuy
} from "./providers/binance";
import {
  getHstoraBalance,
  listHstoraCatalog,
  createHstoraOrder,
  lookupHstoraOrder,
  getHstoraProduct,
  type HstoraProduct,
  type HstoraCatalogItem
} from "./providers/hstora";
import { qualifyHstoraProduct } from "./x-qualification";
import { notifyDiscord } from "./x-alerts";

export type XRunResult={
  action:string;
  dryRun:boolean;
  inventory?:number;
  requested?:number;
  productId?:number;
  unitPriceJpy?:number|null;
  details?:unknown;
};

function jstPeriodStarts(now=Date.now()){
  const JST=9*60*60*1000;
  const local=new Date(now+JST);
  const year=local.getUTCFullYear();
  const month=local.getUTCMonth();
  const date=local.getUTCDate();
  const dayStart=Date.UTC(year,month,date)-JST;
  const day=local.getUTCDay();
  const mondayOffset=(day+6)%7;
  const weekStart=Date.UTC(year,month,date-mondayOffset)-JST;
  const monthStart=Date.UTC(year,month,1)-JST;
  return {dayStart,weekStart,monthStart};
}

async function reconcilePending(env:Env){
  const pending=await pendingPurchaseOrders(env);
  for(const row of pending as any[]){
    try{
      const order=await lookupHstoraOrder(env,String(row.external_order_id));
      const status=String(order.status??"").toUpperCase();
      const hasDelivery=Boolean(order.delivery?.available&&Array.isArray(order.delivery?.items));
      if(hasDelivery){
        const added=await storeDeliveredAccounts(env,{
          purchaseOrderId:String(row.id),
          supplier:"hstora",
          supplierProductId:String(row.supplier_product_id),
          purchasePrice:Number(row.unit_price),
          orderResponse:order
        });
        await updatePurchaseOrderRecord(env,String(row.id),{
          status:status||"DELIVERED",
          supplierOrderId:String(order.id),
          response:order
        });
        await auditX(env,{
          kind:"HSTORA_ORDER_RECONCILED",
          message:"HStora order delivery reconciled",
          details:{purchaseOrderId:row.id,supplierOrderId:order.id,added,status}
        });
      }else if(status){
        await updatePurchaseOrderRecord(env,String(row.id),{
          status,
          supplierOrderId:String(order.id),
          response:order
        });
      }
    }catch(error){
      await auditX(env,{
        level:"warn",
        kind:"HSTORA_RECONCILE_FAILED",
        message:error instanceof Error?error.message:String(error),
        details:{purchaseOrderId:row.id}
      });
    }
  }
}

async function catalogProducts(env:Env,approvedIds:number[]):Promise<HstoraCatalogItem[]>{
  if(approvedIds.length){
    const out:HstoraCatalogItem[]=[];
    for(const id of approvedIds.slice(0,100)){
      try{out.push(await getHstoraProduct(env,id));}
      catch(error){
        await auditX(env,{
          level:"warn",
          kind:"HSTORA_APPROVED_PRODUCT_FETCH_FAILED",
          message:error instanceof Error?error.message:String(error),
          details:{productId:id}
        });
      }
    }
    return out;
  }

  const out:HstoraProduct[]=[];
  let page=1;
  let pages=1;
  do{
    const response=await listHstoraCatalog(env,page,20);
    out.push(...(response.items??[]));
    pages=Math.min(20,Math.max(1,Number(response.pagination?.pages??1)));
    page++;
  }while(page<=pages);
  return out;
}

async function selectCandidate(env:Env,quantity:number){
  const settings=await loadXSettings(env);
  const products=await catalogProducts(env,settings.approved_hstora_product_ids);
  const candidates:Array<{product:HstoraProduct;q:ReturnType<typeof qualifyHstoraProduct>}>=[];

  for(const product of products){
    let full:HstoraProduct;
    try{
      full=await getHstoraProduct(env,Number(product.id));
    }catch(error){
      await auditX(env,{
        level:"warn",
        kind:"HSTORA_PRODUCT_DETAIL_FAILED",
        message:error instanceof Error?error.message:String(error),
        details:{productId:product.id}
      });
      continue;
    }
    const q=qualifyHstoraProduct(full,settings,quantity);
    const previous=await getSupplierProductRecord(env,String(full.id));
    const previousPrice=Number(previous?.unit_price??0);
    const currentPrice=Number(full.price??0);
    const sameCurrency=String(previous?.currency??"").toUpperCase()===String(full.currency??"").toUpperCase();
    if(previous&&sameCurrency&&previousPrice>0&&currentPrice>0){
      const jump=Math.abs(currentPrice-previousPrice)/previousPrice*100;
      if(jump>settings.max_price_jump_percent){
        await setCircuitBreaker(
          env,
          "product_price",
          "OPEN",
          "HSTORA_PRODUCT_PRICE_JUMP:"+jump.toFixed(2)+"%"
        );
        await auditX(env,{
          level:"error",
          kind:"PRODUCT_PRICE_JUMP",
          message:"HStora product price changed beyond configured threshold",
          details:{productId:full.id,previousPrice,currentPrice,jumpPercent:jump}
        });
        throw new Error("PRODUCT_PRICE_JUMP");
      }
    }
    await upsertSupplierProduct(env,{
      supplier:"hstora",
      supplierProductId:String(full.id),
      title:String(full.name??""),
      description:String(full.description??full.short_description??""),
      currency:String(full.currency??""),
      unitPrice:Number(full.price??0),
      stockAvailable:Number(full.stock_available??0),
      productUrl:full.product_url,
      structured:{
        delivery_type:full.delivery_type,
        price_tiers:full.price_tiers,
        rules:full.rules
      },
      qualification:q,
      qualified:q.qualified,
      seller:null
    });
    if(q.qualified) candidates.push({product:full,q});
  }

  candidates.sort((a,b)=>(a.q.unit_price_jpy??Infinity)-(b.q.unit_price_jpy??Infinity));
  return candidates[0]??null;
}

async function fundingWindowRemaining(env:Env,limit:number,since:number){
  if(limit<=0) return 0;
  const spent=await fundingSpendSince(env,since);
  return Math.max(0,limit-spent);
}

async function handleHstoraFundingNeed(
  env:Env,
  neededUsd:number
):Promise<XRunResult>{
  const settings=await loadXSettings(env);
  if(settings.usd_jpy_rate<=0||Date.now()-settings.usd_jpy_rate_updated_at>settings.max_fx_age_ms){
    return {
      action:"MANUAL_FX_RATE_REQUIRED",
      dryRun:settings.dry_run,
      details:{neededUsd}
    };
  }

  let ltcJpy:number;
  let ltcFree:number;
  let jpyFree:number;
  try{
    [ltcJpy,ltcFree,jpyFree]=await Promise.all([
      getLtcJpyMarketStatus().then(v=>v.priceJpy),
      getBinanceBalance(env,"LTC").then(v=>v.free),
      getBinanceBalance(env,"JPY").then(v=>v.free)
    ]);
  }catch(error){
    await setCircuitBreaker(env,"binance","OPEN",error instanceof Error?error.message:String(error));
    await notifyDiscord(env,{
      title:"Circuit Breaker: Binance",
      message:"Binance APIの取得に失敗したため自動処理を停止しました。",
      level:"error"
    }).catch(()=>undefined);
    return {action:"BINANCE_API_BLOCKED",dryRun:settings.dry_run};
  }

  const requiredJpy=Math.ceil(neededUsd*settings.usd_jpy_rate);
  const requiredLtc=requiredJpy/ltcJpy;

  if(ltcFree>=requiredLtc){
    const message="HStora Main WalletへのLTC入金が必要です。HStora公式APIには入金アドレス/入金見積りAPIがないため、自動送金は行いません。";
    await notifyDiscord(env,{
      title:"HStora LTC入金が必要",
      message,
      details:{neededUsd,approxRequiredLtc:requiredLtc,binanceLtcFree:ltcFree}
    }).catch(()=>undefined);
    return {
      action:"MANUAL_HSTORA_LTC_DEPOSIT_REQUIRED",
      dryRun:settings.dry_run,
      details:{neededUsd,requiredJpy,approxRequiredLtc:requiredLtc,binanceLtcFree:ltcFree}
    };
  }

  const ltcShortfall=Math.max(0,requiredLtc-ltcFree);
  const buyNeededJpy=Math.ceil(ltcShortfall*ltcJpy);
  const {dayStart,weekStart,monthStart}=jstPeriodStarts();
  const [daily,weekly,monthly]=await Promise.all([
    fundingWindowRemaining(env,settings.daily_purchase_limit_jpy,dayStart),
    fundingWindowRemaining(env,settings.weekly_purchase_limit_jpy,weekStart),
    fundingWindowRemaining(env,settings.monthly_purchase_limit_jpy,monthStart)
  ]);

  const observedFresh=
    settings.observed_paypay_balance_at>0&&
    Date.now()-settings.observed_paypay_balance_at<=settings.max_paypay_balance_age_ms;

  if(!observedFresh){
    await notifyDiscord(env,{
      title:"PayPay残高確認が必要",
      message:"reserve_jpyを保証するため、管理画面で現在のPayPay残高を更新してください。",
      details:{ltcShortfall,buyNeededJpy}
    }).catch(()=>undefined);
    return {
      action:"PAYPAY_BALANCE_OBSERVATION_REQUIRED",
      dryRun:settings.dry_run,
      details:{ltcShortfall,buyNeededJpy}
    };
  }

  const allowance=calculateFundingAllowance({
    reserveJpy:settings.reserve_jpy,
    maxPurchaseJpy:settings.max_purchase_jpy,
    dailyRemainingJpy:daily,
    weeklyRemainingJpy:weekly,
    monthlyRemainingJpy:monthly,
    minPurchaseJpy:settings.min_purchase_jpy,
    paypayBalanceJpy:settings.observed_paypay_balance_jpy,
    currentLtc:ltcFree,
    targetLtcBalance:settings.target_ltc_balance,
    maxLtcBalance:settings.max_ltc_balance,
    ltcJpy
  });
  const desired=Math.min(buyNeededJpy,allowance.allowedJpy);

  if(desired<=0){
    return {
      action:"FUNDING_LIMIT_BLOCKED",
      dryRun:settings.dry_run,
      details:{buyNeededJpy,allowance}
    };
  }

  if(jpyFree<desired){
    await recordFundingEvent(env,{
      provider:"paypay_manual",
      kind:"JPY_DEPOSIT_REQUIRED",
      amountJpy:desired-jpyFree,
      status:"REQUIRED",
      metadata:{desired,jpyFree}
    });
    await notifyDiscord(env,{
      title:"LTC購入資金が必要",
      message:"Binance JapanへPayPayからJPYを手動入金してください。入金後はBinance残高増加を公式APIで検知します。",
      details:{requiredDepositJpy:Math.ceil(desired-jpyFree),purchaseCeilingJpy:desired}
    }).catch(()=>undefined);
    return {
      action:"MANUAL_PAYPAY_TO_BINANCE_REQUIRED",
      dryRun:settings.dry_run,
      details:{requiredDepositJpy:Math.ceil(desired-jpyFree),allowance}
    };
  }

  if(!settings.auto_purchase_enabled){
    return {
      action:"AUTO_LTC_PURCHASE_DISABLED",
      dryRun:settings.dry_run,
      details:{wouldBuyJpy:desired,ltcJpy}
    };
  }

  if(settings.dry_run){
    return {
      action:"DRY_RUN_LTC_PURCHASE",
      dryRun:true,
      details:{wouldBuyJpy:desired,ltcJpy,estimatedLtc:desired/ltcJpy,allowance}
    };
  }

  const clientOrderId=("shiirex_"+randomId()).slice(0,36);
  try{
    const order=await placeLtcJpyMarketBuy(env,{quoteJpy:Math.floor(desired),clientOrderId,live:true});
    await recordFundingEvent(env,{
      provider:"binance_japan",
      kind:"LTC_PURCHASE",
      amountJpy:Math.floor(desired),
      asset:"LTC",
      assetAmount:Number(order.executedQty??0),
      status:String(order.status??"SUBMITTED").toUpperCase(),
      providerReference:String(order.orderId),
      metadata:{clientOrderId}
    });
    await notifyDiscord(env,{
      title:"LTC購入",
      message:"Binance Japanで上限計算済みのLTC購入注文を送信しました。",
      details:{jpy:Math.floor(desired),status:order.status,orderId:order.orderId}
    }).catch(()=>undefined);
    return {action:"LTC_PURCHASE_SUBMITTED",dryRun:false,details:{orderId:order.orderId,status:order.status}};
  }catch(error){
    await setCircuitBreaker(env,"binance_purchase","OPEN",error instanceof Error?error.message:String(error));
    await notifyDiscord(env,{
      title:"Circuit Breaker: LTC購入",
      message:"LTC購入処理に失敗したため停止しました。",
      level:"error"
    }).catch(()=>undefined);
    return {action:"LTC_PURCHASE_FAILED",dryRun:false};
  }
}

export async function runXProcurement(env:Env):Promise<XRunResult>{
  const settings=await loadXSettings(env);
  if(settings.emergency_stop) return {action:"EMERGENCY_STOP",dryRun:settings.dry_run};

  const breakers=await Promise.all([
    circuitState(env,"hstora"),
    circuitState(env,"binance"),
    circuitState(env,"binance_purchase"),
    circuitState(env,"product_price")
  ]);
  if(breakers.some(value=>String(value?.state??"")==="OPEN")){
    return {action:"CIRCUIT_BREAKER_OPEN",dryRun:settings.dry_run};
  }

  await reconcilePending(env);
  const inventory=await readyInventoryCount(env);
  if(inventory>settings.reorder_point){
    return {action:"INVENTORY_OK",dryRun:settings.dry_run,inventory};
  }

  const need=Math.max(0,settings.target_stock-inventory);
  const batch=Math.min(need,settings.max_batch_purchase);
  if(batch<=0) return {action:"INVENTORY_OK",dryRun:settings.dry_run,inventory};

  let candidate;
  try{candidate=await selectCandidate(env,batch);}
  catch(error){
    const message=error instanceof Error?error.message:String(error);
    if(message==="PRODUCT_PRICE_JUMP"){
      return {action:"PRODUCT_PRICE_CIRCUIT_BREAKER",dryRun:settings.dry_run,inventory};
    }
    await setCircuitBreaker(env,"hstora","OPEN",message);
    await notifyDiscord(env,{
      title:"Circuit Breaker: HStora",
      message:"HStora APIの候補取得に失敗したため自動仕入れを停止しました。",
      level:"error"
    }).catch(()=>undefined);
    return {action:"HSTORA_API_BLOCKED",dryRun:settings.dry_run,inventory};
  }
  if(!candidate){
    return {
      action:"NO_QUALIFIED_HSTORA_PRODUCT",
      dryRun:settings.dry_run,
      inventory,
      details:{
        sellerQualityMode:settings.seller_quality_mode,
        note:"HStora v1 APIにはseller rating/reviews/sales/dispute rateがないためstrict_apiでは自動購入しません。"
      }
    };
  }

  const fresh=await getHstoraProduct(env,Number(candidate.product.id));
  const q=qualifyHstoraProduct(fresh,settings,batch);
  if(!q.qualified){
    await setCircuitBreaker(env,"product_price","OPEN","PRODUCT_REQUALIFICATION_FAILED");
    return {action:"PRODUCT_REQUALIFICATION_FAILED",dryRun:settings.dry_run,inventory,productId:Number(fresh.id),details:q};
  }

  const prior=await successfulPurchaseCountForProduct(env,String(fresh.id));
  const trialCap=prior===0?settings.trial_purchase_count:batch;
  const quantity=Math.min(batch,Math.max(1,trialCap),Number(fresh.stock_available??0));
  if(quantity<=0) return {action:"PRODUCT_OUT_OF_STOCK",dryRun:settings.dry_run,inventory,productId:Number(fresh.id)};

  if(
    !settings.dry_run&&
    settings.require_bulk_confirmation&&
    quantity>=settings.bulk_confirmation_threshold&&
    settings.bulk_approval_until<Date.now()
  ){
    await notifyDiscord(env,{
      title:"大量購入前確認",
      message:"設定された閾値以上の仕入れになるため、管理画面で一時承認が必要です。",
      details:{productId:fresh.id,quantity,threshold:settings.bulk_confirmation_threshold}
    }).catch(()=>undefined);
    return {
      action:"BULK_CONFIRMATION_REQUIRED",
      dryRun:false,
      inventory,
      requested:quantity,
      productId:Number(fresh.id)
    };
  }

  const unitSource=Number(q.unit_price_source);
  const totalSource=unitSource*quantity;
  let supplierBalance;
  try{supplierBalance=await getHstoraBalance(env);}
  catch(error){
    await setCircuitBreaker(env,"hstora","OPEN",error instanceof Error?error.message:String(error));
    return {action:"HSTORA_BALANCE_ERROR",dryRun:settings.dry_run,inventory};
  }

  if(String(supplierBalance.currency).toUpperCase()!=="USD"||String(fresh.currency).toUpperCase()!=="USD"){
    return {
      action:"HSTORA_CURRENCY_UNSUPPORTED",
      dryRun:settings.dry_run,
      details:{walletCurrency:supplierBalance.currency,productCurrency:fresh.currency}
    };
  }

  if(supplierBalance.balance<totalSource){
    return handleHstoraFundingNeed(env,totalSource-supplierBalance.balance);
  }

  const externalOrderId=("shiire-x-"+randomId()).slice(0,64);
  const idempotencyKey=("idem-shiire-x-"+randomId()).slice(0,96);

  if(settings.dry_run||!settings.auto_procurement_enabled){
    await auditX(env,{
      kind:"X_PROCUREMENT_DRY_RUN",
      message:"Qualified HStora product would be purchased",
      details:{
        productId:fresh.id,quantity,unitPriceJpy:q.unit_price_jpy,totalSource,
        searchVisibility:q.search_visibility,trial:prior===0,dryRun:settings.dry_run
      }
    });
    return {
      action:settings.dry_run?"DRY_RUN_HSTORA_PURCHASE":"AUTO_PROCUREMENT_DISABLED",
      dryRun:settings.dry_run,
      inventory,
      requested:quantity,
      productId:Number(fresh.id),
      unitPriceJpy:q.unit_price_jpy,
      details:{qualification:q,totalSource,currency:fresh.currency,trial:prior===0}
    };
  }

  const recordId=await createPurchaseOrderRecord(env,{
    supplier:"hstora",
    supplierProductId:String(fresh.id),
    quantity,
    unitPrice:unitSource,
    totalAmount:totalSource,
    currency:String(fresh.currency),
    externalOrderId,
    idempotencyKey,
    dryRun:false
  });

  await notifyDiscord(env,{
    title:"仕入れ開始",
    message:"HStoraでXアカウント仕入れを開始します。",
    details:{productId:fresh.id,quantity,unitPriceJpy:q.unit_price_jpy,trial:prior===0}
  }).catch(()=>undefined);

  try{
    const order=await createHstoraOrder(env,{
      productId:Number(fresh.id),
      quantity,
      externalOrderId,
      idempotencyKey
    });
    const status=String(order.status??"SUBMITTED").toUpperCase();
    const added=order.delivery?.available
      ?await storeDeliveredAccounts(env,{
        purchaseOrderId:recordId,
        supplier:"hstora",
        supplierProductId:String(fresh.id),
        purchasePrice:unitSource,
        orderResponse:order
      })
      :0;
    await updatePurchaseOrderRecord(env,recordId,{
      status:order.delivery?.available?(status||"DELIVERED"):(status||"PROCESSING"),
      supplierOrderId:String(order.id),
      response:order
    });
    await notifyDiscord(env,{
      title:order.delivery?.available?"仕入れ完了":"仕入れ処理中",
      message:order.delivery?.available
        ?"購入データを暗号化し、READY_FOR_DELIVERYへ保存しました。"
        :"注文は作成済みです。次回実行時に公式Order Lookupで照合します。",
      details:{productId:fresh.id,quantity,stored:added,status}
    }).catch(()=>undefined);
    return {
      action:order.delivery?.available?"HSTORA_PURCHASE_DELIVERED":"HSTORA_PURCHASE_PROCESSING",
      dryRun:false,
      inventory,
      requested:quantity,
      productId:Number(fresh.id),
      unitPriceJpy:q.unit_price_jpy,
      details:{stored:added,status,supplierOrderId:order.id}
    };
  }catch(error){
    let recovered=false;
    try{
      const order=await lookupHstoraOrder(env,externalOrderId);
      recovered=true;
      const status=String(order.status??"PROCESSING").toUpperCase();
      const added=order.delivery?.available
        ?await storeDeliveredAccounts(env,{
          purchaseOrderId:recordId,
          supplier:"hstora",
          supplierProductId:String(fresh.id),
          purchasePrice:unitSource,
          orderResponse:order
        })
        :0;
      await updatePurchaseOrderRecord(env,recordId,{
        status,
        supplierOrderId:String(order.id),
        response:order
      });
      return {
        action:"HSTORA_ORDER_RECOVERED",
        dryRun:false,
        inventory,
        requested:quantity,
        productId:Number(fresh.id),
        details:{status,stored:added}
      };
    }catch{}
    if(!recovered){
      const code=error instanceof Error?error.message.slice(0,120):"HSTORA_PURCHASE_FAILED";
      await updatePurchaseOrderRecord(env,recordId,{status:"FAILED",errorCode:code});
      await setCircuitBreaker(env,"hstora","OPEN",code);
      await notifyDiscord(env,{
        title:"Circuit Breaker: HStora購入",
        message:"注文結果をlookupでも確認できなかったため停止しました。手動確認が必要です。",
        level:"error",
        details:{externalOrderId,code}
      }).catch(()=>undefined);
    }
    return {action:"HSTORA_PURCHASE_FAILED",dryRun:false,inventory,productId:Number(fresh.id)};
  }
}
