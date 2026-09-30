import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
const bundle=await build({stdin:{contents:`
import {withFinancialRunLock} from './src/x-run-lock';
import {runXProcurement} from './src/x-engine';
import {ensureXSchema,createPurchaseOrderRecord} from './src/x-db';
import {saveXSettings} from './src/x-settings';
import {ensureShiireVendingSchema,cleanShiireVendingExpired,reserveShiireOrder} from './src/shiire-vending-db';
export default {async fetch(req,env){
 const u=new URL(req.url);
 if(u.pathname==='/init'){await ensureXSchema(env);await ensureShiireVendingSchema(env);await saveXSettings(env,{dry_run:false,auto_procurement_enabled:true});return Response.json({ok:true});}
 if(u.pathname==='/lock')return Response.json(await withFinancialRunLock(env,async check=>{await fetch('https://gate.example');await check();return {action:'RAN',dryRun:false};}));
 if(u.pathname==='/pending'){await createPurchaseOrderRecord(env,{supplier:'hstora',supplierProductId:'1',quantity:1,unitPrice:1,totalAmount:1,currency:'USD',externalOrderId:'pending',idempotencyKey:'pending',dryRun:false});return Response.json({ok:true});}
 if(u.pathname==='/run')return Response.json(await runXProcurement(env));
 if(u.pathname==='/expire'){await cleanShiireVendingExpired(env);return Response.json({ok:true});}
 if(u.pathname==='/reserve'){try{return Response.json(await reserveShiireOrder(env,{machine:{id:'vm'},product:{id:'p',supplier_product_id:'1',procurement_class:null,price_paypay:100,price_kyash:100},guildId:'g',userId:'u',method:'paypay',quantity:1,discount:0}));}catch(e){return new Response(String(e),{status:409});}}
 return new Response('missing',{status:404});
}};`,resolveDir:process.cwd(),sourcefile:'money-test.ts'},bundle:true,write:false,format:'esm',platform:'browser'});
const instances=[];after(async()=>{await Promise.all(instances.map(m=>m.dispose()));});
async function fixture(options={}){
 let release,started;
 const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r),calls=[];
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{HSTORA_API_KEY:'test',HSTORA_API_SECRET:'test'},outboundService:async req=>{
  calls.push(req.url);
  if(req.url==='https://gate.example/'){started();await gate;return new Response('ok');}
  if(req.url.includes('/orders/lookup'))return Response.json({data:{id:1,order_number:'1',external_order_id:'pending',status:options.status??'PROCESSING',quantity:1,unit_price:1,total_amount:1,currency:'USD',delivery_type:'instant',delivery:{available:false}}});
  return Response.json({error:'unexpected request'},{status:500});
 }});instances.push(mf);
 assert.equal((await mf.dispatchFetch('https://test/init')).status,200);
 return {mf,db:await mf.getD1Database('DB'),release,entered,calls};
}
test('concurrent financial runs execute the side effect only once',async()=>{
 const {mf,release,entered}=await fixture();const first=mf.dispatchFetch('https://test/lock');await entered;
 assert.equal((await (await mf.dispatchFetch('https://test/lock')).json()).action,'FINANCIAL_RUN_LOCKED');
 release();assert.equal((await (await first).json()).action,'RAN');
});
test('a lost lease cannot submit an order or delete a newer owner lock',async()=>{
 const {mf,db,release,entered}=await fixture();const first=mf.dispatchFetch('https://test/lock');await entered;
 await db.prepare("UPDATE financial_run_lock SET token='new-owner'").run();release();
 assert.equal((await first).status,500);
 assert.equal((await db.prepare('SELECT token FROM financial_run_lock').first()).token,'new-owner');
});
for(const status of ['PROCESSING','COMPLETED'])test('unavailable delivery blocks repurchase: '+status,async()=>{
 const {mf,calls}=await fixture({status});await mf.dispatchFetch('https://test/pending');
 const r=await (await mf.dispatchFetch('https://test/run')).json();assert.equal(r.action,'HSTORA_PENDING_ORDER');
 assert.equal(calls.length,1);assert.match(calls[0],/orders\/lookup/);
});
async function account(db){await db.prepare("INSERT INTO purchased_accounts(id,supplier,supplier_product_id,purchase_order_id,purchase_price,purchased_at,credentials_ciphertext,credential_fingerprint,status,created_at) VALUES ('a','hstora','1','po',1,1,'{}','fingerprint','READY_FOR_DELIVERY',1)").run();}
test('reservation insert failure rolls back the inventory claim',async()=>{
 const {mf,db}=await fixture();await account(db);
 await db.exec("CREATE TRIGGER fail_reserve BEFORE INSERT ON shiire_vending_reservations BEGIN SELECT RAISE(ABORT,'injected'); END;");
 assert.equal((await mf.dispatchFetch('https://test/reserve')).status,409);
 assert.equal((await db.prepare("SELECT status FROM purchased_accounts WHERE id='a'").first()).status,'READY_FOR_DELIVERY');
});
test('expiration failure rolls back account release',async()=>{
 const {mf,db}=await fixture();await account(db);
 await db.prepare("UPDATE purchased_accounts SET status='VENDING_RESERVED'").run();
 await db.prepare("INSERT INTO shiire_vending_orders(id,vending_machine_id,product_id,guild_id,user_id,payment_method,quantity,unit_price,total_amount,status,reserved_until,created_at,updated_at) VALUES ('o','vm','p','g','u','paypay',1,100,100,'awaiting_payment',1,1,1)").run();
 await db.prepare("INSERT INTO shiire_vending_reservations(account_id,order_id,product_id,reserved_at) VALUES ('a','o','p',1)").run();
 await db.exec("CREATE TRIGGER fail_expire BEFORE UPDATE ON shiire_vending_orders WHEN NEW.status='expired' BEGIN SELECT RAISE(ABORT,'injected'); END;");
 assert.equal((await mf.dispatchFetch('https://test/expire')).status,500);
 assert.equal((await db.prepare("SELECT status FROM purchased_accounts WHERE id='a'").first()).status,'VENDING_RESERVED');
});
