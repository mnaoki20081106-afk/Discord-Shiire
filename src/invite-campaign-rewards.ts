import type { Env } from "./types";
import { randomId } from "./crypto";
import { decryptSensitive, type EncryptedSecret } from "./x-crypto";
import {
  earnedRewardCount,
  remainingUntilNextReward
} from "./invite-campaign-policy";
import {
  ensureInviteCampaignSchema,
  getInviteCampaignSettings
} from "./invite-campaign-db";
import {
  InviteCampaignDiscordError,
  sendInviteCampaignDm
} from "./invite-campaign-discord";

export type InviteCampaignProgress={
  guild_id:string;
  inviter_user_id:string;
  valid_invites:number;
  excluded_invites:number;
  rewards_earned:number;
  updated_at:number;
};

type RewardRow={
  id:string;
  guild_id:string;
  inviter_user_id:string;
  ordinal:number;
  account_id:string|null;
  status:string;
  error:string|null;
  created_at:number;
  updated_at:number;
  delivered_at:number|null;
};

async function getProgress(
  env:Env,
  guildId:string,
  inviterUserId:string
):Promise<InviteCampaignProgress>{
  await ensureInviteCampaignSchema(env);
  const row=await env.DB.prepare(
    "SELECT * FROM invite_campaign_progress WHERE guild_id=? AND inviter_user_id=?"
  ).bind(guildId,inviterUserId).first<InviteCampaignProgress>();
  return row??{
    guild_id:guildId,
    inviter_user_id:inviterUserId,
    valid_invites:0,
    excluded_invites:0,
    rewards_earned:0,
    updated_at:0
  };
}

async function incrementProgress(
  env:Env,
  guildId:string,
  inviterUserId:string,
  kind:"valid"|"excluded"
):Promise<InviteCampaignProgress>{
  await ensureInviteCampaignSchema(env);
  const now=Date.now();
  const valid=kind==="valid"?1:0;
  const excluded=kind==="excluded"?1:0;
  await env.DB.prepare(
    "INSERT INTO invite_campaign_progress"+
    "(guild_id,inviter_user_id,valid_invites,excluded_invites,rewards_earned,updated_at) "+
    "VALUES(?,?,?,?,0,?) ON CONFLICT(guild_id,inviter_user_id) DO UPDATE SET "+
    "valid_invites=invite_campaign_progress.valid_invites+?,"+
    "excluded_invites=invite_campaign_progress.excluded_invites+?,"+
    "updated_at=excluded.updated_at"
  ).bind(guildId,inviterUserId,valid,excluded,now,valid,excluded).run();
  return getProgress(env,guildId,inviterUserId);
}

async function sendProgress(
  env:Env,
  progress:InviteCampaignProgress,
  kind:"valid"|"excluded",
  reason?:string
):Promise<void>{
  const settings=await getInviteCampaignSettings(env);
  const remaining=remainingUntilNextReward(
    progress.valid_invites,
    settings.invites_per_reward
  );
  const reasonText=reason
    ?String(reason).replaceAll("_"," ").slice(0,120)
    :"";
  await sendInviteCampaignDm(env,progress.inviter_user_id,{
    embeds:[{
      title:kind==="valid"
        ?"招待がカウントされました"
        :"対象外招待として記録されました",
      description:kind==="valid"
        ?"あなたの招待リンクから新しいメンバーが参加しました。"
        :"参加は確認できましたが、この招待は報酬対象外です。"+
          (reasonText?"\n理由: "+reasonText:""),
      color:kind==="valid"?0x2ecc71:0xed4245,
      fields:[
        {name:"有効招待数",value:String(progress.valid_invites)+"人"},
        {name:"対象外招待",value:String(progress.excluded_invites)+"人"},
        {name:"次の報酬まで",value:"あと "+String(remaining)+"人"},
        {name:"次の報酬",value:"Xアカウント 1個"}
      ],
      footer:{text:"仕入れBOT 招待キャンペーン"},
      timestamp:new Date().toISOString()
    }],
    allowed_mentions:{parse:[]}
  });
}

async function claimCampaignAccount(
  env:Env
):Promise<{id:string;credentials_ciphertext:string}|null>{
  await ensureInviteCampaignSchema(env);
  for(let attempt=0;attempt<8;attempt++){
    const row=await env.DB.prepare(
      "SELECT id,credentials_ciphertext FROM purchased_accounts "+
      "WHERE procurement_class='INVITE_CAMPAIGN' AND status='READY_FOR_DELIVERY' "+
      "ORDER BY created_at ASC,id ASC LIMIT 1"
    ).first<{id:string;credentials_ciphertext:string}>();
    if(!row) return null;
    const result=await env.DB.prepare(
      "UPDATE purchased_accounts SET status='INVITE_REWARD_RESERVED' "+
      "WHERE id=? AND status='READY_FOR_DELIVERY'"
    ).bind(row.id).run();
    if(Number(result.meta?.changes??0)>0) return row;
  }
  return null;
}

function parseCiphertext(raw:string):EncryptedSecret{
  const value=JSON.parse(raw) as EncryptedSecret;
  if(
    !value||
    value.version!==1||
    typeof value.iv!=="string"||
    typeof value.ciphertext!=="string"
  ){
    throw new Error("INVITE_REWARD_CREDENTIAL_CIPHERTEXT_INVALID");
  }
  return value;
}

function credentialBlock(value:string){
  const fence=String.fromCharCode(96).repeat(3);
  const safe=value.replaceAll(fence,"' ' '").slice(0,3600);
  return fence+"text\n"+safe+"\n"+fence;
}

async function loadReward(env:Env,id:string){
  await ensureInviteCampaignSchema(env);
  return env.DB.prepare(
    "SELECT * FROM invite_campaign_rewards WHERE id=?"
  ).bind(id).first<RewardRow>();
}

async function updateReward(
  env:Env,
  id:string,
  status:string,
  input:{accountId?:string;error?:string|null;deliveredAt?:number}={}
){
  await env.DB.prepare(
    "UPDATE invite_campaign_rewards SET status=?,"+
    "account_id=COALESCE(?,account_id),error=?,delivered_at=COALESCE(?,delivered_at),"+
    "updated_at=? WHERE id=?"
  ).bind(
    status,
    input.accountId??null,
    input.error??null,
    input.deliveredAt??null,
    Date.now(),
    id
  ).run();
}

async function deliverReward(
  env:Env,
  reward:RewardRow
):Promise<string>{
  let accountId=reward.account_id;
  let ciphertext:string|null=null;

  if(accountId){
    const row=await env.DB.prepare(
      "SELECT id,credentials_ciphertext FROM purchased_accounts "+
      "WHERE id=? AND procurement_class='INVITE_CAMPAIGN'"
    ).bind(accountId).first<{id:string;credentials_ciphertext:string}>();
    if(!row){
      await updateReward(env,reward.id,"ERROR",{error:"RESERVED_ACCOUNT_NOT_FOUND"});
      return "ERROR";
    }
    ciphertext=row.credentials_ciphertext;
  }else{
    const row=await claimCampaignAccount(env);
    if(!row){
      await updateReward(env,reward.id,"WAITING_STOCK",{
        error:"INVITE_CAMPAIGN_STOCK_EMPTY"
      });
      return "WAITING_STOCK";
    }
    accountId=row.id;
    ciphertext=row.credentials_ciphertext;
    await updateReward(env,reward.id,"RESERVED",{accountId,error:null});
  }

  let credential:string;
  try{
    credential=await decryptSensitive(env,parseCiphertext(ciphertext));
  }catch(error){
    await updateReward(env,reward.id,"ERROR",{
      error:(error instanceof Error?error.message:String(error)).slice(0,500)
    });
    return "ERROR";
  }

  await updateReward(env,reward.id,"SENDING",{error:null});
  try{
    await sendInviteCampaignDm(env,reward.inviter_user_id,{
      embeds:[{
        title:"🎁 招待報酬を獲得しました",
        description:
          "招待条件を達成したため、Xアカウントを1個プレゼントします。\n\n"+
          credentialBlock(credential),
        color:0x2ecc71,
        fields:[
          {name:"達成回数",value:String(reward.ordinal)+"回目",inline:true}
        ],
        footer:{text:"仕入れBOT 招待キャンペーン"},
        timestamp:new Date().toISOString()
      }],
      allowed_mentions:{parse:[]}
    });
  }catch(error){
    const message=(error instanceof Error?error.message:String(error)).slice(0,500);
    if(error instanceof InviteCampaignDiscordError&&error.status<500){
      const now=Date.now();
      if(accountId){
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE purchased_accounts SET status='READY_FOR_DELIVERY' "+
            "WHERE id=? AND status='INVITE_REWARD_RESERVED'"
          ).bind(accountId),
          env.DB.prepare(
            "UPDATE invite_campaign_rewards SET status='DM_FAILED',account_id=NULL,"+
            "error=?,updated_at=? WHERE id=?"
          ).bind(message,now,reward.id)
        ]);
      }else{
        await updateReward(env,reward.id,"DM_FAILED",{error:message});
      }
      return "DM_FAILED";
    }
    await updateReward(env,reward.id,"DELIVERY_UNCERTAIN",{error:message});
    return "DELIVERY_UNCERTAIN";
  }

  const now=Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE purchased_accounts SET status='DELIVERED_INVITE_REWARD',delivered_at=? "+
      "WHERE id=? AND status='INVITE_REWARD_RESERVED'"
    ).bind(now,accountId),
    env.DB.prepare(
      "UPDATE invite_campaign_rewards SET status='DELIVERED',error=NULL,"+
      "delivered_at=?,updated_at=? WHERE id=?"
    ).bind(now,now,reward.id)
  ]);
  return "DELIVERED";
}

async function ensureRewards(
  env:Env,
  progress:InviteCampaignProgress
):Promise<void>{
  const settings=await getInviteCampaignSettings(env);
  const earned=earnedRewardCount(
    progress.valid_invites,
    settings.invites_per_reward
  );
  const now=Date.now();
  for(let ordinal=1;ordinal<=earned;ordinal++){
    await env.DB.prepare(
      "INSERT OR IGNORE INTO invite_campaign_rewards"+
      "(id,guild_id,inviter_user_id,ordinal,account_id,status,error,created_at,updated_at,delivered_at) "+
      "VALUES(?,?,?,?,NULL,'WAITING_STOCK',NULL,?,?,NULL)"
    ).bind(
      randomId(),progress.guild_id,progress.inviter_user_id,ordinal,now,now
    ).run();
  }
  await env.DB.prepare(
    "UPDATE invite_campaign_progress SET rewards_earned=?,updated_at=? "+
    "WHERE guild_id=? AND inviter_user_id=?"
  ).bind(earned,now,progress.guild_id,progress.inviter_user_id).run();

  const pending=(await env.DB.prepare(
    "SELECT * FROM invite_campaign_rewards WHERE guild_id=? AND inviter_user_id=? "+
    "AND status='WAITING_STOCK' ORDER BY ordinal ASC LIMIT 20"
  ).bind(progress.guild_id,progress.inviter_user_id).all<RewardRow>()).results;
  for(const reward of pending) await deliverReward(env,reward);
}

export async function applyInviteCampaignCredit(
  env:Env,
  guildId:string,
  inviterUserId:string,
  kind:"valid"|"excluded",
  reason?:string
){
  const progress=await incrementProgress(env,guildId,inviterUserId,kind);
  await sendProgress(env,progress,kind,reason).catch(()=>undefined);
  if(kind==="valid") await ensureRewards(env,progress);
  return progress;
}

export async function retryInviteCampaignRewards(env:Env){
  await ensureInviteCampaignSchema(env);
  const settings=await getInviteCampaignSettings(env);
  if(!settings.enabled) return {attempted:0,delivered:0};
  const rows=(await env.DB.prepare(
    "SELECT * FROM invite_campaign_rewards "+
    "WHERE status='WAITING_STOCK' ORDER BY created_at ASC LIMIT 20"
  ).all<RewardRow>()).results;
  let delivered=0;
  for(const row of rows){
    if(await deliverReward(env,row)==="DELIVERED") delivered++;
  }
  return {attempted:rows.length,delivered};
}

export async function retryInviteCampaignReward(env:Env,rewardId:string){
  const row=await loadReward(env,rewardId);
  if(!row) throw new Error("INVITE_REWARD_NOT_FOUND");
  if(row.status==="DELIVERED") return {status:"DELIVERED"};
  if(row.status==="DELIVERY_UNCERTAIN"||row.status==="SENDING"){
    throw new Error("INVITE_REWARD_DELIVERY_UNCERTAIN_MANUAL_REVIEW_REQUIRED");
  }
  return {status:await deliverReward(env,row)};
}
