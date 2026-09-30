import type { Env } from "./types";
import {
  cacheInviteCampaignGuild,
  getInviteCampaignSettings,
  markInviteCampaignGatewayReady,
  recordInviteCampaignRuntimeError
} from "./invite-campaign-db";
import {
  handleInviteCampaignMemberJoin,
  seedInviteCampaignSnapshot
} from "./invite-campaign";

type GatewayState={
  sessionId:string|null;
  sequence:number|null;
  resumeUrl:string|null;
  heartbeatInterval:number|null;
  lastHeartbeatSent:number|null;
  lastHeartbeatAck:number|null;
  reconnectAttempts:number;
};

type GatewayPayload={
  op:number;
  t?:string|null;
  s?:number|null;
  d?:unknown;
};

const STATE_KEY="invite_campaign_gateway_state";
const VERSION=10;
const INTENTS=(1<<0)|(1<<1);
const PLANNED_CLOSE=3001;

function initialState():GatewayState{
  return {
    sessionId:null,
    sequence:null,
    resumeUrl:null,
    heartbeatInterval:null,
    lastHeartbeatSent:null,
    lastHeartbeatAck:null,
    reconnectAttempts:0
  };
}

function websocketUrl(value:string){
  const url=new URL(value);
  if(url.protocol==="wss:") url.protocol="https:";
  if(url.protocol==="ws:") url.protocol="http:";
  url.searchParams.set("v",String(VERSION));
  url.searchParams.set("encoding","json");
  return url.toString();
}

function freshSessionClose(code:number){
  return code===4007||code===4009;
}

function fatalClose(code:number){
  return [4004,4010,4011,4012,4013,4014].includes(code);
}

export async function ensureInviteCampaignGateway(env:Env):Promise<void>{
  const settings=await getInviteCampaignSettings(env);
  if(!settings.enabled) return;
  if(!env.INVITE_GATEWAY){
    throw new Error("INVITE_GATEWAY_BINDING_NOT_CONFIGURED");
  }
  if(!env.DISCORD_BOT_TOKEN?.trim()){
    throw new Error("DISCORD_BOT_TOKEN_NOT_CONFIGURED");
  }
  const id=env.INVITE_GATEWAY.idFromName("invite-campaign");
  const response=await env.INVITE_GATEWAY.get(id).fetch(
    "https://invite-gateway.internal/start",
    {method:"POST"}
  );
  if(!response.ok){
    throw new Error(
      "INVITE_GATEWAY_START_FAILED:"+response.status+":"+
      (await response.text().catch(()=>"")).slice(0,300)
    );
  }
}

export async function stopInviteCampaignGateway(env:Env):Promise<void>{
  if(!env.INVITE_GATEWAY) return;
  const id=env.INVITE_GATEWAY.idFromName("invite-campaign");
  const response=await env.INVITE_GATEWAY.get(id).fetch(
    "https://invite-gateway.internal/stop",
    {method:"POST"}
  );
  if(!response.ok){
    throw new Error(
      "INVITE_GATEWAY_STOP_FAILED:"+response.status+":"+
      (await response.text().catch(()=>"")).slice(0,300)
    );
  }
}

export class InviteGateway{
  private socket:WebSocket|null=null;
  private plannedClose=false;
  private queue:Promise<void>=Promise.resolve();

  constructor(
    private readonly state:DurableObjectState,
    private readonly env:Env
  ){}

  async fetch(request:Request):Promise<Response>{
    const path=new URL(request.url).pathname;
    if(request.method!=="POST"){
      return new Response("Method Not Allowed",{status:405});
    }
    if(path==="/start"){
      if(!this.socket) await this.connect();
      return Response.json({ok:true});
    }
    if(path==="/stop"){
      await this.state.storage.deleteAlarm();
      if(this.socket){
        this.plannedClose=true;
        try{this.socket.close(1000,"invite campaign disabled");}catch{}
        this.socket=null;
      }
      await this.state.storage.delete(STATE_KEY);
      return Response.json({ok:true});
    }
    return new Response("Not Found",{status:404});
  }

  async alarm():Promise<void>{
    try{
      if(!this.socket){
        await this.connect();
        return;
      }
      const stored=await this.load();
      if(!stored.heartbeatInterval){
        await this.state.storage.setAlarm(Date.now()+5000);
        return;
      }
      if(
        stored.lastHeartbeatSent!==null&&
        (stored.lastHeartbeatAck===null||
          stored.lastHeartbeatAck<stored.lastHeartbeatSent)
      ){
        await this.scheduleReconnect(false);
        return;
      }
      this.heartbeat(stored);
      stored.lastHeartbeatSent=Date.now();
      await this.save(stored);
      await this.state.storage.setAlarm(
        Date.now()+Math.max(1000,stored.heartbeatInterval)
      );
    }catch(error){
      await recordInviteCampaignRuntimeError(this.env,error).catch(()=>undefined);
      await this.state.storage.setAlarm(Date.now()+15000);
    }
  }

  private async load():Promise<GatewayState>{
    return (await this.state.storage.get<GatewayState>(STATE_KEY))??initialState();
  }

  private save(value:GatewayState){
    return this.state.storage.put(STATE_KEY,value);
  }

  private async gatewayUrl():Promise<string>{
    const response=await fetch("https://discord.com/api/v10/gateway/bot",{
      headers:{Authorization:"Bot "+this.env.DISCORD_BOT_TOKEN}
    });
    if(!response.ok){
      throw new Error(
        "DISCORD_GATEWAY_URL_FAILED:"+response.status+":"+
        (await response.text()).slice(0,300)
      );
    }
    const data=await response.json() as {url?:string};
    if(!data.url) throw new Error("DISCORD_GATEWAY_URL_MISSING");
    return data.url;
  }

  private async connect():Promise<void>{
    if(this.socket) return;
    const stored=await this.load();
    const resume=Boolean(
      stored.sessionId&&stored.sequence!==null&&stored.resumeUrl
    );
    let base:string;
    try{
      base=resume?stored.resumeUrl!:await this.gatewayUrl();
    }catch(error){
      await recordInviteCampaignRuntimeError(this.env,error).catch(()=>undefined);
      const message=error instanceof Error?error.message:String(error);
      if(
        message.includes("DISCORD_GATEWAY_URL_FAILED:401")||
        message.includes("DISCORD_GATEWAY_URL_FAILED:403")
      ){
        await this.state.storage.deleteAlarm();
        return;
      }
      await this.scheduleReconnect(false);
      return;
    }

    let response:Response;
    try{
      response=await fetch(websocketUrl(base),{
        headers:{Upgrade:"websocket"}
      });
    }catch(error){
      await recordInviteCampaignRuntimeError(this.env,error).catch(()=>undefined);
      await this.scheduleReconnect(false);
      return;
    }
    if(!response.webSocket){
      await recordInviteCampaignRuntimeError(
        this.env,
        new Error("DISCORD_GATEWAY_WEBSOCKET_MISSING:"+response.status)
      ).catch(()=>undefined);
      await this.scheduleReconnect(false);
      return;
    }

    const socket=response.webSocket;
    socket.accept();
    this.socket=socket;
    this.plannedClose=false;

    socket.addEventListener("message",event=>{
      if(this.socket!==socket) return;
      this.queue=this.queue
        .then(()=>this.handleMessage(String(event.data)))
        .catch(error=>{
          console.error("invite gateway message failed",error);
          void recordInviteCampaignRuntimeError(this.env,error);
        });
    });

    socket.addEventListener("close",event=>{
      if(this.socket!==socket) return;
      this.socket=null;
      if(this.plannedClose){
        this.plannedClose=false;
        return;
      }
      if(fatalClose(event.code)){
        void (async()=>{
          await recordInviteCampaignRuntimeError(
            this.env,
            new Error(
              "DISCORD_GATEWAY_FATAL_CLOSE:"+event.code+":"+
              String(event.reason??"").slice(0,200)
            )
          ).catch(()=>undefined);
          await this.state.storage.deleteAlarm();
        })();
        return;
      }
      void this.scheduleReconnect(
        freshSessionClose(event.code)
      );
    });

    socket.addEventListener("error",()=>{
      if(this.socket!==socket) return;
      this.socket=null;
      if(this.plannedClose) return;
      void this.scheduleReconnect(false);
    });

    await this.state.storage.setAlarm(Date.now()+10000);
  }

  private async scheduleReconnect(
    clearSession:boolean,
    forcedDelay?:number
  ):Promise<void>{
    const stored=await this.load();
    stored.reconnectAttempts++;
    stored.heartbeatInterval=null;
    stored.lastHeartbeatSent=null;
    stored.lastHeartbeatAck=null;
    if(clearSession){
      stored.sessionId=null;
      stored.sequence=null;
      stored.resumeUrl=null;
    }
    await this.save(stored);

    if(this.socket){
      this.plannedClose=true;
      try{this.socket.close(PLANNED_CLOSE,"reconnect");}catch{}
      this.socket=null;
    }
    const delay=forcedDelay??
      Math.min(60000,1000*2**Math.min(stored.reconnectAttempts,5));
    await this.state.storage.setAlarm(Date.now()+delay);
  }

  private heartbeat(stored:GatewayState){
    if(!this.socket) return;
    this.socket.send(JSON.stringify({op:1,d:stored.sequence}));
  }

  private async identifyOrResume(stored:GatewayState){
    if(!this.socket) return;
    if(stored.sessionId&&stored.sequence!==null&&stored.resumeUrl){
      this.socket.send(JSON.stringify({
        op:6,
        d:{
          token:this.env.DISCORD_BOT_TOKEN,
          session_id:stored.sessionId,
          seq:stored.sequence
        }
      }));
      return;
    }
    this.socket.send(JSON.stringify({
      op:2,
      d:{
        token:this.env.DISCORD_BOT_TOKEN,
        intents:INTENTS,
        properties:{
          os:"cloudflare",
          browser:"shiire-invite-campaign",
          device:"shiire-invite-campaign"
        }
      }
    }));
  }

  private async handleMessage(raw:string){
    let payload:GatewayPayload;
    try{payload=JSON.parse(raw) as GatewayPayload;}
    catch{return;}

    const stored=await this.load();
    if(payload.s!==undefined&&payload.s!==null){
      stored.sequence=payload.s;
      await this.save(stored);
    }

    if(payload.op===10){
      const hello=payload.d as {heartbeat_interval?:number};
      if(!hello?.heartbeat_interval){
        await this.scheduleReconnect(false);
        return;
      }
      stored.heartbeatInterval=hello.heartbeat_interval;
      stored.lastHeartbeatAck=Date.now();
      stored.lastHeartbeatSent=null;
      await this.save(stored);
      await this.identifyOrResume(stored);
      await this.state.storage.setAlarm(
        Date.now()+Math.max(1000,Math.floor(hello.heartbeat_interval*Math.random()))
      );
      return;
    }
    if(payload.op===11){
      stored.lastHeartbeatAck=Date.now();
      await this.save(stored);
      return;
    }
    if(payload.op===1){
      this.heartbeat(stored);
      return;
    }
    if(payload.op===7){
      await this.scheduleReconnect(false,1000);
      return;
    }
    if(payload.op===9){
      await this.scheduleReconnect(payload.d!==true,1000+Math.random()*4000);
      return;
    }
    if(payload.op===0){
      await this.handleDispatch(payload,stored);
    }
  }

  private async handleDispatch(
    payload:GatewayPayload,
    stored:GatewayState
  ):Promise<void>{
    if(payload.t==="READY"){
      const ready=payload.d as {
        session_id?:string;
        resume_gateway_url?:string;
      };
      stored.sessionId=ready.session_id??null;
      stored.resumeUrl=ready.resume_gateway_url??stored.resumeUrl;
      stored.reconnectAttempts=0;
      await this.save(stored);
      await markInviteCampaignGatewayReady(this.env);
      const settings=await getInviteCampaignSettings(this.env);
      if(settings.enabled&&settings.guild_id){
        await seedInviteCampaignSnapshot(this.env,settings.guild_id)
          .catch(error=>recordInviteCampaignRuntimeError(this.env,error));
      }
      return;
    }

    if(payload.t==="RESUMED"){
      stored.reconnectAttempts=0;
      await this.save(stored);
      await markInviteCampaignGatewayReady(this.env);
      return;
    }

    if(payload.t==="GUILD_CREATE"){
      const guild=payload.d as {
        id?:string;
        name?:string;
        icon?:string|null;
      };
      if(guild.id&&guild.name){
        await cacheInviteCampaignGuild(this.env,{
          id:guild.id,
          name:guild.name,
          icon:guild.icon??null
        });
      }
      const settings=await getInviteCampaignSettings(this.env);
      if(guild.id&&settings.enabled&&settings.guild_id===guild.id){
        await seedInviteCampaignSnapshot(this.env,guild.id)
          .catch(error=>recordInviteCampaignRuntimeError(this.env,error));
      }
      return;
    }

    if(payload.t==="GUILD_MEMBER_ADD"){
      await handleInviteCampaignMemberJoin(
        this.env,
        payload.d as import("./invite-campaign").InviteCampaignMemberEvent
      );
    }
  }
}
