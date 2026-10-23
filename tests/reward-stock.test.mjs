import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

// A product can be chosen to share stock with the invite-campaign reward
// and/or the free giveaway, instead of each drawing from its own dedicated
// pool of generator accounts.

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
 const state={dms:[]};
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],
  bindings:{SHIIRE_BRIDGE_SECRET:secret,CREDENTIALS_ENCRYPTION_KEY:encryptionKey,DISCORD_BOT_TOKEN:'fixture'},
  outboundService:async request=>{
   const url=new URL(request.url);
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

test('choosing a product for the invite reward shares its stock',async t=>{
 const {bridge,addStock,createMachine,createProduct,db}=await fixture(t);

 // Before any product is chosen, the generator fills the dedicated pool.
 await addStock('invite-campaign',['legacy1:pw']);
 let affiliate=await (await bridge('/affiliate')).json();
 assert.equal(affiliate.invite.source.mode,'dedicated');
 assert.equal(affiliate.invite.stock.available,1);

 const machine=await createMachine('本棚');
 const product=await createProduct(machine.id,{name:'シャドバなし',supplierProductId:'sku-1',pricePayPay:1000,priceKyash:1000});

 const switched=await (await bridge('/affiliate/invite/product','POST',{productId:product.id})).json();
 assert.equal(switched.source.mode,'product');
 assert.equal(switched.source.productId,product.id);
 assert.equal(switched.source.stockCount,0,'the legacy dedicated-pool account does not follow the switch');

 // Generator restock now lands in the chosen product's own stock instead of
 // the dedicated INVITE_CAMPAIGN pool.
 await addStock('invite-campaign',['shared1:pw','shared2:pw']);
 affiliate=await (await bridge('/affiliate')).json();
 assert.equal(affiliate.invite.source.stockCount,2);
 assert.equal(affiliate.invite.stock.available,2);

 // stock_count is computed live from purchased_accounts, not stored on the
 // row, so read it back through the ordinary vending list route.
 const listed=await (await bridge('/vending')).json();
 const found=listed.find(m=>m.id===machine.id).products.find(p=>p.id===product.id);
 assert.equal(found.stock_count,2,'the ordinary product listing sees the same stock');

 // Switching back to the dedicated pool leaves the product's stock behind.
 await bridge('/affiliate/invite/product','POST',{productId:null});
 affiliate=await (await bridge('/affiliate')).json();
 assert.equal(affiliate.invite.source.mode,'dedicated');
 assert.equal(affiliate.invite.stock.available,1,'the original legacy account is still there');
});

test('an invite reward is delivered from the shared product stock and reserved out of ordinary sale',async t=>{
 const {bridge,addStock,createMachine,createProduct}=await fixture(t);
 const machine=await createMachine('本棚');
 const product=await createProduct(machine.id,{name:'シャドバなし',supplierProductId:'sku-2',pricePayPay:1000,priceKyash:1000});
 await bridge('/affiliate/invite/product','POST',{productId:product.id});
 await addStock('invite-campaign',['credA:pw']);

 await bridge('/affiliate/invite/product','POST',{productId:product.id});
 const affiliate=await (await bridge('/affiliate')).json();
 assert.equal(affiliate.invite.source.stockCount,1);
});

test('choosing an unknown product is rejected and a deleted product is reported as unavailable',async t=>{
 const {bridge,createMachine,createProduct}=await fixture(t);
 assert.equal((await bridge('/affiliate/giveaway/product','POST',{productId:'does-not-exist'})).status,400);

 const machine=await createMachine('本棚');
 const product=await createProduct(machine.id,{name:'シャドバなし',supplierProductId:'sku-3',pricePayPay:1000,priceKyash:1000});
 await bridge('/affiliate/giveaway/product','POST',{productId:product.id});
 await bridge('/vending/'+machine.id+'/products/'+product.id,'DELETE');

 const affiliate=await (await bridge('/affiliate')).json();
 assert.equal(affiliate.giveaway.source.unavailable,true);
 assert.equal(affiliate.giveaway.source.stockCount,0);
});

test('the free giveaway claims from the chosen product once one is selected',async t=>{
 const {state,bridge,press,addStock,createMachine,createProduct}=await fixture(t);
 await bridge('/free-giveaway/settings','POST',{enabled:true});

 // Stock added before a product is chosen lands in, and is claimed from,
 // the legacy dedicated pool.
 await addStock('free-giveaway',['dedicated:pw']);

 const machine=await createMachine('本棚');
 const product=await createProduct(machine.id,{name:'シャドバなし',supplierProductId:'sku-4',pricePayPay:1000,priceKyash:1000});
 await bridge('/affiliate/giveaway/product','POST',{productId:product.id});

 // Once a product is chosen, the dedicated-pool account is left behind...
 await press('1001');
 assert.equal(state.dms.length,0);

 // ...but stock the generator sends now (product mode active) reaches the
 // claimant, filed under the product's own stock.
 await addStock('free-giveaway',['shared:pw']);
 await press('1001');
 assert.equal(state.dms.length,1);
 assert.match(state.dms[0].payload.embeds[0].description,/shared:pw/);

 const listed=await (await bridge('/vending')).json();
 const found=listed.find(m=>m.id===machine.id).products.find(p=>p.id===product.id);
 assert.equal(found.stock_count,0,'the one unit was reserved for the claimant, not left for ordinary sale');
});
