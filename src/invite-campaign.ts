import type { Env } from "./types";
import { inviteUsesDelta } from "./invite-campaign-policy";
import {
  ensureInviteCampaignSchema,
  getInviteCampaignSettings,
  markInviteCampaignEvent,
  recordInviteCampaignRuntimeError
} from "./invite-campaign-db";
import {
  createDiscordCampaignInvite,
  fetchDiscordGuildInvites
} from "./invite-campaign-discord";
import { applyInviteCampaignCredit } from "./invite-campaign-rewards";

type InviteRow={
  guild_id:string;
  code:string;
  owner_user_id:string|null;
  owner_source:string;
  uses:number;
  pending_uses:number;
  channel_id:string|null;
  max_uses:number;
  expires_at:string|null;
  last_seen_at:number;
};

export type InviteCampaignMemberEvent={
  guild_id:string;
  user:{
    id:string;
    username?:string;
    global_name?:string|null;
    bot?:boolean;
  };
};

async function refreshInviteSnapshot(env:Env,guildId:string):Promise<void>{
  await ensureInviteCampaignSchema(env);
  const current=await fetchDiscordGuildInvites(env,guildId);
  const previousRows=(await env.DB.prepare(
    "SELECT * FROM invite_campaign_invites WHERE guild_id=?"
  ).bind(guildId).all<InviteRow>()).results;
  const previousByCode=new Map(previousRows.map(row=>[row.code,row]));
  const now=Date.now();
  const statements=current
    .filter(invite=>Boolean(invite.code))
    .map(invite=>{
      const previous=previousByCode.get(invite.code);
      const uses=Math.max(0,Math.floor(Number(invite.uses??0)));
      const delta=previous?inviteUsesDelta(previous.uses,uses):0;
      const managed=previous?.owner_source==="managed";
      const ownerUserId=managed
        ?previous?.owner_user_id??null
        :(String(invite.inviter?.id??"")||previous?.owner_user_id||null);
      const ownerSource=managed?"managed":"discord";
      const pending=Math.max(0,Number(previous?.pending_uses??0))+delta;
      return env.DB.prepare(
        "INSERT INTO invite_campaign_invites"+
        "(guild_id,code,owner_user_id,owner_source,uses,pending_uses,channel_id,max_uses,"+
        "expires_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?) "+
        "ON CONFLICT(guild_id,code) DO UPDATE SET "+
        "owner_user_id=CASE WHEN invite_campaign_invites.owner_source='managed' "+
        "THEN invite_campaign_invites.owner_user_id ELSE excluded.owner_user_id END,"+
        "owner_source=CASE WHEN invite_campaign_invites.owner_source='managed' "+
        "THEN invite_campaign_invites.owner_source ELSE excluded.owner_source END,"+
        "uses=excluded.uses,pending_uses=?,channel_id=excluded.channel_id,"+
        "max_uses=excluded.max_uses,expires_at=excluded.expires_at,last_seen_at=excluded.last_seen_at"
      ).bind(
        guildId,
        invite.code,
        ownerUserId,
        ownerSource,
        uses,
        pending,
        invite.channel?.id??null,
        Math.max(0,Math.floor(Number(invite.max_uses??0))),
        invite.expires_at??null,
        now,
        pending
      );
    });

  for(let index=0;index<statements.length;index+=75){
    await env.DB.batch(statements.slice(index,index+75));
  }
}

export async function seedInviteCampaignSnapshot(
  env:Env,
  guildId?:string
):Promise<{guildId:string;invites:number}>{
  const settings=await getInviteCampaignSettings(env);
  const id=(guildId??settings.guild_id).trim();
  if(!id) throw new Error("INVITE_CAMPAIGN_GUILD_REQUIRED");
  await refreshInviteSnapshot(env,id);
  const row=await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM invite_campaign_invites WHERE guild_id=?"
  ).bind(id).first<{count:number}>();
  return {guildId:id,invites:Number(row?.count??0)};
}

async function consumePendingInvite(
  env:Env,
  guildId:string
):Promise<InviteRow|null>{
  await refreshInviteSnapshot(env,guildId);
  for(let attempt=0;attempt<5;attempt++){
    const row=await env.DB.prepare(
      "SELECT * FROM invite_campaign_invites "+
      "WHERE guild_id=? AND pending_uses>0 "+
      "ORDER BY pending_uses DESC,last_seen_at DESC,code ASC LIMIT 1"
    ).bind(guildId).first<InviteRow>();
    if(!row) return null;
    const result=await env.DB.prepare(
      "UPDATE invite_campaign_invites SET pending_uses=pending_uses-1 "+
      "WHERE guild_id=? AND code=? AND pending_uses>0"
    ).bind(guildId,row.code).run();
    if(Number(result.meta?.changes??0)>0){
      return {...row,pending_uses:Math.max(0,row.pending_uses-1)};
    }
  }
  return null;
}

async function recordMemberJoin(
  env:Env,
  event:InviteCampaignMemberEvent,
  invite:InviteRow|null
):Promise<void>{
  await ensureInviteCampaignSchema(env);
  const now=Date.now();
  const inviterUserId=invite?.owner_user_id??null;
  const existing=await env.DB.prepare(
    "SELECT member_user_id FROM invite_campaign_members "+
    "WHERE guild_id=? AND member_user_id=?"
  ).bind(event.guild_id,event.user.id).first<{member_user_id:string}>();

  if(existing){
    await env.DB.prepare(
      "UPDATE invite_campaign_members SET last_joined_at=?,join_count=join_count+1 "+
      "WHERE guild_id=? AND member_user_id=?"
    ).bind(now,event.guild_id,event.user.id).run();
    if(inviterUserId){
      await applyInviteCampaignCredit(
        env,event.guild_id,inviterUserId,"excluded","REJOIN_ALREADY_COUNTED"
      );
    }
    return;
  }

  let reason:string|null=null;
  if(!invite||!inviterUserId) reason="INVITER_UNRESOLVED";
  else if(inviterUserId===event.user.id) reason="SELF_INVITE";

  const counted=reason?0:1;
  await env.DB.prepare(
    "INSERT INTO invite_campaign_members"+
    "(guild_id,member_user_id,inviter_user_id,invite_code,counted,exclusion_reason,"+
    "first_joined_at,last_joined_at,join_count) VALUES(?,?,?,?,?,?,?,?,1)"
  ).bind(
    event.guild_id,
    event.user.id,
    inviterUserId,
    invite?.code??null,
    counted,
    reason,
    now,
    now
  ).run();

  if(!inviterUserId) return;
  await applyInviteCampaignCredit(
    env,
    event.guild_id,
    inviterUserId,
    counted===1?"valid":"excluded",
    reason??undefined
  );
}

export async function handleInviteCampaignMemberJoin(
  env:Env,
  event:InviteCampaignMemberEvent
):Promise<void>{
  if(!event?.guild_id||!event.user?.id||event.user.bot) return;
  const settings=await getInviteCampaignSettings(env);
  if(!settings.enabled||settings.guild_id!==event.guild_id) return;
  try{
    const invite=await consumePendingInvite(env,event.guild_id);
    await recordMemberJoin(env,event,invite);
    await markInviteCampaignEvent(env);
  }catch(error){
    await recordInviteCampaignRuntimeError(env,error);
    throw error;
  }
}

export async function createInviteCampaignLink(
  env:Env,
  input:{guildId:string;channelId:string;ownerUserId:string}
):Promise<{code:string;url:string}>{
  const settings=await getInviteCampaignSettings(env);
  if(!settings.enabled||settings.guild_id!==input.guildId){
    throw new Error("INVITE_CAMPAIGN_NOT_ENABLED_FOR_GUILD");
  }
  if(
    !/^\d{15,22}$/.test(input.channelId)||
    !/^\d{15,22}$/.test(input.ownerUserId)
  ){
    throw new Error("INVALID_DISCORD_ID");
  }

  const invite=await createDiscordCampaignInvite(env,input.channelId);
  if(!invite.code) throw new Error("DISCORD_INVITE_CODE_MISSING");
  await ensureInviteCampaignSchema(env);
  const now=Date.now();
  await env.DB.prepare(
    "INSERT INTO invite_campaign_invites"+
    "(guild_id,code,owner_user_id,owner_source,uses,pending_uses,channel_id,max_uses,"+
    "expires_at,last_seen_at) VALUES(?,?,?,'managed',?,0,?,?,?,?) "+
    "ON CONFLICT(guild_id,code) DO UPDATE SET owner_user_id=excluded.owner_user_id,"+
    "owner_source='managed',uses=excluded.uses,channel_id=excluded.channel_id,"+
    "max_uses=excluded.max_uses,expires_at=excluded.expires_at,last_seen_at=excluded.last_seen_at"
  ).bind(
    input.guildId,
    invite.code,
    input.ownerUserId,
    Math.max(0,Math.floor(Number(invite.uses??0))),
    invite.channel?.id??input.channelId,
    Math.max(0,Math.floor(Number(invite.max_uses??0))),
    invite.expires_at??null,
    now
  ).run();
  return {code:invite.code,url:"https://discord.gg/"+invite.code};
}
