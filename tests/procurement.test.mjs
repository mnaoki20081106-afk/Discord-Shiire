import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID,randomBytes} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

const secret='fixture-procurement-bridge-secret-32-characters+';
const key=randomBytes(32).toString('base64');
const guild='123456789012345678';
const bundle=await build({stdin:{contents:`
import {handleShiireMainBridge} from './src/shiire-vending';
import {transferHstoraAccounts,stockForClass,ensureProcurementSchema} from './src/procurement';
import {runAllProducts} from './src/engine';
import {encryptSensitive} from './src/x-crypto';
export default {async fetch(request,env){
 const u=new URL(request.url);
 try{
  if(u.pathname==='/transfer') return Response.json(await transferHstoraAccounts(env));
  if(u.pathname==='/stock') return Response.json({n:await stockForClass(env,u.searchParams.get('class'))});
  if(u.pathname==='/run-all') return Response.json(await runAllProducts(env,Number(u.searchParams.get('now'))));
  if(u.pathname==='/schema'){await ensureProcurementSchema(env);return Response.json({ok:true});}
  if(u.pathname==='/account'){
   const b=await request.json();
   const enc=JSON.stringify(await encryptSensitive(env,b.content));
   await env.DB.prepare("INSERT INTO purchased_accounts(id,supplier,supplier_product_id,purchase_order_id,purchase_price,purchased_at,credentials_ciphertext,credential_fingerprint,procurement_class,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
     .bind(b.id,'hstora',b.product??'1','po',1,1,enc,'fp-'+b.id,b.cls,'READY_FOR_DELIVERY',Date.now()).run();
   return Response.json({ok:true});
  }
  return await handleShiireMainBridge(request,env,u)??new Response('missing',{status:404});
 }catch(error){return Response.json({message:error.message},{status:error.status??500});}
}};`,resolveDir:process.cwd(),sourcefile:'procurement-fixture.ts'},bundle:true,write:false,format:'esm',platform:'browser'});

const instances=[];after(async()=>{await Promise.all(instances.map(m=>m.dispose()));});

async function fixture(options={}){
 const main={stock:{'prod-a':options.stockA??0,'prod-b':0},delivered:[],calls:[]};
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],
  bindings:{SHIIRE_BRIDGE_SECRET:secret,XACCOUNT_BOT_BASE_URL:'https://xaccount.example',CREDENTIALS_ENCRYPTION_KEY:key},
  outboundService:async req=>{
   const url=new URL(req.url);
   main.calls.push(req.method+' '+url.host+url.pathname);
   if(url.host==='xaccount.example'){
    if(url.pathname==='/api/vending/supply/catalog') return Response.json({products:[
     {product_id:'prod-a',product_name:'商品A',vending_machine_id:'vm1',vending_machine_name:'自販機1',guild_id:guild,available:main.stock['prod-a']},
     {product_id:'prod-b',product_name:'商品B',vending_machine_id:'vm1',vending_machine_name:'自販機1',guild_id:guild,available:main.stock['prod-b']}
    ]});
    const stock=url.pathname.match(/^\/api\/vending\/supply\/products\/([^/]+)\/stock$/);
    if(stock){
     if(options.stockDown) return Response.json({error:'down'},{status:503});
     return Response.json({productId:stock[1],name:'x',available:main.stock[stock[1]]??0,infinite:false});
    }
    if(url.pathname==='/api/vending/supply/deliver'){
     const body=await req.json();
     const seen=main.delivered.find(row=>row.idempotencyKey===body.idempotencyKey);
     if(seen) return Response.json({ok:true,productId:body.productId,added:seen.items.length,duplicateRequest:true});
     main.delivered.push(body);main.stock[body.productId]=(main.stock[body.productId]??0)+body.items.length;
     return Response.json({ok:true,productId:body.productId,added:body.items.length});
    }
   }
   if(url.host==='supplier.example'&&url.pathname==='/api/acquire'){
    const body=await req.json();
    main.acquireAuth=req.headers.get('Authorization');
    return Response.json({items:Array.from({length:body.quantity},(_,i)=>body.sku+'-'+Date.now()+'-'+i)});
   }
   return Response.json({error:'unexpected '+url.host+url.pathname},{status:500});
  }});
 instances.push(mf);
 const db=await mf.getD1Database('DB');
 const call=async(method,path,body)=>{
  const full='/bridge/main/guilds/'+guild+path;
  const raw=body===undefined?'':JSON.stringify(body);
  const ts=String(Date.now()),nonce=randomUUID().replace(/-/g,'');
  const sig=createHmac('sha256',secret).update([ts,nonce,method,full,raw].join('\n')).digest('hex');
  const response=await mf.dispatchFetch('https://shiire.example'+full,{method,body:raw||undefined,headers:{'X-Shiire-Timestamp':ts,'X-Shiire-Nonce':nonce,'X-Shiire-Signature':sig,'Content-Type':'application/json'}});
  return {status:response.status,body:await response.json()};
 };
 return {mf,db,main,call};
}

test('legacy HSTORA settings migrate once into a supplier and two disabled items, even with concurrent first requests',async()=>{
 const {call}=await fixture();
 const [a,b,c]=await Promise.all([call('GET','/procurement'),call('GET','/procurement'),call('GET','/procurement')]);
 for(const r of [a,b,c]) assert.equal(r.status,200,JSON.stringify(r.body));
 const {body}=await call('GET','/procurement');
 assert.equal(body.suppliers.filter(s=>s.template==='hstora').length,1);
 const hstoraItems=body.items.filter(i=>i.template==='hstora');
 assert.deepEqual(hstoraItems.map(i=>i.condition.class).sort(),['NO_SHADOWBAN','TOP_SEARCH']);
 assert.ok(hstoraItems.every(i=>!i.enabled&&!i.mainProductId),'migrated items wait for a destination');
 assert.deepEqual(body.templates.map(t=>t.id),['hstora','custom_api','manual']);
 assert.equal(body.restockTime,'18:00');
});

test('supplier secrets are stored encrypted and never returned; insecure URLs are rejected',async()=>{
 const {call,db}=await fixture();
 const bad=await call('POST','/procurement/suppliers',{name:'X',template:'custom_api',config:{baseUrl:'http://supplier.example'}});
 assert.equal(bad.status,400);
 const created=await call('POST','/procurement/suppliers',{name:'Supplier X',template:'custom_api',config:{baseUrl:'https://supplier.example',acquirePath:'/api/acquire'},secrets:{apiKey:'super-secret-key'}});
 assert.equal(created.status,201,JSON.stringify(created.body));
 assert.deepEqual(created.body.configuredSecrets,['apiKey']);
 assert.equal(JSON.stringify(created.body).includes('super-secret-key'),false);
 const row=await db.prepare('SELECT config_json,secrets_enc FROM suppliers WHERE id=?').bind(created.body.id).first();
 assert.equal(row.config_json.includes('super-secret-key'),false);
 assert.equal(row.secrets_enc.includes('super-secret-key'),false);
 // A blank secret on edit keeps the stored key.
 const renamed=await call('PATCH','/procurement/suppliers/'+created.body.id,{name:'Supplier Y',config:{baseUrl:'https://supplier.example',acquirePath:'/api/acquire'},secrets:{apiKey:''}});
 assert.equal(renamed.status,200,JSON.stringify(renamed.body));
 assert.deepEqual(renamed.body.configuredSecrets,['apiKey']);
 const dup=await call('POST','/procurement/suppliers',{name:'HSTORA 2',template:'hstora',secrets:{apiKey:'a',apiSecret:'b'}});
 assert.equal(dup.status,409,'only one HSTORA supplier');
});

test('item validation: thresholds, budget total, HSTORA class uniqueness, destination required to enable',async()=>{
 const {call}=await fixture();
 const {body}=await call('GET','/procurement');
 const hstora=body.suppliers.find(s=>s.template==='hstora');
 const top=body.items.find(i=>i.condition.class==='TOP_SEARCH');
 assert.equal((await call('PATCH','/procurement/items/'+top.id,{minStock:5,targetStock:3})).status,400);
 assert.equal((await call('PATCH','/procurement/items/'+top.id,{enabled:true})).status,400,'needs a destination');
 assert.equal((await call('PATCH','/procurement/items/'+top.id,{mainProductId:'missing'})).status,400);
 const other=body.items.find(i=>i.condition.class==='NO_SHADOWBAN');
 assert.equal((await call('PATCH','/procurement/items/'+top.id,{budgetPercent:60})).status,400,'migrated 50 + 60 > 100');
 assert.equal((await call('PATCH','/procurement/items/'+other.id,{budgetPercent:40})).status,200);
 const ok=await call('PATCH','/procurement/items/'+top.id,{mainProductId:'prod-a',enabled:true,minStock:2,targetStock:5,budgetPercent:60});
 assert.equal(ok.status,200,JSON.stringify(ok.body));
 assert.equal(ok.body.destinationLabel,'自販機1 / 商品A');
 assert.equal((await call('PATCH','/procurement/items/'+other.id,{budgetPercent:50})).status,400,'60+50 > 100');
 assert.equal((await call('PATCH','/procurement/items/'+top.id,{maxStock:4})).status,400,'max stock below target');
 const sameClass=await call('POST','/procurement/items',{name:'dup',supplierId:hstora.id,condition:{class:'TOP_SEARCH'}});
 assert.equal(sameClass.status,409);
});

test('HSTORA accounts move to the destination product once, and the stock count includes the destination',async()=>{
 const {mf,call,main}=await fixture({stockA:3});
 const {body}=await call('GET','/procurement');
 const top=body.items.find(i=>i.condition.class==='TOP_SEARCH');
 await call('PATCH','/procurement/items/'+top.id,{mainProductId:'prod-a',enabled:true,minStock:2,targetStock:5});
 // Without a parsable format the account is held for review, never sold broken.
 for(const [id,content] of [['a1','unknown-format-line'],['a2','unknown-2']]){
  await mf.dispatchFetch('https://t/account',{method:'POST',body:JSON.stringify({id,cls:'TOP_SEARCH',content})});
 }
 const first=await (await mf.dispatchFetch('https://t/transfer')).json();
 assert.equal(first[0].transferred,0);
 assert.equal(first[0].skipped,2);
 assert.equal(main.delivered.length,0);
 assert.equal((await (await mf.dispatchFetch('https://t/stock?class=TOP_SEARCH')).json()).n,3,'review accounts are not counted as sellable');
});

test('a failed destination lookup is an error, not an empty stock that would trigger buying',async()=>{
 const {mf,call}=await fixture({stockDown:true});
 const {body}=await call('GET','/procurement');
 const top=body.items.find(i=>i.condition.class==='TOP_SEARCH');
 await call('PATCH','/procurement/items/'+top.id,{mainProductId:'prod-a',enabled:true});
 const response=await mf.dispatchFetch('https://t/stock?class=TOP_SEARCH');
 assert.equal(response.status,500);
});

test('generic items run once a day at the shared time, respect the max stock and send the dashboard API key',async()=>{
 const {mf,call,main}=await fixture({stockA:1});
 const supplier=(await call('POST','/procurement/suppliers',{name:'S',template:'custom_api',config:{baseUrl:'https://supplier.example',acquirePath:'/api/acquire'},secrets:{apiKey:'k-123'}})).body;
 const item=await call('POST','/procurement/items',{name:'A',supplierId:supplier.id,condition:{sku:'SKU1'},mainProductId:'prod-a',enabled:true,minStock:3,targetStock:4,maxStock:4,maxBatch:50});
 assert.equal(item.status,201,JSON.stringify(item.body));
 const day=Date.UTC(2026,10,20,0,0); // 09:00 JST
 assert.deepEqual(await (await mf.dispatchFetch('https://t/run-all?now='+day)).json(),[],'before 18:00 JST nothing runs');
 const at=Date.UTC(2026,10,20,9,1); // 18:01 JST
 const ran=await (await mf.dispatchFetch('https://t/run-all?now='+at)).json();
 assert.equal(ran.length,1);
 assert.equal(ran[0].action,'restocked');
 assert.equal(main.delivered[0].items.length,3,'fills up to the target: 4-1=3');
 assert.equal(main.acquireAuth,'Bearer k-123');
 const again=await (await mf.dispatchFetch('https://t/run-all?now='+(at+60_000))).json();
 assert.equal(again.length,0,'once per day');
 assert.equal((await call('POST','/procurement/restock-time',{restockTime:'25:00'})).status,400);
 assert.equal((await call('POST','/procurement/restock-time',{restockTime:'07:30'})).body.restockTime,'07:30');
});

test('readable HSTORA accounts are delivered to the destination once and retries are no-ops',async()=>{
 const {mf,call,main,db}=await fixture({stockA:0});
 const {body}=await call('GET','/procurement');
 const top=body.items.find(i=>i.condition.class==='TOP_SEARCH');
 await call('PATCH','/procurement/items/'+top.id,{mainProductId:'prod-a',enabled:true,minStock:1,targetStock:5});
 const line='alice_x:Passw0rd!:alice@example.com:MailPass1:0123456789abcdef0123456789abcdef01234567:JBSWY3DPEHPK3PXP';
 await mf.dispatchFetch('https://t/account',{method:'POST',body:JSON.stringify({id:'ok1',cls:'TOP_SEARCH',product:'119',content:line})});
 await mf.dispatchFetch('https://t/account',{method:'POST',body:JSON.stringify({id:'other',cls:'NO_SHADOWBAN',product:'119',content:line+'x'})});
 const first=await (await mf.dispatchFetch('https://t/transfer')).json();
 assert.equal(first.length,1,'only the item with a destination transfers');
 assert.equal(first[0].transferred,1,JSON.stringify(first));
 assert.equal(main.delivered[0].productId,'prod-a');
 assert.equal(main.delivered[0].items.length,1);
 assert.equal((await db.prepare("SELECT status FROM purchased_accounts WHERE id='ok1'").first()).status,'TRANSFERRED_TO_MAIN');
 assert.equal((await db.prepare("SELECT status FROM purchased_accounts WHERE id='other'").first()).status,'READY_FOR_DELIVERY');
 await mf.dispatchFetch('https://t/transfer');
 assert.equal(main.delivered.length,1,'nothing is re-sent');
 assert.equal((await (await mf.dispatchFetch('https://t/stock?class=TOP_SEARCH')).json()).n,1,'counted once (destination)');
});
