import { parseAccount } from "./account-format";
import { FORMAT_CATALOG } from "./generated/hstora-formats";

export class DeliveryFormatError extends Error{
  constructor(public code:string){
    super(code);
    this.name="DeliveryFormatError";
  }
}

export function normalizeHstoraDeliveryForVending(
  raw:string,
  supplierProductId:string
):string{
  let parsed;
  try{
    parsed=parseAccount(raw,FORMAT_CATALOG,{productId:supplierProductId});
  }catch{
    throw new DeliveryFormatError("HSTORA_DELIVERY_FORMAT_UNKNOWN");
  }
  if(parsed.candidates.length!==1||parsed.fields.length===0){
    throw new DeliveryFormatError("HSTORA_DELIVERY_FORMAT_AMBIGUOUS");
  }
  if(parsed.fields.some(field=>field.confidence!=="format")){
    throw new DeliveryFormatError("HSTORA_DELIVERY_FORMAT_UNVERIFIED");
  }
  return parsed.fields.map(field=>field.value).join(":");
}
