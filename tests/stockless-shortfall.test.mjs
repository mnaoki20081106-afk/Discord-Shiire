import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
const bundle=await build({stdin:{contents:`
import {ensureXSchema} from './src/x-db';
import {ensureShiireVendingSchema,reserveShiireOrder,getShiireProduct,markShiirePaid,tryReserveStocklessOrder,cleanShiireVendingExpired} from './src/shiire-vending-db';
export default {async fetch(req,env){try{
 const path=new URL(req.url).pathname;
 if(path==='/init'){await ensureXSchema(env);await ensureShiireVendingSchema(env);return Response.json({ok:true});}
 const input=await req.json();
 if(path==='/reserve')return Response.json(await reserveShiireOrder(env,{machine:{id:'vm'},product:await getShiireProduct(env,'p'),guildId:'g',userId:'u',discount:0,method:'paypay',...input}));
 if(path==='/paid'){await markShiirePaid(env,input.id);return Response.json({ok:true});}
 if(path==='/fill')return Response.json({filled:await tryReserveStocklessOrder(env,input.id)});
 if(path==='/expire'){await cleanShiireVendingExpired(env);return Response.json({ok:true});}
 return new Response('missing',{status:404});
}catch(e){return Response.json({error:e.message},{status:409});}}};`,resolveDir:process.cwd(),sourcefile:'shortfall-fixture.ts'},bundle:true,write:false,format:'esm',platform:'browser'});
async function fixture(t,stock=0){
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],d1Databases:['DB']});
 t.after(()=>mf.dispose());
 await mf.dispatchFetch('https://fixture/init');
 const db=await mf.getD1Database('DB');
 await db.prepare("INSERT INTO shiire_vending_machines(id,guild_id,name,created_at,updated_at) VALUES ('vm','g','vm',1,1)").run();
 await db.prepare("INSERT INTO shiire_vending_products(id,vending_machine_id,supplier_product_id,procurement_class,name,price_paypay,price_kyash,stockless_enabled,created_at,updated_at) VALUES ('p','vm','1','NO_SHADOWBAN','p',100,100,1,1,1)").run();
 let counter=0;
 const add=async count=>{for(let i=0;i<count;i++){
  const id='a'+(++counter);
  await db.prepare("INSERT INTO purchased_accounts(id,supplier,supplier_product_id,purchase_order_id,purchase_price,purchased_at,credentials_ciphertext,credential_fingerprint,status,procurement_class,created_at) VALUES (?,'hstora','1','po',1,1,'{}',?,'READY_FOR_DELIVERY','NO_SHADOWBAN',1)").bind(id,id).run();
 }};
 await add(stock);
 const call=async(path,input={})=>mf.dispatchFetch('https://fixture'+path,{method:'POST',body:JSON.stringify(input)});
 const held=async id=>Number((await db.prepare('SELECT COUNT(*) n FROM shiire_vending_reservations WHERE order_id=?').bind(id).first()).n);
 return {db,call,add,held};
}
test('sufficient inventory keeps ordinary PayPay/Kyash checkout',async t=>{
 const {call,held}=await fixture(t,4);
 for(const method of ['paypay','kyash']){
  const r=await call('/reserve',{quantity:2,method});assert.equal(r.status,200);
  const order=await r.json();assert.equal(order.stockless,0);assert.equal(await held(order.id),2);
 }
});
test('shortfall reserves existing units, rejects Kyash, and fills only missing slots',async t=>{
 const {call,held,add,db}=await fixture(t,2);
 const rejected=await call('/reserve',{quantity:5,method:'kyash'});
 assert.equal(rejected.status,409);assert.equal((await rejected.json()).error,'STOCKLESS_PAYPAY_ONLY');
 const order=await (await call('/reserve',{quantity:5})).json();
 assert.equal(order.stockless,1);assert.equal(await held(order.id),2);
 await call('/paid',{id:order.id});
 await add(1);assert.equal((await (await call('/fill',{id:order.id})).json()).filled,false);
 assert.equal(await held(order.id),3);
 await add(2);
 const responses=await Promise.all([call('/fill',{id:order.id}),call('/fill',{id:order.id})]);
 assert.ok(responses.every(r=>r.status===200));
 assert.equal(await held(order.id),5);
 assert.equal((await db.prepare('SELECT status FROM shiire_vending_orders WHERE id=?').bind(order.id).first()).status,'paid');
 await call('/fill',{id:order.id});assert.equal(await held(order.id),5);
});
test('zero inventory checkout and disabled stockless mode',async t=>{
 const {call,held,db}=await fixture(t);
 const order=await (await call('/reserve',{quantity:3})).json();assert.equal(order.stockless,1);assert.equal(await held(order.id),0);
 await db.prepare("UPDATE shiire_vending_products SET stockless_enabled=0").run();
 assert.equal((await call('/reserve',{quantity:1})).status,409);
});
test('expiring an unpaid mixed order releases its existing inventory',async t=>{
 const {call,db,held}=await fixture(t,2);
 const order=await (await call('/reserve',{quantity:4})).json();
 await db.prepare('UPDATE shiire_vending_orders SET reserved_until=1 WHERE id=?').bind(order.id).run();
 await call('/expire');assert.equal(await held(order.id),0);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM purchased_accounts WHERE status='READY_FOR_DELIVERY'").first()).n,2);
});
test('overlapping orders cannot share stock or overfill reservations',async t=>{
 const {call,held,db}=await fixture(t,3);
 const responses=await Promise.all([call('/reserve',{quantity:5}),call('/reserve',{quantity:5})]);
 const orders=await Promise.all(responses.map(r=>r.json()));
 for(const order of orders)assert.ok(order.id,JSON.stringify(order));
 assert.equal((await held(orders[0].id))+(await held(orders[1].id)),3);
 assert.equal((await db.prepare('SELECT COUNT(DISTINCT account_id) n FROM shiire_vending_reservations').first()).n,3);
});
