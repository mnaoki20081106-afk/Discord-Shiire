import type { ProcurementClass } from "./x-qualification";

export const PRIMARY_SPLIT_HSTORA_PRODUCT_ID=4841;

export function isPrimarySplitHstoraProduct(productId:unknown):boolean{
  return Number(productId)===PRIMARY_SPLIT_HSTORA_PRODUCT_ID;
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
