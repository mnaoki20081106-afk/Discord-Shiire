import type { Env } from "./types";
import { randomId } from "./crypto";
import {
  auditX,
  circuitState,
  createPurchaseOrderRecord,
  fundingSpendSince,
  getSupplierProductRecord,
  getXSetting,
  getProcurementBudgets,
  initializeProcurementBudgetsIfNeeded,
  creditProcurementBudgets,
  reserveProcurementBudgetCharges,
  releaseProcurementBudgetCharges,
  pendingPurchaseOrders,
  purchasedAccountCountForOrder,
  readyInventoryCount,
  readyInventoryCountByClass,
  recordFundingEvent,
  updateFundingEventByProviderReference,
  setCircuitBreaker,
  storeDeliveredAccounts,
  successfulPurchaseCountForProduct,
  setXSetting,
  updatePurchaseOrderRecord,
  upsertSupplierProduct
} from "./x-db";
import { loadXSettings, saveXSettings } from "./x-settings";
import {
  procurementBudgetCharges,
  maxAffordableQuantityForBudget,
  type ProcurementBudgetAmounts
} from "./x-budget";
import { isBinanceAutoFundingServerEnabled } from "./x-funding-mode";
import {
  calculateLtcPurchaseAllowance,
  calculateSpendablePayPayJpy,
  nextObservedPayPayBalance,
  planManualPayPayPaths,
  detectManualPayPayCompletion
} from "./x-risk";
import {
  getBinanceBalance,
  getBinanceOrder,
  getLtcJpyMarketStatus,
  placeLtcJpyMarketBuy,
  BinanceApiError
} from "./providers/binance";
import {
  getHstoraBalance,
  listHstoraCatalog,
  createHstoraOrder,
  lookupHstoraOrder,
  getHstoraProduct,
  HstoraApiError,
  type HstoraProduct,
  type HstoraCatalogItem
} from "./providers/hstora";
import {
  detectSearchVisibility,
  isXAccountProduct,
  qualifyHstoraProduct,
  type ProcurementClass
} from "./x-qualification";
import {
  DUAL_TOP_SPLIT_MODE,
  PREFERRED_NO_SHADOWBAN_HSTORA_PRODUCT_IDS,
  PREFERRED_TOP_HSTORA_PRODUCT_IDS,
  evenSplitPurchaseQuantity,
  hasDualTopNoShadowbanEvidence,
  isTopSearchFallbackEligible,
  isPreferredNoShadowbanHstoraSource,
  isPreferredTopHstoraSource,
  procurementClassOverrideForHstoraProduct
} from "./x-procurement-policy";
import { notifyDiscord } from "./x-alerts";
import { notifyShiireVendingStockArrival } from "./shiire-vending";
import {
  getInviteCampaignSettings,
  inviteCampaignStockCount
} from "./invite-campaign-db";

const PAYPAY_DIRECT_PURCHASE_MIN_JPY=1_000;
const PAYPAY_JPY_DEPOSIT_MIN_GROSS_JPY=1_000;
const PAYPAY_JPY_DEPOSIT_FEE_JPY=110;

export type XRunResult={
  action:string;
  dryRun:boolean;
  inventory?:number;
  requested?:number;
  productId?:number;
  unitPriceJpy?:number|null;
  details?:unknown;
};

type ProcurementTarget=ProcurementClass|"INVITE_CAMPAIGN";

function procurementBudgetPercentages(
  settings:Awaited<ReturnType<typeof loadXSettings>>
){
  return {
    INVITE_CAMPAIGN:settings.invite_campaign_budget_percent,
    NO_SHADOWBAN:settings.no_shadowban_budget_percent,
    TOP_SEARCH:settings.top_search_budget_percent
  };
}

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

export async function reconcilePendingXOrders(env:Env){
  const pending=await pendingPurchaseOrders(env);
  for(const row of pending as any[]){
    try{
      const order=await lookupHstoraOrder(env,String(row.external_order_id));
      const status=String(order.status??"").toUpperCase();
      const hasDelivery=Boolean(order.delivery?.available&&Array.isArray(order.delivery?.items));
      if(hasDelivery){
        const stored=await storeDeliveredAccounts(env,{
          purchaseOrderId:String(row.id),
          supplier:"hstora",
          supplierProductId:String(row.supplier_product_id),
          purchasePrice:Number(row.unit_price),
          procurementClass:
            row.procurement_class==="TOP_SEARCH"||
            row.procurement_class==="NO_SHADOWBAN"||
            row.procurement_class==="INVITE_CAMPAIGN"
              ?row.procurement_class
              :null,
          orderResponse:order
        });
        const added=stored.inserted;
        if(added>0){
          await notifyShiireVendingStockArrival(
            env,
            String(row.supplier_product_id),
            added,
            stored.byClass
          ).catch(()=>undefined);
        }
        const storedTotal=await purchasedAccountCountForOrder(env,String(row.id));
        if(storedTotal!==Number(row.quantity)){
          await updatePurchaseOrderRecord(env,String(row.id),{
            status:"DELIVERY_INTEGRITY_FAILED",
            supplierOrderId:String(order.id),
            response:order,
            errorCode:"DELIVERY_COUNT_MISMATCH"
          });
          await setCircuitBreaker(env,"delivery_integrity","OPEN","DELIVERY_COUNT_MISMATCH");
          await notifyDiscord(env,{
            title:"不良商品",
            message:"再照合したHStora注文の納品件数が注文数と一致しません。",
            level:"error",
            details:{purchaseOrderId:row.id,ordered:Number(row.quantity),insertedNow:added,storedTotal}
          }).catch(()=>undefined);
          continue;
        }
        await updatePurchaseOrderRecord(env,String(row.id),{
          status:status||"DELIVERED",
          supplierOrderId:String(order.id),
          response:order
        });
        await auditX(env,{
          kind:"HSTORA_ORDER_RECONCILED",
          message:"HStora order delivery reconciled",
          details:{purchaseOrderId:row.id,supplierOrderId:order.id,insertedNow:added,storedTotal,status}
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

  const out:HstoraCatalogItem[]=[];
  let page=1;
  let pages=1;
  do{
    const response=await listHstoraCatalog(env,page,20);
    out.push(...(response.items??[]));
    const reportedPages=Math.max(
      1,
      Math.floor(Number(response.pagination?.pages??1))
    );
    // Fail closed instead of silently scanning only part of a catalog if the
    // API suddenly reports an implausibly large page count.
    if(reportedPages>200){
      throw new Error("HSTORA_CATALOG_PAGE_COUNT_UNEXPECTED");
    }
    pages=reportedPages;
    page++;
  }while(page<=pages);
  return out;
}

function hasTopSearchEvidence(product:HstoraCatalogItem|HstoraProduct){
  const labels=detectSearchVisibility(product).labels;
  return labels.includes("TOP+Latest")||labels.includes("TOP Search");
}

function catalogBasePriceJpy(
  product:HstoraCatalogItem,
  settings:Awaited<ReturnType<typeof loadXSettings>>
):number|null{
  const currency=String(product.currency??"").toUpperCase();
  const price=Number(product.price);
  if(!Number.isFinite(price)||price<=0) return null;
  if(currency==="JPY") return price;
  if(
    currency==="USD"&&
    settings.usd_jpy_rate>0&&
    settings.usd_jpy_rate_updated_at>0&&
    Date.now()-settings.usd_jpy_rate_updated_at<=settings.max_fx_age_ms
  ){
    return price*settings.usd_jpy_rate;
  }
  return null;
}

async function selectCandidate(
  env:Env,
  quantityLimit:number,
  targetClass:ProcurementTarget,
  budgetAvailable?:ProcurementBudgetAmounts
){
  const settings=await loadXSettings(env);
  const trustedApprovedIds=[...new Set([
    ...PREFERRED_TOP_HSTORA_PRODUCT_IDS,
    ...PREFERRED_NO_SHADOWBAN_HSTORA_PRODUCT_IDS,
    ...settings.approved_hstora_product_ids
  ])];
  const approvedIds=
    settings.seller_quality_mode==="manual_product_approval"
      ?trustedApprovedIds
      :[];
  const qualificationSettings=
    settings.seller_quality_mode==="manual_product_approval"
      ?{...settings,approved_hstora_product_ids:trustedApprovedIds}
      :settings;
  const products=await catalogProducts(env,approvedIds);
  const candidates:Array<{
    product:HstoraProduct;
    q:ReturnType<typeof qualifyHstoraProduct>;
    plannedQuantity:number;
    priorPurchases:number;
  }> = [];

  for(const product of products){
    if(!isXAccountProduct(product)) continue;

    const visibility=detectSearchVisibility(product);
    const hasTop=
      visibility.labels.includes("TOP+Latest")||
      visibility.labels.includes("TOP Search");
    const hasNoShadow=visibility.labels.includes("No Shadowban");
    const dualCapability=hasDualTopNoShadowbanEvidence(
      visibility.labels
    );
    const forceNoShadowban=
      procurementClassOverrideForHstoraProduct(product.id)==="NO_SHADOWBAN";
    const baseJpy=catalogBasePriceJpy(product,settings);
    const baseUsd=
      String(product.currency??"").toUpperCase()==="USD"
        ?Number(product.price)
        :null;

    if(targetClass==="TOP_SEARCH"){
      if(forceNoShadowban) continue;
      if(!hasTop) continue;
      if(!isTopSearchFallbackEligible(product.id,visibility.labels)) continue;
      if(baseJpy===null||baseJpy>settings.max_unit_price_jpy) continue;
    }else if(targetClass==="NO_SHADOWBAN"){
      if(hasTop&&!dualCapability&&!forceNoShadowban) continue;
      if(!hasNoShadow) continue;
      if(
        baseUsd===null||
        !Number.isFinite(baseUsd)||
        baseUsd>settings.max_no_shadowban_unit_price_usd
      ){
        continue;
      }
    }else{
      const topEligible=
        !forceNoShadowban&&hasTop&&
        baseJpy!==null&&baseJpy<=settings.max_unit_price_jpy;
      const noShadowEligible=
        hasNoShadow&&
        (!hasTop||dualCapability||forceNoShadowban)&&
        baseUsd!==null&&Number.isFinite(baseUsd)&&
        baseUsd<=settings.max_no_shadowban_unit_price_usd;
      if(!topEligible&&!noShadowEligible) continue;
    }

    let full:HstoraProduct;
    try{
      full=await getHstoraProduct(env,Number(product.id));
    }catch(error){
      await auditX(env,{
        level:"warn",
        kind:"HSTORA_PRODUCT_DETAIL_FAILED",
        message:error instanceof Error?error.message:String(error),
        details:{productId:product.id,targetClass}
      });
      continue;
    }

    const priorPurchases=await successfulPurchaseCountForProduct(
      env,
      String(full.id)
    );
    const trialCap=
      priorPurchases===0
        ?settings.trial_purchase_count
        :quantityLimit;
    const fullVisibility=detectSearchVisibility(full);
    const fullDualCapability=hasDualTopNoShadowbanEvidence(
      fullVisibility.labels
    );
    const fullForceNoShadowban=
      procurementClassOverrideForHstoraProduct(full.id)==="NO_SHADOWBAN";
    let plannedQuantity=Math.min(
      quantityLimit,
      Math.max(1,trialCap),
      Math.max(0,Number(full.stock_available??0))
    );
    if(targetClass!=="INVITE_CAMPAIGN"&&fullDualCapability&&!fullForceNoShadowban){
      plannedQuantity=evenSplitPurchaseQuantity(plannedQuantity);
    }
    if(plannedQuantity<=0) continue;

    const classOverride=
      procurementClassOverrideForHstoraProduct(full.id)??undefined;
    const policyQualification=qualifyHstoraProduct(
      full,
      qualificationSettings,
      plannedQuantity,
      Date.now(),
      classOverride
    );
    const q=
      classOverride
        ?{
          ...policyQualification,
          evidence:[
            ...policyQualification.evidence,
            "POLICY_OVERRIDE_HSTORA_4521_NO_SHADOWBAN"
          ]
        }
        :policyQualification;
    const previous=await getSupplierProductRecord(env,String(full.id));
    const previousPrice=Number(previous?.unit_price??0);
    const currentPrice=Number(full.price??0);
    const sameCurrency=
      String(previous?.currency??"").toUpperCase()===
      String(full.currency??"").toUpperCase();

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
          details:{
            productId:full.id,
            previousPrice,
            currentPrice,
            jumpPercent:jump,
            targetClass
          }
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
      unitPrice:Number(q.unit_price_source??full.price??0),
      stockAvailable:Number(full.stock_available??0),
      productUrl:full.product_url,
      structured:{
        delivery_type:full.delivery_type,
        price_tiers:full.price_tiers,
        rules:full.rules,
        procurement_strategy:settings.procurement_strategy,
        planned_quantity:plannedQuantity,
        procurement_class:q.procurement_class
      },
      qualification:q,
      procurementClass:q.procurement_class,
      qualified:q.qualified,
      seller:null
    });

    const supportsTarget=
      targetClass==="INVITE_CAMPAIGN"
        ?Boolean(q.procurement_class)
        :q.procurement_class===targetClass||
          (
            targetClass==="NO_SHADOWBAN"&&
            q.procurement_class==="TOP_SEARCH"&&
            hasDualTopNoShadowbanEvidence(q.search_visibility)
          );
    if(q.qualified&&supportsTarget){
      candidates.push({product:full,q,plannedQuantity,priorPurchases});
    }
  }

  candidates.sort((a,b)=>{
    if(targetClass==="INVITE_CAMPAIGN"){
      const aPreferred=isPreferredTopHstoraSource(a.product.id)||isPreferredNoShadowbanHstoraSource(a.product.id);
      const bPreferred=isPreferredTopHstoraSource(b.product.id)||isPreferredNoShadowbanHstoraSource(b.product.id);
      if(aPreferred!==bPreferred) return aPreferred?-1:1;
    }else if(targetClass==="NO_SHADOWBAN"){
      const aPreferredNoShadow=isPreferredNoShadowbanHstoraSource(a.product.id);
      const bPreferredNoShadow=isPreferredNoShadowbanHstoraSource(b.product.id);
      if(aPreferredNoShadow!==bPreferredNoShadow){
        return aPreferredNoShadow?-1:1;
      }
      const aPreferredTop=isPreferredTopHstoraSource(a.product.id);
      const bPreferredTop=isPreferredTopHstoraSource(b.product.id);
      if(aPreferredTop!==bPreferredTop) return aPreferredTop?-1:1;
    }else{
      const aPreferred=isPreferredTopHstoraSource(a.product.id);
      const bPreferred=isPreferredTopHstoraSource(b.product.id);
      if(aPreferred!==bPreferred) return aPreferred?-1:1;
    }

    if(targetClass==="NO_SHADOWBAN"){
      const aDual=hasDualTopNoShadowbanEvidence(a.q.search_visibility);
      const bDual=hasDualTopNoShadowbanEvidence(b.q.search_visibility);
      if(aDual!==bDual) return aDual?-1:1;
    }

    const aPrice=
      targetClass==="NO_SHADOWBAN"
        ?Number(a.q.unit_price_source)
        :Number(a.q.unit_price_jpy??Infinity);
    const bPrice=
      targetClass==="NO_SHADOWBAN"
        ?Number(b.q.unit_price_source)
        :Number(b.q.unit_price_jpy??Infinity);
    const price=aPrice-bPrice;
    if(price!==0) return price;
    const stock=
      Number(b.product.stock_available??0)-
      Number(a.product.stock_available??0);
    if(stock!==0) return stock;
    return Number(a.product.id)-Number(b.product.id);
  });

  await auditX(env,{
    kind:"HSTORA_CHEAPEST_FIRST_SCAN",
    message:"HStora candidates ranked within procurement class",
    details:{
      targetClass,
      scannedCatalogItems:products.length,
      qualifiedCandidates:candidates.length,
      maxUnitPrice:
        targetClass==="TOP_SEARCH"
          ?{currency:"JPY",value:settings.max_unit_price_jpy}
          :targetClass==="NO_SHADOWBAN"
            ?{currency:"USD",value:settings.max_no_shadowban_unit_price_usd}
            :{
              topSearch:{currency:"JPY",value:settings.max_unit_price_jpy},
              noShadowban:{currency:"USD",value:settings.max_no_shadowban_unit_price_usd}
            },
      strategy:settings.procurement_strategy,
      cheapest:candidates.slice(0,10).map(candidate=>({
        productId:candidate.product.id,
        procurementClass:candidate.q.procurement_class,
        unitPriceSource:candidate.q.unit_price_source,
        unitPriceJpy:candidate.q.unit_price_jpy,
        plannedQuantity:candidate.plannedQuantity,
        stock:candidate.product.stock_available,
        searchVisibility:candidate.q.search_visibility
      }))
    }
  });

  if(!budgetAvailable) return candidates[0]??null;

  for(const candidate of candidates){
    const forceNoShadowban=
      procurementClassOverrideForHstoraProduct(candidate.product.id)==="NO_SHADOWBAN";
    const splitAcrossClasses=
      targetClass!=="INVITE_CAMPAIGN"&&
      !forceNoShadowban&&
      hasDualTopNoShadowbanEvidence(candidate.q.search_visibility);
    const step=splitAcrossClasses?2:1;
    const classOverride=
      procurementClassOverrideForHstoraProduct(candidate.product.id)??undefined;

    for(
      let affordableQuantity=candidate.plannedQuantity;
      affordableQuantity>=step;
      affordableQuantity-=step
    ){
      const budgetQualification=qualifyHstoraProduct(
        candidate.product,
        qualificationSettings,
        affordableQuantity,
        Date.now(),
        classOverride
      );
      const supportsTarget=
        targetClass==="INVITE_CAMPAIGN"
          ?Boolean(budgetQualification.procurement_class)
          :budgetQualification.procurement_class===targetClass||
            (
              targetClass==="NO_SHADOWBAN"&&
              budgetQualification.procurement_class==="TOP_SEARCH"&&
              hasDualTopNoShadowbanEvidence(
                budgetQualification.search_visibility
              )
            );
      if(!budgetQualification.qualified||!supportsTarget) continue;

      const unitPriceUsd=Number(budgetQualification.unit_price_source);
      const maxAffordable=maxAffordableQuantityForBudget(
        targetClass,
        splitAcrossClasses,
        unitPriceUsd,
        affordableQuantity,
        budgetAvailable
      );
      if(maxAffordable>=affordableQuantity){
        return candidate;
      }
    }
  }

  return null;
}

async function fundingWindowRemaining(env:Env,limit:number,since:number){
  if(limit<=0) return 0;
  const spent=await fundingSpendSince(env,since);
  return Math.max(0,limit-spent);
}

type MarketGuard={ltcJpy:number;updatedAt:number};
async function checkLtcPriceGuard(env:Env,current:number,maxJumpPercent:number){
  const previous=await getXSetting<MarketGuard>(env,"x_ltc_market_guard");
  if(previous&&previous.ltcJpy>0&&current>0){
    const jump=Math.abs(current-previous.ltcJpy)/previous.ltcJpy*100;
    if(jump>maxJumpPercent){
      await setCircuitBreaker(
        env,
        "ltc_price",
        "OPEN",
        "LTCJPY_PRICE_JUMP:"+jump.toFixed(2)+"%"
      );
      await auditX(env,{
        level:"error",
        kind:"LTC_PRICE_JUMP",
        message:"LTC/JPY moved beyond configured threshold.",
        details:{previous:previous.ltcJpy,current,jumpPercent:jump}
      });
      return false;
    }
  }
  await setXSetting(env,"x_ltc_market_guard",{ltcJpy:current,updatedAt:Date.now()});
  return true;
}

type BalanceGuard={hstoraUsd:number;allowedDecreaseUsd:number;updatedAt:number};
async function checkHstoraBalanceGuard(
  env:Env,
  current:number,
  settings:Awaited<ReturnType<typeof loadXSettings>>
){
  const percentages=procurementBudgetPercentages(settings);
  const existingBudget=await getProcurementBudgets(env);
  const budgetWasInitialized=existingBudget.initialized;
  const budgetBefore=budgetWasInitialized
    ?existingBudget
    :await initializeProcurementBudgetsIfNeeded(
      env,
      current,
      percentages
    );
  const previous=await getXSetting<BalanceGuard>(env,"x_hstora_balance_guard");
  let remainingAllowed=0;
  if(previous&&Number.isFinite(previous.hstoraUsd)){
    const allowed=Math.max(0,Number(previous.allowedDecreaseUsd??0));
    const delta=current-previous.hstoraUsd;
    if(delta>0.01){
      // On the first run after this feature is deployed, the current HStora
      // balance is already used to seed all three buckets. Do not add the
      // same balance delta again from the legacy balance guard.
      const budgetAfter=budgetWasInitialized
        ?await creditProcurementBudgets(
          env,
          delta,
          percentages
        )
        :budgetBefore;
      await auditX(env,{
        kind:"HSTORA_BALANCE_INCREASE",
        message:"HStora wallet balance increased.",
        details:{
          previous:previous.hstoraUsd,
          current,
          increaseUsd:delta,
          budgetBefore:budgetBefore.available,
          budgetAfter:budgetAfter.available,
          percentages
        }
      });
      await notifyDiscord(env,{
        title:"HStora入金完了",
        message:"HStora Main Wallet残高の増加を確認し、設定割合で仕入れ予算へ自動配分しました。",
        details:{
          increaseUsd:delta,
          currentBalanceUsd:current,
          budget:budgetAfter.available,
          percentages
        }
      }).catch(()=>undefined);
      await setXSetting(env,"x_manual_hstora_topup_notice",{
        neededUsd:0,
        notifiedAt:0
      });
      remainingAllowed=allowed;
    }else if(delta<0){
      const decrease=-delta;
      if(decrease>allowed+0.01){
        await setCircuitBreaker(
          env,
          "unexpected_balance",
          "OPEN",
          "HSTORA_BALANCE_DECREASE"
        );
        await auditX(env,{
          level:"error",
          kind:"UNEXPECTED_HSTORA_BALANCE_DECREASE",
          message:"HStora balance decreased beyond the amount expected from bot purchases.",
          details:{
            previous:previous.hstoraUsd,
            current,
            decreaseUsd:decrease,
            allowedDecreaseUsd:allowed
          }
        });
        return false;
      }
      remainingAllowed=Math.max(0,allowed-decrease);
    }else{
      remainingAllowed=allowed;
    }
  }
  await setXSetting(env,"x_hstora_balance_guard",{
    hstoraUsd:current,
    allowedDecreaseUsd:remainingAllowed,
    updatedAt:Date.now()
  });
  return true;
}

async function allowExpectedHstoraDecrease(env:Env,amountUsd:number){
  const current=await getXSetting<BalanceGuard>(env,"x_hstora_balance_guard");
  if(!current) return;
  await setXSetting(env,"x_hstora_balance_guard",{
    ...current,
    allowedDecreaseUsd:Math.max(0,current.allowedDecreaseUsd)+Math.max(0,amountUsd),
    updatedAt:Date.now()
  });
}


async function submitLtcMarketPurchase(
  env:Env,
  input:{
    settings:Awaited<ReturnType<typeof loadXSettings>>;
    desiredJpy:number;
    ltcJpy:number;
    purchaseAllowance:ReturnType<typeof calculateLtcPurchaseAllowance>;
    source:"target_rebalance"|"hstora_shortfall";
  }
):Promise<XRunResult>{
  const desired=Math.floor(input.desiredJpy);
  const settings=input.settings;

  if(desired<=0){
    return {
      action:"LTC_PURCHASE_LIMIT_BLOCKED",
      dryRun:settings.dry_run,
      details:{purchaseAllowance:input.purchaseAllowance,source:input.source}
    };
  }

  if(!settings.auto_purchase_enabled){
    return {
      action:"AUTO_LTC_PURCHASE_DISABLED",
      dryRun:settings.dry_run,
      details:{wouldBuyJpy:desired,ltcJpy:input.ltcJpy,source:input.source}
    };
  }

  if(settings.dry_run){
    return {
      action:"DRY_RUN_LTC_PURCHASE",
      dryRun:true,
      details:{
        wouldBuyJpy:desired,
        ltcJpy:input.ltcJpy,
        estimatedLtc:desired/input.ltcJpy,
        purchaseAllowance:input.purchaseAllowance,
        source:input.source
      }
    };
  }

  const clientOrderId=("shiirex_"+randomId()).slice(0,36);
  await recordFundingEvent(env,{
    provider:"binance_japan",
    kind:"LTC_PURCHASE",
    amountJpy:desired,
    asset:"LTC",
    status:"INTENT",
    providerReference:clientOrderId,
    metadata:{clientOrderId,source:input.source}
  });

  try{
    const order=await placeLtcJpyMarketBuy(env,{
      quoteJpy:desired,
      clientOrderId,
      live:true
    });
    if("dryRun" in order){
      throw new Error("BINANCE_LIVE_ORDER_RETURNED_DRY_RUN");
    }
    await updateFundingEventByProviderReference(env,"binance_japan",clientOrderId,{
      status:String(order.status??"SUBMITTED").toUpperCase(),
      assetAmount:Number(order.executedQty??0),
      metadata:{
        clientOrderId,
        orderId:order.orderId,
        source:input.source
      }
    });
    await auditX(env,{
      kind:"BINANCE_LTC_PURCHASE_SUBMITTED",
      message:"Binance Japan LTCJPY market-buy submitted.",
      details:{
        clientOrderId,
        orderId:order.orderId,
        status:order.status,
        jpy:desired,
        source:input.source
      }
    });
    await notifyDiscord(env,{
      title:"LTC購入",
      message:"Binance Japanで上限計算済みのLTC購入注文を送信しました。",
      details:{
        jpy:desired,
        status:order.status,
        orderId:order.orderId,
        source:input.source
      }
    }).catch(()=>undefined);
    return {
      action:"LTC_PURCHASE_SUBMITTED",
      dryRun:false,
      details:{
        orderId:order.orderId,
        status:order.status,
        jpy:desired,
        source:input.source
      }
    };
  }catch(error){
    if(
      error instanceof BinanceApiError&&
      error.status>=400&&
      error.status<500&&
      !error.retryable
    ){
      await updateFundingEventByProviderReference(env,"binance_japan",clientOrderId,{
        status:"FAILED",
        metadata:{
          clientOrderId,
          rejected:true,
          code:error.code,
          status:error.status,
          source:input.source
        }
      });
      await setCircuitBreaker(
        env,
        "binance_purchase",
        "OPEN",
        error.code+":"+error.message.slice(0,160)
      );
      await auditX(env,{
        level:"error",
        kind:"BINANCE_ORDER_REJECTED",
        message:"Binance explicitly rejected the LTCJPY order; no ambiguous retry will be attempted.",
        details:{
          clientOrderId,
          status:error.status,
          code:error.code,
          message:error.message,
          source:input.source
        }
      });
      return {
        action:"LTC_PURCHASE_REJECTED",
        dryRun:false,
        details:{
          clientOrderId,
          status:error.status,
          code:error.code,
          source:input.source
        }
      };
    }

    try{
      const recovered=await getBinanceOrder(env,{origClientOrderId:clientOrderId});
      await updateFundingEventByProviderReference(env,"binance_japan",clientOrderId,{
        status:String(recovered.status??"SUBMITTED").toUpperCase(),
        assetAmount:Number(recovered.executedQty??0),
        metadata:{
          clientOrderId,
          orderId:recovered.orderId,
          recovered:true,
          source:input.source
        }
      });
      await auditX(env,{
        kind:"BINANCE_ORDER_RECOVERED",
        message:"Binance order was recovered by clientOrderId after an ambiguous submission result.",
        details:{
          clientOrderId,
          orderId:recovered.orderId,
          status:recovered.status,
          source:input.source
        }
      });
      return {
        action:"LTC_PURCHASE_RECOVERED",
        dryRun:false,
        details:{
          orderId:recovered.orderId,
          status:recovered.status,
          source:input.source
        }
      };
    }catch{}

    await updateFundingEventByProviderReference(env,"binance_japan",clientOrderId,{
      status:"UNKNOWN",
      metadata:{clientOrderId,source:input.source}
    });
    await setCircuitBreaker(
      env,
      "binance_purchase",
      "OPEN",
      error instanceof Error?error.message:String(error)
    );
    await notifyDiscord(env,{
      title:"Circuit Breaker: LTC購入",
      message:"LTC購入結果をclientOrderIdでも照合できなかったため停止しました。手動確認が必要です。",
      level:"error",
      details:{clientOrderId,source:input.source}
    }).catch(()=>undefined);
    return {
      action:"LTC_PURCHASE_UNKNOWN",
      dryRun:false,
      details:{clientOrderId,source:input.source}
    };
  }
}

export async function runLtcAutoPurchase(env:Env):Promise<XRunResult>{
  const settings=await loadXSettings(env);

  if(settings.emergency_stop){
    return {action:"EMERGENCY_STOP",dryRun:settings.dry_run};
  }
  if(settings.funding_mode!=="binance_auto"){
    return {
      action:"MANUAL_HSTORA_LTC_FUNDING_MODE",
      dryRun:settings.dry_run,
      details:{fundingMode:settings.funding_mode}
    };
  }
  if(!isBinanceAutoFundingServerEnabled(env)){
    return {
      action:"BINANCE_AUTO_FUNDING_SERVER_LOCKED",
      dryRun:settings.dry_run
    };
  }
  if(!settings.auto_purchase_enabled){
    return {action:"AUTO_LTC_PURCHASE_DISABLED",dryRun:settings.dry_run};
  }

  const breakers=await Promise.all([
    circuitState(env,"binance"),
    circuitState(env,"binance_purchase"),
    circuitState(env,"ltc_price")
  ]);
  if(breakers.some(value=>String(value?.state??"")==="OPEN")){
    return {action:"CIRCUIT_BREAKER_OPEN",dryRun:settings.dry_run};
  }

  let market;
  let ltcBalance;
  let jpyBalance;
  try{
    [market,ltcBalance,jpyBalance]=await Promise.all([
      getLtcJpyMarketStatus(),
      getBinanceBalance(env,"LTC"),
      getBinanceBalance(env,"JPY")
    ]);
  }catch(error){
    await setCircuitBreaker(
      env,
      "binance",
      "OPEN",
      error instanceof Error?error.message:String(error)
    );
    return {
      action:"BINANCE_API_BLOCKED",
      dryRun:settings.dry_run,
      details:{error:error instanceof Error?error.message:String(error)}
    };
  }

  if(
    market.status!=="TRADING"||
    !market.isSpotTradingAllowed||
    !market.quoteOrderQtyMarketAllowed
  ){
    return {
      action:"LTCJPY_MARKET_UNAVAILABLE",
      dryRun:settings.dry_run,
      details:{market}
    };
  }

  if(
    !await checkLtcPriceGuard(
      env,
      market.priceJpy,
      settings.max_ltc_price_jump_percent
    )
  ){
    return {action:"LTC_PRICE_CIRCUIT_BREAKER",dryRun:settings.dry_run};
  }

  const currentLtc=ltcBalance.free+ltcBalance.locked;
  const {dayStart,weekStart,monthStart}=jstPeriodStarts();
  const [daily,weekly,monthly]=await Promise.all([
    fundingWindowRemaining(env,settings.daily_purchase_limit_jpy,dayStart),
    fundingWindowRemaining(env,settings.weekly_purchase_limit_jpy,weekStart),
    fundingWindowRemaining(env,settings.monthly_purchase_limit_jpy,monthStart)
  ]);

  const purchaseAllowance=calculateLtcPurchaseAllowance({
    maxPurchaseJpy:settings.max_purchase_jpy,
    dailyRemainingJpy:daily,
    weeklyRemainingJpy:weekly,
    monthlyRemainingJpy:monthly,
    minPurchaseJpy:settings.min_purchase_jpy,
    currentLtc,
    targetLtcBalance:settings.target_ltc_balance,
    maxLtcBalance:settings.max_ltc_balance,
    ltcJpy:market.priceJpy
  });

  if(purchaseAllowance.allowedJpy<=0){
    return {
      action:
        purchaseAllowance.blockedReason==="TARGET_LTC_BALANCE_REACHED"
          ?"LTC_TARGET_OK"
          :"LTC_PURCHASE_LIMIT_BLOCKED",
      dryRun:settings.dry_run,
      details:{
        currentLtc,
        targetLtcBalance:settings.target_ltc_balance,
        maxLtcBalance:settings.max_ltc_balance,
        purchaseAllowance
      }
    };
  }

  const exchangeMinJpy=Math.ceil(market.minMarketNotionalJpy??0);
  const configuredMinJpy=Math.ceil(Math.max(0,settings.min_purchase_jpy));
  const minimumOrderJpy=Math.max(1,exchangeMinJpy,configuredMinJpy);
  const exchangeMaxJpy=
    market.maxMarketNotionalJpy===null
      ?Number.POSITIVE_INFINITY
      :Math.floor(market.maxMarketNotionalJpy);
  const availableJpy=Math.floor(Math.max(0,jpyBalance.free));
  const desired=Math.floor(Math.min(
    purchaseAllowance.allowedJpy,
    availableJpy,
    exchangeMaxJpy
  ));

  if(desired<minimumOrderJpy){
    return {
      action:"BINANCE_JPY_FUNDING_REQUIRED",
      dryRun:settings.dry_run,
      details:{
        availableJpy,
        minimumOrderJpy,
        allowedJpy:purchaseAllowance.allowedJpy,
        currentLtc,
        targetLtcBalance:settings.target_ltc_balance,
        maxLtcBalance:settings.max_ltc_balance
      }
    };
  }

  return submitLtcMarketPurchase(env,{
    settings,
    desiredJpy:desired,
    ltcJpy:market.priceJpy,
    purchaseAllowance,
    source:"target_rebalance"
  });
}

async function handleHstoraFundingNeed(
  env:Env,
  neededUsd:number
):Promise<XRunResult>{
  let settings=await loadXSettings(env);

  if(settings.funding_mode==="manual_hstora"){
    const now=Date.now();
    const previous=await getXSetting<{neededUsd:number;notifiedAt:number}>(
      env,
      "x_manual_hstora_topup_notice"
    );
    const shouldNotify=
      !previous||
      now-Number(previous.notifiedAt??0)>=30*60_000||
      Math.abs(Number(previous.neededUsd??0)-neededUsd)>=0.01;
    if(shouldNotify){
      await notifyDiscord(env,{
        title:"HStora LTC補充が必要",
        message:"HStora Main WalletへLTCで手動補充してください。残高反映後は次回Cronから仕入れ・納品を自動再開します。",
        details:{
          neededUsd,
          fundingMode:"manual_hstora",
          walletUrl:"https://hstora.com/en/wallet"
        }
      }).catch(()=>undefined);
      await setXSetting(env,"x_manual_hstora_topup_notice",{
        neededUsd,
        notifiedAt:now
      });
    }
    return {
      action:"MANUAL_HSTORA_LTC_TOPUP_REQUIRED",
      dryRun:settings.dry_run,
      details:{
        neededUsd,
        fundingMode:"manual_hstora",
        resume:"automatic_after_hstora_balance_credit",
        walletUrl:"https://hstora.com/en/wallet"
      }
    };
  }

  if(!isBinanceAutoFundingServerEnabled(env)){
    return {
      action:"BINANCE_AUTO_FUNDING_SERVER_LOCKED",
      dryRun:settings.dry_run,
      details:{fundingMode:settings.funding_mode}
    };
  }

  if(settings.usd_jpy_rate<=0||Date.now()-settings.usd_jpy_rate_updated_at>settings.max_fx_age_ms){
    return {
      action:"MANUAL_FX_RATE_REQUIRED",
      dryRun:settings.dry_run,
      details:{neededUsd}
    };
  }

  let ltcJpy:number;
  let ltcFree:number;
  let ltcLocked:number;
  let jpyFree:number;
  try{
    const [market,ltcBalance,jpyBalance]=await Promise.all([
      getLtcJpyMarketStatus(),
      getBinanceBalance(env,"LTC"),
      getBinanceBalance(env,"JPY")
    ]);
    ltcJpy=market.priceJpy;
    ltcFree=ltcBalance.free;
    ltcLocked=ltcBalance.locked;
    jpyFree=jpyBalance.free;
  }catch(error){
    await setCircuitBreaker(env,"binance","OPEN",error instanceof Error?error.message:String(error));
    await notifyDiscord(env,{
      title:"Circuit Breaker: Binance",
      message:"Binance APIの取得に失敗したため自動処理を停止しました。",
      level:"error"
    }).catch(()=>undefined);
    return {action:"BINANCE_API_BLOCKED",dryRun:settings.dry_run};
  }

  if(!await checkLtcPriceGuard(env,ltcJpy,settings.max_ltc_price_jump_percent)){
    return {action:"LTC_PRICE_CIRCUIT_BREAKER",dryRun:settings.dry_run};
  }

  const requiredJpy=Math.ceil(neededUsd*settings.usd_jpy_rate);
  const requiredLtc=requiredJpy/ltcJpy;

  if(settings.pending_paypay_funding_jpy>0){
    const pathAmountsCaptured=settings.pending_paypay_path_amounts_captured;
    const jpyDepositGross=pathAmountsCaptured
      ?settings.pending_paypay_jpy_deposit_required_jpy
      :settings.pending_paypay_funding_jpy;
    const jpyCreditRequired=pathAmountsCaptured
      ?settings.pending_paypay_jpy_credit_required_jpy
      :settings.pending_paypay_funding_jpy;
    const directLtcBudget=pathAmountsCaptured
      ?settings.pending_paypay_direct_ltc_budget_jpy
      :0;
    const completion=detectManualPayPayCompletion({
      pendingReservationJpy:settings.pending_paypay_funding_jpy,
      jpyCreditRequiredJpy:jpyCreditRequired,
      binanceJpyBaseline:settings.pending_paypay_binance_jpy_baseline,
      binanceLtcBaseline:settings.pending_paypay_binance_ltc_baseline,
      ltcBaselineCaptured:settings.pending_paypay_ltc_baseline_captured,
      directLtcBudgetJpy:directLtcBudget,
      currentBinanceJpy:jpyFree,
      currentBinanceLtc:ltcFree+ltcLocked
    });
    const ltcIncreaseDetected=completion==="LTC_INCREASE_DETECTED";

    if(ltcIncreaseDetected){
      const currentTotal=ltcFree+ltcLocked;
      return {
        action:"MANUAL_PAYPAY_LTC_CONFIRMATION_REQUIRED",
        dryRun:settings.dry_run,
        details:{
          paypayReservationJpy:settings.pending_paypay_funding_jpy,
          directLtcBudgetJpy:directLtcBudget,
          binanceLtcBaseline:settings.pending_paypay_binance_ltc_baseline,
          currentBinanceLtcTotal:currentTotal,
          detectedLtcIncrease:Math.max(
            0,
            currentTotal-settings.pending_paypay_binance_ltc_baseline
          ),
          requestedAt:settings.pending_paypay_requested_at
        }
      };
    }

    if(completion==="JPY_FUNDED"){
      const confirmedSpend=jpyDepositGross;
      if(confirmedSpend<=0){
        await setCircuitBreaker(
          env,
          "paypay_manual",
          "OPEN",
          "PENDING_PAYPAY_PATH_AMOUNT_MISSING"
        );
        return {
          action:"PAYPAY_PENDING_STATE_INVALID",
          dryRun:settings.dry_run
        };
      }
      const ltcBaseline=settings.pending_paypay_binance_ltc_baseline;
      const detectedLtcIncrease=0;
      settings=await saveXSettings(env,{
        observed_paypay_balance_jpy:nextObservedPayPayBalance({
          observedBalanceJpy:settings.observed_paypay_balance_jpy,
          observedAt:settings.observed_paypay_balance_at,
          pendingRequestedAt:settings.pending_paypay_requested_at,
          confirmedSpendJpy:confirmedSpend
        }),
        pending_paypay_funding_jpy:0,
        pending_paypay_jpy_deposit_required_jpy:0,
        pending_paypay_jpy_credit_required_jpy:0,
        pending_paypay_direct_ltc_budget_jpy:0,
        pending_paypay_path_amounts_captured:false,
        pending_paypay_binance_jpy_baseline:0,
        pending_paypay_binance_ltc_baseline:0,
        pending_paypay_required_ltc:0,
        pending_paypay_ltc_baseline_captured:false,
        pending_paypay_requested_at:0
      });
      await recordFundingEvent(env,{
        provider:"paypay_manual",
        kind:"JPY_DEPOSIT_DETECTED",
        amountJpy:confirmedSpend,
        status:"COMPLETED",
        metadata:{
          binanceJpyFree:jpyFree,
          binanceLtcFree:ltcFree,
          binanceLtcBaseline:ltcBaseline,
          detectedLtcIncrease,
          jpyDepositGrossJpy:jpyDepositGross,
          expectedJpyCreditJpy:jpyCreditRequired
        }
      });
      await auditX(env,{
        kind:"PAYPAY_FUNDING_CONFIRMED",
        message:"Binance JPY balance increase satisfied the pending manual PayPay funding request.",
        details:{
          completionMode:"jpy_deposit",
          confirmedSpendJpy:confirmedSpend,
          binanceJpyFree:jpyFree,
          binanceLtcFree:ltcFree,
          binanceLtcBaseline:ltcBaseline,
          detectedLtcIncrease,
          jpyDepositGrossJpy:jpyDepositGross,
          expectedJpyCreditJpy:jpyCreditRequired
        }
      });
    }else{
      return {
        action:"WAITING_MANUAL_PAYPAY_ACTION",
        dryRun:settings.dry_run,
        details:{
          paypayReservationJpy:settings.pending_paypay_funding_jpy,
          jpyDepositGrossJpy:jpyDepositGross,
          expectedJpyCreditJpy:jpyCreditRequired,
          directLtcBudgetJpy:directLtcBudget,
          binanceJpyBaseline:settings.pending_paypay_binance_jpy_baseline,
          binanceLtcBaseline:settings.pending_paypay_binance_ltc_baseline,
          requiredLtcAtRequest:settings.pending_paypay_required_ltc,
          currentBinanceJpy:jpyFree,
          currentBinanceLtc:ltcFree,
          requiredLtcNow:requiredLtc,
          requestedAt:settings.pending_paypay_requested_at,
          acceptedManualPaths:[
            "PayPay -> Binance JPY instant funding",
            "PayPay -> direct LTC purchase in Binance official UI when LTC is offered"
          ]
        }
      };
    }
  }

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

  const purchaseAllowance=calculateLtcPurchaseAllowance({
    maxPurchaseJpy:settings.max_purchase_jpy,
    dailyRemainingJpy:daily,
    weeklyRemainingJpy:weekly,
    monthlyRemainingJpy:monthly,
    minPurchaseJpy:settings.min_purchase_jpy,
    // Exposure caps count both available and order-locked LTC.
    currentLtc:ltcFree+ltcLocked,
    targetLtcBalance:settings.target_ltc_balance,
    maxLtcBalance:settings.max_ltc_balance,
    ltcJpy
  });
  const desired=Math.min(buyNeededJpy,purchaseAllowance.allowedJpy);

  if(desired<=0){
    return {
      action:"FUNDING_LIMIT_BLOCKED",
      dryRun:settings.dry_run,
      details:{buyNeededJpy,purchaseAllowance}
    };
  }

  // Existing Binance JPY can be used without consulting PayPay balance.
  // PayPay reserve_jpy only protects new PayPay outflow.
  if(jpyFree<desired){
    const observedFresh=
      settings.observed_paypay_balance_at>0&&
      Date.now()-settings.observed_paypay_balance_at<=settings.max_paypay_balance_age_ms;

    if(!observedFresh){
      await notifyDiscord(env,{
        title:"PayPay残高確認が必要",
        message:"reserve_jpyを保証するため、管理画面で現在のPayPay残高を更新してください。",
        details:{ltcShortfall,buyNeededJpy,desiredPurchaseJpy:desired}
      }).catch(()=>undefined);
      return {
        action:"PAYPAY_BALANCE_OBSERVATION_REQUIRED",
        dryRun:settings.dry_run,
        details:{ltcShortfall,buyNeededJpy,desiredPurchaseJpy:desired}
      };
    }

    const spendablePayPay=calculateSpendablePayPayJpy({
      observedBalanceJpy:settings.observed_paypay_balance_jpy,
      reserveJpy:settings.reserve_jpy
    });
    const pathPlan=planManualPayPayPaths({
      desiredPurchaseJpy:desired,
      currentBinanceJpy:jpyFree,
      spendablePayPayJpy:spendablePayPay,
      directPurchaseMinJpy:PAYPAY_DIRECT_PURCHASE_MIN_JPY,
      jpyDepositMinGrossJpy:PAYPAY_JPY_DEPOSIT_MIN_GROSS_JPY,
      jpyDepositFeeJpy:PAYPAY_JPY_DEPOSIT_FEE_JPY
    });
    const {
      expectedNetJpyCredit:netJpyCreditNeeded,
      grossJpyDepositRequired,
      jpyDepositAvailable,
      directLtcAvailable,
      paypayReservationJpy
    }=pathPlan;

    if(!jpyDepositAvailable&&!directLtcAvailable){
      return {
        action:"PAYPAY_FUNDING_LIMIT_BLOCKED",
        dryRun:settings.dry_run,
        details:{
          desiredPurchaseJpy:desired,
          spendablePayPayJpy:spendablePayPay,
          reserveJpy:settings.reserve_jpy,
          jpyDeposit:{
            grossRequiredJpy:grossJpyDepositRequired,
            expectedNetCreditJpy:netJpyCreditNeeded,
            feeJpy:PAYPAY_JPY_DEPOSIT_FEE_JPY,
            minimumGrossJpy:PAYPAY_JPY_DEPOSIT_MIN_GROSS_JPY,
            available:false
          },
          directLtc:{
            purchaseJpy:desired,
            minimumJpy:PAYPAY_DIRECT_PURCHASE_MIN_JPY,
            available:false
          },
          purchaseAllowance
        }
      };
    }

    settings=await saveXSettings(env,{
      pending_paypay_funding_jpy:paypayReservationJpy,
      pending_paypay_jpy_deposit_required_jpy:
        jpyDepositAvailable?grossJpyDepositRequired:0,
      pending_paypay_jpy_credit_required_jpy:
        jpyDepositAvailable?netJpyCreditNeeded:0,
      pending_paypay_direct_ltc_budget_jpy:
        directLtcAvailable?desired:0,
      pending_paypay_path_amounts_captured:true,
      pending_paypay_binance_jpy_baseline:Math.floor(jpyFree),
      pending_paypay_binance_ltc_baseline:ltcFree+ltcLocked,
      pending_paypay_required_ltc:requiredLtc,
      pending_paypay_ltc_baseline_captured:true,
      pending_paypay_requested_at:Date.now()
    });

    await recordFundingEvent(env,{
      provider:"paypay_manual",
      kind:"PAYPAY_MANUAL_ACTION_REQUIRED",
      amountJpy:paypayReservationJpy,
      status:"REQUIRED",
      metadata:{
        desiredPurchaseJpy:desired,
        spendablePayPayJpy:spendablePayPay,
        jpyDepositAvailable,
        grossJpyDepositRequired,
        expectedNetJpyCredit:netJpyCreditNeeded,
        paypayJpyDepositFeeJpy:PAYPAY_JPY_DEPOSIT_FEE_JPY,
        directLtcAvailable,
        directLtcBudgetJpy:directLtcAvailable?desired:0,
        binanceJpyFree:jpyFree
      }
    });

    const manualPaths:string[]=[];
    if(jpyDepositAvailable){
      manualPaths.push(
        "PayPay -> Binance JPY instant funding: gross "+
        grossJpyDepositRequired+
        " JPY (official fee "+
        PAYPAY_JPY_DEPOSIT_FEE_JPY+
        " JPY, expected balance increase at least "+
        netJpyCreditNeeded+
        " JPY)"
      );
    }
    if(directLtcAvailable){
      manualPaths.push(
        "PayPay -> direct LTC purchase in Binance official UI: "+
        desired+
        " JPY"
      );
    }

    await notifyDiscord(env,{
      title:"PayPay手動操作が必要",
      message:"Binance Japanの公式UIで、表示された利用可能な経路のどちらかを実行してください。BOTは実際のJPY/LTC残高増加を検知して自動再開します。",
      details:{
        paypayReservationJpy,
        desiredPurchaseJpy:desired,
        jpyDeposit:jpyDepositAvailable?{
          grossRequiredJpy:grossJpyDepositRequired,
          expectedNetCreditJpy:netJpyCreditNeeded,
          feeJpy:PAYPAY_JPY_DEPOSIT_FEE_JPY
        }:null,
        directLtc:directLtcAvailable?{
          purchaseJpy:desired,
          minimumJpy:PAYPAY_DIRECT_PURCHASE_MIN_JPY
        }:null,
        requiredLtc,
        acceptedManualPaths:manualPaths
      }
    }).catch(()=>undefined);

    return {
      action:"MANUAL_PAYPAY_ACTION_REQUIRED",
      dryRun:settings.dry_run,
      details:{
        paypayReservationJpy,
        desiredPurchaseJpy:desired,
        jpyDeposit:jpyDepositAvailable?{
          grossRequiredJpy:grossJpyDepositRequired,
          expectedNetCreditJpy:netJpyCreditNeeded,
          feeJpy:PAYPAY_JPY_DEPOSIT_FEE_JPY
        }:null,
        directLtc:directLtcAvailable?{
          purchaseJpy:desired,
          minimumJpy:PAYPAY_DIRECT_PURCHASE_MIN_JPY
        }:null,
        requiredLtc,
        purchaseAllowance,
        acceptedManualPaths:manualPaths
      }
    };
  }

  return submitLtcMarketPurchase(env,{
    settings,
    desiredJpy:desired,
    ltcJpy,
    purchaseAllowance,
    source:"hstora_shortfall"
  });
}

export async function runXProcurement(env:Env):Promise<XRunResult>{
  const settings=await loadXSettings(env);
  if(settings.emergency_stop) return {action:"EMERGENCY_STOP",dryRun:settings.dry_run};

  const breakerKeys=[
    "hstora",
    "product_price",
    "unexpected_balance",
    "delivery_integrity",
    "hstora_order_alert"
  ];
  if(settings.funding_mode==="binance_auto"){
    breakerKeys.push(
      "binance",
      "binance_purchase",
      "paypay_manual",
      "fx_rate",
      "ltc_price"
    );
  }
  const breakers=await Promise.all(
    breakerKeys.map(key=>circuitState(env,key))
  );
  if(breakers.some(value=>String(value?.state??"")==="OPEN")){
    return {action:"CIRCUIT_BREAKER_OPEN",dryRun:settings.dry_run};
  }

  await reconcilePendingXOrders(env);

  try{
    const observedHstora=await getHstoraBalance(env);
    if(
      String(observedHstora.currency).toUpperCase()==="USD"&&
      !await checkHstoraBalanceGuard(env,Number(observedHstora.balance),settings)
    ){
      return {action:"UNEXPECTED_BALANCE_CIRCUIT_BREAKER",dryRun:settings.dry_run};
    }
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    await setCircuitBreaker(env,"hstora","OPEN",message);
    return {action:"HSTORA_BALANCE_ERROR",dryRun:settings.dry_run};
  }

  const campaignSettings=await getInviteCampaignSettings(env);
  const [inventory,topInventory,noShadowInventory,campaignInventory]=await Promise.all([
    readyInventoryCount(env),
    readyInventoryCountByClass(env,"TOP_SEARCH"),
    readyInventoryCountByClass(env,"NO_SHADOWBAN"),
    inviteCampaignStockCount(env)
  ]);

  const budgetSnapshot=await getProcurementBudgets(env);
  const targetOptions:Array<{
    targetClass:ProcurementTarget;
    classInventory:number;
    classTarget:number;
    budgetUsd:number;
  }> = [];

  if(campaignSettings.enabled&&campaignInventory<campaignSettings.target_stock){
    targetOptions.push({
      targetClass:"INVITE_CAMPAIGN",
      classInventory:campaignInventory,
      classTarget:campaignSettings.target_stock,
      budgetUsd:budgetSnapshot.available.INVITE_CAMPAIGN
    });
  }
  if(topInventory<=settings.reorder_point){
    targetOptions.push({
      targetClass:"TOP_SEARCH",
      classInventory:topInventory,
      classTarget:settings.target_stock,
      budgetUsd:budgetSnapshot.available.TOP_SEARCH
    });
  }
  if(noShadowInventory<=settings.no_shadowban_reorder_point){
    targetOptions.push({
      targetClass:"NO_SHADOWBAN",
      classInventory:noShadowInventory,
      classTarget:settings.no_shadowban_target_stock,
      budgetUsd:budgetSnapshot.available.NO_SHADOWBAN
    });
  }

  if(targetOptions.length===0){
    return {
      action:"INVENTORY_OK",
      dryRun:settings.dry_run,
      inventory,
      details:{
        topSearch:topInventory,
        noShadowban:noShadowInventory,
        inviteCampaign:campaignInventory,
        inviteCampaignTarget:campaignSettings.target_stock,
        procurementBudget:budgetSnapshot
      }
    };
  }

  let targetClass:ProcurementTarget|null=null;
  let classInventory=0;
  let classTarget=0;
  let classBudgetUsd=0;
  let batch=0;
  type ProcurementCandidate={
    product:HstoraProduct;
    q:ReturnType<typeof qualifyHstoraProduct>;
    plannedQuantity:number;
    priorPurchases:number;
  };
  let candidate:ProcurementCandidate|null=null;
  const skippedTargets:Array<Record<string,unknown>>=[];

  for(const option of targetOptions){
    if(option.budgetUsd<=0.00000001){
      skippedTargets.push({
        targetClass:option.targetClass,
        reason:"BUDGET_ZERO",
        budgetUsd:option.budgetUsd
      });
      continue;
    }

    const need=Math.max(0,option.classTarget-option.classInventory);
    const plannedBatch=Math.min(need,settings.max_batch_purchase);
    if(plannedBatch<=0) continue;

    let possible:ProcurementCandidate|null=null;
    try{
      possible=await selectCandidate(
        env,
        plannedBatch,
        option.targetClass,
        budgetSnapshot.available
      );
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      if(message==="PRODUCT_PRICE_JUMP"){
        return {
          action:"PRODUCT_PRICE_CIRCUIT_BREAKER",
          dryRun:settings.dry_run,
          inventory
        };
      }
      await setCircuitBreaker(env,"hstora","OPEN",message);
      await notifyDiscord(env,{
        title:"Circuit Breaker: HStora",
        message:"HStora APIの候補取得に失敗したため自動仕入れを停止しました。",
        level:"error"
      }).catch(()=>undefined);
      return {
        action:"HSTORA_API_BLOCKED",
        dryRun:settings.dry_run,
        inventory
      };
    }

    if(!possible){
      skippedTargets.push({
        targetClass:option.targetClass,
        reason:"NO_QUALIFIED_PRODUCT",
        budgetUsd:option.budgetUsd
      });
      continue;
    }

    targetClass=option.targetClass;
    classInventory=option.classInventory;
    classTarget=option.classTarget;
    classBudgetUsd=option.budgetUsd;
    batch=plannedBatch;
    candidate=possible;
    break;
  }

  if(!targetClass||!candidate){
    const allZero=targetOptions.every(
      option=>option.budgetUsd<=0.00000001
    );
    return {
      action:allZero
        ?"PROCUREMENT_BUDGET_EXHAUSTED"
        :"NO_AFFORDABLE_HSTORA_PRODUCT",
      dryRun:settings.dry_run,
      inventory,
      details:{
        procurementBudget:budgetSnapshot,
        targetOptions,
        skippedTargets
      }
    };
  }

  const refreshedClassInventory=await readyInventoryCountByClass(
    env,
    targetClass
  );
  const refreshedReorder=
    targetClass==="INVITE_CAMPAIGN"
      ?Math.max(0,campaignSettings.target_stock-1)
      :targetClass==="TOP_SEARCH"
        ?settings.reorder_point
        :settings.no_shadowban_reorder_point;
  if(refreshedClassInventory>refreshedReorder){
    return {
      action:"INVENTORY_RECLASSIFIED_OK",
      dryRun:settings.dry_run,
      inventory:await readyInventoryCount(env),
      details:{
        targetClass,
        before:classInventory,
        after:refreshedClassInventory,
        procurementBudget:budgetSnapshot
      }
    };
  }
  const refreshedNeed=Math.max(0,classTarget-refreshedClassInventory);
  batch=Math.min(refreshedNeed,settings.max_batch_purchase);
  if(batch<=0){
    return {
      action:"INVENTORY_RECLASSIFIED_OK",
      dryRun:settings.dry_run,
      inventory:await readyInventoryCount(env),
      details:{
        targetClass,
        classInventory:refreshedClassInventory,
        classTarget,
        procurementBudget:budgetSnapshot
      }
    };
  }

  const fresh=await getHstoraProduct(env,Number(candidate.product.id));
  const prior=await successfulPurchaseCountForProduct(env,String(fresh.id));
  const trialCap=prior===0?settings.trial_purchase_count:batch;
  const freshVisibility=detectSearchVisibility(fresh);
  const freshForceNoShadowban=
    procurementClassOverrideForHstoraProduct(fresh.id)==="NO_SHADOWBAN";
  const splitAcrossClasses=
    !freshForceNoShadowban&&
    hasDualTopNoShadowbanEvidence(freshVisibility.labels);
  let quantity=Math.min(
    batch,
    Math.max(1,trialCap),
    Math.max(0,Number(fresh.stock_available??0))
  );
  if(targetClass!=="INVITE_CAMPAIGN"&&splitAcrossClasses){
    quantity=evenSplitPurchaseQuantity(quantity);
  }
  if(quantity<=0){
    return {
      action:"PRODUCT_OUT_OF_STOCK",
      dryRun:settings.dry_run,
      inventory,
      productId:Number(fresh.id)
    };
  }

  // Recalculate the effective tier price whenever the budget reduces the
  // quantity. A smaller order can lose a volume discount, so affordability
  // must be checked again until the quantity and tier price are stable.
  const trustedApprovedIds=[...new Set([
    ...PREFERRED_TOP_HSTORA_PRODUCT_IDS,
    ...PREFERRED_NO_SHADOWBAN_HSTORA_PRODUCT_IDS,
    ...settings.approved_hstora_product_ids
  ])];
  const qualificationSettings=
    settings.seller_quality_mode==="manual_product_approval"
      ?{...settings,approved_hstora_product_ids:trustedApprovedIds}
      :settings;
  const classOverride=
    procurementClassOverrideForHstoraProduct(fresh.id)??undefined;

  const qualifyForQuantity=(orderQuantity:number)=>{
    const policyQualification=qualifyHstoraProduct(
      fresh,
      qualificationSettings,
      orderQuantity,
      Date.now(),
      classOverride
    );
    return classOverride
      ?{
        ...policyQualification,
        evidence:[
          ...policyQualification.evidence,
          "POLICY_OVERRIDE_HSTORA_4521_NO_SHADOWBAN"
        ]
      }
      :policyQualification;
  };

  let q=qualifyForQuantity(quantity);
  while(quantity>0){
    const budgetUnitSource=Number(q.unit_price_source);
    if(!Number.isFinite(budgetUnitSource)||budgetUnitSource<=0) break;

    const nextQuantity=maxAffordableQuantityForBudget(
      targetClass,
      splitAcrossClasses,
      budgetUnitSource,
      quantity,
      budgetSnapshot.available
    );
    if(nextQuantity===quantity) break;

    quantity=nextQuantity;
    if(quantity<=0){
      return {
        action:"PROCUREMENT_BUDGET_EXHAUSTED",
        dryRun:settings.dry_run,
        inventory,
        productId:Number(fresh.id),
        details:{
          targetClass,
          availableBudgetUsd:classBudgetUsd,
          unitPriceUsd:budgetUnitSource,
          requiredBudgetClasses:splitAcrossClasses
            ?["TOP_SEARCH","NO_SHADOWBAN"]
            :[targetClass],
          procurementBudget:budgetSnapshot
        }
      };
    }
    q=qualifyForQuantity(quantity);
  }

  const supportsTarget=
    targetClass==="INVITE_CAMPAIGN"
      ?Boolean(q.procurement_class)
      :q.procurement_class===targetClass||
        (
          targetClass==="NO_SHADOWBAN"&&
          q.procurement_class==="TOP_SEARCH"&&
          hasDualTopNoShadowbanEvidence(q.search_visibility)
        );
  if(!q.qualified||!supportsTarget){
    await setCircuitBreaker(
      env,
      "product_price",
      "OPEN",
      "PRODUCT_REQUALIFICATION_FAILED"
    );
    return {
      action:"PRODUCT_REQUALIFICATION_FAILED",
      dryRun:settings.dry_run,
      inventory,
      productId:Number(fresh.id),
      details:q
    };
  }

  const storedProcurementClass=
    targetClass==="INVITE_CAMPAIGN"
      ?"INVITE_CAMPAIGN" as const
      :q.procurement_class;
  const storedSplitAcrossClasses=
    targetClass!=="INVITE_CAMPAIGN"&&splitAcrossClasses;

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
  const budgetCharges=procurementBudgetCharges(
    targetClass,
    storedSplitAcrossClasses,
    totalSource
  );
  let supplierBalance;
  try{supplierBalance=await getHstoraBalance(env);}
  catch(error){
    await setCircuitBreaker(env,"hstora","OPEN",error instanceof Error?error.message:String(error));
    return {action:"HSTORA_BALANCE_ERROR",dryRun:settings.dry_run,inventory};
  }

  if(
    String(supplierBalance.currency).toUpperCase()==="USD"&&
    !await checkHstoraBalanceGuard(env,Number(supplierBalance.balance),settings)
  ){
    return {action:"UNEXPECTED_BALANCE_CIRCUIT_BREAKER",dryRun:settings.dry_run,inventory};
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
        procurementClass:storedProcurementClass,
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
      details:{
        qualification:q,
        totalSource,
        currency:fresh.currency,
        trial:prior===0,
        targetClass,
        availableBudgetUsd:classBudgetUsd,
        budgetCharges,
        procurementBudget:budgetSnapshot
      }
    };
  }

  const budgetReserved=await reserveProcurementBudgetCharges(
    env,
    budgetCharges
  );
  if(!budgetReserved){
    return {
      action:"PROCUREMENT_BUDGET_CHANGED",
      dryRun:false,
      inventory,
      requested:quantity,
      productId:Number(fresh.id),
      details:{
        targetClass,
        requiredUsd:totalSource,
        budgetCharges,
        procurementBudget:await getProcurementBudgets(env)
      }
    };
  }

  let recordId:string;
  try{
    recordId=await createPurchaseOrderRecord(env,{
      supplier:"hstora",
      supplierProductId:String(fresh.id),
      quantity,
      unitPrice:unitSource,
      totalAmount:totalSource,
      currency:String(fresh.currency),
      externalOrderId,
      idempotencyKey,
      procurementClass:storedProcurementClass,
      deliverySplitMode:
        storedSplitAcrossClasses
          ?DUAL_TOP_SPLIT_MODE
          :null,
      dryRun:false
    });
  }catch(error){
    await releaseProcurementBudgetCharges(env,budgetCharges);
    throw error;
  }

  await notifyDiscord(env,{
    title:"仕入れ開始",
    message:"HStoraでXアカウント仕入れを開始します。",
    details:{
      productId:fresh.id,
      quantity,
      unitPriceJpy:q.unit_price_jpy,
      trial:prior===0,
      budgetClass:targetClass,
      budgetReservedUsd:totalSource,
      budgetCharges
    }
  }).catch(()=>undefined);

  try{
    const order=await createHstoraOrder(env,{
      productId:Number(fresh.id),
      quantity,
      externalOrderId,
      idempotencyKey
    });
    const status=String(order.status??"SUBMITTED").toUpperCase();
    await allowExpectedHstoraDecrease(env,totalSource);
    const stored=order.delivery?.available
      ?await storeDeliveredAccounts(env,{
        purchaseOrderId:recordId,
        supplier:"hstora",
        supplierProductId:String(fresh.id),
        purchasePrice:unitSource,
        procurementClass:storedProcurementClass,
        orderResponse:order
      })
      :null;
    const added=stored?.inserted??0;
    if(added>0){
      await notifyShiireVendingStockArrival(
        env,
        String(fresh.id),
        added,
        stored?.byClass
      ).catch(()=>undefined);
    }
    const storedTotal=order.delivery?.available
      ?await purchasedAccountCountForOrder(env,recordId)
      :0;
    if(order.delivery?.available&&storedTotal!==quantity){
      await updatePurchaseOrderRecord(env,recordId,{
        status:"DELIVERY_INTEGRITY_FAILED",
        supplierOrderId:String(order.id),
        response:order,
        errorCode:"DELIVERY_COUNT_MISMATCH"
      });
      await setCircuitBreaker(env,"delivery_integrity","OPEN","DELIVERY_COUNT_MISMATCH");
      await notifyDiscord(env,{
        title:"不良商品",
        message:"HStora納品件数が注文数と一致しないため自動仕入れを停止しました。",
        level:"error",
        details:{productId:fresh.id,ordered:quantity,insertedNow:added,storedTotal,supplierOrderId:order.id}
      }).catch(()=>undefined);
      return {
        action:"DELIVERY_INTEGRITY_FAILED",
        dryRun:false,
        inventory,
        requested:quantity,
        productId:Number(fresh.id),
        details:{ordered:quantity,insertedNow:added,storedTotal}
      };
    }
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
      details:{productId:fresh.id,quantity,insertedNow:added,storedTotal,status}
    }).catch(()=>undefined);
    return {
      action:order.delivery?.available?"HSTORA_PURCHASE_DELIVERED":"HSTORA_PURCHASE_PROCESSING",
      dryRun:false,
      inventory,
      requested:quantity,
      productId:Number(fresh.id),
      unitPriceJpy:q.unit_price_jpy,
      details:{insertedNow:added,storedTotal,status,supplierOrderId:order.id}
    };
  }catch(error){
    let recovered=false;
    try{
      const order=await lookupHstoraOrder(env,externalOrderId);
      recovered=true;
      const status=String(order.status??"PROCESSING").toUpperCase();
      await allowExpectedHstoraDecrease(env,totalSource);
      const stored=order.delivery?.available
        ?await storeDeliveredAccounts(env,{
          purchaseOrderId:recordId,
          supplier:"hstora",
          supplierProductId:String(fresh.id),
          purchasePrice:unitSource,
          procurementClass:storedProcurementClass,
          orderResponse:order
        })
        :null;
      const added=stored?.inserted??0;
      if(added>0){
        await notifyShiireVendingStockArrival(
          env,
          String(fresh.id),
          added,
          stored?.byClass
        ).catch(()=>undefined);
      }
      const recoveredStoredTotal=order.delivery?.available
        ?await purchasedAccountCountForOrder(env,recordId)
        :0;
      if(order.delivery?.available&&recoveredStoredTotal!==quantity){
        await updatePurchaseOrderRecord(env,recordId,{
          status:"DELIVERY_INTEGRITY_FAILED",
          supplierOrderId:String(order.id),
          response:order,
          errorCode:"DELIVERY_COUNT_MISMATCH"
        });
        await setCircuitBreaker(env,"delivery_integrity","OPEN","DELIVERY_COUNT_MISMATCH");
        await notifyDiscord(env,{
          title:"不良商品",
          message:"照合回収したHStora注文の納品件数が注文数と一致しません。",
          level:"error",
          details:{ordered:quantity,insertedNow:added,storedTotal:recoveredStoredTotal,supplierOrderId:order.id}
        }).catch(()=>undefined);
        return {
          action:"DELIVERY_INTEGRITY_FAILED",
          dryRun:false,
          inventory,
          requested:quantity,
          productId:Number(fresh.id),
          details:{ordered:quantity,insertedNow:added,storedTotal:recoveredStoredTotal}
        };
      }
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
        details:{status,insertedNow:added,storedTotal:recoveredStoredTotal}
      };
    }catch{}
    if(!recovered){
      const code=error instanceof Error?error.message.slice(0,120):"HSTORA_PURCHASE_FAILED";
      const definitiveRejection=
        error instanceof HstoraApiError&&!error.retryable;
      if(definitiveRejection){
        await releaseProcurementBudgetCharges(env,budgetCharges);
      }
      await updatePurchaseOrderRecord(env,recordId,{status:"FAILED",errorCode:code});
      await setCircuitBreaker(env,"hstora","OPEN",code);
      await notifyDiscord(env,{
        title:"Circuit Breaker: HStora購入",
        message:definitiveRejection
          ?"HStoraが注文を確定拒否したため、予約していたカテゴリ予算を戻して停止しました。"
          :"注文結果をlookupでも確認できなかったため停止しました。予算は二重使用防止のため予約状態を維持します。",
        level:"error",
        details:{
          externalOrderId,
          code,
          budgetClass:targetClass,
          budgetReservedUsd:totalSource,
          budgetCharges,
          budgetReleased:definitiveRejection
        }
      }).catch(()=>undefined);
    }
    return {action:"HSTORA_PURCHASE_FAILED",dryRun:false,inventory,productId:Number(fresh.id)};
  }
}
