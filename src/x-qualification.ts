import type { HStoraProduct } from "./x-hstora";
import type { XSettings } from "./x-settings";

export type ProductQualification={
  qualified:boolean;
  unit_price_source:number;
  unit_price_jpy:number|null;
  stock:number;
  search_visibility:string[];
  seller_quality:"api"|"manual_approval"|"unavailable";
  reasons:string[];
  evidence:string[];
};

const VISIBILITY_RULES:Array<{label:string;patterns:RegExp[]}>= [
  {label:"TOP+Latest",patterns:[/\btop\s*\+\s*latest\b/i,/\btop\s*(?:and|&)\s*latest\b/i]},
  {label:"TOP Search",patterns:[/\btop\s+search\b/i,/\btop\s+searchable\b/i]},
  {label:"Latest Search",patterns:[/\blatest\s+search\b/i,/\blatest\s+searchable\b/i]},
  {label:"No Shadowban",patterns:[/\bno\s+shadow\s*ban\b/i,/\bnot\s+shadow\s*banned\b/i]},
  {label:"Search Visible",patterns:[/\bsearch\s+visible\b/i,/\bvisible\s+in\s+search\b/i]}
];

function productText(product:HStoraProduct):string{
  return [product.name,product.short_description??"",product.description??""]
    .join("\n").replace(/\s+/g," ").trim();
}

export function detectSearchVisibility(product:HStoraProduct){
  const text=productText(product);
  const labels:string[]=[];
  const evidence:string[]=[];
  for(const rule of VISIBILITY_RULES){
    if(rule.patterns.some(pattern=>pattern.test(text))){
      labels.push(rule.label);
      evidence.push(rule.label);
    }
  }
  return {labels,evidence,text};
}

export function tierUnitPrice(product:HStoraProduct,quantity:number):number{
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

export function qualifyHStoraProduct(
  product:HStoraProduct,
  settings:XSettings,
  quantity=1,
  now=Date.now()
):ProductQualification{
  const reasons:string[]=[];
  const visibility=detectSearchVisibility(product);
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

  if(!visibility.labels.length) reasons.push("SEARCH_VISIBILITY_NOT_CONFIRMED");
  if(product.stock_available<settings.minimum_stock) reasons.push("STOCK_BELOW_MINIMUM");
  if(unitJpy===null||!Number.isFinite(unitJpy)||unitJpy<=0){
    reasons.push("UNIT_PRICE_JPY_UNAVAILABLE");
  }else if(unitJpy>settings.max_unit_price_jpy){
    reasons.push("UNIT_PRICE_ABOVE_LIMIT");
  }

  let sellerQuality:ProductQualification["seller_quality"]="unavailable";
  if(settings.seller_quality_mode==="strict_api"){
    reasons.push("SELLER_QUALITY_FIELDS_UNAVAILABLE_IN_HSTORA_API");
  }else if(settings.approved_hstora_product_ids.includes(Number(product.id))){
    sellerQuality="manual_approval";
  }else{
    reasons.push("PRODUCT_NOT_MANUALLY_APPROVED");
  }

  return {
    qualified:reasons.length===0,
    unit_price_source:unitSource,
    unit_price_jpy:unitJpy,
    stock:Number(product.stock_available??0),
    search_visibility:visibility.labels,
    seller_quality:sellerQuality,
    reasons,
    evidence:visibility.evidence
  };
}
