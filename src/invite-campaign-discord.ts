import type { Env } from "./types";

export type DiscordInviteSnapshot={
  code:string;
  uses?:number;
  max_uses?:number;
  expires_at?:string|null;
  channel?:{id?:string}|null;
  inviter?:{id?:string}|null;
};

export class InviteCampaignDiscordError extends Error{
  constructor(
    public status:number,
    message:string,
    public responseBody:string
  ){
    super(message);
  }
}

function token(env:Env){
  const value=env.DISCORD_BOT_TOKEN?.trim()??"";
  if(!value) throw new Error("DISCORD_BOT_NOT_CONFIGURED");
  return value;
}

export async function inviteDiscordJson<T>(
  env:Env,
  path:string,
  init:RequestInit={}
):Promise<T>{
  const headers=new Headers(init.headers);
  headers.set("Authorization","Bot "+token(env));
  if(typeof init.body==="string"&&!headers.has("Content-Type")){
    headers.set("Content-Type","application/json");
  }
  const response=await fetch("https://discord.com/api/v10"+path,{...init,headers});
  if(!response.ok){
    const body=await response.text().catch(()=>"");
    throw new InviteCampaignDiscordError(
      response.status,
      "DISCORD_API_"+response.status+":"+body.slice(0,300),
      body
    );
  }
  if(response.status===204) return {} as T;
  return await response.json() as T;
}

export function fetchDiscordGuildInvites(env:Env,guildId:string){
  return inviteDiscordJson<DiscordInviteSnapshot[]>(
    env,
    "/guilds/"+encodeURIComponent(guildId)+"/invites"
  );
}

export async function sendInviteCampaignDm(
  env:Env,
  userId:string,
  payload:unknown
):Promise<{id?:string}>{
  const channel=await inviteDiscordJson<{id:string}>(
    env,
    "/users/@me/channels",
    {
      method:"POST",
      body:JSON.stringify({recipient_id:userId})
    }
  );
  if(!channel.id) throw new Error("DISCORD_DM_CHANNEL_MISSING");
  return inviteDiscordJson<{id?:string}>(
    env,
    "/channels/"+encodeURIComponent(channel.id)+"/messages",
    {
      method:"POST",
      body:JSON.stringify(payload)
    }
  );
}
