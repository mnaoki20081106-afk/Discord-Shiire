import type { Env } from "./types";

export type XNotificationKind=
  |"LTC_PURCHASE_REQUIRED"
  |"LTC_TRANSFER_COMPLETED"
  |"HSTORA_DEPOSIT_COMPLETED"
  |"PROCUREMENT_STARTED"
  |"PROCUREMENT_COMPLETED"
  |"BAD_PRODUCT"
  |"INSUFFICIENT_BALANCE"
  |"INSUFFICIENT_INVENTORY"
  |"API_OUTAGE"
  |"CIRCUIT_BREAKER"
  |"BULK_PURCHASE_CONFIRMATION";

export async function notifyDiscord(
  env:Env,
  kind:XNotificationKind,
  message:string,
  details?:Record<string,unknown>
){
  const webhook=env.DISCORD_NOTIFY_WEBHOOK_URL?.trim()??"";
  if(!webhook) return {sent:false,reason:"WEBHOOK_NOT_CONFIGURED" as const};

  let url:URL;
  try{url=new URL(webhook);}catch{return {sent:false,reason:"WEBHOOK_INVALID" as const};}
  if(url.protocol!=="https:"||url.hostname!=="discord.com"){
    return {sent:false,reason:"WEBHOOK_HOST_INVALID" as const};
  }

  const safeDetails=details
    ?Object.entries(details)
      .filter(([key])=>!/(secret|token|password|credential|2fa|api.?key)/i.test(key))
      .slice(0,12)
      .map(([key,value])=>`${key}: ${String(value).slice(0,150)}`)
      .join("\n")
    :"";
  const content=`**[${kind}]** ${message}${safeDetails?"\n"+safeDetails:""}`.slice(0,1900);

  const response=await fetch(webhook,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({content,allowed_mentions:{parse:[]}})
  });
  return {sent:response.ok,status:response.status};
}
