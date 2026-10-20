import type { Env } from "./types";
import type { SmmMachine, SmmOrder, SmmProduct, SmmSettings } from "./smm-db";
import type { LuckyService } from "./smm-luckypanel";
import {
  type SmmLinkKind,
  maskSmmLink,
  smmQuantityBounds,
  smmQuote,
  smmOrderNonce
} from "./smm-policy";

export class SmmError extends Error{
  status:number;
  constructor(status:number,message:string){
    super(message);
    this.name="SmmError";
    this.status=status;
  }
}

function botToken(env:Env){
  const token=env.DISCORD_BOT_TOKEN?.trim()??"";
  if(!token) throw new SmmError(503,"DISCORD_BOT_NOT_CONFIGURED");
  return token;
}

export async function smmDiscordFetch(env:Env,path:string,init:RequestInit={}){
  const headers=new Headers(init.headers);
  headers.set("Authorization","Bot "+botToken(env));
  if(init.body&&typeof init.body==="string"&&!headers.has("Content-Type")){
    headers.set("Content-Type","application/json");
  }
  const response=await fetch("https://discord.com/api/v10"+path,{...init,headers});
  if(!response.ok){
    const text=await response.text();
    throw new SmmError(
      response.status===403?403:502,
      "DISCORD_"+response.status+":"+text.slice(0,300)
    );
  }
  return response;
}

export async function smmDiscordJson<T>(env:Env,path:string,init:RequestInit={}):Promise<T>{
  const response=await smmDiscordFetch(env,path,init);
  const text=await response.text();
  return (text?JSON.parse(text):{}) as T;
}

export async function smmSendMessage(
  env:Env,
  channelId:string,
  payload:Record<string,unknown>
){
  return smmDiscordJson<{id:string}>(
    env,
    "/channels/"+channelId+"/messages",
    {method:"POST",body:JSON.stringify(payload)}
  );
}

export async function smmSendDm(
  env:Env,
  userId:string,
  payload:Record<string,unknown>
){
  const dm=await smmDiscordJson<{id:string}>(
    env,
    "/users/@me/channels",
    {method:"POST",body:JSON.stringify({recipient_id:userId})}
  );
  return smmSendMessage(env,dm.id,payload);
}

export async function smmRequireChannelInGuild(env:Env,guildId:string,channelId:string){
  const channel=await smmDiscordJson<{id:string;guild_id?:string}>(
    env,
    "/channels/"+channelId
  );
  if(channel.guild_id!==guildId) throw new SmmError(400,"CHANNEL_NOT_IN_GUILD");
  return channel;
}

export function smmEphemeral(content:string,components?:unknown[],embeds?:unknown[]){
  return {
    type:4,
    data:{
      content,
      flags:64,
      ...(components?{components}:{}),
      ...(embeds?{embeds}:{})
    }
  };
}

export function yen(value:number){
  return "¥"+Math.round(value).toLocaleString("ja-JP");
}

export function productPer1000(product:SmmProduct,rate:number|null):string{
  if(rate===null||!Number.isFinite(rate)) return "価格確認中";
  return yen(smmQuote(rate,1000,product));
}

export const SMM_LINK_LABEL:Record<SmmLinkKind,{label:string;placeholder:string}>={
  x_profile:{label:"XアカウントのURL",placeholder:"https://x.com/ユーザー名"},
  x_post:{label:"XポストのURL",placeholder:"https://x.com/ユーザー名/status/123..."},
  instagram_profile:{label:"InstagramアカウントのURL",placeholder:"https://www.instagram.com/ユーザー名/"},
  instagram_post:{label:"Instagram投稿・リールのURL",placeholder:"https://www.instagram.com/p/XXXXXXXXX/"},
  tiktok_profile:{label:"TikTokアカウントのURL",placeholder:"https://www.tiktok.com/@ユーザー名"},
  tiktok_video:{label:"TikTok動画のURL",placeholder:"https://www.tiktok.com/@ユーザー名/video/123..."},
  youtube_channel:{label:"YouTubeチャンネルのURL",placeholder:"https://www.youtube.com/@ハンドル"},
  youtube_video:{label:"YouTube動画のURL",placeholder:"https://www.youtube.com/watch?v=XXXXXXXXXXX"},
  url:{label:"対象のURL",placeholder:"https://..."}
};

export function smmPanelPayload(
  settings:SmmSettings,
  machine:SmmMachine,
  products:SmmProduct[],
  services:Map<string,LuckyService>
){
  const fields=products.slice(0,25).map(product=>{
    const service=services.get(product.service_id);
    const rate=service?service.rate:null;
    const bounds=service
      ?smmQuantityBounds(service,product)
      :{min:product.min_qty,max:product.max_qty};
    const lines=[
      "1000件あたり: "+productPer1000(product,rate),
      "数量: "+bounds.min.toLocaleString("ja-JP")+" 〜 "+bounds.max.toLocaleString("ja-JP")
    ];
    return {
      name:((product.emoji?product.emoji+" ":"")+product.name).slice(0,256),
      value:((product.description?product.description+"\n":"")+"```\n"+lines.join("\n")+"\n```").slice(0,1024),
      inline:false
    };
  });
  return {
    embeds:[{
      title:machine.panel_title.slice(0,256),
      description:settings.paused
        ?"現在受付を停止しています。"
        :(fields.length?machine.panel_description:"現在販売中の商品はありません。").slice(0,2000),
      color:machine.panel_color,
      fields,
      ...(machine.panel_image_url?{image:{url:machine.panel_image_url}}:{})
    }],
    components:[{
      type:1,
      components:[
        {type:2,style:3,label:"注文する",emoji:{name:"🛒"},custom_id:"smm:buy:"+machine.id,disabled:Boolean(settings.paused)||!fields.length},
        {type:2,style:1,label:"注文状況",emoji:{name:"📋"},custom_id:"smm:status:"+machine.id}
      ]
    }]
  };
}

const STATUS_LABEL:Record<string,string>={
  awaiting_payment:"支払い待ち",
  payment_pending:"決済確認中",
  paid:"受付済み(発注準備中)",
  placing:"発注中",
  placed:"実行中",
  completed:"完了",
  partial:"一部完了",
  canceled:"キャンセル",
  failed:"失敗",
  hold:"運営確認中",
  expired:"期限切れ"
};

export function smmStatusLabel(status:string){
  return STATUS_LABEL[status]??status;
}

export function smmOrderLines(order:SmmOrder){
  return [
    "注文ID: "+order.id,
    "商品: "+order.product_name,
    "数量: "+order.quantity.toLocaleString("ja-JP"),
    "対象: "+maskSmmLink(order.link),
    "金額: "+yen(order.total_amount)
  ].join("\n");
}

export function buyerResultMessage(order:SmmOrder){
  const base={
    title:"",
    color:5763719,
    fields:[
      {name:"商品",value:order.product_name,inline:true},
      {name:"数量",value:order.quantity.toLocaleString("ja-JP"),inline:true},
      {name:"支払金額",value:yen(order.total_amount),inline:true},
      {name:"対象",value:order.link.slice(0,1000),inline:false},
      {name:"注文ID",value:order.id,inline:false}
    ] as Array<{name:string;value:string;inline:boolean}>,
    timestamp:new Date().toISOString()
  };
  if(order.status==="completed"){
    base.title="注文が完了しました";
  }else if(order.status==="partial"){
    base.title="注文が一部のみ完了しました";
    base.color=16705372;
    base.fields.push({
      name:"未達分の返金",
      value:yen(order.refund_amount)+"\n運営が確認後、PayPayで返金します。",
      inline:false
    });
  }else{
    base.title=order.status==="canceled"?"注文がキャンセルされました":"注文を実行できませんでした";
    base.color=15548997;
    base.fields.push({
      name:"返金",
      value:yen(order.refund_amount)+"\n運営が確認後、PayPayで返金します。",
      inline:false
    });
  }
  return {
    embeds:[base],
    allowed_mentions:{parse:[]},
    nonce:smmOrderNonce(order.id),
    enforce_nonce:true
  };
}
