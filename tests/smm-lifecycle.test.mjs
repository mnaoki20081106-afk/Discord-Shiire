import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

const bundle=await build({stdin:{contents:`
import {ensureSmmSchema,saveSmmSettings,createSmmMachine,defaultMachineTexts,createSmmProduct,createSmmOrder,markSmmPaid,getSmmOrder,attachSmmPaymentLink,loadSmmServices} from './src/smm-db';
import {placeSmmOrder,processSmmPayment,trackSmmOrders,smmSweep,smmAdminAction} from './src/smm-orders';
import {handleSmmBridge} from './src/smm-bridge';
import {handleSmmInteraction} from './src/smm-vending';
export default {async fetch(req,env){
 const u=new URL(req.url);const q=u.searchParams;
 if(u.pathname==='/init'){
  await ensureSmmSchema(env);
  await saveSmmSettings(env,'1',{paused:0,min_margin_percent:0,private_log_channel_id:'123456789012345678'});
  const machine=await createSmmMachine(env,'1',{sns:'x',...defaultMachineTexts('x'),name:'X',panel_image_url:null});
  const p=await createSmmProduct(env,'1',{machine_id:machine.id,name:'X Followers',description:'',emoji:null,service_id:'101',service_name:'X Followers',service_category:'X',markup_percent:30,fee_jpy:0,min_qty:10,max_qty:0,link_kind:'x_profile',active:true});
  return Response.json({productId:p.id,machineId:machine.id});
 }
 if(u.pathname==='/legacy-init'){
  for(const sql of [
   "CREATE TABLE smm_settings (guild_id TEXT PRIMARY KEY,panel_title TEXT NOT NULL,panel_description TEXT NOT NULL,panel_color INTEGER NOT NULL,panel_image_url TEXT,public_log_channel_id TEXT,private_log_channel_id TEXT,paused INTEGER NOT NULL DEFAULT 0,min_margin_percent REAL NOT NULL DEFAULT 0,max_open_orders_per_user INTEGER NOT NULL DEFAULT 5,min_supplier_balance_jpy INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)",
   "CREATE TABLE smm_products (id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',emoji TEXT,service_id TEXT NOT NULL,service_name TEXT NOT NULL DEFAULT '',service_category TEXT NOT NULL DEFAULT '',markup_percent REAL NOT NULL DEFAULT 30,fee_jpy INTEGER NOT NULL DEFAULT 0,min_qty INTEGER NOT NULL DEFAULT 1,max_qty INTEGER NOT NULL DEFAULT 0,link_kind TEXT NOT NULL DEFAULT 'url',active INTEGER NOT NULL DEFAULT 1,sales_count INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
   "CREATE TABLE smm_panels (guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,message_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(guild_id,channel_id,message_id))",
   "INSERT INTO smm_settings VALUES ('1','Old title','Old description',255,NULL,NULL,'123456789012345678',0,15,7,500,1)",
   "INSERT INTO smm_products(id,guild_id,name,service_id,link_kind,created_at,updated_at) VALUES ('legacy-p','1','Legacy followers','101','x_profile',1,1)",
   "INSERT INTO smm_panels VALUES ('1','555555555555555555','666666666666666666',1,1)"
  ]) await env.DB.prepare(sql).run();
  await ensureSmmSchema(env);
  return Response.json({ok:true});
 }
 if(u.pathname==='/order'){
  const product=await env.DB.prepare('SELECT * FROM smm_products LIMIT 1').first();
  const order=await createSmmOrder(env,{guildId:'1',userId:'2',product,link:'https://x.com/target',quantity:Number(q.get('qty')??1000),rateSnapshot:500,total:Number(q.get('total')??650)});
  if(q.get('paid')==='1') await markSmmPaid(env,order);
  return Response.json(await getSmmOrder(env,order.id));
 }
 if(u.pathname==='/interact'){
  const pending=[];
  const res=await handleSmmInteraction(await req.json(),env,{waitUntil:p=>pending.push(p)});
  await Promise.all(pending);
  return res?Response.json(await res.json()):Response.json({unhandled:true});
 }
 if(u.pathname==='/get') return Response.json(await getSmmOrder(env,q.get('id')));
 if(u.pathname==='/place') return Response.json({result:await placeSmmOrder(env,q.get('id'))});
 if(u.pathname==='/place-twice'){const r=await Promise.all([placeSmmOrder(env,q.get('id')),placeSmmOrder(env,q.get('id'))]);return Response.json({results:r});}
 if(u.pathname==='/pay'){await attachSmmPaymentLink(env,q.get('id'),q.get('link'));const o=await getSmmOrder(env,q.get('id'));try{return Response.json(await processSmmPayment(env,o,q.get('link')));}catch(e){return Response.json({thrown:String(e.message)});}}
 if(u.pathname==='/pay-twice'){await attachSmmPaymentLink(env,q.get('id'),q.get('link'));const o=await getSmmOrder(env,q.get('id'));const r=await Promise.all([processSmmPayment(env,o,q.get('link')),processSmmPayment(env,o,q.get('link'))]);return Response.json(r);}
 if(u.pathname==='/track'){await trackSmmOrders(env);return Response.json({ok:true});}
 if(u.pathname==='/sweep'){await smmSweep(env);return Response.json({ok:true});}
 if(u.pathname==='/action'){const o=await getSmmOrder(env,q.get('id'));return Response.json(await smmAdminAction(env,o,await req.json()));}
 if(u.pathname==='/bridge'||u.pathname.startsWith('/bridge/')){return handleSmmBridge(env,req.method,'1',u.pathname.slice(7),u,req.method==='GET'?'':await req.text());}
 return new Response('missing',{status:404});
}};`,resolveDir:process.cwd(),sourcefile:'smm-test.ts'},bundle:true,write:false,format:'esm',platform:'browser'});

const instances=[];after(async()=>{await Promise.all(instances.map(m=>m.dispose()));});

async function fixture(options={}){
 const lp={calls:[],balance:100000,currency:'JPY',addMode:'ok',nextOrder:9000,
  services:[{service:'101',name:'X Followers',type:'Default',category:'X',rate:'500',min:'10',max:'10000',refill:true,cancel:false}],
  statusFor:()=>({status:'In progress',charge:'500',start_count:'10',remains:'1000',currency:'JPY'})};
 const pay={calls:[],mode:'ok'};
 const discord=[];
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],
  bindings:{
   DISCORD_BOT_TOKEN:'test',LUCKYPANEL_API_KEY:'lp-key',
   SHIIRE_BRIDGE_SECRET:'x'.repeat(40),XACCOUNT_BOT_BASE_URL:'https://xaccount.example',
   CREDENTIALS_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')
  },
  outboundService:async req=>{
   const url=new URL(req.url);
   if(url.host==='luckypanel.jp'){
    const form=Object.fromEntries(new URLSearchParams(await req.text()));
    lp.calls.push(form);
    assert.equal(form.key,'lp-key');
    if(form.action==='services')return Response.json(lp.services);
    if(form.action==='balance')return Response.json({balance:String(lp.balance),currency:lp.currency});
    if(form.action==='add'){
     if(lp.addMode==='ok')return Response.json({order:lp.nextOrder++});
     if(lp.addMode==='funds')return Response.json({error:'Not enough funds on balance'});
     if(lp.addMode==='badlink')return Response.json({error:'Incorrect link'});
     if(lp.addMode==='http500')return new Response('boom',{status:500});
     if(lp.addMode==='noid')return Response.json({});
    }
    if(form.action==='status'){
     if(form.order)return Response.json(lp.statusFor(form.order));
     return Response.json(Object.fromEntries(form.orders.split(',').map(id=>[id,lp.statusFor(id)])));
    }
    if(form.action==='cancel')return Response.json([{order:Number(form.orders),cancel:1}]);
    return Response.json({error:'unknown action'});
   }
   if(url.host==='xaccount.example'&&url.pathname==='/api/shiire/payment/status')return Response.json({paypay:pay.available!==false,kyash:false});
   if(url.host==='xaccount.example'){
    const body=await req.json();pay.calls.push(body);
    if(pay.mode==='ok')return Response.json({ok:true,status:'completed',amount:body.amount});
    if(pay.mode==='short')return Response.json({ok:true,status:'completed',amount:1});
    if(pay.mode==='pending')return Response.json({ok:false,status:'pending'});
    return Response.json({ok:false,status:'rejected',reason:'PAYPAY_MONEY_LIGHT_NOT_ALLOWED'},{status:409});
   }
   if(url.host==='discord.com'){
    let body=null;try{body=await req.json();}catch{}
    discord.push({url:url.pathname,method:req.method,body});
    const channel=url.pathname.match(/^\/api\/v10\/channels\/(\d+)$/);
    if(req.method==='GET'&&channel)return Response.json({id:channel[1],guild_id:'1'});
    return Response.json({id:'123456789012345679'});
   }
   return Response.json({error:'unexpected '+req.url},{status:500});
  }});
 instances.push(mf);
 const init=options.skipInit?{}:await (await mf.dispatchFetch('https://test/init')).json();
 return {mf,lp,pay,discord,db:await mf.getD1Database('DB'),productId:init.productId,machineId:init.machineId,
  async order(params=''){return (await mf.dispatchFetch('https://test/order?'+params)).json();},
  async get(id){return (await mf.dispatchFetch('https://test/get?id='+id)).json();},
  async place(id){return (await (await mf.dispatchFetch('https://test/place?id='+id)).json()).result;}};
}
const adds=f=>f.lp.calls.filter(c=>c.action==='add');

test('a paid order is placed on the supplier exactly once',async()=>{
 const f=await fixture();const o=await f.order('paid=1');
 assert.equal(await f.place(o.id),'placed');
 assert.equal(await f.place(o.id),'skipped');
 const after=await f.get(o.id);
 assert.equal(after.status,'placed');assert.equal(after.supplier_order_id,'9000');
 assert.equal(adds(f).length,1);
 assert.deepEqual(adds(f)[0],{key:'lp-key',action:'add',service:'101',link:'https://x.com/target',quantity:'1000'});
});

test('concurrent placement attempts create a single supplier order',async()=>{
 const f=await fixture();const o=await f.order('paid=1');
 const r=await (await f.mf.dispatchFetch('https://test/place-twice?id='+o.id)).json();
 assert.deepEqual(r.results.slice().sort(),['placed','skipped']);
 assert.equal(adds(f).length,1);
});

test('an unpaid order is never placed',async()=>{
 const f=await fixture();const o=await f.order('');
 assert.equal(await f.place(o.id),'skipped');
 assert.equal(adds(f).length,0);
});

test('an ambiguous supplier failure holds the order and is never retried automatically',async()=>{
 const f=await fixture();f.lp.addMode='http500';const o=await f.order('paid=1');
 assert.equal(await f.place(o.id),'hold');
 assert.match((await f.get(o.id)).last_error,/PLACING_AMBIGUOUS/);
 f.lp.addMode='ok';
 await f.mf.dispatchFetch('https://test/sweep');
 await f.mf.dispatchFetch('https://test/sweep');
 assert.equal((await f.get(o.id)).status,'hold');
 assert.equal(adds(f).length,1);
});

test('a 2xx reply without an order id is treated as ambiguous',async()=>{
 const f=await fixture();f.lp.addMode='noid';const o=await f.order('paid=1');
 assert.equal(await f.place(o.id),'hold');
 assert.equal(adds(f).length,1);
});

test('a definitive supplier rejection fails the order and queues a full refund',async()=>{
 const f=await fixture();f.lp.addMode='badlink';const o=await f.order('paid=1');
 assert.equal(await f.place(o.id),'failed');
 const after=await f.get(o.id);
 assert.equal(after.status,'failed');assert.equal(after.refund_state,'required');assert.equal(after.refund_amount,650);
});

test('insufficient supplier funds retries later and eventually refunds',async()=>{
 const f=await fixture();f.lp.addMode='funds';const o=await f.order('paid=1');
 assert.equal(await f.place(o.id),'retry');
 let after=await f.get(o.id);
 assert.equal(after.status,'paid');assert.ok(after.next_attempt_at>Date.now());
 assert.equal(await f.place(o.id),'skipped');
 let guard=0;
 while(after.status!=='failed'&&guard++<20){
  await f.db.prepare('UPDATE smm_orders SET next_attempt_at=NULL WHERE id=?').bind(o.id).run();
  await f.place(o.id);after=await f.get(o.id);
 }
 assert.equal(after.status,'failed');assert.equal(after.refund_state,'required');
 assert.ok(adds(f).length<=12);
});

test('funds recovered before the retry limit places the order once',async()=>{
 const f=await fixture();f.lp.addMode='funds';const o=await f.order('paid=1');
 await f.place(o.id);
 f.lp.addMode='ok';
 await f.db.prepare('UPDATE smm_orders SET next_attempt_at=NULL WHERE id=?').bind(o.id).run();
 assert.equal(await f.place(o.id),'placed');
 assert.equal((await f.get(o.id)).status,'placed');
});

test('a supplier price increase above the paid amount holds instead of selling at a loss',async()=>{
 const f=await fixture();const o=await f.order('paid=1');
 f.lp.services[0].rate='900';
 await f.db.prepare("DELETE FROM smm_meta WHERE key='services_json'").run();
 assert.equal(await f.place(o.id),'hold');
 assert.match((await f.get(o.id)).last_error,/PRICE_CHANGED/);
 assert.equal(adds(f).length,0);
});

test('a service that disappeared fails with a refund before anything is sent',async()=>{
 const f=await fixture();const o=await f.order('paid=1');
 f.lp.services=[];await f.db.prepare("DELETE FROM smm_meta WHERE key='services_json'").run();
 assert.equal(await f.place(o.id),'failed');
 assert.equal(adds(f).length,0);
});

test('supplier tracking completes, partially refunds and cancels',async()=>{
 const f=await fixture();
 const a=await f.order('paid=1'),b=await f.order('paid=1'),c=await f.order('paid=1');
 for(const o of [a,b,c])await f.place(o.id);
 const ids={[a.id]:'9000',[b.id]:'9001',[c.id]:'9002'};
 f.lp.statusFor=id=>id==='9000'?{status:'Completed',charge:'500',start_count:'1',remains:'0',currency:'JPY'}
  :id==='9001'?{status:'Partial',charge:'400',start_count:'1',remains:'250',currency:'JPY'}
  :{status:'Canceled',charge:'0',start_count:'0',remains:'1000',currency:'JPY'};
 await f.mf.dispatchFetch('https://test/track');
 const ra=await f.get(a.id),rb=await f.get(b.id),rc=await f.get(c.id);
 assert.equal(ra.status,'completed');assert.equal(ra.refund_state,'none');
 assert.equal(rb.status,'partial');assert.equal(rb.refund_state,'required');assert.equal(rb.refund_amount,162);
 assert.equal(rc.status,'canceled');assert.equal(rc.refund_amount,650);
 assert.ok(ids);
});

test('an unknown supplier order id holds the order for review',async()=>{
 const f=await fixture();const o=await f.order('paid=1');await f.place(o.id);
 f.lp.statusFor=()=>({error:'Incorrect order ID'});
 await f.mf.dispatchFetch('https://test/track');
 assert.equal((await f.get(o.id)).status,'hold');
});

test('payment completes and places the order, and double processing places once',async()=>{
 const f=await fixture();const o=await f.order('');
 const r=await (await f.mf.dispatchFetch('https://test/pay-twice?id='+o.id+'&link='+encodeURIComponent('https://pay.paypay.ne.jp/abc'))).json();
 assert.equal(r.every(x=>x.status==='completed'),true);
 assert.equal((await f.get(o.id)).status,'placed');
 assert.equal(adds(f).length,1);
 assert.equal(f.pay.calls[0].requirePayPayMoney,true);
 assert.equal(f.pay.calls[0].method,'paypay');
 assert.equal(f.pay.calls[0].amount,650);
 assert.equal((await f.db.prepare('SELECT sales_count FROM smm_products').first()).sales_count,1);
});

test('an under-paid receipt never marks the order paid or places it',async()=>{
 const f=await fixture();f.pay.mode='short';const o=await f.order('');
 const r=await (await f.mf.dispatchFetch('https://test/pay?id='+o.id+'&link='+encodeURIComponent('https://pay.paypay.ne.jp/abc'))).json();
 assert.match(r.thrown,/AMOUNT_MISMATCH/);
 assert.equal((await f.get(o.id)).status,'payment_pending');
 assert.equal(adds(f).length,0);
});

test('a rejected payment link returns the order to awaiting payment',async()=>{
 const f=await fixture();f.pay.mode='rejected';const o=await f.order('');
 const r=await (await f.mf.dispatchFetch('https://test/pay?id='+o.id+'&link='+encodeURIComponent('https://pay.paypay.ne.jp/abc'))).json();
 assert.equal(r.status,'rejected');
 assert.equal((await f.get(o.id)).status,'awaiting_payment');
 assert.equal(adds(f).length,0);
});

test('unpaid orders expire after the payment window',async()=>{
 const f=await fixture();const o=await f.order('');
 await f.db.prepare('UPDATE smm_orders SET reserved_until=1 WHERE id=?').bind(o.id).run();
 await f.mf.dispatchFetch('https://test/sweep');
 assert.equal((await f.get(o.id)).status,'expired');
});

test('the sweep places paid orders, tracks them and notifies the buyer once',async()=>{
 const f=await fixture();const o=await f.order('paid=1');
 await f.mf.dispatchFetch('https://test/sweep');
 assert.equal((await f.get(o.id)).status,'placed');
 f.lp.statusFor=()=>({status:'Completed',charge:'500',start_count:'1',remains:'0',currency:'JPY'});
 await f.mf.dispatchFetch('https://test/sweep');
 await f.mf.dispatchFetch('https://test/sweep');
 const after=await f.get(o.id);
 assert.equal(after.status,'completed');assert.ok(after.buyer_notified_at);
 const dms=f.discord.filter(m=>m.url.endsWith('/messages')&&JSON.stringify(m.body).includes('注文が完了しました'));
 assert.equal(dms.length,1);
 assert.equal(adds(f).length,1);
});

test('admin retry requires confirmation and only works for unplaced held orders',async()=>{
 const f=await fixture();f.lp.addMode='http500';const o=await f.order('paid=1');await f.place(o.id);
 f.lp.addMode='ok';
 const act=async body=>(await f.mf.dispatchFetch('https://test/action?id='+o.id,{method:'POST',body:JSON.stringify(body)})).json();
 assert.equal((await act({action:'retry',confirmNotPlaced:false})).ok,false);
 assert.equal(adds(f).length,1);
 assert.equal((await act({action:'retry',confirmNotPlaced:true})).ok,true);
 assert.equal((await f.get(o.id)).status,'placed');
 assert.equal(adds(f).length,2);
 assert.equal((await act({action:'retry',confirmNotPlaced:true})).ok,false);
});

test('admin can link an ambiguous order to the supplier order found manually',async()=>{
 const f=await fixture();f.lp.addMode='http500';const o=await f.order('paid=1');await f.place(o.id);
 const r=await (await f.mf.dispatchFetch('https://test/action?id='+o.id,{method:'POST',body:JSON.stringify({action:'link_supplier',supplierOrderId:'7777'})})).json();
 assert.equal(r.ok,true);
 const after=await f.get(o.id);
 assert.equal(after.status,'placed');assert.equal(after.supplier_order_id,'7777');
});

test('refund completion is recorded once',async()=>{
 const f=await fixture();f.lp.addMode='badlink';const o=await f.order('paid=1');await f.place(o.id);
 const act=async()=>(await (await f.mf.dispatchFetch('https://test/action?id='+o.id,{method:'POST',body:JSON.stringify({action:'refund_done'})})).json());
 assert.equal((await act()).ok,true);
 assert.equal((await act()).ok,false);
 assert.equal((await f.get(o.id)).refund_state,'done');
});

test('bridge: product creation validates the service and refuses unprofitable pricing',async()=>{
 const f=await fixture();
 const post=async(path,body,method='POST')=>f.mf.dispatchFetch('https://test/bridge'+path,{method,body:JSON.stringify(body)});
 let res=await post('/products',{machine_id:f.machineId,name:'Bad',service_id:'999',price_percent:130,link_kind:'x_profile'});
 assert.equal(res.status,400);
 f.lp.services.push({service:'202',name:'Comments',type:'Custom Comments',category:'X',rate:'900',min:'10',max:'100',refill:false,cancel:false});
 await f.db.prepare("DELETE FROM smm_meta WHERE key='services_json'").run();
 res=await post('/products',{machine_id:f.machineId,name:'Comments',service_id:'202',price_percent:130,link_kind:'x_post'});
 assert.equal(res.status,400);
 assert.match((await res.json()).message,/SERVICE_TYPE_UNSUPPORTED/);
 await post('/settings',{min_margin_percent:20});
 res=await post('/products',{machine_id:f.machineId,name:'Thin',service_id:'101',price_percent:105,link_kind:'x_profile'});
 assert.equal(res.status,400);
 assert.match((await res.json()).message,/MARGIN_BELOW_FLOOR/);
 res=await post('/products',{machine_id:f.machineId,name:'Good',service_id:'101',price_percent:130,link_kind:'x_profile'});
 assert.equal(res.status,200);
});

test('bridge: prices must be at least 101% of cost and fixed fees are ignored',async()=>{
 const f=await fixture();
 const post=body=>f.mf.dispatchFetch('https://test/bridge/products',{method:'POST',body:JSON.stringify(body)});
 for(const price_percent of [100,99,0,'abc']){
  const res=await post({machine_id:f.machineId,name:'X',service_id:'101',price_percent,link_kind:'x_profile'});
  assert.equal(res.status,400,String(price_percent));
 }
 const res=await post({machine_id:f.machineId,name:'Cheap',service_id:'101',price_percent:101,fee_jpy:500,link_kind:'x_profile'});
 assert.equal(res.status,200);
 const {product}=await res.json();
 assert.equal(product.markup_percent,1);assert.equal(product.fee_jpy,0);
 const overview=await (await f.mf.dispatchFetch('https://test/bridge')).json();
 const cheap=overview.products.find(p=>p.name==='Cheap');
 assert.equal(cheap.price_percent,101);assert.equal(cheap.per1000,505);
});

test('bridge: overview reports balance and never exposes payment links',async()=>{
 const f=await fixture();const o=await f.order('');
 await f.mf.dispatchFetch('https://test/pay?id='+o.id+'&link='+encodeURIComponent('https://pay.paypay.ne.jp/secret'));
 const overview=await (await f.mf.dispatchFetch('https://test/bridge')).json();
 assert.equal(overview.configured,true);
 assert.equal(overview.balance.ok,true);assert.equal(overview.balance.balance,100000);assert.equal(overview.balance.currencyOk,true);
 assert.equal(overview.products[0].per1000,650);
 const orders=await (await f.mf.dispatchFetch('https://test/bridge/orders')).text();
 assert.doesNotMatch(orders,/payment_link_ciphertext|pay\.paypay/);
});


const interactionBase={application_id:'555',token:'tok',guild_id:'1',member:{user:{id:'2'}}};
async function interact(f,interaction){
 const before=f.discord.length;
 const response=await (await f.mf.dispatchFetch('https://test/interact',{method:'POST',body:JSON.stringify({...interactionBase,...interaction})})).json();
 const edits=f.discord.slice(before).filter(m=>m.url.includes('/webhooks/555/tok/messages/@original'));
 return {response,edit:edits.at(-1)?.body};
}
const modal=(customId,fields)=>({type:5,data:{custom_id:customId,components:Object.entries(fields).map(([id,value])=>({type:1,components:[{type:4,custom_id:id,value}]}))}});

test('interaction: the buy button lists active products with their price per 1000',async()=>{
 const f=await fixture();
 const {response}=await interact(f,{type:3,data:{custom_id:'smm:buy:'+f.machineId}});
 assert.match(response.data.content,/購入する商品/);
 const option=response.data.components[0].components[0].options[0];
 assert.equal(option.value,f.productId);
 assert.match(option.description,/1000件 ¥650/);
 assert.equal(response.data.flags,64);
});

test('interaction: a paused shop refuses to start orders',async()=>{
 const f=await fixture();
 await f.db.prepare('UPDATE smm_guild_settings SET paused=1').run();
 const {response}=await interact(f,{type:3,data:{custom_id:'smm:buy:'+f.machineId}});
 assert.match(response.data.content,/停止/);
 const order=await interact(f,modal('smm:order:'+f.productId,{link:'https://x.com/target',quantity:'1000'}));
 assert.match(order.edit.content,/停止/);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM smm_orders').first()).n,0);
});

test('interaction: picking a product opens the order modal',async()=>{
 const f=await fixture();
 const {response}=await interact(f,{type:3,data:{custom_id:'smm:pick:'+f.machineId,values:[f.productId]}});
 assert.equal(response.type,9);
 assert.equal(response.data.custom_id,'smm:order:'+f.productId);
 assert.deepEqual(response.data.components.map(r=>r.components[0].custom_id),['link','quantity']);
});

test('interaction: a valid order is quoted, normalized and awaits payment',async()=>{
 const f=await fixture();
 const {response,edit}=await interact(f,modal('smm:order:'+f.productId,{link:'https://twitter.com/target?s=20',quantity:'1,000'}));
 assert.equal(response.type,5);
 assert.match(edit.content,/¥650/);
 assert.equal(edit.components[0].components[0].custom_id.startsWith('smm:pay:'),true);
 const order=await f.db.prepare('SELECT * FROM smm_orders').first();
 assert.equal(order.status,'awaiting_payment');
 assert.equal(order.link,'https://x.com/target');
 assert.equal(order.total_amount,650);assert.equal(order.quantity,1000);assert.equal(order.user_id,'2');
 assert.equal(adds(f).length,0);
});

test('interaction: invalid links and quantities never create orders',async()=>{
 const f=await fixture();
 let r=await interact(f,modal('smm:order:'+f.productId,{link:'https://evil.example/target',quantity:'1000'}));
 assert.match(r.edit.content,/URLの形式/);
 r=await interact(f,modal('smm:order:'+f.productId,{link:'https://x.com/target',quantity:'5'}));
 assert.match(r.edit.content,/数量が不正/);
 r=await interact(f,modal('smm:order:'+f.productId,{link:'https://x.com/target',quantity:'999999'}));
 assert.match(r.edit.content,/数量が不正/);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM smm_orders').first()).n,0);
});

test('interaction: orders are refused when the supplier balance cannot cover them',async()=>{
 const f=await fixture();f.lp.balance=100;
 const r=await interact(f,modal('smm:order:'+f.productId,{link:'https://x.com/target',quantity:'1000'}));
 assert.match(r.edit.content,/受付枠/);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM smm_orders').first()).n,0);
});

test('interaction: orders are refused when the supplier balance is not in JPY',async()=>{
 const f=await fixture();f.lp.currency='USD';
 const r=await interact(f,modal('smm:order:'+f.productId,{link:'https://x.com/target',quantity:'1000'}));
 assert.match(r.edit.content,/受け付けられません/);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM smm_orders').first()).n,0);
});

test('interaction: the per-user open order cap is enforced',async()=>{
 const f=await fixture();
 await f.db.prepare('UPDATE smm_guild_settings SET max_open_orders_per_user=2').run();
 for(let i=0;i<2;i++) await interact(f,modal('smm:order:'+f.productId,{link:'https://x.com/target',quantity:'100'}));
 const r=await interact(f,modal('smm:order:'+f.productId,{link:'https://x.com/target',quantity:'100'}));
 assert.match(r.edit.content,/上限/);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM smm_orders').first()).n,2);
});

test('interaction: a product from another server cannot be ordered',async()=>{
 const f=await fixture();
 const r=await interact(f,{...modal('smm:order:'+f.productId,{link:'https://x.com/target',quantity:'1000'}),guild_id:'999'});
 assert.match(r.edit.content,/このサーバー/);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM smm_orders').first()).n,0);
});

test('interaction: paying places the supplier order and only the buyer can pay',async()=>{
 const f=await fixture();
 await interact(f,modal('smm:order:'+f.productId,{link:'https://x.com/target',quantity:'1000'}));
 const order=await f.db.prepare('SELECT * FROM smm_orders').first();
 const stranger=await interact(f,{type:3,data:{custom_id:'smm:pay:'+order.id},member:{user:{id:'777'}}});
 assert.match(stranger.response.data.content,/見つかりません/);
 const open=await interact(f,{type:3,data:{custom_id:'smm:pay:'+order.id}});
 assert.equal(open.response.type,9);
 const paid=await interact(f,modal('smm:paymodal:'+order.id,{link:'https://pay.paypay.ne.jp/abc123'}));
 assert.match(paid.edit.content,/発注しました/);
 assert.equal((await f.get(order.id)).status,'placed');
 assert.equal(adds(f).length,1);
 const again=await interact(f,modal('smm:paymodal:'+order.id,{link:'https://pay.paypay.ne.jp/abc123'}));
 assert.match(again.edit.content,/失効/);
 assert.equal(adds(f).length,1);
});

test('interaction: PayPay Money Light links are rejected with guidance',async()=>{
 const f=await fixture();f.pay.mode='rejected';
 await interact(f,modal('smm:order:'+f.productId,{link:'https://x.com/target',quantity:'1000'}));
 const order=await f.db.prepare('SELECT * FROM smm_orders').first();
 const r=await interact(f,modal('smm:paymodal:'+order.id,{link:'https://pay.paypay.ne.jp/abc123'}));
 assert.match(r.edit.content,/マネーライト/);
 assert.equal((await f.get(order.id)).status,'awaiting_payment');
});

test('interaction: order status shows only the buyer\'s own orders',async()=>{
 const f=await fixture();
 await f.order('paid=1');
 const mine=await interact(f,{type:3,data:{custom_id:'smm:status:'+f.machineId}});
 assert.equal(mine.response.data.embeds[0].fields.length,1);
 const other=await interact(f,{type:3,data:{custom_id:'smm:status:'+f.machineId},member:{user:{id:'888'}}});
 assert.match(other.response.data.content,/まだありません/);
});

test('interaction: unrelated custom ids are left to other handlers',async()=>{
 const f=await fixture();
 const {response}=await interact(f,{type:3,data:{custom_id:'svm:buy:abc'}});
 assert.equal(response.unhandled,true);
});


const post=(f,path,body,method='POST')=>f.mf.dispatchFetch('https://test/bridge'+path,{method,body:JSON.stringify(body)});

test('machines: each SNS gets its own panel texts and only its own link kinds',async()=>{
 const f=await fixture();
 let res=await post(f,'/machines',{sns:'instagram'});
 assert.equal(res.status,200);
 const {machine}=await res.json();
 assert.equal(machine.sns,'instagram');assert.match(machine.panel_title,/Instagram/);
 assert.equal((await post(f,'/machines',{sns:'myspace'})).status,400);
 res=await post(f,'/products',{machine_id:machine.id,name:'IG Followers',service_id:'101',price_percent:130,link_kind:'x_profile'});
 assert.equal(res.status,400);assert.equal((await res.json()).error,'LINK_KIND_INVALID');
 res=await post(f,'/products',{machine_id:machine.id,name:'IG Followers',service_id:'101',price_percent:130,link_kind:'instagram_profile'});
 assert.equal(res.status,200);
 res=await post(f,'/products',{machine_id:'nope',name:'Ghost',service_id:'101',price_percent:130,link_kind:'url'});
 assert.equal(res.status,400);assert.equal((await res.json()).error,'MACHINE_NOT_FOUND');
});

test('machines: the 25 product limit applies per machine, not per server',async()=>{
 const f=await fixture();
 const {machine:other}=await (await post(f,'/machines',{sns:'tiktok'})).json();
 const base={name:'bulk',description:'',emoji:null,service_id:'101',service_name:'',service_category:'',markup_percent:30,fee_jpy:0,min_qty:10,max_qty:0,link_kind:'x_profile',active:1,sales_count:0,created_at:1,updated_at:1};
 for(let i=0;i<23;i++) await f.db.prepare("INSERT INTO smm_products(id,guild_id,machine_id,name,service_id,link_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,1,1)").bind('bulk'+i,'1',f.machineId,'bulk'+i,'101','x_profile').run();
 assert.ok(base);
 let res=await post(f,'/products',{machine_id:f.machineId,name:'25th',service_id:'101',price_percent:130,link_kind:'x_profile'});
 assert.equal(res.status,200);
 res=await post(f,'/products',{machine_id:f.machineId,name:'26th',service_id:'101',price_percent:130,link_kind:'x_profile'});
 assert.equal(res.status,409);assert.equal((await res.json()).error,'TOO_MANY_ACTIVE_PRODUCTS');
 res=await post(f,'/products',{machine_id:other.id,name:'TikTok one',service_id:'101',price_percent:130,link_kind:'tiktok_profile'});
 assert.equal(res.status,200);
});

test('machines: panels install to separate channels and show only their own products',async()=>{
 const f=await fixture();
 const {machine:ig}=await (await post(f,'/machines',{sns:'instagram'})).json();
 await post(f,'/products',{machine_id:ig.id,name:'IG Followers',service_id:'101',price_percent:130,link_kind:'instagram_profile'});
 const a=await (await post(f,`/machines/${f.machineId}/panel`,{channelId:'111111111111111111'})).json();
 const b=await (await post(f,`/machines/${ig.id}/panel`,{channelId:'222222222222222222'})).json();
 assert.equal(a.ok,true);assert.equal(b.ok,true);
 const sent=f.discord.filter(m=>m.method==='POST'&&/\/channels\/\d+\/messages$/.test(m.url)&&m.body?.embeds?.[0]?.fields);
 const toX=sent.find(m=>m.url.includes('111111111111111111')),toIg=sent.find(m=>m.url.includes('222222222222222222'));
 assert.deepEqual(toX.body.embeds[0].fields.map(x=>x.name),['X Followers']);
 assert.deepEqual(toIg.body.embeds[0].fields.map(x=>x.name),['IG Followers']);
 assert.equal(toX.body.components[0].components[0].custom_id,'smm:buy:'+f.machineId);
 assert.equal(toIg.body.components[0].components[0].custom_id,'smm:buy:'+ig.id);
 const overview=await (await f.mf.dispatchFetch('https://test/bridge')).json();
 assert.equal(overview.machines.length,2);
 assert.equal(overview.machines.find(m=>m.id===ig.id).panels[0].channel_id,'222222222222222222');
 assert.equal((await post(f,`/machines/${ig.id}/panel`,{channelId:'not-a-channel'})).status>=400,true);
});

test('machines: editing a product refreshes only the panels of its machine',async()=>{
 const f=await fixture();
 const {machine:ig}=await (await post(f,'/machines',{sns:'instagram'})).json();
 await post(f,`/machines/${f.machineId}/panel`,{channelId:'111111111111111111'});
 await post(f,`/machines/${ig.id}/panel`,{channelId:'222222222222222222'});
 const before=f.discord.length;
 const res=await post(f,'/products/'+f.productId,{price_percent:150},'PATCH');
 assert.equal(res.status,200);
 const patches=f.discord.slice(before).filter(m=>m.method==='PATCH');
 assert.equal(patches.length,1);
 assert.match(patches[0].url,/channels\/111111111111111111\/messages/);
 assert.match(patches[0].body.embeds[0].fields[0].value,/¥750/);
});

test('machines: pausing the shop disables the buttons on every panel',async()=>{
 const f=await fixture();
 const {machine:ig}=await (await post(f,'/machines',{sns:'instagram'})).json();
 await post(f,`/machines/${f.machineId}/panel`,{channelId:'111111111111111111'});
 await post(f,`/machines/${ig.id}/panel`,{channelId:'222222222222222222'});
 const before=f.discord.length;
 await post(f,'/settings',{paused:true});
 const patches=f.discord.slice(before).filter(m=>m.method==='PATCH');
 assert.equal(patches.length,2);
 for(const patch of patches){
  assert.equal(patch.body.components[0].components[0].disabled,true);
  assert.match(patch.body.embeds[0].description,/停止/);
 }
});

test('machines: deletion is blocked while products remain',async()=>{
 const f=await fixture();
 const {machine:tt}=await (await post(f,'/machines',{sns:'tiktok'})).json();
 await post(f,'/products',{machine_id:tt.id,name:'TT',service_id:'101',price_percent:130,link_kind:'tiktok_profile'});
 let res=await post(f,'/machines/'+tt.id,{},'DELETE');
 assert.equal(res.status,409);assert.equal((await res.json()).error,'MACHINE_HAS_PRODUCTS');
 const overview=await (await f.mf.dispatchFetch('https://test/bridge')).json();
 const product=overview.products.find(p=>p.name==='TT');
 await post(f,'/products/'+product.id,{},'DELETE');
 res=await post(f,'/machines/'+tt.id,{},'DELETE');
 assert.equal(res.status,200);
});

test('machines: a product can move to another machine of a compatible SNS',async()=>{
 const f=await fixture();
 const {machine:second}=await (await post(f,'/machines',{sns:'x',name:'X (2)'})).json();
 let res=await post(f,'/products/'+f.productId,{machine_id:second.id},'PATCH');
 assert.equal(res.status,200);
 const {machine:ig}=await (await post(f,'/machines',{sns:'instagram'})).json();
 res=await post(f,'/products/'+f.productId,{machine_id:ig.id},'PATCH');
 assert.equal(res.status,400);assert.equal((await res.json()).error,'LINK_KIND_INVALID');
});

test('interaction: a panel only offers its own machine products',async()=>{
 const f=await fixture();
 const {machine:ig}=await (await post(f,'/machines',{sns:'instagram'})).json();
 const {product}=await (await post(f,'/products',{machine_id:ig.id,name:'IG Followers',service_id:'101',price_percent:130,link_kind:'instagram_profile'})).json();
 const x=await interact(f,{type:3,data:{custom_id:'smm:buy:'+f.machineId}});
 assert.deepEqual(x.response.data.components[0].components[0].options.map(o=>o.value),[f.productId]);
 const i=await interact(f,{type:3,data:{custom_id:'smm:buy:'+ig.id}});
 assert.deepEqual(i.response.data.components[0].components[0].options.map(o=>o.value),[product.id]);
 const cross=await interact(f,{type:3,data:{custom_id:'smm:pick:'+f.machineId,values:[product.id]}});
 assert.match(cross.response.data.content,/購入できません/);
 const wrongGuild=await interact(f,{type:3,data:{custom_id:'smm:buy:'+f.machineId},guild_id:'999'});
 assert.match(wrongGuild.response.data.content,/利用できません/);
});

test('interaction: Instagram links are validated by the machine link kind',async()=>{
 const f=await fixture();
 const {machine:ig}=await (await post(f,'/machines',{sns:'instagram'})).json();
 const {product}=await (await post(f,'/products',{machine_id:ig.id,name:'IG Followers',service_id:'101',price_percent:130,link_kind:'instagram_profile'})).json();
 let r=await interact(f,modal('smm:order:'+product.id,{link:'https://x.com/target',quantity:'1000'}));
 assert.match(r.edit.content,/URLの形式/);
 r=await interact(f,modal('smm:order:'+product.id,{link:'https://instagram.com/some.user?igsh=abc',quantity:'1000'}));
 assert.match(r.edit.content,/¥650/);
 assert.equal((await f.db.prepare('SELECT link FROM smm_orders').first()).link,'https://www.instagram.com/some.user/');
});

test('legacy: a single-panel install is folded into an X machine without losing data',async()=>{
 const f=await fixture({skipInit:true});
 await f.mf.dispatchFetch('https://test/legacy-init');
 const overview=await (await f.mf.dispatchFetch('https://test/bridge')).json();
 assert.equal(overview.machines.length,1);
 const machine=overview.machines[0];
 assert.equal(machine.sns,'x');assert.equal(machine.panel_title,'Old title');assert.equal(machine.panel_description,'Old description');
 assert.equal(machine.totalProducts,1);assert.equal(machine.panels.length,1);
 assert.equal(overview.products[0].machine_id,machine.id);
 assert.equal(overview.settings.private_log_channel_id,'123456789012345678');
 assert.equal(overview.settings.min_margin_percent,15);assert.equal(overview.settings.max_open_orders_per_user,7);
 assert.equal(overview.settings.paused,0);
});
