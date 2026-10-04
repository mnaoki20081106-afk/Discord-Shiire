import type { HstoraProduct } from "./providers/hstora";
import type { XSettings } from "./x-settings";
import {
  HSTORA_X_MAX_UNIT_PRICE_USD,
  isBlockedHstoraSource
} from "./x-procurement-policy";

export type ProcurementClass="TOP_SEARCH"|"NO_SHADOWBAN";

export type ProductQualification={
  qualified:boolean;
  procurement_class:ProcurementClass|null;
  unit_price_source:number;
  unit_price_jpy:number|null;
  stock:number;
  search_visibility:string[];
  seller_quality:"api"|"manual_approval"|"trial_only"|"unavailable";
  reasons:string[];
  evidence:string[];
};

const VISIBILITY_RULES:Array<{label:string;patterns:RegExp[]}>= [
  {label:"TOP+Latest",patterns:[/\btop\s*\+\s*latest\b/i,/\btop\s*(?:and|&)\s*latest\b/i,/\btop\s+latest\b/i]},
  {label:"TOP Search",patterns:[/\btop\s+search\b/i,/\btop\s+searchable\b/i]},
  {label:"Latest Search",patterns:[/\blatest\s+search\b/i,/\blatest\s+searchable\b/i]},
  {label:"No Shadowban",patterns:[/\bno\s+shadow\s*bans?\b/i,/\bnot\s+shadow\s*banned\b/i]},
  {label:"Search Visible",patterns:[/\bsearch\s+visible\b/i,/\bvisible\s+in\s+search\b/i]}
];

type VisibilityProduct=Pick<HstoraProduct,"name"|"slug"|"short_description">&
  Partial<Pick<HstoraProduct,"description">>;

const NEGATED_TOP_PATTERNS:RegExp[]=[
  /\b(?:no|not|without)\s+top\s+search(?:able)?\b/gi,
  /\b(?:no|not|without)\s+top\s*(?:\+|and|&|\s)\s*latest(?:\s+search)?\b/gi,
  /\btop\s+search(?:able)?\s+(?:unavailable|disabled|unsupported|not\s+available)\b/gi,
  /\btop\s*(?:\+|and|&|\s)\s*latest(?:\s+search)?\s+(?:unavailable|disabled|unsupported|not\s+available)\b/gi
];

function productText(product:VisibilityProduct):string{
  return [
    product.name,
    String(product.slug??"").replace(/[_-]+/g," "),
    product.short_description??"",
    product.description??""
  ].join("\n").replace(/\s+/g," ").trim();
}

export function isXAccountProduct(product:VisibilityProduct):boolean{
  const identity=[product.name,product.slug,product.short_description??""]
    .join(" ")
    .replace(/[_-]+/g," ");
  return (
    /\btwitter\b/i.test(identity)||
    /\bx\s+accounts?\b/i.test(identity)||
    /\bx\s+top\b/i.test(identity)||
    /\btwitter\s*\/\s*x\b/i.test(identity)
  );
}

export function detectSearchVisibility(product:VisibilityProduct){
  const text=productText(product);
  const positiveTopText=NEGATED_TOP_PATTERNS.reduce(
    (value,pattern)=>value.replace(pattern," "),
    text
  );
  const labels:string[]=[];
  const evidence:string[]=[];
  for(const rule of VISIBILITY_RULES){
    const haystack=
      rule.label==="TOP+Latest"||rule.label==="TOP Search"
        ?positiveTopText
        :text;
    if(rule.patterns.some(pattern=>pattern.test(haystack))){
      labels.push(rule.label);
      evidence.push(rule.label);
    }
  }
  return {labels,evidence,text};
}

export function hasSearchVisibilityEvidence(labels:readonly string[]):boolean{
  return (
    labels.includes("TOP+Latest")||
    labels.includes("TOP Search")||
    labels.includes("Latest Search")||
    labels.includes("Search Visible")
  );
}

function normalizeRangeEnd(start:number,rawEnd:string):number{
  const parsed=Number(rawEnd);
  if(rawEnd.length===2){
    const century=Math.floor(start/100)*100;
    let candidate=century+parsed;
    if(candidate<start) candidate+=100;
    return candidate;
  }
  return parsed;
}

export function detectOldAccountEvidence(
  product:VisibilityProduct,
  now=Date.now()
){
  const text=productText(product);
  const currentYear=new Date(now).getUTCFullYear();
  const evidence:string[]=[];

  const range=/\b((?:19|20)\d{2})\s*[-–—]\s*((?:(?:19|20)\d{2})|\d{2})(?:\s*(?:year|years))?\b/gi;
  for(const match of text.matchAll(range)){
    const start=Number(match[1]);
    const end=normalizeRangeEnd(start,match[2]!);
    if(
      Number.isInteger(start)&&
      Number.isInteger(end)&&
      start>=1990&&
      start<=end&&
      end<currentYear
    ){
      evidence.push(`Year range ${start}-${end}`);
    }
  }

  const agedYearPatterns=[
    /\b(?:aged|old|created|registered|since)\D{0,12}((?:19|20)\d{2})\b/gi,
    /\b((?:19|20)\d{2})\D{0,12}(?:aged|old)\b/gi
  ];
  for(const pattern of agedYearPatterns){
    for(const match of text.matchAll(pattern)){
      const year=Number(match[1]);
      if(Number.isInteger(year)&&year>=1990&&year<currentYear){
        evidence.push(`Old-year ${year}`);
      }
    }
  }

  if(/\bold\s+(?:twitter\s*\/?\s*x\s+)?accounts?\b/i.test(text)){
    evidence.push("Explicit old account");
  }

  return {
    old:evidence.length>0,
    evidence:[...new Set(evidence)]
  };
}

export function hasOldSearchNoShadowbanEvidence(
  product:VisibilityProduct,
  now=Date.now()
):boolean{
  const visibility=detectSearchVisibility(product);
  return (
    visibility.labels.includes("No Shadowban")&&
    hasSearchVisibilityEvidence(visibility.labels)&&
    detectOldAccountEvidence(product,now).old
  );
}

export function classifyProcurementClass(
  product:VisibilityProduct
):ProcurementClass|null{
  if(!isXAccountProduct(product)) return null;
  const visibility=detectSearchVisibility(product);
  if(!visibility.labels.includes("No Shadowban")) return null;
  if(
    hasSearchVisibilityEvidence(visibility.labels)&&
    detectOldAccountEvidence(product).old
  ){
    return "TOP_SEARCH";
  }
  return "NO_SHADOWBAN";
}

export function tierUnitPrice(product:HstoraProduct,quantity:number):number{
  const base=Number(product.price);
  let best=base;
  const qty=Math.max(1,Math.floor(quantity));
  for(const tier of product.price_tiers??[]){
    const min=Number(tier.min_quantity);
    const price=Number(tier.unit_price);
    if(Number.isFinite(min)&&Number.isFinite(price)&&qty>=min&&price>0){
      best=Math.min(best,price);
    }
  }
  return best;
}

export function qualifyHstoraProduct(
  product:HstoraProduct,
  settings:XSettings,
  quantity=1,
  now=Date.now(),
  procurementClassOverride?:ProcurementClass
):ProductQualification{
  const reasons:string[]=[];
  const visibility=detectSearchVisibility(product);
  const oldEvidence=detectOldAccountEvidence(product,now);
  const detectedProcurementClass=classifyProcurementClass(product);
  const procurementClass=
    procurementClassOverride??detectedProcurementClass;
  const unitSource=tierUnitPrice(product,quantity);
  const currency=String(product.currency??"").toUpperCase();

  let unitJpy:number|null=null;
  if(currency==="JPY"){
    unitJpy=unitSource;
  }else if(currency==="USD"){
    const fxAge=now-settings.usd_jpy_rate_updated_at;
    if(settings.usd_jpy_rate>0&&settings.usd_jpy_rate_updated_at>0&&fxAge>=0&&fxAge<=settings.max_fx_age_ms){
      unitJpy=unitSource*settings.usd_jpy_rate;
    }else{
      reasons.push("USDJPY_RATE_MISSING_OR_STALE");
    }
  }else{
    reasons.push("UNSUPPORTED_CURRENCY_"+currency);
  }

  if(isBlockedHstoraSource(product.id)){
    reasons.push("HSTORA_PRODUCT_BLOCKED_BY_POLICY");
  }
  if(!isXAccountProduct(product)) reasons.push("NOT_X_ACCOUNT_PRODUCT");
  if(!procurementClass){
    reasons.push("SUPPORTED_X_PRODUCT_CLASS_NOT_CONFIRMED");
  }

  if(
    procurementClass&&
    !visibility.labels.includes("No Shadowban")
  ){
    reasons.push("NO_SHADOWBAN_EVIDENCE_NOT_CONFIRMED");
  }

  if(procurementClass==="TOP_SEARCH"){
    if(!hasSearchVisibilityEvidence(visibility.labels)){
      reasons.push("SEARCH_VISIBILITY_EVIDENCE_NOT_CONFIRMED");
    }
    if(!oldEvidence.old){
      reasons.push("OLD_ACCOUNT_EVIDENCE_NOT_CONFIRMED");
    }
  }

  if(product.stock_available<settings.minimum_stock) reasons.push("STOCK_BELOW_MINIMUM");

  if(procurementClass){
    if(currency!=="USD"){
      reasons.push("HSTORA_X_REQUIRES_USD_PRICE");
    }else if(
      !Number.isFinite(unitSource)||
      unitSource<=0||
      unitSource>HSTORA_X_MAX_UNIT_PRICE_USD
    ){
      reasons.push("HSTORA_X_UNIT_PRICE_ABOVE_USD_LIMIT");
    }
  }

  let sellerQuality:ProductQualification["seller_quality"]="unavailable";
  if(settings.seller_quality_mode==="strict_api"){
    reasons.push("SELLER_QUALITY_FIELDS_UNAVAILABLE_IN_HSTORA_API");
  }else if(settings.seller_quality_mode==="trial_only"){
    sellerQuality="trial_only";
  }else if(settings.approved_hstora_product_ids.includes(Number(product.id))){
    sellerQuality="manual_approval";
  }else{
    reasons.push("PRODUCT_NOT_MANUALLY_APPROVED");
  }

  return {
    qualified:reasons.length===0,
    procurement_class:procurementClass,
    unit_price_source:unitSource,
    unit_price_jpy:unitJpy,
    stock:Number(product.stock_available??0),
    search_visibility:visibility.labels,
    seller_quality:sellerQuality,
    reasons,
    evidence:[
      ...visibility.evidence,
      ...oldEvidence.evidence
    ]
  };
}
