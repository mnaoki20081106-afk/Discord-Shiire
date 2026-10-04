import type { ProcurementClass } from "./x-qualification";

export const DUAL_TOP_SPLIT_MODE="TOP_SEARCH_NO_SHADOWBAN_50_50" as const;

// Normal X-account procurement policy.
//
// - <= $0.35: eligible
// - <  $0.30: preferred low-price band
// - >  $0.35: never auto-procure
//
// Product 5132 is explicitly excluded even if its price later changes.
export const HSTORA_X_MAX_UNIT_PRICE_USD=0.35 as const;
export const HSTORA_X_PREFERRED_PRICE_CEILING_USD=0.30 as const;
export const BLOCKED_HSTORA_PRODUCT_IDS=[5132] as const;

// There is currently no hard-coded preferred product for the premium
// old+search-visible class. A source has to prove the required attributes
// from the live HStora listing every time.
export const PREFERRED_TOP_HSTORA_PRODUCT_IDS=[] as const;
export const PREFERRED_NO_SHADOWBAN_HSTORA_PRODUCT_IDS=[4521,1609] as const;

export function isBlockedHstoraSource(productId:unknown):boolean{
  const id=Number(productId);
  return BLOCKED_HSTORA_PRODUCT_IDS.some(value=>value===id);
}

export function isPreferredTopHstoraSource(productId:unknown):boolean{
  const id=Number(productId);
  return PREFERRED_TOP_HSTORA_PRODUCT_IDS.some(value=>value===id);
}

export function isPreferredNoShadowbanHstoraSource(productId:unknown):boolean{
  const id=Number(productId);
  return PREFERRED_NO_SHADOWBAN_HSTORA_PRODUCT_IDS.some(value=>value===id);
}

export function procurementClassOverrideForHstoraProduct(
  productId:unknown
):ProcurementClass|null{
  if(isBlockedHstoraSource(productId)) return null;
  return isPreferredNoShadowbanHstoraSource(productId)
    ?"NO_SHADOWBAN"
    :null;
}

export function hasDualTopNoShadowbanEvidence(labels:readonly string[]):boolean{
  const hasTop=
    labels.includes("TOP+Latest")||
    labels.includes("TOP Search")||
    labels.includes("Latest Search")||
    labels.includes("Search Visible");
  return hasTop&&labels.includes("No Shadowban");
}

export function isTopSearchFallbackEligible(
  productId:unknown,
  labels:readonly string[]
):boolean{
  if(isBlockedHstoraSource(productId)) return false;
  return hasDualTopNoShadowbanEvidence(labels);
}

export function hstoraPricePriorityTier(unitPriceUsd:unknown):number{
  const price=Number(unitPriceUsd);
  if(!Number.isFinite(price)||price<=0) return 3;
  if(price>HSTORA_X_MAX_UNIT_PRICE_USD) return 2;
  if(price<HSTORA_X_PREFERRED_PRICE_CEILING_USD) return 0;
  return 1;
}

export function hstoraProcurementPriorityTier(
  productId:unknown,
  targetClass:ProcurementClass|"INVITE_CAMPAIGN"
):number{
  if(isBlockedHstoraSource(productId)) return 99;
  if(targetClass==="NO_SHADOWBAN"){
    if(isPreferredNoShadowbanHstoraSource(productId)) return 0;
    return 1;
  }
  if(targetClass==="TOP_SEARCH"){
    return isPreferredTopHstoraSource(productId)?0:1;
  }
  return (
    isPreferredNoShadowbanHstoraSource(productId)||
    isPreferredTopHstoraSource(productId)
  )?0:1;
}

export function evenSplitPurchaseQuantity(value:number):number{
  const quantity=Math.max(0,Math.floor(Number(value)||0));
  if(quantity<2) return 0;
  return quantity-(quantity%2);
}

export function splitProcurementClassAtRank(
  rank:number,
  total:number
):ProcurementClass{
  const safeTotal=Math.max(1,Math.floor(total));
  const safeRank=Math.max(0,Math.floor(rank));
  const topTarget=Math.ceil(safeTotal/2);
  return safeRank<topTarget?"TOP_SEARCH":"NO_SHADOWBAN";
}
