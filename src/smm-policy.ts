export const SMM_PANEL_PRODUCT_LIMIT=25;
export const SMM_MAX_ORDER_QUANTITY=10_000_000;
export const SMM_PAYMENT_WINDOW_MS=10*60_000;
export const SMM_PLACING_STALE_MS=5*60_000;
export const SMM_MAX_PLACE_ATTEMPTS=12;
export const SMM_RETRY_DELAY_MS=5*60_000;

export const SMM_SNS=["x","instagram","tiktok","youtube","other"] as const;
export type SmmSns=typeof SMM_SNS[number];

export type SmmLinkKind=
  |"x_profile"|"x_post"
  |"instagram_profile"|"instagram_post"
  |"tiktok_profile"|"tiktok_video"
  |"youtube_channel"|"youtube_video"
  |"url";

export const SMM_LINK_KINDS:SmmLinkKind[]=[
  "x_profile","x_post",
  "instagram_profile","instagram_post",
  "tiktok_profile","tiktok_video",
  "youtube_channel","youtube_video",
  "url"
];

export const SMM_LINK_KINDS_BY_SNS:Record<SmmSns,SmmLinkKind[]>={
  x:["x_profile","x_post","url"],
  instagram:["instagram_profile","instagram_post","url"],
  tiktok:["tiktok_profile","tiktok_video","url"],
  youtube:["youtube_channel","youtube_video","url"],
  other:["url"]
};

export function isSmmSns(value:unknown):value is SmmSns{
  return SMM_SNS.includes(value as SmmSns);
}

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

const X_HOSTS=["x.com","www.x.com","mobile.x.com","twitter.com","www.twitter.com","mobile.twitter.com"];
const IG_HOSTS=["instagram.com","www.instagram.com"];
const TT_HOSTS=["tiktok.com","www.tiktok.com"];
const YT_HOSTS=["youtube.com","www.youtube.com","m.youtube.com"];
const IG_RESERVED=new Set(["p","reel","reels","tv","explore","accounts","stories","direct","about","legal"]);

function parseHttpsUrl(text:string):URL|null{
  let url:URL;
  try{url=new URL(text);}catch{return null;}
  if(url.protocol!=="https:"||url.username||url.password) return null;
  return url;
}

export function normalizeSmmLink(kind:SmmLinkKind,raw:string):string|null{
  const text=String(raw??"").trim();
  if(!text||text.length>500||/\s/.test(text)) return null;
  const url=parseHttpsUrl(text);
  if(!url) return null;
  const host=url.hostname.toLowerCase();
  const parts=url.pathname.split("/").filter(Boolean);
  switch(kind){
    case "url":
      return url.toString();
    case "x_profile":
    case "x_post":{
      if(!X_HOSTS.includes(host)) return null;
      const user=parts[0]??"";
      if(!/^[A-Za-z0-9_]{1,15}$/.test(user)||X_RESERVED.has(user.toLowerCase())) return null;
      if(kind==="x_profile") return parts.length===1?"https://x.com/"+user:null;
      if(parts.length>=3&&parts[1]==="status"&&/^\d{1,25}$/.test(parts[2]!)){
        return "https://x.com/"+user+"/status/"+parts[2];
      }
      return null;
    }
    case "instagram_profile":{
      if(!IG_HOSTS.includes(host)||parts.length!==1) return null;
      const user=parts[0]!;
      if(!/^[A-Za-z0-9._]{1,30}$/.test(user)||IG_RESERVED.has(user.toLowerCase())) return null;
      return "https://www.instagram.com/"+user+"/";
    }
    case "instagram_post":{
      if(!IG_HOSTS.includes(host)||parts.length<2) return null;
      const type=parts[0]!.toLowerCase();
      if(!["p","reel","tv"].includes(type)||!/^[A-Za-z0-9_-]{5,20}$/.test(parts[1]!)) return null;
      return "https://www.instagram.com/"+type+"/"+parts[1]+"/";
    }
    case "tiktok_profile":{
      if(!TT_HOSTS.includes(host)||parts.length!==1) return null;
      const m=parts[0]!.match(/^@([A-Za-z0-9._]{2,24})$/);
      return m?"https://www.tiktok.com/@"+m[1]:null;
    }
    case "tiktok_video":{
      if(!TT_HOSTS.includes(host)||parts.length<3) return null;
      const m=parts[0]!.match(/^@([A-Za-z0-9._]{2,24})$/);
      if(!m||parts[1]!=="video"||!/^\d{10,25}$/.test(parts[2]!)) return null;
      return "https://www.tiktok.com/@"+m[1]+"/video/"+parts[2];
    }
    case "youtube_channel":{
      if(!YT_HOSTS.includes(host)||parts.length<1) return null;
      const first=parts[0]!;
      if(/^@[A-Za-z0-9._-]{3,30}$/.test(first)&&parts.length===1) return "https://www.youtube.com/"+first;
      if(first==="channel"&&/^UC[A-Za-z0-9_-]{20,24}$/.test(parts[1]??"")&&parts.length===2){
        return "https://www.youtube.com/channel/"+parts[1];
      }
      return null;
    }
    case "youtube_video":{
      let id:string|null=null;
      if(host==="youtu.be"&&parts.length===1) id=parts[0]!;
      else if(YT_HOSTS.includes(host)){
        if(parts[0]==="watch") id=url.searchParams.get("v");
        else if(["shorts","live"].includes(parts[0]??"")&&parts.length===2) id=parts[1]!;
      }
      return id&&/^[A-Za-z0-9_-]{11}$/.test(id)?"https://www.youtube.com/watch?v="+id:null;
    }
  }
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
