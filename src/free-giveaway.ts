import type { Env } from "./types";
import { decryptSensitive, type EncryptedSecret } from "./x-crypto";
import { ensureXSchema, getXSetting, setXSetting } from "./x-db";
import {
  InviteCampaignDiscordError,
  inviteDiscordJson,
  sendInviteCampaignDm
} from "./invite-campaign-discord";

// Free giveaway: every Discord account can claim exactly one account for free
// by pressing the button on a panel. Stock is a dedicated pool of
// purchased_accounts rows with procurement_class='FREE_GIVEAWAY', kept apart
// from the vending and invite-campaign pools. It is never touched by the
// HStora procurement engine; it is filled from the X-Account Generator
// (see addGeneratorAccountsAsStock).

export const FREE_GIVEAWAY_CLASS="FREE_GIVEAWAY";
export const INVITE_CAMPAIGN_CLASS="INVITE_CAMPAIGN";

// Pools the generator may fill, by the name used on the bridge.
export const GENERATOR_POOLS={
  "invite-campaign":INVITE_CAMPAIGN_CLASS,
  "free-giveaway":FREE_GIVEAWAY_CLASS
} as const;
export type GeneratorPoolName=keyof typeof GENERATOR_POOLS;

const ENABLED_KEY="free_giveaway_enabled";
const RESERVED_STATUS="FREE_GIVEAWAY_RESERVED";
const DELIVERED_STATUS="DELIVERED_FREE_GIVEAWAY";
// A claim stuck mid-flight (crashed worker) can be retaken after this long.
const STALE_MS=5*60_000;

export type ClaimStatus=
  |"CLAIMING"|"SENDING"|"DELIVERED"|"WAITING_STOCK"|"DM_FAILED"|"DELIVERY_UNCERTAIN"|"ERROR";

type ClaimRow={
  user_id:string;
  guild_id:string;
  account_id:string|null;
  status:ClaimStatus;
  error:string|null;
  created_at:number;
  updated_at:number;
  delivered_at:number|null;
};

type PoolAccountRow={id:string;credentials_ciphertext:string;status:string};

let schemaReady=false;
export async function ensureFreeGiveawaySchema(env:Env){
  if(schemaReady) return;
  await ensureXSchema(env);
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS free_giveaway_claims ("+
    "user_id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,account_id TEXT,status TEXT NOT NULL,"+
    "error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,delivered_at INTEGER)"
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS free_giveaway_claims_status_idx ON free_giveaway_claims(status,updated_at)"
  ).run();
  schemaReady=true;
}

export async function isFreeGiveawayEnabled(env:Env):Promise<boolean>{
  return (await getXSetting<boolean>(env,ENABLED_KEY))===true;
}

export async function setFreeGiveawayEnabled(env:Env,enabled:boolean){
  await setXSetting(env,ENABLED_KEY,Boolean(enabled));
}

export async function poolAvailableCount(env:Env,procurementClass:string):Promise<number>{
  await ensureXSchema(env);
  const row=await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM purchased_accounts "+
    "WHERE procurement_class=? AND status='READY_FOR_DELIVERY'"
  ).bind(procurementClass).first<{count:number}>();
  return Math.max(0,Number(row?.count??0));
}

async function loadClaim(env:Env,userId:string){
  return await env.DB.prepare(
    "SELECT * FROM free_giveaway_claims WHERE user_id=?"
  ).bind(userId).first<ClaimRow>()??null;
}

async function setClaim(
  env:Env,
  userId:string,
  status:ClaimStatus,
  patch:{error?:string|null;accountId?:string|null;delivered?:boolean}={}
){
  const now=Date.now();
  await env.DB.prepare(
    "UPDATE free_giveaway_claims SET status=?,error=?,account_id=COALESCE(?,account_id),"+
    "delivered_at=COALESCE(?,delivered_at),updated_at=? WHERE user_id=?"
  ).bind(
    status,
    patch.error===undefined?null:patch.error,
    patch.accountId??null,
    patch.delivered?now:null,
    now,
    userId
  ).run();
}

// Returns the claim to work on, or the status that stops the user from claiming.
async function beginClaim(
  env:Env,
  userId:string,
  guildId:string
):Promise<{claim:ClaimRow}|{stop:"ALREADY_CLAIMED"|"BUSY"|"ERROR"}>{
  const now=Date.now();
  const inserted=await env.DB.prepare(
    "INSERT OR IGNORE INTO free_giveaway_claims(user_id,guild_id,status,created_at,updated_at) "+
    "VALUES(?,?,'CLAIMING',?,?)"
  ).bind(userId,guildId,now,now).run();
  if(Number(inserted.meta?.changes??0)===1){
    const fresh=await loadClaim(env,userId);
    return fresh?{claim:fresh}:{stop:"ERROR"};
  }

  const existing=await loadClaim(env,userId);
  if(!existing) return {stop:"ERROR"};

  if(existing.status==="DELIVERED"||existing.status==="DELIVERY_UNCERTAIN"){
    return {stop:"ALREADY_CLAIMED"};
  }
  if(existing.status==="WAITING_STOCK"||existing.status==="DM_FAILED"||existing.status==="ERROR"){
    const taken=await env.DB.prepare(
      "UPDATE free_giveaway_claims SET status='CLAIMING',error=NULL,guild_id=?,updated_at=? "+
      "WHERE user_id=? AND status=?"
    ).bind(guildId,now,userId,existing.status).run();
    if(Number(taken.meta?.changes??0)!==1) return {stop:"BUSY"};
    return {claim:{...existing,status:"CLAIMING",error:null,guild_id:guildId,updated_at:now}};
  }
  // CLAIMING / SENDING: someone (probably this same user, double click) is mid-flight.
  if(now-existing.updated_at<STALE_MS) return {stop:"BUSY"};
  if(existing.status==="SENDING"){
    // The DM may or may not have gone out. Never hand out a second account.
    await setClaim(env,userId,"DELIVERY_UNCERTAIN",{error:"STALE_SENDING"});
    return {stop:"ALREADY_CLAIMED"};
  }
  const retaken=await env.DB.prepare(
    "UPDATE free_giveaway_claims SET updated_at=? WHERE user_id=? AND status='CLAIMING' AND updated_at=?"
  ).bind(now,userId,existing.updated_at).run();
  if(Number(retaken.meta?.changes??0)!==1) return {stop:"BUSY"};
  return {claim:{...existing,updated_at:now}};
}

async function reserveAccount(env:Env,claim:ClaimRow):Promise<PoolAccountRow|null>{
  if(claim.account_id){
    const held=await env.DB.prepare(
      "SELECT id,credentials_ciphertext,status FROM purchased_accounts "+
      "WHERE id=? AND procurement_class=? AND status=?"
    ).bind(claim.account_id,FREE_GIVEAWAY_CLASS,RESERVED_STATUS).first<PoolAccountRow>();
    if(held) return held;
  }
  for(let attempt=0;attempt<8;attempt++){
    const row=await env.DB.prepare(
      "SELECT id,credentials_ciphertext,status FROM purchased_accounts "+
      "WHERE procurement_class=? AND status='READY_FOR_DELIVERY' "+
      "ORDER BY created_at ASC,id ASC LIMIT 1"
    ).bind(FREE_GIVEAWAY_CLASS).first<PoolAccountRow>();
    if(!row) return null;
    const results=await env.DB.batch([
      env.DB.prepare(
        "UPDATE purchased_accounts SET status=? WHERE id=? AND status='READY_FOR_DELIVERY'"
      ).bind(RESERVED_STATUS,row.id),
      env.DB.prepare(
        "UPDATE free_giveaway_claims SET account_id=?,updated_at=? "+
        "WHERE user_id=? AND status='CLAIMING' AND account_id IS NULL"
      ).bind(row.id,Date.now(),claim.user_id)
    ]);
    const accountChanged=Number(results[0]?.meta?.changes??0);
    const claimChanged=Number(results[1]?.meta?.changes??0);
    if(accountChanged===1&&claimChanged===1) return {...row,status:RESERVED_STATUS};
    if(accountChanged===1){
      // Reserved the account but the claim moved on: give it back.
      await env.DB.prepare(
        "UPDATE purchased_accounts SET status='READY_FOR_DELIVERY' WHERE id=? AND status=?"
      ).bind(row.id,RESERVED_STATUS).run().catch(()=>undefined);
      return null;
    }
  }
  return null;
}

function parseCiphertext(raw:string):EncryptedSecret{
  const value=JSON.parse(raw) as EncryptedSecret;
  if(!value||value.version!==1||typeof value.iv!=="string"||typeof value.ciphertext!=="string"){
    throw new Error("FREE_GIVEAWAY_CREDENTIAL_CIPHERTEXT_INVALID");
  }
  return value;
}

function credentialBlock(value:string){
  const fence=String.fromCharCode(96).repeat(3);
  const safe=value.replaceAll(fence,"' ' '").slice(0,3600);
  return fence+"text\n"+safe+"\n"+fence;
}

export type ClaimOutcome=
  |"DELIVERED"|"ALREADY_CLAIMED"|"BUSY"|"DISABLED"|"WAITING_STOCK"|"DM_FAILED"
  |"DELIVERY_UNCERTAIN"|"ERROR";

// Runs the whole claim for one user. Safe to call concurrently for the same
// user: only one caller gets the claim row, and an account is only ever
// reserved through a conditional state transition.
export async function claimFreeGiveaway(
  env:Env,
  userId:string,
  guildId:string
):Promise<ClaimOutcome>{
  await ensureFreeGiveawaySchema(env);
  if(!(await isFreeGiveawayEnabled(env))) return "DISABLED";

  const begun=await beginClaim(env,userId,guildId);
  if("stop" in begun) return begun.stop;
  const claim=begun.claim;

  const account=await reserveAccount(env,claim);
  if(!account){
    await setClaim(env,userId,"WAITING_STOCK",{error:"FREE_GIVEAWAY_STOCK_EMPTY"});
    return "WAITING_STOCK";
  }

  let credential:string;
  try{
    credential=await decryptSensitive(env,parseCiphertext(account.credentials_ciphertext));
  }catch(error){
    await setClaim(env,userId,"ERROR",{
      error:(error instanceof Error?error.message:String(error)).slice(0,500),
      accountId:account.id
    });
    return "ERROR";
  }

  await setClaim(env,userId,"SENDING",{error:null,accountId:account.id});
  try{
    await sendInviteCampaignDm(env,userId,{
      embeds:[{
        title:"🎁 無料のXアカウントをプレゼント",
        description:"受け取りありがとうございます。無料配布のXアカウントです。\n\n"+credentialBlock(credential),
        color:0x2ecc71,
        footer:{text:"仕入れBOT 無料配布（お一人様1個）"},
        timestamp:new Date().toISOString()
      }],
      allowed_mentions:{parse:[]}
    });
  }catch(error){
    const message=(error instanceof Error?error.message:String(error)).slice(0,500);
    if(error instanceof InviteCampaignDiscordError&&error.status<500){
      // Discord refused the DM (closed DMs): nothing was delivered, so release the account.
      const now=Date.now();
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE purchased_accounts SET status='READY_FOR_DELIVERY' WHERE id=? AND status=?"
        ).bind(account.id,RESERVED_STATUS),
        env.DB.prepare(
          "UPDATE free_giveaway_claims SET status='DM_FAILED',account_id=NULL,error=?,updated_at=? "+
          "WHERE user_id=? AND status='SENDING'"
        ).bind(message,now,userId)
      ]);
      return "DM_FAILED";
    }
    await setClaim(env,userId,"DELIVERY_UNCERTAIN",{error:message});
    return "DELIVERY_UNCERTAIN";
  }

  const now=Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE purchased_accounts SET status=?,delivered_at=? WHERE id=? AND status=?"
    ).bind(DELIVERED_STATUS,now,account.id,RESERVED_STATUS),
    env.DB.prepare(
      "UPDATE free_giveaway_claims SET status='DELIVERED',error=NULL,delivered_at=?,updated_at=? "+
      "WHERE user_id=? AND status='SENDING'"
    ).bind(now,now,userId)
  ]);
  return "DELIVERED";
}

const OUTCOME_MESSAGE:Record<ClaimOutcome,string>={
  DELIVERED:"🎁 無料のXアカウントをDMに送りました。DMを確認してください。",
  ALREADY_CLAIMED:"無料配布はお一人様1個までです。すでに受け取り済みです。",
  BUSY:"処理中です。少し待ってからもう一度お試しください。",
  DISABLED:"現在、無料配布は行っていません。",
  WAITING_STOCK:"ただいま在庫切れです。入荷したらもう一度ボタンを押してください。",
  DM_FAILED:"DMを送れませんでした。サーバーのプライバシー設定でDMを許可してから、もう一度ボタンを押してください。",
  DELIVERY_UNCERTAIN:"送信結果を確認できませんでした。DMを確認し、届いていなければ管理者に連絡してください。",
  ERROR:"エラーが発生しました。時間をおいてもう一度お試しください。"
};

export const FREE_GIVEAWAY_BUTTON_ID="fgv:claim";

export function freeGiveawayPanelPayload(){
  return {
    embeds:[{
      title:"🎁 Xアカウント 無料プレゼント",
      description:
        "Discordアカウントごとに **1個** 、Xアカウントを無料でプレゼントします。\n"+
        "下のボタンを押すと、DMに受け取り用の情報が届きます。\n"+
        "※ DMを受け取れる設定にしてから押してください。",
      color:0x2ecc71
    }],
    components:[{
      type:1,
      components:[{
        type:2,
        style:3,
        label:"無料で受け取る",
        emoji:{name:"🎁"},
        custom_id:FREE_GIVEAWAY_BUTTON_ID
      }]
    }],
    allowed_mentions:{parse:[]}
  };
}

function json(payload:unknown){
  return new Response(JSON.stringify(payload),{
    headers:{"Content-Type":"application/json; charset=utf-8"}
  });
}

async function editOriginal(interaction:any,content:string){
  const applicationId=String(interaction.application_id??"");
  const token=String(interaction.token??"");
  if(!applicationId||!token) return;
  await fetch(
    "https://discord.com/api/v10/webhooks/"+encodeURIComponent(applicationId)+"/"+
      encodeURIComponent(token)+"/messages/@original",
    {
      method:"PATCH",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({content:content.slice(0,2000)})
    }
  ).catch(error=>console.error("free giveaway interaction edit failed",error));
}

// Button handler. Returns null for interactions that are not ours.
export async function handleFreeGiveawayInteraction(
  interaction:any,
  env:Env,
  ctx:{waitUntil(promise:Promise<unknown>):void}
):Promise<Response|null>{
  if(interaction?.type!==3) return null;
  if(String(interaction?.data?.custom_id??"")!==FREE_GIVEAWAY_BUTTON_ID) return null;

  const user=interaction.member?.user??interaction.user;
  const userId=String(user?.id??"");
  const guildId=String(interaction.guild_id??"");
  if(!userId||user?.bot) return json({type:4,data:{content:OUTCOME_MESSAGE.ERROR,flags:64}});

  // The claim can take a few Discord round trips, so acknowledge first and
  // report the result by editing the (ephemeral) reply.
  ctx.waitUntil((async()=>{
    let outcome:ClaimOutcome;
    try{
      outcome=await claimFreeGiveaway(env,userId,guildId);
    }catch(error){
      console.error("free giveaway claim failed",error);
      outcome="ERROR";
    }
    await editOriginal(interaction,OUTCOME_MESSAGE[outcome]);
  })());
  return json({type:5,data:{flags:64}});
}

export async function postFreeGiveawayPanel(env:Env,channelId:string){
  const message=await inviteDiscordJson<{id?:string}>(
    env,
    "/channels/"+encodeURIComponent(channelId)+"/messages",
    {method:"POST",body:JSON.stringify(freeGiveawayPanelPayload())}
  );
  return {messageId:message.id??null};
}

export async function freeGiveawayOverview(env:Env){
  await ensureFreeGiveawaySchema(env);
  const [enabled,stock,reserved,statusRows,recent]=await Promise.all([
    isFreeGiveawayEnabled(env),
    poolAvailableCount(env,FREE_GIVEAWAY_CLASS),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM purchased_accounts WHERE procurement_class=? AND status=?"
    ).bind(FREE_GIVEAWAY_CLASS,RESERVED_STATUS).first<{count:number}>(),
    env.DB.prepare(
      "SELECT status,COUNT(*) AS count FROM free_giveaway_claims GROUP BY status"
    ).all<{status:string;count:number}>(),
    env.DB.prepare(
      "SELECT user_id,status,error,updated_at,delivered_at FROM free_giveaway_claims "+
      "ORDER BY updated_at DESC LIMIT 20"
    ).all<{user_id:string;status:string;error:string|null;updated_at:number;delivered_at:number|null}>()
  ]);
  const claims:Record<string,number>={};
  for(const row of statusRows.results) claims[row.status]=Number(row.count);
  return {
    enabled,
    stockCount:stock,
    reservedCount:Math.max(0,Number(reserved?.count??0)),
    claims,
    recent:recent.results
  };
}

