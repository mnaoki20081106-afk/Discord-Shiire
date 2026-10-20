export const SMM_PANEL_PRODUCT_LIMIT=25;
export const SMM_MAX_ORDER_QUANTITY=10_000_000;
export const SMM_PAYMENT_WINDOW_MS=10*60_000;
export const SMM_PLACING_STALE_MS=5*60_000;
export const SMM_MAX_PLACE_ATTEMPTS=12;
export const SMM_RETRY_DELAY_MS=5*60_000;

export type SmmLinkKind="x_profile"|"x_post"|"url";
export const SMM_LINK_KINDS:SmmLinkKind[]=["x_profile","x_post","url"];

export type SmmOrderStatus=
  |"awaiting_payment"
  |"payment_pending"
  |"paid"
  |"placing"
  |"placed"
  |"completed"
  |"partial"
  |"canceled"
  |"failed"
  |"hold"
  |"expired";

export type SmmRefundState="none"|"required"|"done";

export const SMM_OPEN_STATUSES:SmmOrderStatus[]=[
  "awaiting_payment","payment_pending","paid","placing","placed","hold"
];
export const SMM_FINAL_STATUSES:SmmOrderStatus[]=[
  "completed","partial","canceled","failed"
];

const X_RESERVED=new Set([
  "home","i","search","explore","settings","notifications","messages","compose",
  "intent","share","hashtag","login","logout","signup","tos","privacy","about",
  "download","jobs","help","support","account","oauth","web","status"
]);

export function normalizeSmmLink(kind:SmmLinkKind,raw:string):string|null{
  const text=String(raw??"").trim();
  if(!text||text.length>500||/\s/.test(text)) return null;
  let url:URL;
  try{url=new URL(text);}catch{return null;}
  if(url.protocol!=="https:"||url.username||url.password) return null;
  if(kind==="url") return url.toString();
  const host=url.hostname.toLowerCase();
  if(!["x.com","www.x.com","mobile.x.com","twitter.com","www.twitter.com","mobile.twitter.com"].includes(host)){
    return null;
  }
  const parts=url.pathname.split("/").filter(Boolean);
  const user=parts[0]??"";
  if(!/^[A-Za-z0-9_]{1,15}$/.test(user)||X_RESERVED.has(user.toLowerCase())) return null;
  if(kind==="x_profile"){
    return parts.length===1?"https://x.com/"+user:null;
  }
  if(parts.length>=3&&parts[1]==="status"&&/^\d{1,25}$/.test(parts[2]!)){
    return "https://x.com/"+user+"/status/"+parts[2];
  }
  return null;
}

export function smmCost(ratePer1000:number,quantity:number):number{
  const rate=Number(ratePer1000);
  const qty=Number(quantity);
  if(!Number.isFinite(rate)||!Number.isFinite(qty)||rate<0||qty<0) return Number.NaN;
  return rate*qty/1000;
}

export type SmmPricing={markup_percent:number;fee_jpy:number};

export function smmQuote(
  ratePer1000:number,
  quantity:number,
  pricing:SmmPricing
):number{
  const cost=smmCost(ratePer1000,quantity);
  if(!Number.isFinite(cost)) throw new Error("SMM_RATE_INVALID");
  const markup=Math.max(0,Number(pricing.markup_percent)||0);
  const fee=Math.max(0,Math.floor(Number(pricing.fee_jpy)||0));
  return Math.max(1,Math.ceil(cost*(1+markup/100)-1e-9)+fee);
}

export function smmQuoteIsProfitable(
  total:number,
  ratePer1000:number,
  quantity:number,
  minMarginPercent:number
):boolean{
  const cost=smmCost(ratePer1000,quantity);
  if(!Number.isFinite(cost)||!Number.isFinite(total)||total<1) return false;
  const margin=Math.max(0,Number(minMarginPercent)||0);
  return cost<=total*(1-margin/100)+1e-9;
}

export function smmQuantityBounds(
  service:{min:number;max:number},
  product:{min_qty:number;max_qty:number}
):{min:number;max:number}{
  const min=Math.max(1,Math.floor(Number(service.min)||1),Math.floor(Number(product.min_qty)||1));
  const productMax=Number(product.max_qty)>0?Math.floor(Number(product.max_qty)):SMM_MAX_ORDER_QUANTITY;
  const serviceMax=Number(service.max)>0?Math.floor(Number(service.max)):SMM_MAX_ORDER_QUANTITY;
  return {min,max:Math.min(productMax,serviceMax,SMM_MAX_ORDER_QUANTITY)};
}

export function parseSmmQuantity(raw:unknown,bounds:{min:number;max:number}):number|null{
  const text=String(raw??"").replace(/[,\s]/g,"").replace(/[０-９]/g,ch=>
    String.fromCharCode(ch.charCodeAt(0)-0xfee0)
  );
  if(!/^\d{1,9}$/.test(text)) return null;
  const value=Number(text);
  if(!Number.isSafeInteger(value)||value<bounds.min||value>bounds.max) return null;
  return value;
}

export function isSupportedSmmServiceType(type:string):boolean{
  return String(type??"").trim().toLowerCase()==="default";
}

export function isJpyCurrency(currency:string):boolean{
  return /^(jpy|¥|￥|円)$/i.test(String(currency??"").trim());
}

export type SmmSupplierState=
  |{kind:"active"}
  |{kind:"completed"}
  |{kind:"partial"}
  |{kind:"canceled"}
  |{kind:"unknown";raw:string};

export function mapSmmSupplierStatus(raw:string):SmmSupplierState{
  const value=String(raw??"").trim().toLowerCase();
  if(["pending","in progress","processing","in_progress"].includes(value)) return {kind:"active"};
  if(value==="completed") return {kind:"completed"};
  if(value==="partial") return {kind:"partial"};
  if(["canceled","cancelled","refunded","failed","fail","error"].includes(value)){
    return {kind:"canceled"};
  }
  return {kind:"unknown",raw:value};
}

export function smmRefundAmount(
  total:number,
  quantity:number,
  remains:number,
  state:"partial"|"canceled"|"failed"
):number{
  if(state!=="partial") return Math.max(0,Math.floor(total));
  if(quantity<=0) return 0;
  const clamped=Math.min(Math.max(0,Math.floor(remains)),quantity);
  return Math.floor(total*clamped/quantity);
}

export function isRetryableSupplierRejection(message:string):boolean{
  return /(not enough|insufficient|low balance|funds|balance|残高|資金)/i.test(message);
}

export function placeRetryDecision(attempts:number):"retry"|"give_up"{
  return attempts+1>=SMM_MAX_PLACE_ATTEMPTS?"give_up":"retry";
}

export function shouldExpireSmmOrder(
  status:string,
  reservedUntil:number|null,
  now:number
):boolean{
  return status==="awaiting_payment"&&
    reservedUntil!==null&&
    Number.isFinite(reservedUntil)&&
    reservedUntil<now;
}

export function smmOrderNonce(orderId:string):string{
  return ("smm"+orderId.replace(/[^A-Za-z0-9]/g,"")).slice(0,25);
}

export function maskSmmLink(link:string):string{
  try{
    const url=new URL(link);
    return url.hostname+url.pathname.slice(0,40);
  }catch{
    return link.slice(0,40);
  }
}
