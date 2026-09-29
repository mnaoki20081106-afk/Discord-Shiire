import type { Env } from "./types";
import { ensureXSchema } from "./x-db";
import {
  DEFAULT_INVITES_PER_REWARD,
  DEFAULT_INVITE_CAMPAIGN_TARGET_STOCK,
  normalizePositiveInteger
} from "./invite-campaign-policy";

export type InviteCampaignSettings={
  enabled:boolean;
  guild_id:string;
  invites_per_reward:number;
  target_stock:number;
  updated_at:number;
};

let schemaReady:Promise<void>|null=null;

const SCHEMA=[
  "CREATE TABLE IF NOT EXISTS invite_campaign_settings ("+
    "id INTEGER PRIMARY KEY CHECK(id=1),"+
    "enabled INTEGER NOT NULL DEFAULT 0,"+
    "guild_id TEXT NOT NULL DEFAULT '',"+
    "invites_per_reward INTEGER NOT NULL DEFAULT 5,"+
    "target_stock INTEGER NOT NULL DEFAULT 20,"+
    "updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS invite_campaign_guilds ("+
    "guild_id TEXT PRIMARY KEY,name TEXT NOT NULL,icon TEXT,last_seen_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS invite_campaign_invites ("+
    "guild_id TEXT NOT NULL,code TEXT NOT NULL,owner_user_id TEXT,"+
    "owner_source TEXT NOT NULL DEFAULT 'discord',uses INTEGER NOT NULL DEFAULT 0,"+
    "pending_uses INTEGER NOT NULL DEFAULT 0,channel_id TEXT,max_uses INTEGER NOT NULL DEFAULT 0,"+
    "expires_at TEXT,last_seen_at INTEGER NOT NULL,PRIMARY KEY(guild_id,code))",
  "CREATE TABLE IF NOT EXISTS invite_campaign_members ("+
    "guild_id TEXT NOT NULL,member_user_id TEXT NOT NULL,inviter_user_id TEXT,invite_code TEXT,"+
    "counted INTEGER NOT NULL,exclusion_reason TEXT,first_joined_at INTEGER NOT NULL,"+
    "last_joined_at INTEGER NOT NULL,join_count INTEGER NOT NULL DEFAULT 1,"+
    "PRIMARY KEY(guild_id,member_user_id))",
  "CREATE TABLE IF NOT EXISTS invite_campaign_progress ("+
    "guild_id TEXT NOT NULL,inviter_user_id TEXT NOT NULL,valid_invites INTEGER NOT NULL DEFAULT 0,"+
    "excluded_invites INTEGER NOT NULL DEFAULT 0,rewards_earned INTEGER NOT NULL DEFAULT 0,"+
    "updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,inviter_user_id))",
  "CREATE TABLE IF NOT EXISTS invite_campaign_rewards ("+
    "id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,inviter_user_id TEXT NOT NULL,ordinal INTEGER NOT NULL,"+
    "account_id TEXT UNIQUE,status TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,"+
    "updated_at INTEGER NOT NULL,delivered_at INTEGER,UNIQUE(guild_id,inviter_user_id,ordinal))",
  "CREATE TABLE IF NOT EXISTS invite_campaign_runtime ("+
    "id INTEGER PRIMARY KEY CHECK(id=1),gateway_ready_at INTEGER,last_event_at INTEGER,"+
    "last_error TEXT,updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS invite_campaign_rewards_status_idx "+
    "ON invite_campaign_rewards(status,created_at)",
  "CREATE INDEX IF NOT EXISTS invite_campaign_invites_pending_idx "+
    "ON invite_campaign_invites(guild_id,pending_uses)"
];

export async function ensureInviteCampaignSchema(env:Env):Promise<void>{
  if(!schemaReady){
    schemaReady=env.DB.batch(SCHEMA.map(sql=>env.DB.prepare(sql))).then(()=>undefined);
    schemaReady.catch(()=>{schemaReady=null;});
  }
  await schemaReady;
}

function fromRow(row:any):InviteCampaignSettings{
  return {
    enabled:Number(row?.enabled??0)===1,
    guild_id:String(row?.guild_id??""),
    invites_per_reward:normalizePositiveInteger(
      row?.invites_per_reward,DEFAULT_INVITES_PER_REWARD,1000
    ),
    target_stock:normalizePositiveInteger(
      row?.target_stock,DEFAULT_INVITE_CAMPAIGN_TARGET_STOCK,10000
    ),
    updated_at:Number(row?.updated_at??0)
  };
}

export async function getInviteCampaignSettings(env:Env):Promise<InviteCampaignSettings>{
  await ensureInviteCampaignSchema(env);
  const row=await env.DB.prepare(
    "SELECT * FROM invite_campaign_settings WHERE id=1"
  ).first<any>();
  if(row) return fromRow(row);
  const now=Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO invite_campaign_settings"+
    "(id,enabled,guild_id,invites_per_reward,target_stock,updated_at) VALUES(1,0,'',?,?,?)"
  ).bind(DEFAULT_INVITES_PER_REWARD,DEFAULT_INVITE_CAMPAIGN_TARGET_STOCK,now).run();
  return {
    enabled:false,
    guild_id:"",
    invites_per_reward:DEFAULT_INVITES_PER_REWARD,
    target_stock:DEFAULT_INVITE_CAMPAIGN_TARGET_STOCK,
    updated_at:now
  };
}

export async function saveInviteCampaignSettings(
  env:Env,
  input:{enabled?:unknown;guildId?:unknown;invitesPerReward?:unknown;targetStock?:unknown}
):Promise<InviteCampaignSettings>{
  const current=await getInviteCampaignSettings(env);
  const guildId=input.guildId===undefined
    ?current.guild_id
    :String(input.guildId??"").trim();
  if(guildId&&!/^\d{15,22}$/.test(guildId)){
    throw new Error("INVITE_CAMPAIGN_GUILD_ID_INVALID");
  }
  const invitesPerReward=input.invitesPerReward===undefined
    ?current.invites_per_reward
    :normalizePositiveInteger(input.invitesPerReward,0,1000);
  const targetStock=input.targetStock===undefined
    ?current.target_stock
    :normalizePositiveInteger(input.targetStock,0,10000);
  if(invitesPerReward<1) throw new Error("INVITES_PER_REWARD_INVALID");
  if(targetStock<1) throw new Error("INVITE_CAMPAIGN_TARGET_STOCK_INVALID");
  const enabled=input.enabled===undefined?current.enabled:Boolean(input.enabled);
  if(enabled&&!guildId) throw new Error("INVITE_CAMPAIGN_GUILD_REQUIRED");

  const now=Date.now();
  await env.DB.prepare(
    "INSERT INTO invite_campaign_settings"+
    "(id,enabled,guild_id,invites_per_reward,target_stock,updated_at) VALUES(1,?,?,?,?,?) "+
    "ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,guild_id=excluded.guild_id,"+
    "invites_per_reward=excluded.invites_per_reward,target_stock=excluded.target_stock,"+
    "updated_at=excluded.updated_at"
  ).bind(enabled?1:0,guildId,invitesPerReward,targetStock,now).run();
  return getInviteCampaignSettings(env);
}

export async function cacheInviteCampaignGuild(
  env:Env,
  guild:{id:string;name:string;icon?:string|null}
):Promise<void>{
  if(!guild.id||!guild.name) return;
  await ensureInviteCampaignSchema(env);
  await env.DB.prepare(
    "INSERT INTO invite_campaign_guilds(guild_id,name,icon,last_seen_at) VALUES(?,?,?,?) "+
    "ON CONFLICT(guild_id) DO UPDATE SET name=excluded.name,icon=excluded.icon,"+
    "last_seen_at=excluded.last_seen_at"
  ).bind(guild.id,guild.name,guild.icon??null,Date.now()).run();
}

export async function listInviteCampaignGuilds(env:Env){
  await ensureInviteCampaignSchema(env);
  return (await env.DB.prepare(
    "SELECT guild_id,name,icon,last_seen_at FROM invite_campaign_guilds "+
    "ORDER BY name COLLATE NOCASE"
  ).all()).results;
}

export async function markInviteCampaignGatewayReady(env:Env):Promise<void>{
  await ensureInviteCampaignSchema(env);
  const now=Date.now();
  await env.DB.prepare(
    "INSERT INTO invite_campaign_runtime(id,gateway_ready_at,last_event_at,last_error,updated_at) "+
    "VALUES(1,?,NULL,NULL,?) ON CONFLICT(id) DO UPDATE SET "+
    "gateway_ready_at=excluded.gateway_ready_at,last_error=NULL,updated_at=excluded.updated_at"
  ).bind(now,now).run();
}

export async function markInviteCampaignEvent(env:Env):Promise<void>{
  await ensureInviteCampaignSchema(env);
  const now=Date.now();
  await env.DB.prepare(
    "INSERT INTO invite_campaign_runtime(id,gateway_ready_at,last_event_at,last_error,updated_at) "+
    "VALUES(1,NULL,?,NULL,?) ON CONFLICT(id) DO UPDATE SET "+
    "last_event_at=excluded.last_event_at,last_error=NULL,updated_at=excluded.updated_at"
  ).bind(now,now).run();
}

export async function recordInviteCampaignRuntimeError(env:Env,error:unknown):Promise<void>{
  await ensureInviteCampaignSchema(env);
  const message=(error instanceof Error?error.message:String(error)).slice(0,500);
  const now=Date.now();
  await env.DB.prepare(
    "INSERT INTO invite_campaign_runtime(id,gateway_ready_at,last_event_at,last_error,updated_at) "+
    "VALUES(1,NULL,NULL,?,?) ON CONFLICT(id) DO UPDATE SET "+
    "last_error=excluded.last_error,updated_at=excluded.updated_at"
  ).bind(message,now).run();
}

export async function inviteCampaignStockCount(env:Env):Promise<number>{
  await Promise.all([
    ensureInviteCampaignSchema(env),
    ensureXSchema(env)
  ]);
  const row=await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM purchased_accounts "+
    "WHERE procurement_class='INVITE_CAMPAIGN' AND status='READY_FOR_DELIVERY'"
  ).first<{count:number}>();
  return Math.max(0,Number(row?.count??0));
}

export async function getInviteCampaignDashboard(env:Env){
  await ensureInviteCampaignSchema(env);
  const [settings,guilds,stock,runtime,progress,rewards]=await Promise.all([
    getInviteCampaignSettings(env),
    listInviteCampaignGuilds(env),
    inviteCampaignStockCount(env),
    env.DB.prepare(
      "SELECT gateway_ready_at,last_event_at,last_error,updated_at "+
      "FROM invite_campaign_runtime WHERE id=1"
    ).first<any>(),
    env.DB.prepare(
      "SELECT guild_id,inviter_user_id,valid_invites,excluded_invites,rewards_earned,updated_at "+
      "FROM invite_campaign_progress ORDER BY valid_invites DESC,updated_at DESC LIMIT 100"
    ).all<any>(),
    env.DB.prepare(
      "SELECT id,guild_id,inviter_user_id,ordinal,account_id,status,error,created_at,"+
      "updated_at,delivered_at FROM invite_campaign_rewards ORDER BY created_at DESC LIMIT 100"
    ).all<any>()
  ]);
  const unresolved=(rewards.results as any[]).filter(
    row=>String(row.status)!=="DELIVERED"
  ).length;
  return {
    settings,
    guilds,
    stock:{
      available:stock,
      target:settings.target_stock,
      deficit:Math.max(0,settings.target_stock-stock)
    },
    runtime:runtime??{
      gateway_ready_at:null,last_event_at:null,last_error:null,updated_at:null
    },
    progress:progress.results,
    rewards:rewards.results,
    unresolvedRewards:unresolved
  };
}
