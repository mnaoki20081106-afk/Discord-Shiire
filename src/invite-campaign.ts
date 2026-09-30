import type { Env } from "./types";
import {
  decideInviteAttribution,
  nextPendingInviteUses
} from "./invite-campaign-policy";
import {
  ensureInviteCampaignSchema,
  getInviteCampaignSettings,
  markInviteCampaignEvent,
  recordInviteCampaignRuntimeError
} from "./invite-campaign-db";
import { fetchDiscordGuildInvites } from "./invite-campaign-discord";
import {
  afterInviteCampaignProgressChanged,
  getInviteCampaignProgress,
  type InviteCampaignProgress
} from "./invite-campaign-rewards";

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

type JoinAttribution=
  |{kind:"none"}
  |{kind:"resolved";invite:InviteRow}
  |{kind:"ambiguous";codes:string[]};

type PostJoinAction={
  progress:InviteCampaignProgress;
  kind:"valid"|"excluded";
  reason?:string;
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

function delay(ms:number){
  return new Promise<void>(resolve=>setTimeout(resolve,ms));
}

async function refreshInviteSnapshot(
  env:Env,
  guildId:string,
  mode:"baseline"|"join"
):Promise<void>{
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
      const pending=nextPendingInviteUses(
        previous
          ?{uses:previous.uses,pendingUses:previous.pending_uses}
          :null,
        uses,
        mode
      );
      const managed=previous?.owner_source==="managed";
      const ownerUserId=managed
        ?previous?.owner_user_id??null
        :(String(invite.inviter?.id??"")||previous?.owner_user_id||null);
      const ownerSource=managed?"managed":"discord";

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
  await ensureInviteCampaignSchema(env);

  // A seed is a new baseline, not a replay. Pending deltas from an older
  // gateway session must never leak into future joins.
  await env.DB.prepare(
    "UPDATE invite_campaign_invites SET pending_uses=0 WHERE guild_id=?"
  ).bind(id).run();
  await refreshInviteSnapshot(env,id,"baseline");

  const row=await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM invite_campaign_invites WHERE guild_id=?"
  ).bind(id).first<{count:number}>();
  return {guildId:id,invites:Number(row?.count??0)};
}

async function pendingInvites(
  env:Env,
  guildId:string
):Promise<InviteRow[]>{
  return (await env.DB.prepare(
    "SELECT * FROM invite_campaign_invites "+
    "WHERE guild_id=? AND pending_uses>0 "+
    "ORDER BY pending_uses DESC,last_seen_at DESC,code ASC"
  ).bind(guildId).all<InviteRow>()).results;
}

async function resolveJoinAttribution(
  env:Env,
  guildId:string
):Promise<JoinAttribution>{
  const retryDelays=[0,150,350];
  for(let attempt=0;attempt<retryDelays.length;attempt++){
    if(retryDelays[attempt]!>0) await delay(retryDelays[attempt]!);
    await refreshInviteSnapshot(env,guildId,"join");
    const rows=await pendingInvites(env,guildId);
    const decision=decideInviteAttribution(
      rows.map(row=>({
        code:row.code,
        ownerUserId:row.owner_user_id,
        pendingUses:row.pending_uses,
        lastSeenAt:row.last_seen_at
      }))
    );

    if(decision.kind==="none"){
      if(attempt<retryDelays.length-1) continue;
      return {kind:"none"};
    }
    if(decision.kind==="ambiguous"){
      return {kind:"ambiguous",codes:decision.codes};
    }
    const invite=rows.find(row=>row.code===decision.code);
    if(invite) return {kind:"resolved",invite};
  }
  return {kind:"none"};
}

function progressUpsert(
  env:Env,
  guildId:string,
  inviterUserId:string,
  kind:"valid"|"excluded",
  now:number
){
  const valid=kind==="valid"?1:0;
  const excluded=kind==="excluded"?1:0;
  return env.DB.prepare(
    "INSERT INTO invite_campaign_progress"+
    "(guild_id,inviter_user_id,valid_invites,excluded_invites,rewards_earned,updated_at) "+
    "VALUES(?,?,?,?,0,?) ON CONFLICT(guild_id,inviter_user_id) DO UPDATE SET "+
    "valid_invites=invite_campaign_progress.valid_invites+?,"+
    "excluded_invites=invite_campaign_progress.excluded_invites+?,"+
    "updated_at=excluded.updated_at"
  ).bind(
    guildId,inviterUserId,valid,excluded,now,valid,excluded
  );
}

async function recordMemberJoin(
  env:Env,
  event:InviteCampaignMemberEvent,
  attribution:JoinAttribution
):Promise<PostJoinAction|null>{
  await ensureInviteCampaignSchema(env);
  const now=Date.now();
  const invite=attribution.kind==="resolved"?attribution.invite:null;
  const inviterUserId=invite?.owner_user_id??null;
  const existing=await env.DB.prepare(
    "SELECT member_user_id FROM invite_campaign_members "+
    "WHERE guild_id=? AND member_user_id=?"
  ).bind(event.guild_id,event.user.id).first<{member_user_id:string}>();

  let reason:string|null=null;
  let kind:"valid"|"excluded"="valid";

  if(attribution.kind==="ambiguous"){
    reason="INVITER_AMBIGUOUS";
    kind="excluded";
  }else if(!invite||!inviterUserId){
    reason="INVITER_UNRESOLVED";
    kind="excluded";
  }else if(existing){
    reason="REJOIN_ALREADY_COUNTED";
    kind="excluded";
  }else if(event.user.bot){
    reason="BOT_ACCOUNT";
    kind="excluded";
  }else if(inviterUserId===event.user.id){
    reason="SELF_INVITE";
    kind="excluded";
  }

  const statements:D1PreparedStatement[]=[];

  if(attribution.kind==="ambiguous"&&attribution.codes.length>0){
    const placeholders=attribution.codes.map(()=>"?").join(",");
    statements.push(
      env.DB.prepare(
        "UPDATE invite_campaign_invites SET pending_uses=0 "+
        "WHERE guild_id=? AND code IN ("+placeholders+")"
      ).bind(event.guild_id,...attribution.codes)
    );
  }else if(invite){
    statements.push(
      env.DB.prepare(
        "UPDATE invite_campaign_invites SET pending_uses=pending_uses-1 "+
        "WHERE guild_id=? AND code=? AND pending_uses>0"
      ).bind(event.guild_id,invite.code)
    );
  }

  if(existing){
    statements.push(
      env.DB.prepare(
        "UPDATE invite_campaign_members SET last_joined_at=?,join_count=join_count+1 "+
        "WHERE guild_id=? AND member_user_id=?"
      ).bind(now,event.guild_id,event.user.id)
    );
  }else{
    statements.push(
      env.DB.prepare(
        "INSERT INTO invite_campaign_members"+
        "(guild_id,member_user_id,inviter_user_id,invite_code,counted,exclusion_reason,"+
        "first_joined_at,last_joined_at,join_count) VALUES(?,?,?,?,?,?,?,?,1)"
      ).bind(
        event.guild_id,
        event.user.id,
        inviterUserId,
        invite?.code??null,
        kind==="valid"?1:0,
        reason,
        now,
        now
      )
    );
  }

  if(inviterUserId){
    statements.push(
      progressUpsert(env,event.guild_id,inviterUserId,kind,now)
    );
  }

  await env.DB.batch(statements);

  if(!inviterUserId) return null;
  const progress=await getInviteCampaignProgress(
    env,event.guild_id,inviterUserId
  );
  return {
    progress,
    kind,
    reason:reason??undefined
  };
}

export async function handleInviteCampaignMemberJoin(
  env:Env,
  event:InviteCampaignMemberEvent
):Promise<void>{
  if(!event?.guild_id||!event.user?.id) return;
  const settings=await getInviteCampaignSettings(env);
  if(!settings.enabled||settings.guild_id!==event.guild_id) return;

  let post:PostJoinAction|null=null;
  try{
    const attribution=await resolveJoinAttribution(env,event.guild_id);
    post=await recordMemberJoin(env,event,attribution);
    await markInviteCampaignEvent(env);
  }catch(error){
    await recordInviteCampaignRuntimeError(env,error);
    throw error;
  }

  if(post){
    try{
      await afterInviteCampaignProgressChanged(
        env,post.progress,post.kind,post.reason
      );
    }catch(error){
      // The member/progress transaction is already committed. Reward creation
      // is reconciled by the scheduled sweep, so do not corrupt attribution by
      // putting the consumed invite back into the pending pool.
      await recordInviteCampaignRuntimeError(env,error);
    }
  }
}
