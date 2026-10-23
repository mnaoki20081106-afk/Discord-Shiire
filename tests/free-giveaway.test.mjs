import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

const guild='123456789012345678',channel='223456789012345678',secret='fixture-giveaway-secret-longer-than-32-characters';
const encryptionKey=Buffer.alloc(32,9).toString('base64');
const bundle=await build({stdin:{contents:`import {handleShiireMainBridge} from './src/shiire-vending';
import {handleFreeGiveawayInteraction} from './src/free-giveaway';
export default {async fetch(request,env){try{
 const url=new URL(request.url);
 if(url.pathname==='/interaction'){
  // waitUntil work must finish inside the same request here: workerd does not allow
  // awaiting a promise created by another request. The response is already built, so
  // this only makes the test deterministic.
  const pending=[];
  const ctx={waitUntil(promise){pending.push(promise);}};
  const response=await handleFreeGiveawayInteraction(await request.json(),env,ctx);
  await Promise.all(pending);
  return response??new Response('not-handled',{status:404});
 }
 return await handleShiireMainBridge(request,env,url)??new Response('missing',{status:404});
}catch(error){return Response.json({message:error.message},{status:error.status??500});}}};`,resolveDir:process.cwd(),sourcefile:'free-giveaway-fixture.ts'},bundle:true,write:false,format:'esm',platform:'browser'});

async function fixture(t){
 const state={dms:[],edits:[],panels:[],failDm:false};
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],
  bindings:{SHIIRE_BRIDGE_SECRET:secret,CREDENTIALS_ENCRYPTION_KEY:encryptionKey,DISCORD_BOT_TOKEN:'fixture'},
  outboundService:async request=>{
   const url=new URL(request.url);
   assert.equal(url.hostname,'discord.com');
   if(url.pathname==='/api/v10/users/@me/channels') return Response.json({id:'dm-'+(await request.json()).recipient_id});
   const dmMatch=url.pathname.match(/^\/api\/v10\/channels\/dm-(\d+)\/messages$/);
   if(dmMatch){
    if(state.failDm) return new Response(JSON.stringify({code:50007,message:'Cannot send messages to this user'}),{status:403});
    state.dms.push({userId:dmMatch[1],payload:await request.json()});
    return Response.json({id:'dm-message'});
   }
   if(url.pathname==='/api/v10/channels/'+channel&&request.method==='GET') return Response.json({id:channel,guild_id:guild});
   if(url.pathname==='/api/v10/channels/'+channel+'/messages'){
    state.panels.push(await request.json());
    return Response.json({id:'panel-message'});
   }
   if(url.pathname.endsWith('/messages/@original')&&request.method==='PATCH'){
    state.edits.push((await request.json()).content);
    return Response.json({});
   }
   return Response.json({message:'unexpected '+request.method+' '+url.pathname},{status:404});
  }});
 t.after(()=>mf.dispose());
 const bridge=async(suffix,method='GET',payload)=>{
  const path='/bridge/main/guilds/'+guild+suffix,body=payload?JSON.stringify(payload):'',timestamp=String(Date.now()),nonce=randomUUID();
  const signature=createHmac('sha256',secret).update([timestamp,nonce,method,path,body].join('\n')).digest('hex');
  return mf.dispatchFetch('https://fixture.example'+path,{method,body:body||undefined,headers:{'X-Shiire-Timestamp':timestamp,'X-Shiire-Nonce':nonce,'X-Shiire-Signature':signature}});
 };
 const press=(userId,extra={})=>mf.dispatchFetch('https://fixture.example/interaction',{method:'POST',body:JSON.stringify({
  type:3,application_id:'app1',token:'tok-'+userId,guild_id:guild,data:{custom_id:'fgv:claim'},member:{user:{id:userId}},...extra})});
 const flush=async()=>{};
 const addStock=(pool,items)=>bridge('/generator/pools/'+pool+'/stock','POST',{items});
 const stock=async pool=>(await (await bridge('/generator/pools/'+pool+'/stock')).json()).stockCount;
 const overview=async()=>(await bridge('/free-giveaway')).json();
 const db=await mf.getD1Database('DB');
 const audit=async()=>(await db.prepare("SELECT message,details_json FROM audit_logs WHERE kind='FREE_GIVEAWAY_CLAIM' ORDER BY created_at").all()).results.map(r=>({message:r.message,...JSON.parse(r.details_json)}));
 return {state,bridge,press,flush,addStock,stock,overview,db,audit};
}

test('pools are filled independently and unknown pool names are rejected',async t=>{
 const {bridge,addStock,stock}=await fixture(t);
 assert.equal(await stock('free-giveaway'),0);
 const added=await (await addStock('free-giveaway',['a:pw|a@x.test','b:pw|b@x.test','a:pw|a@x.test'])).json();
 assert.equal(added.submitted,2);
 assert.equal(added.added,2);
 assert.equal(await stock('free-giveaway'),2);
 assert.equal(await stock('invite-campaign'),0,'the invite pool is separate');
 assert.equal((await (await addStock('invite-campaign',['c:pw','a:pw|a@x.test'])).json()).added,1,'a credential already stored anywhere is not duplicated');
 assert.equal(await stock('invite-campaign'),1);
 for(const name of ['nope','constructor','__proto__','toString']){
  assert.equal((await bridge('/generator/pools/'+name+'/stock')).status,404,name);
 }
 assert.equal((await addStock('free-giveaway',[])).status,400);
 assert.equal((await bridge('/generator/pools/free-giveaway/stock','POST',{items:Array.from({length:501},(_,i)=>'u'+i)})).status,400);
});

test('each Discord account gets exactly one free account, delivered by DM',async t=>{
 const {state,press,flush,addStock,stock,bridge,overview}=await fixture(t);
 await addStock('free-giveaway',['a:pw|a@x.test','b:pw|b@x.test']);

 let reply=await press('1001');
 assert.equal(reply.status,200);
 assert.equal((await reply.json()).type,5,'acknowledged immediately');
 await flush();
 assert.match(state.edits.at(-1),/配布は行っていません/,'disabled by default');
 assert.equal(state.dms.length,0);
 assert.equal(await stock('free-giveaway'),2);

 assert.equal((await bridge('/free-giveaway/settings','POST',{enabled:'yes'})).status,400);
 assert.equal((await (await bridge('/free-giveaway/settings','POST',{enabled:true})).json()).enabled,true);

 await press('1001');await flush();
 assert.equal(state.dms.length,1);
 assert.equal(state.dms[0].userId,'1001');
 assert.match(state.dms[0].payload.embeds[0].description,/([ab]):pw\|\1@x\.test/,'credentials are decrypted for delivery');
 assert.match(state.edits.at(-1),/DMに送りました/);
 assert.equal(await stock('free-giveaway'),1);

 await press('1001');await flush();
 assert.equal(state.dms.length,1,'second press must not send another account');
 assert.match(state.edits.at(-1),/1個まで/);
 assert.equal(await stock('free-giveaway'),1);

 await press('1002');await flush();
 assert.equal(state.dms.length,2);
 assert.notEqual(state.dms[1].payload.embeds[0].description,state.dms[0].payload.embeds[0].description,'each claimant gets a different account');
 assert.equal(await stock('free-giveaway'),0);

 const data=await overview();
 assert.equal(data.enabled,true);
 assert.equal(data.claims.DELIVERED,2);
 assert.equal(data.reservedCount,0);
 assert.equal(data.recent.length,2);
});

test('pressing twice at once reserves one account only',async t=>{
 const {state,press,flush,addStock,stock,bridge}=await fixture(t);
 await bridge('/free-giveaway/settings','POST',{enabled:true});
 await addStock('free-giveaway',['a:pw','b:pw','c:pw']);
 await Promise.all([press('2001'),press('2001'),press('2001')]);
 await flush();
 assert.equal(state.dms.length,1);
 assert.equal(await stock('free-giveaway'),2,'exactly one account consumed');
});

test('an empty pool waits for stock and the same user can claim once it arrives',async t=>{
 const {state,press,flush,addStock,bridge,overview}=await fixture(t);
 await bridge('/free-giveaway/settings','POST',{enabled:true});
 await addStock('invite-campaign',['inv:pw']);
 await press('3001');await flush();
 assert.match(state.edits.at(-1),/在庫切れ/);
 assert.equal(state.dms.length,0,'the invite pool must never feed the giveaway');
 assert.equal((await overview()).claims.WAITING_STOCK,1);

 await addStock('free-giveaway',['g:pw|g@x.test']);
 await press('3001');await flush();
 assert.equal(state.dms.length,1);
 assert.match(state.dms[0].payload.embeds[0].description,/g:pw/);
 assert.equal((await overview()).claims.DELIVERED,1);
});

test('a refused DM releases the account and lets the user retry',async t=>{
 const {state,press,flush,addStock,stock,bridge,overview}=await fixture(t);
 await bridge('/free-giveaway/settings','POST',{enabled:true});
 await addStock('free-giveaway',['a:pw']);

 state.failDm=true;
 await press('4001');await flush();
 assert.match(state.edits.at(-1),/DMを送れませんでした/);
 assert.equal(await stock('free-giveaway'),1,'the account is back in stock');
 assert.equal((await overview()).claims.DM_FAILED,1);

 state.failDm=false;
 await press('4001');await flush();
 assert.equal(state.dms.length,1);
 assert.equal(await stock('free-giveaway'),0);
 assert.equal((await overview()).claims.DELIVERED,1);
});

test('the panel is posted with the claim button and only to a channel of this guild',async t=>{
 const {state,bridge,press}=await fixture(t);
 const posted=await bridge('/free-giveaway/panel','POST',{channelId:channel});
 assert.equal(posted.status,200,await posted.clone().text());
 assert.equal(state.panels[0].components[0].components[0].custom_id,'fgv:claim');
 assert.equal((await bridge('/free-giveaway/panel','POST',{})).status,400);
 // Interactions that are not ours are ignored.
 const other=await press('5001',{data:{custom_id:'svm:buy:x'}});
 assert.equal(other.status,404);
});

test('blocked users cannot claim, and unblocking restores access',async t=>{
 const {state,bridge,press,addStock,stock,overview}=await fixture(t);
 await bridge('/free-giveaway/settings','POST',{enabled:true});
 await addStock('free-giveaway',['a:pw','b:pw']);

 assert.equal((await bridge('/free-giveaway/blocklist','POST',{userId:'abc'})).status,400);
 const blocked=await (await bridge('/free-giveaway/blocklist','POST',{userId:'6001234567890123',reason:'alt farm'})).json();
 assert.equal(blocked.blocked[0].user_id,'6001234567890123');
 assert.equal(blocked.blocked[0].reason,'alt farm');

 await press('6001234567890123');
 assert.match(state.edits.at(-1),/受け取りできません/);
 assert.equal(state.dms.length,0);
 assert.equal(await stock('free-giveaway'),2,'no account is reserved for a blocked user');
 assert.equal(Object.keys((await overview()).claims).length,0,'blocked presses create no claim');

 assert.equal((await bridge('/free-giveaway/blocklist/6001234567890123','DELETE')).status,200);
 assert.equal((await bridge('/free-giveaway/blocklist/6001234567890123','DELETE')).status,404);
 await press('6001234567890123');
 assert.equal(state.dms.length,1);
});

test('members who skipped membership screening or are timed out do not get an account',async t=>{
 const {state,bridge,press,addStock,stock,overview}=await fixture(t);
 await bridge('/free-giveaway/settings','POST',{enabled:true});
 await addStock('free-giveaway',['a:pw']);

 await press('7001',{member:{user:{id:'7001'},pending:true}});
 assert.match(state.edits.at(-1),/メンバー認証/);
 const future=new Date(Date.now()+3600_000).toISOString();
 await press('7002',{member:{user:{id:'7002'},communication_disabled_until:future}});
 assert.match(state.edits.at(-1),/受け取りできません/);
 await press('7003',{member:{user:{id:'7003'},communication_disabled_until:new Date(Date.now()-3600_000).toISOString()}});
 assert.equal(state.dms.length,1,'an expired timeout no longer blocks');
 assert.equal(state.dms[0].userId,'7003');
 assert.equal(await stock('free-giveaway'),0);
 assert.deepEqual(Object.keys((await overview()).claims),['DELIVERED']);
});

test('a burst of claims is throttled, and it never blocks people who already have an account',async t=>{
 const {state,bridge,press,addStock,db,overview}=await fixture(t);
 await bridge('/free-giveaway/settings','POST',{enabled:true});
 assert.equal((await bridge('/free-giveaway/settings','POST',{burstLimit:-1})).status,400);
 assert.equal((await bridge('/free-giveaway/settings','POST',{burstLimit:1.5})).status,400);
 assert.equal((await bridge('/free-giveaway/settings','POST',{})).status,400);
 assert.equal((await (await bridge('/free-giveaway/settings','POST',{burstLimit:2})).json()).burstLimit,2);
 await addStock('free-giveaway',['a:pw','b:pw','c:pw','d:pw']);

 await press('8001');await press('8002');
 assert.equal(state.dms.length,2);
 await press('8003');
 assert.match(state.edits.at(-1),/集中しています/);
 assert.equal(state.dms.length,2);
 await press('8001');
 assert.match(state.edits.at(-1),/1個まで/,'a person who already claimed is told so, not "busy"');

 // Once the window has passed, claims flow again.
 await db.prepare('UPDATE free_giveaway_claims SET delivered_at=delivered_at-1200000').run();
 await press('8003');
 assert.equal(state.dms.length,3);
 assert.equal((await overview()).burstLimit,2);

 // 0 turns the throttle off.
 await bridge('/free-giveaway/settings','POST',{burstLimit:0});
 await press('8004');await press('8005');
 assert.equal(state.dms.length,4,'the pool had one account left');
});

test('every press is logged and repeat attempts are counted',async t=>{
 const {state,bridge,press,addStock,overview,audit}=await fixture(t);
 await bridge('/free-giveaway/settings','POST',{enabled:true});
 await addStock('free-giveaway',['a:pw']);
 await press('9001');
 await press('9001');
 await press('9001');
 await bridge('/free-giveaway/blocklist','POST',{userId:'90021234567890123'});
 await press('90021234567890123');

 const log=await audit();
 assert.deepEqual(log.map(entry=>entry.userId+':'+entry.outcome),['9001:DELIVERED','9001:ALREADY_CLAIMED','9001:ALREADY_CLAIMED','90021234567890123:BLOCKED']);
 const data=await overview();
 assert.equal(data.recent.find(row=>row.user_id==='9001').attempts,3);
 assert.equal(state.dms.length,1);
 assert.doesNotMatch(JSON.stringify(log),/pw/,'credentials are never written to the log');
});
