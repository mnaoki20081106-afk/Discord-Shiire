import type { Env } from "./types";

const SECRETISH=/(token|secret|password|credential|2fa|authorization|private.?key)/i;

function scrub(value:unknown,depth=0):unknown{
  if(depth>4) return "[TRUNCATED]";
  if(Array.isArray(value)) return value.slice(0,25).map(v=>scrub(v,depth+1));
  if(value&&typeof value==="object"){
    const out:Record<string,unknown>={};
    for(const [key,item] of Object.entries(value as Record<string,unknown>)){
      out[key]=SECRETISH.test(key)?"[REDACTED]":scrub(item,depth+1);
    }
    return out;
  }
  return value;
}

export async function notifyDiscord(env:Env,input:{
  title:string;
  message:string;
  level?:"info"|"warning"|"error";
  details?:unknown;
}){
  const url=env.DISCORD_NOTIFY_WEBHOOK_URL?.trim()??"";
  if(!url) return {sent:false,reason:"NOT_CONFIGURED"};
  let parsed:URL;
  try{parsed=new URL(url);}catch{return {sent:false,reason:"INVALID_URL"};}
  if(parsed.protocol!=="https:"||!(parsed.hostname==="discord.com"||parsed.hostname==="discordapp.com")){
    return {sent:false,reason:"UNAPPROVED_WEBHOOK_HOST"};
  }

  const details=input.details===undefined?"":"\n\n\`\`\`json\n"+
    JSON.stringify(scrub(input.details),null,2).slice(0,2500)+"\n\`\`\`";
  const content=("**"+input.title+"**\n"+input.message+details).slice(0,3900);
  const response=await fetch(url,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({content,allowed_mentions:{parse:[]}})
  });
  if(!response.ok) return {sent:false,reason:"HTTP_"+response.status};
  return {sent:true};
}
