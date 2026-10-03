import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
const bundle=await build({stdin:{contents:`
import {withFinancialRunLock} from './src/x-run-lock';
import {runXProcurement,runXMaintenance} from './src/x-engine';
import {ensureXSchema,createPurchaseOrderRecord,rebalanceProcurementBudgets,setXSetting} from './src/x-db';
import {startDailyRestock,continueDailyRestock,handleDailyRestockCron,updateDailyRestockConfig,installDailyRestockPanel} from './src/x-daily-restock';
import {saveDailyRestockConfig,saveDailyRestockState,loadDailyRestockState} from './src/x-daily-restock-state';
import {handleXAdminApi} from './src/x-admin';
import {saveXSettings} from './src/x-settings';
import {ensureShiireVendingSchema,cleanShiireVendingExpired,reserveShiireOrder} from './src/shiire-vending-db';
export default {async fetch(req,env){
 const u=new URL(req.url);
 if(u.pathname==='/init'){await ensureXSchema(env);await ensureShiireVendingSchema(env);await saveXSettings(env,{dry_run:false,auto_procurement_enabled:true});return Response.json({ok:true});}
 if(u.pathname==='/lock')return Response.json(await withFinancialRunLock(env,async check=>{await fetch('https://gate.example');await check();return {action:'RAN',dryRun:false};}));
 if(u.pathname==='/pending'){await createPurchaseOrderRecord(env,{supplier:'hstora',supplierProductId:'1',quantity:1,unitPrice:1,totalAmount:1,currency:'USD',externalOrderId:'pending',idempotencyKey:'pending',dryRun:false});return Response.json({ok:true});}
 if(u.pathname==='/maintenance')return Response.json(await runXMaintenance(env));
 if(u.pathname==='/pause'){await saveXSettings(env,{auto_procurement_enabled:false,emergency_stop:u.searchParams.has('stop')});return Response.json({ok:true});}
 if(u.pathname==='/run')return Response.json(await runXProcurement(env));
 if(u.pathname==='/balance-run')return Response.json(await runXProcurement(env,{targetClasses:[]}));
 if(u.pathname==='/budget-init'){await rebalanceProcurementBudgets(env,100,{INVITE_CAMPAIGN:0,NO_SHADOWBAN:50,TOP_SEARCH:50});await setXSetting(env,'x_hstora_balance_guard',{hstoraUsd:100,allowedDecreaseUsd:0,updatedAt:Date.now()});return Response.json({ok:true});}
 if(u.pathname==='/budget-order'){try{await createPurchaseOrderRecord(env,{supplier:'hstora',supplierProductId:'1',quantity:1,unitPrice:60,totalAmount:60,currency:'USD',externalOrderId:u.searchParams.get('id')??'budget-order',idempotencyKey:u.searchParams.get('id')??'budget-order',dryRun:false,budgetCharges:{NO_SHADOWBAN:30,TOP_SEARCH:30}});return Response.json({ok:true});}catch(e){return new Response(String(e),{status:409});}}
 if(u.pathname==='/api/x/procurement-budget/rebalance')return handleXAdminApi(req,env,u);
 if(u.pathname==='/daily-running'){await saveDailyRestockState(env,{date_key:'2026-09-30',status:'running',started_at:Date.now(),completed_at:0,notified_at:0,initial_top_search:0,initial_no_shadowban:0,target_top_search:1,target_no_shadowban:1,final_top_search:0,final_no_shadowban:0,added_top_search:0,added_no_shadowban:0,last_action:'STARTED',error:''});return Response.json({ok:true});}
 if(u.pathname==='/daily-init'){await saveDailyRestockConfig(env,{top_search_target_stock:0,no_shadowban_target_stock:0,notification_channel_id:'123456789012345678'});return Response.json({ok:true});}
 if(u.pathname==='/daily-settings')return Response.json(await updateDailyRestockConfig(env,await req.json()));
 if(u.pathname==='/daily-panel')return Response.json(await installDailyRestockPanel(env));
 if(u.pathname==='/daily-cron')return Response.json(await handleDailyRestockCron(env,Number(u.searchParams.get('time'))));
 if(u.pathname==='/daily-start')return Response.json(await startDailyRestock(env));
 if(u.pathname==='/daily-continue')return Response.json(await continueDailyRestock(env));

 if(u.pathname==='/expire'){await cleanShiireVendingExpired(env);return Response.json({ok:true});}
 if(u.pathname==='/reserve'){try{return Response.json(await reserveShiireOrder(env,{machine:{id:'vm'},product:{id:'p',supplier_product_id:'1',procurement_class:null,price_paypay:100,price_kyash:100},guildId:'g',userId:'u',method:'paypay',quantity:1,discount:0}));}catch(e){return new Response(String(e),{status:409});}}
 return new Response('missing',{status:404});
}};`,resolveDir:process.cwd(),sourcefile:'money-test.ts'},bundle:true,write:false,format:'esm',platform:'browser'});
const instances=[];after(async()=>{await Promise.all(instances.map(m=>m.dispose()));});
async function fixture(options={}){
 let release,started;
 const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r),calls=[],messages=[];
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{HSTORA_API_KEY:'test',HSTORA_API_SECRET:'test',DISCORD_BOT_TOKEN:'test'},outboundService:async req=>{
  calls.push(req.url);
  if(req.url==='https://gate.example/'){started();await gate;return new Response('ok');}
  if(req.url.includes('/api/v1/balance'))return Response.json({success:true,data:{balance:options.balance??100,pending_balance:0,currency:'USD'}});
  if(req.url.includes('discord.com')){messages.push(await req.json());if(options.holdNotification){started();await gate;}return Response.json({id:'123456789012345679'});}
  if(req.url.includes('/orders/lookup'))return Response.json({success:true,data:{id:1,order_number:'1',external_order_id:'pending',status:options.status??'PROCESSING',quantity:1,unit_price:1,total_amount:1,currency:'USD',delivery_type:'instant',delivery:{available:false}}});
  return Response.json({error:'unexpected request'},{status:500});
 }});instances.push(mf);
 assert.equal((await mf.dispatchFetch('https://test/init')).status,200);
 return {mf,db:await mf.getD1Database('DB'),release,entered,calls,messages};
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
 const {mf,calls,db}=await fixture({status});await mf.dispatchFetch('https://test/pending');
 const r=await (await mf.dispatchFetch('https://test/run')).json();assert.equal(r.action,'HSTORA_PENDING_ORDER');
 assert.equal(calls.length,1);assert.match(calls[0],/orders\/lookup/);
 assert.equal((await db.prepare("SELECT status FROM purchase_orders WHERE external_order_id='pending'").first()).status,'PROCESSING');
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

test('deposit budget credit survives audit failure without crediting twice',async()=>{
 const {mf,db}=await fixture({balance:110});await mf.dispatchFetch('https://test/budget-init');
 await db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_logs WHEN NEW.kind='HSTORA_BALANCE_INCREASE' BEGIN SELECT RAISE(ABORT,'injected'); END;");
 await mf.dispatchFetch('https://test/balance-run');
 await db.exec("DROP TRIGGER fail_audit;");await db.prepare("UPDATE circuit_breakers SET state='CLOSED'").run();
 await mf.dispatchFetch('https://test/balance-run');
 assert.equal((await db.prepare('SELECT SUM(available_usd) n FROM procurement_budgets').first()).n,110);
});
test('overlapping daily executions publish one summary',async()=>{
 const {mf,db,calls,entered,release}=await fixture({holdNotification:true});await mf.dispatchFetch('https://test/daily-init');await notificationState(mf,db);
 const first=mf.dispatchFetch('https://test/daily-continue');await entered;
 const second=mf.dispatchFetch('https://test/daily-continue');
 // Flush the second invocation through its database operations before responding.
 const response=await Promise.race([second,new Promise(r=>setTimeout(()=>r(null),100))]);
 release();await first;await second;
 assert.equal(calls.filter(u=>u.includes('discord.com')).length,1);
 assert.ok(response,'overlap should promptly report a held daily lease');
});

test('order persistence failure rolls back the reserved category budgets',async()=>{
 const {mf,db}=await fixture();await mf.dispatchFetch('https://test/budget-init');
 await db.exec("CREATE TRIGGER fail_order BEFORE INSERT ON purchase_orders BEGIN SELECT RAISE(ABORT,'injected'); END;");
 assert.equal((await mf.dispatchFetch('https://test/budget-order')).status,409);
 assert.equal((await db.prepare('SELECT SUM(available_usd) n FROM procurement_budgets').first()).n,100);
});
test('simultaneous budget reservations cannot spend the same funds',async()=>{
 const {mf,db}=await fixture();await mf.dispatchFetch('https://test/budget-init');
 const replies=await Promise.all(['a','b'].map(id=>mf.dispatchFetch('https://test/budget-order?id='+id)));
 assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);
 assert.equal((await db.prepare('SELECT count(*) n FROM purchase_orders').first()).n,1);
 assert.equal((await db.prepare('SELECT SUM(available_usd) n FROM procurement_budgets').first()).n,40);
});
test('busy financial run keeps daily batch running and blocks admin rebalance',async()=>{
 const {mf,db,release,entered}=await fixture();await mf.dispatchFetch('https://test/daily-running');
 const held=mf.dispatchFetch('https://test/lock');await entered;
 try{
  assert.equal((await (await mf.dispatchFetch('https://test/daily-continue')).json()).action,'DAILY_RESTOCK_CONTINUES_NEXT_TICK');
  assert.equal(JSON.parse((await db.prepare("SELECT value_json FROM settings WHERE key='x_daily_restock_state'").first()).value_json).status,'running');
  assert.equal((await mf.dispatchFetch('https://test/api/x/procurement-budget/rebalance',{method:'POST',body:'{}'})).status,409);
 }finally{release();await held;}
});

test('public arrival notice lists sellable stock without internal target or budget fields',async()=>{
 const {mf,db,messages}=await fixture();await mf.dispatchFetch('https://test/daily-init');await notificationState(mf,db);
 await db.prepare("UPDATE purchased_accounts SET procurement_class='TOP_SEARCH' WHERE id='a'").run();
 await db.prepare("INSERT INTO purchased_accounts(id,supplier,supplier_product_id,purchase_order_id,purchase_price,purchased_at,credentials_ciphertext,credential_fingerprint,procurement_class,status,created_at) VALUES ('b','hstora','1','po',1,1,'{}','reserved-fingerprint','NO_SHADOWBAN','VENDING_RESERVED',1)").run();
 assert.equal((await mf.dispatchFetch('https://test/daily-continue')).status,200);
 assert.match(messages[0].content,/①Search Top \+ No shadow ban\*\n現在在庫 : 0個（\+0個）/);
 assert.match(messages[0].content,/②【Old】Top Search \+ No shadow ban\*\n現在在庫 : 1個（\+1個）/);
 assert.match(messages[0].content,/^@everyone/);
 assert.deepEqual(messages[0].allowed_mentions,{parse:['everyone']});
 assert.deepEqual(messages[0].embeds,[]);
 await mf.dispatchFetch('https://test/daily-continue');
 assert.equal(messages.length,1,'retry after successful notification must not send again');
 assert.doesNotMatch(JSON.stringify(messages[0]),/TARGET_NOT_REACHED|budget|恒常在庫未達/);
});

async function notificationState(mf,db){
 await mf.dispatchFetch('https://test/daily-running');await account(db);
 await db.prepare("UPDATE purchased_accounts SET procurement_class='TOP_SEARCH',created_at=? WHERE id='a'").bind(Date.now()+1000).run();
 const row=await db.prepare("SELECT value_json FROM settings WHERE key='x_daily_restock_state'").first();
 const state=JSON.parse(row.value_json);state.status='completed';
 await db.prepare("UPDATE settings SET value_json=? WHERE key='x_daily_restock_state'").bind(JSON.stringify(state)).run();
}
test('previous day notification at 18:00 does not skip todays restock',async()=>{
 const {mf,db}=await fixture();await mf.dispatchFetch('https://test/daily-init');await notificationState(mf,db);
 const at=Date.UTC(2026,9,1,9,0);
 await mf.dispatchFetch('https://test/daily-cron?time='+at);
 await mf.dispatchFetch('https://test/daily-cron?time='+(at+60000));
 const state=JSON.parse((await db.prepare("SELECT value_json FROM settings WHERE key='x_daily_restock_state'").first()).value_json);
 assert.equal(state.date_key,'2026-10-01');
 assert.equal((await (await mf.dispatchFetch('https://test/daily-cron?time='+(at+120000))).json()).action,'DAILY_RESTOCK_ALREADY_RAN');
});

for(const stopped of [false,true])test('paused procurement still credits deposits without purchasing; emergency stop='+stopped,async()=>{
 const {mf,db,calls}=await fixture({balance:110});
 await mf.dispatchFetch('https://test/budget-init');
 await mf.dispatchFetch('https://test/pause'+(stopped?'?stop':''));
 const first=await (await mf.dispatchFetch('https://test/maintenance')).json();
 assert.equal(first.action,'HSTORA_BALANCE_SYNCED');
 await mf.dispatchFetch('https://test/maintenance');
 assert.equal((await db.prepare('SELECT SUM(available_usd) n FROM procurement_budgets').first()).n,110);
 assert.equal(calls.some(url=>url.includes('/orders')),false);
});
test('maintenance uses the purchase lock so deposits cannot race budget changes',async()=>{
 const {mf,release,entered,calls}=await fixture();
 const held=mf.dispatchFetch('https://test/lock');await entered;
 try{
  assert.equal((await (await mf.dispatchFetch('https://test/maintenance')).json()).action,'FINANCIAL_RUN_LOCKED');
  assert.equal(calls.some(url=>url.includes('/balance')),false);
 }finally{release();await held;}
});

for(const mention of ['123456789012345680',''])test('daily arrival mention selection and silent preview: '+(mention||'none'),async()=>{
 const {mf,db,messages}=await fixture();
 await mf.dispatchFetch('https://test/daily-init');
 const updated=await mf.dispatchFetch('https://test/daily-settings',{method:'POST',body:JSON.stringify({notificationMention:mention,notificationMessage:'{mention} 通常 {normal_stock}個 (+{normal_added}) / Old {old_stock}個 (+{old_added})'})});
 assert.equal(updated.status,200);
 assert.equal((await updated.json()).config.notification_mention,mention);
 await mf.dispatchFetch('https://test/daily-panel');
 assert.deepEqual(messages[0].allowed_mentions,{parse:[]},'installing preview must not ping');
 await notificationState(mf,db);
 await mf.dispatchFetch('https://test/daily-continue');
 assert.equal(messages.length,3);
 assert.deepEqual(messages[1].allowed_mentions,{parse:[]},'updating tracked panel must not ping');
 assert.deepEqual(messages[2].allowed_mentions,mention?{roles:[mention]}:{parse:[]});
 assert.equal(messages[2].content,(mention?'<@&'+mention+'>':'')+' 通常 0個 (+0) / Old 1個 (+1)');
 await mf.dispatchFetch('https://test/daily-continue');
 assert.equal(messages.length,3);
});
