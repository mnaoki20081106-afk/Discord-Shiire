import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
const bundle=await build({stdin:{contents:`
import {ensureXSchema} from './src/x-db';
import {ensureShiireVendingSchema} from './src/shiire-vending-db';
import {shiireVendingSweep,reconcileShiireDelivery} from './src/shiire-vending';
import {encryptSensitive} from './src/x-crypto';
export default {async fetch(req,env){
 if(new URL(req.url).pathname==='/reconcile'){
   const input=await req.json();
   try{return Response.json(await reconcileShiireDelivery(env,input.orderId,input.messageId));}
   catch(error){return Response.json({error:error.message},{status:error.status??409});}
 }
 if(new URL(req.url).pathname==='/init'){
   await ensureXSchema(env);await ensureShiireVendingSchema(env);
   return Response.json(await encryptSensitive(env,'username:password:mail:mailpassword'));
 }
 await shiireVendingSweep(env);return Response.json({ok:true});
}};`,resolveDir:process.cwd(),sourcefile:'delivery-fixture.ts'},bundle:true,write:false,format:'esm',platform:'browser'});
async function fixture(t,mode){
  const calls=[];
  let recovery={};
  const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{CREDENTIALS_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),DISCORD_BOT_TOKEN:'fixture'},outboundService:async req=>{
    calls.push(req.url);
    if(req.url.endsWith('/users/@me'))return Response.json({id:'789'});
    if(req.url.endsWith('/channels/123/messages/456'))return Response.json({id:'456',channel_id:'123',nonce:'svdo',author:{id:'789'},...recovery});
    if(req.url.endsWith('/users/@me/channels'))return Response.json({id:'123'});
    if(req.url.endsWith('/channels/123/messages')){
      if(mode==='transport')throw new Error('response lost after sending');
      if(mode==='schema')return Response.json({});
      if(mode==='rejected')return Response.json({message:'Cannot send messages to this user'},{status:403});
      return Response.json({id:'456'});
    }
    throw new Error('Unexpected provider call');
  }});
  t.after(()=>mf.dispose());
  const cipher=await (await mf.dispatchFetch('https://fixture/init')).json();
  const db=await mf.getD1Database('DB');
  await db.batch([
    db.prepare("INSERT INTO shiire_vending_machines(id,guild_id,name,created_at,updated_at) VALUES ('vm','g','vm',1,1)"),
    db.prepare("INSERT INTO shiire_vending_products(id,vending_machine_id,supplier_product_id,procurement_class,name,price_paypay,stockless_enabled,created_at,updated_at) VALUES ('p','vm','1','NO_SHADOWBAN','p',100,1,1,1)"),
    db.prepare("INSERT INTO shiire_vending_orders(id,vending_machine_id,product_id,guild_id,user_id,payment_method,quantity,unit_price,total_amount,stockless,status,created_at,updated_at,paid_at) VALUES ('o','vm','p','g','u','paypay',1,100,100,1,'paid',1,1,1)"),
    db.prepare("INSERT INTO purchased_accounts(id,supplier,supplier_product_id,purchase_order_id,purchase_price,purchased_at,credentials_ciphertext,credential_fingerprint,status,procurement_class,created_at) VALUES ('a','manual','1','po',1,1,?,'fingerprint','VENDING_RESERVED','NO_SHADOWBAN',1)").bind(JSON.stringify(cipher)),
    db.prepare("INSERT INTO shiire_vending_reservations(account_id,order_id,product_id,reserved_at) VALUES ('a','o','p',1)")
  ]);
  const sweep=()=>mf.dispatchFetch('https://fixture/sweep');
  const status=async()=> (await db.prepare("SELECT status,delivery_message_id FROM shiire_vending_orders WHERE id='o'").first());
  const reconcile=()=>mf.dispatchFetch('https://fixture/reconcile',{method:'POST',body:JSON.stringify({orderId:'o',messageId:'456'})});
  return {db,calls,sweep,status,reconcile,setRecovery:patch=>{recovery=patch;}};
}
for(const mode of ['transport','schema'])test('ambiguous Discord '+mode+' result preserves stock and blocks automatic duplicate delivery',async t=>{
  const f=await fixture(t,mode);
  await f.sweep();assert.equal((await f.status()).status,'delivering');
  assert.equal((await f.db.prepare("SELECT status FROM purchased_accounts WHERE id='a'").first()).status,'VENDING_RESERVED');
  await f.sweep();assert.equal(f.calls.filter(url=>url.endsWith('/messages')).length,1);
  const log=await f.db.prepare("SELECT kind FROM audit_logs WHERE kind='SHIIRE_VENDING_DELIVERY_RESULT_UNKNOWN'").first();
  assert.ok(log);
});
test('definitive Discord rejection keeps the order paid for recovery',async t=>{
  const f=await fixture(t,'rejected');await f.sweep();
  assert.equal((await f.status()).status,'paid');
});
test('successful stockless delivery records message ID and consumes inventory exactly once',async t=>{
  const f=await fixture(t,'success');await f.sweep();
  const order=await f.status();assert.equal(order.status,'delivered');assert.equal(order.delivery_message_id,'456');
  await f.sweep();assert.equal(f.calls.filter(url=>url.endsWith('/messages')).length,1);
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM shiire_vending_reservations WHERE order_id='o'").first()).n,0);
});
test('unknown delivery can only be recovered from this bots matching order DM, without resending',async t=>{
  const f=await fixture(t,'schema');await f.sweep();
  for(const patch of [{nonce:'different_order'},{nonce:null},{author:{id:'other_bot'}},{channel_id:'other_channel'},{webhook_id:'123'}]){
    f.setRecovery(patch);assert.equal((await f.reconcile()).status,409);
    assert.equal((await f.status()).status,'delivering');
  }
  f.setRecovery({});assert.equal((await f.reconcile()).status,200);
  assert.equal((await f.status()).status,'delivered');
  assert.equal((await f.reconcile()).status,200);
  await f.sweep();assert.equal(f.calls.filter(url=>url.endsWith('/messages')).length,1);
  assert.equal((await f.db.prepare("SELECT sales_count FROM shiire_vending_products WHERE id='p'").first()).sales_count,1);
});
