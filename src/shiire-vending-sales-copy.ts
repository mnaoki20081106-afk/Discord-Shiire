export type ShiireSalesClass="TOP_SEARCH"|"NO_SHADOWBAN";

export type ShiireSalesCopy={
  name:string;
  description:string;
  priceJpy:number;
};

export const SHIIRE_VENDING_SALES_COPY:Record<ShiireSalesClass,ShiireSalesCopy>={
  NO_SHADOWBAN:{
    name:"Search Top + No shadow ban",
    description:"検索上位に載るシャドバンされてない垢です。",
    priceJpy:350
  },
  TOP_SEARCH:{
    name:"【old】Search Top + No shadow ban",
    description:"検索上位にのるシャドバンされていないOld垢です。より運用向きです！",
    priceJpy:500
  }
};

export const SHIIRE_VENDING_SALES_COPY_VERSION="2026-10-01-v1";

export function shiireSalesCopyForClass(value:unknown):ShiireSalesCopy|null{
  if(value==="NO_SHADOWBAN") return SHIIRE_VENDING_SALES_COPY.NO_SHADOWBAN;
  if(value==="TOP_SEARCH") return SHIIRE_VENDING_SALES_COPY.TOP_SEARCH;
  return null;
}
