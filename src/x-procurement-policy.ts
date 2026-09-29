import type { ProcurementClass } from "./x-qualification";

export const DUAL_TOP_SPLIT_MODE="TOP_SEARCH_NO_SHADOWBAN_50_50" as const;

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
