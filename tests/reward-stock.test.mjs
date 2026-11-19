import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

// An Xaccount-Bot product can be chosen as the stock of the invite-campaign
// reward and/or the free giveaway (instead of each drawing from its own
// dedicated pool of generator accounts). Accounts are withdrawn from that
// product one at a time through the signed supply bridge.

const guild='123456789012345678',secret='fixture-reward-stock-secret-longer-than-32-characters';
const encryptionKey=Buffer.alloc(32,9).toString('base64');
const bundle=await build({stdin:{contents:`import {handleShiireMainBridge} from './src/shiire-vending';
import {handleFreeGiveawayInteraction} from './src/free-giveaway';
export default {async fetch(request,env){try{
 const url=new URL(request.url);
 if(url.pathname==='/interaction'){
  const pending=[];
  const ctx={waitUntil(promise){pending.push(promise);}};
  const response=await handleFreeGiveawayInteraction(await request.json(),env,ctx);
  await Promise.all(pending);
  return response??new Response('not-handled',{status:404});
 }
 return await handleShiireMainBridge(request,env,url)??new Response('missing',{status:404});
}catch(error){return Response.json({message:error.message},{status:error.status??500});}}};`,resolveDir:process.cwd(),sourcefile:'reward-stock-fixture.ts'},bundle:true,write:false,format:'esm',platform:'browser'});

async function fixture(t){
 const state={dms:[],stock:{'xp-1':[],'xp-2':[]},withdrawals:{}};
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],
  bindings:{SHIIRE_BRIDGE_SECRET:secret,CREDENTIALS_ENCRYPTION_KEY:encryptionKey,DISCORD_BOT_TOKEN:'fixture',XACCOUNT_BOT_BASE_URL:'https://xaccount.example'},
  outboundService:async request=>{
   const url=new URL(request.url);
   if(url.host==='xaccount.example'){
    if(url.pathname==='/api/vending/supply/catalog') return Response.json({products:Object.keys(state.stock).map(id=>({product_id:id,product_name:'商品'+id,vending_machine_id:'vm',vending_machine_name:'自販機',guild_id:guild,available:state.stock[id].length}))});
    const stock=url.pathname.match(/^\/api\/vending\/supply\/products\/([^/]+)\/stock$/);
    if(stock) return state.stock[stock[1]]?Response.json({productId:stock[1],name:'x',available:state.stock[stock[1]].length,infinite:false}):Response.json({error:'product_not_found'},{status:404});
    if(url.pathname==='/api/vending/supply/withdraw'){
     const body=await request.json();
     if(!state.withdrawals[body.idempotencyKey]) state.withdrawals[body.idempotencyKey]=state.stock[body.productId].splice(0,body.quantity);
     return Response.json({ok:true,productId:body.productId,items:state.withdrawals[body.idempotencyKey]});
    }
   }
   if(url.pathname==='/api/v10/users/@me/channels') return Response.json({id:'dm-'+(await request.json()).recipient_id});
   const dmMatch=url.pathname.match(/^\/api\/v10\/channels\/dm-(\d+)\/messages$/);
   if(dmMatch){
    state.dms.push({userId:dmMatch[1],payload:await request.json()});
    return Response.json({id:'dm-message'});
   }
   if(url.pathname.endsWith('/messages/@original')&&request.method==='PATCH') return Response.json({});
   return Response.json({message:'unexpected '+request.method+' '+url.pathname},{status:404});
  }});
 t.after(()=>mf.dispose());
 const bridge=async(suffix,method='GET',payload)=>{
  const path='/bridge/main/guilds/'+guild+suffix,body=payload?JSON.stringify(payload):'',timestamp=String(Date.now()),nonce=randomUUID();
  const signature=createHmac('sha256',secret).update([timestamp,nonce,method,path,body].join('\n')).digest('hex');
  return mf.dispatchFetch('https://fixture.example'+path,{method,body:body||undefined,headers:{'X-Shiire-Timestamp':timestamp,'X-Shiire-Nonce':nonce,'X-Shiire-Signature':signature}});
 };
 const press=userId=>mf.dispatchFetch('https://fixture.example/interaction',{method:'POST',body:JSON.stringify({
  type:3,application_id:'app1',token:'tok-'+userId,guild_id:guild,data:{custom_id:'fgv:claim'},member:{user:{id:userId}}})});
 const db=await mf.getD1Database('DB');
 const addStock=(pool,items)=>bridge('/generator/pools/'+pool+'/stock','POST',{items});
 const createMachine=async name=>(await (await bridge('/vending','POST',{name})).json());
 const createProduct=async(machineId,body)=>{
  await db.prepare(
   "INSERT INTO supplier_products(id,supplier,supplier_product_id,title,currency,unit_price,last_seen_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).bind('sp-'+body.supplierProductId,'hstora',body.supplierProductId,'fixture title','JPY',1000,Date.now(),Date.now(),Date.now()).run();
  const res=await bridge('/vending/'+machineId+'/products','POST',body);
  return res.json();
 };
 return {state,bridge,press,addStock,createMachine,createProduct,db};
}

test('choosing an Xaccount-Bot product for the invite reward uses its stock',async t=>{
 const {state,bridge,addStock}=await fixture(t);
 await addStock('invite-campaign',['legacy1:pw']);
 let affiliate=await (await bridge('/affiliate')).json();
 assert.equal(affiliate.invite.source.mode,'dedicated');
 assert.equal(affiliate.invite.stock.available,1);
 assert.deepEqual(affiliate.products.map(p=>p.id),['xp-1','xp-2'],'candidates are Xaccount-Bot products');

 state.stock['xp-1'].push('shared1:pw','shared2:pw');
 const switched=await (await bridge('/affiliate/invite/product','POST',{productId:'xp-1'})).json();
 assert.equal(switched.source.mode,'xaccount');
 assert.equal(switched.source.productName,'商品xp-1');
 assert.equal(switched.source.stockCount,2,'the legacy pool does not follow the switch');

 // Stock now belongs on the Xaccount-Bot product, not in a Shiire pool.
 assert.equal((await addStock('invite-campaign',['x:pw'])).status,409);

 await bridge('/affiliate/invite/product','POST',{productId:null});
 affiliate=await (await bridge('/affiliate')).json();
 assert.equal(affiliate.invite.source.mode,'dedicated');
 assert.equal(affiliate.invite.stock.available,1,'the original legacy account is still there');
});

test('choosing an unknown product is rejected and a removed product is reported as unavailable',async t=>{
 const {state,bridge}=await fixture(t);
 assert.equal((await bridge('/affiliate/giveaway/product','POST',{productId:'does-not-exist'})).status,400);
 assert.equal((await bridge('/affiliate/giveaway/product','POST',{productId:'xp-2'})).status,200);
 delete state.stock['xp-2'];
 const affiliate=await (await bridge('/affiliate')).json();
 assert.equal(affiliate.giveaway.source.unavailable,true);
 assert.equal(affiliate.giveaway.source.stockCount,0);
});

test('the free giveaway takes one account from the chosen Xaccount-Bot product per claim',async t=>{
 const {state,bridge,press,addStock}=await fixture(t);
 await bridge('/free-giveaway/settings','POST',{enabled:true});
 await addStock('free-giveaway',['dedicated:pw']);
 await bridge('/affiliate/giveaway/product','POST',{productId:'xp-1'});

 // The dedicated-pool account is left behind and the product is empty.
 await press('1001');
 assert.equal(state.dms.length,0);
 assert.equal(Object.keys(state.withdrawals).length,1,'one (empty) withdrawal attempt');

 state.stock['xp-1'].push('shared:pw','other:pw');
 await press('1001');
 assert.equal(state.dms.length,1);
 assert.match(state.dms[0].payload.embeds[0].description,/shared:pw/);
 assert.deepEqual(state.stock['xp-1'],['other:pw'],'only one account left the product');
 // The same user cannot take a second one.
 await press('1001');
 assert.equal(state.dms.length,1);
 assert.deepEqual(state.stock['xp-1'],['other:pw']);
});
