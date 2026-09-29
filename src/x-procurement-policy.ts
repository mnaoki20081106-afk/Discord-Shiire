import type { ProcurementClass } from "./x-qualification";

export const DUAL_TOP_SPLIT_MODE="TOP_SEARCH_NO_SHADOWBAN_50_50" as const;
export const PREFERRED_TOP_HSTORA_PRODUCT_IDS=[4841,5132] as const;
export const PREFERRED_NO_SHADOWBAN_HSTORA_PRODUCT_IDS=[4521] as const;

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
  return isPreferredNoShadowbanHstoraSource(productId)
    ?"NO_SHADOWBAN"
    :null;
}

export function hasDualTopNoShadowbanEvidence(labels:readonly string[]):boolean{
  const hasTop=
    labels.includes("TOP+Latest")||
    labels.includes("TOP Search");
  return hasTop&&labels.includes("No Shadowban");
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
