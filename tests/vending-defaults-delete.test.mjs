import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

const guild='123456789012345678',secret='fixture-vending-secret-longer-than-32-characters';
const bundle=await build({stdin:{contents:`import {handleShiireMainBridge} from './src/shiire-vending';
import {reserveShiireOrder} from './src/shiire-vending-db';
export default {async fetch(request,env){try{
 if(new URL(request.url).pathname==='/stale-reservation')return Response.json(await reserveShiireOrder(env,await request.json()));
 return await handleShiireMainBridge(request,env,new URL(request.url))??new Response('missing',{status:404});
}catch(error){return Response.json({message:error.message},{status:error.status??500});}}};`,resolveDir:process.cwd(),sourcefile:'vending-default-fixture.ts'},bundle:true,write:false,format:'esm',platform:'browser'});
async function fixture(t,legacy=false){
 const discordDeletes=[],discordUpdates=[];
 let failDiscordPatch=false;
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{SHIIRE_BRIDGE_SECRET:secret,DISCORD_BOT_TOKEN:'fixture'},outboundService:async request=>{
  assert.equal(new URL(request.url).hostname,'discord.com');
  if(request.method==='DELETE')discordDeletes.push(request.url);
  if(request.method==='PATCH'){
   discordUpdates.push(await request.json());
   if(failDiscordPatch)return new Response('fixture panel refresh failure',{status:500});
  }
  return request.method==='DELETE'?new Response(null,{status:204}):Response.json({id:'fixture-message'});
 }});t.after(()=>mf.dispose());
 const db=await mf.getD1Database('DB');
 if(legacy) await db.prepare('CREATE TABLE shiire_vending_machines (id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,name TEXT NOT NULL,public_log_channel_id TEXT,private_log_channel_id TEXT,role_id TEXT,panel_title TEXT,panel_description TEXT,panel_image_url TEXT,panel_image_mime TEXT,panel_image_base64 TEXT,active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)').run();
 const call=async(suffix,method='GET',payload)=>{
  const path='/bridge/main/guilds/'+guild+suffix,body=payload?JSON.stringify(payload):'',timestamp=String(Date.now()),nonce=randomUUID();
  const signature=createHmac('sha256',secret).update([timestamp,nonce,method,path,body].join('\n')).digest('hex');
  return mf.dispatchFetch('https://fixture.example'+path,{method,body:body||undefined,headers:{'X-Shiire-Timestamp':timestamp,'X-Shiire-Nonce':nonce,'X-Shiire-Signature':signature}});
 };
 const created=await call('/vending','POST',{name:'Fixture vending'});assert.equal(created.status,201,await created.clone().text());
 const machine=await created.json();
 return {
  mf,call,machine,db,discordDeletes,discordUpdates,
  setFailDiscordPatch(value){failDiscordPatch=Boolean(value);}
 };
}
test('new machine has two independent class products and default seeding preserves edited prices',async t=>{
 const {call,machine,db}=await fixture(t);
 const first=await (await call('/vending')).json();
 assert.equal(first[0].products.length,2);
 assert.deepEqual(new Set(first[0].products.map(p=>p.procurement_class)),new Set(['TOP_SEARCH','NO_SHADOWBAN']));
 const shadow=first[0].products.find(p=>p.procurement_class==='NO_SHADOWBAN');
 assert.equal(shadow.stock_count,0);
 await db.prepare('UPDATE shiire_vending_products SET price_paypay=150,name=? WHERE id=?').bind('Custom sale name',shadow.id).run();
 const replies=await Promise.all([call('/vending'),call('/vending')]);
 for(const reply of replies){const data=await reply.json();assert.equal(data[0].products.length,2);assert.equal(data[0].products.find(p=>p.id===shadow.id).price_paypay,150);}
 await db.prepare('UPDATE shiire_vending_products SET active=0 WHERE id=?').bind(shadow.id).run();
 assert.equal((await (await call('/vending/'+machine.id)).json()).products.length,1,'explicit deletion must not be undone by defaults');
});
test('legacy one-product machine gets only the missing class',async t=>{
 const {call,machine,db}=await fixture(t);
 await db.prepare("DELETE FROM shiire_vending_products WHERE vending_machine_id=? AND procurement_class='TOP_SEARCH'").bind(machine.id).run();
 await db.prepare("UPDATE shiire_vending_products SET name='Existing',price_paypay=175 WHERE vending_machine_id=?").bind(machine.id).run();
 const data=await (await call('/vending/'+machine.id)).json();
 assert.equal(data.products.length,2);
 assert.equal(data.products.find(p=>p.procurement_class==='NO_SHADOWBAN').price_paypay,175);
 assert.equal(data.products.find(p=>p.procurement_class==='NO_SHADOWBAN').name,'Existing');
});
test('deleting machine removes panels, preserves inventory/history, and rejects stale purchase',async t=>{
 const {call,machine,db,mf,discordDeletes}=await fixture(t);
 const before=await (await call('/vending/'+machine.id)).json();
 await db.prepare("INSERT INTO shiire_vending_panels(vending_machine_id,guild_id,channel_id,message_id,created_at,updated_at) VALUES (?, ?, 'channel', 'message',1,1)").bind(machine.id,guild).run();
 await db.prepare("INSERT INTO purchased_accounts(id,supplier,supplier_product_id,purchase_order_id,purchase_price,purchased_at,credentials_ciphertext,credential_fingerprint,status,created_at) VALUES ('stock','hstora','1','po',1,1,'{}','stock-fingerprint','READY_FOR_DELIVERY',1)").run();
 const deleted=await call('/vending/'+machine.id,'DELETE');assert.equal(deleted.status,200);assert.deepEqual((await deleted.json()).panelErrors,[]);
 assert.equal((await (await call('/vending')).json()).length,0);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM shiire_vending_panels').first()).n,0);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM purchased_accounts').first()).n,1);
 assert.equal(discordDeletes.length,1);
 const stale=await mf.dispatchFetch('https://fixture.example/stale-reservation',{method:'POST',body:JSON.stringify({machine,product:before.products[0],guildId:guild,userId:'user',method:'paypay',quantity:1,discount:0})});
 assert.equal(stale.status,500);assert.match(await stale.text(),/VENDING_MACHINE_NOT_AVAILABLE/);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM shiire_vending_orders').first()).n,0);
});
for(const status of ['reserving','awaiting_payment','payment_pending','paid','delivering','delivery_sent'])test('deletion is blocked during '+status,async t=>{
 const {call,machine,db,discordDeletes}=await fixture(t);
 const product=(await db.prepare('SELECT id FROM shiire_vending_products LIMIT 1').first()).id;
 await db.prepare('INSERT INTO shiire_vending_orders(id,vending_machine_id,product_id,guild_id,user_id,payment_method,quantity,unit_price,total_amount,status,reserved_until,created_at,updated_at) VALUES (?,?,?,?,?,?,1,100,100,?,?,?,?)').bind('order',machine.id,product,guild,'user','paypay',status,Date.now()+60000,Date.now(),Date.now()).run();
 const response=await call('/vending/'+machine.id,'DELETE');assert.equal(response.status,409,await response.clone().text());
 assert.equal((await db.prepare('SELECT active FROM shiire_vending_machines WHERE id=?').bind(machine.id).first()).active,1);
 assert.equal(discordDeletes.length,0);
});

test('product edits report partial failure when Discord panel refresh fails',async t=>{
 const {call,machine,db,setFailDiscordPatch,discordUpdates}=await fixture(t);
 const data=await (await call('/vending/'+machine.id)).json();
 const product=data.products[0];
 await db.prepare("INSERT INTO shiire_vending_panels(vending_machine_id,guild_id,channel_id,message_id,created_at,updated_at) VALUES (?, ?, 'channel', 'message',1,1)").bind(machine.id,guild).run();
 setFailDiscordPatch(true);
 const response=await call('/vending/'+machine.id+'/products/'+product.id,'PATCH',{name:'Updated sale name'});
 assert.equal(response.status,502,await response.clone().text());
 const body=await response.json();
 assert.equal(body.ok,false);
 assert.equal(body.saved,true);
 assert.equal(body.panelRefreshOk,false);
 assert.equal(body.error,'VENDING_PANEL_REFRESH_FAILED');
 assert.match(body.message,/保存されましたが.*反映に失敗/);
 assert.ok(discordUpdates.length>=1,'Discord panel refresh must be attempted');
 const saved=await (await call('/vending/'+machine.id)).json();
 assert.equal(saved.products.find(p=>p.id===product.id).name,'Updated sale name','DB edit must remain saved');
});

test('machine edits report partial failure when Discord panel refresh fails',async t=>{
 const {call,machine,db,setFailDiscordPatch,discordUpdates}=await fixture(t);
 await db.prepare("INSERT INTO shiire_vending_panels(vending_machine_id,guild_id,channel_id,message_id,created_at,updated_at) VALUES (?, ?, 'channel', 'message',1,1)").bind(machine.id,guild).run();
 setFailDiscordPatch(true);
 const response=await call('/vending/'+machine.id,'PATCH',{panelTitle:'Saved but not refreshed'});
 assert.equal(response.status,502,await response.clone().text());
 const body=await response.json();
 assert.equal(body.ok,false);
 assert.equal(body.saved,true);
 assert.equal(body.panelRefreshOk,false);
 assert.equal(body.error,'VENDING_PANEL_REFRESH_FAILED');
 assert.match(body.message,/保存されましたが.*反映に失敗/);
 assert.ok(discordUpdates.length>=1,'Discord panel refresh must be attempted');
 const saved=await (await call('/vending/'+machine.id)).json();
 assert.equal(saved.panel_title,'Saved but not refreshed','machine edit must remain saved');
});

test('legacy database migrates panel color, persists changes and refreshes tracked Discord messages',async t=>{
 const {call,machine,db,discordUpdates}=await fixture(t,true);
 assert.equal(machine.panel_color,5763719);
 assert.equal((await (await call('/status')).json()).panelFormat,'price-code-block-v1');
 await db.prepare("INSERT INTO shiire_vending_panels(vending_machine_id,guild_id,channel_id,message_id,created_at,updated_at) VALUES (?, ?, 'channel', 'message',1,1)").bind(machine.id,guild).run();
 for(const color of [0xff3366,0,0xffffff]){
  const response=await call('/vending/'+machine.id,'PATCH',{panelColor:color});
  assert.equal(response.status,200,await response.clone().text());
  assert.equal((await (await call('/vending/'+machine.id)).json()).panel_color,color);
  assert.equal(discordUpdates.at(-1).embeds[0].color,color);
  assert.match(discordUpdates.at(-1).embeds[0].description,/```\nPayPay:[\s\S]*?\n```/);
 }
 await call('/vending/'+machine.id,'PATCH',{panelTitle:'Color persists'});
 assert.equal((await (await call('/vending/'+machine.id)).json()).panel_color,0xffffff);
 const count=discordUpdates.length;
 for(const color of [-1,0x1000000,0.5,null,true,'#ff3366']){
  const response=await call('/vending/'+machine.id,'PATCH',{name:'Must not save',panelColor:color});
  assert.equal(response.status,400);
  assert.match(await response.text(),/INVALID_PANEL_COLOR/);
 }
 const saved=await (await call('/vending/'+machine.id)).json();
 assert.equal(saved.panel_color,0xffffff);assert.equal(saved.name,'Fixture vending');
 assert.equal(discordUpdates.length,count,'invalid colors must not update Discord');
});
