import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

const guild='123456789012345678',otherGuild='223456789012345678',secret='fixture-generator-stock-secret-longer-than-32-chars';
const encryptionKey=Buffer.alloc(32,7).toString('base64');
const bundle=await build({stdin:{contents:`import {handleShiireMainBridge} from './src/shiire-vending';
export default {async fetch(request,env){try{
 return await handleShiireMainBridge(request,env,new URL(request.url))??new Response('missing',{status:404});
}catch(error){return Response.json({message:error.message},{status:error.status??500});}}};`,resolveDir:process.cwd(),sourcefile:'generator-stock-fixture.ts'},bundle:true,write:false,format:'esm',platform:'browser'});

async function fixture(t){
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{SHIIRE_BRIDGE_SECRET:secret,CREDENTIALS_ENCRYPTION_KEY:encryptionKey,DISCORD_BOT_TOKEN:'fixture'},outboundService:async()=>Response.json({id:'fixture'})});
 t.after(()=>mf.dispose());
 const call=async(suffix,method='GET',payload,guildId=guild)=>{
  const path='/bridge/main/guilds/'+guildId+suffix,body=payload?JSON.stringify(payload):'',timestamp=String(Date.now()),nonce=randomUUID();
  const signature=createHmac('sha256',secret).update([timestamp,nonce,method,path,body].join('\n')).digest('hex');
  return mf.dispatchFetch('https://fixture.example'+path,{method,body:body||undefined,headers:{'X-Shiire-Timestamp':timestamp,'X-Shiire-Nonce':nonce,'X-Shiire-Signature':signature}});
 };
 const created=await call('/vending','POST',{name:'Stock fixture'});
 assert.equal(created.status,201,await created.clone().text());
 const machine=await created.json();
 const machines=await (await call('/vending')).json();
 const products=machines.find(row=>row.id===machine.id).products;
 return {call,machine,products};
}

test('generator accounts become sellable stock of the chosen vending product',async t=>{
 const {call,products}=await fixture(t);
 const shadow=products.find(p=>p.procurement_class==='NO_SHADOWBAN');
 const top=products.find(p=>p.procurement_class==='TOP_SEARCH');
 const path='/generator/products/'+shadow.id+'/stock';

 const empty=await (await call(path)).json();
 assert.equal(empty.stockCount,0);

 const first=await call(path,'POST',{items:['a:pw|a@x.test','b:pw|b@x.test','a:pw|a@x.test']});
 assert.equal(first.status,200,await first.clone().text());
 const firstBody=await first.json();
 assert.equal(firstBody.submitted,2,'duplicates inside one request are collapsed');
 assert.equal(firstBody.added,2);
 assert.equal(firstBody.stockCount,2);

 const again=await (await call(path,'POST',{items:['a:pw|a@x.test','c:pw|c@x.test']})).json();
 assert.equal(again.added,1,'an already stored credential is not added twice');
 assert.equal(again.stockCount,3);

 const other=await (await call('/generator/products/'+top.id+'/stock')).json();
 assert.equal(other.stockCount,0,'stock of the other class product is untouched');
 const listed=await (await call('/vending')).json();
 assert.equal(listed[0].products.find(p=>p.id===shadow.id).stock_count,3,'vending listing sees the new stock');
});

test('stock endpoints reject unknown products, other guilds and bad payloads',async t=>{
 const {call,products}=await fixture(t);
 const shadow=products.find(p=>p.procurement_class==='NO_SHADOWBAN');
 const path='/generator/products/'+shadow.id+'/stock';
 assert.equal((await call('/generator/products/missing/stock')).status,404);
 assert.equal((await call(path,'GET',undefined,otherGuild)).status,404);
 assert.equal((await call(path,'POST',{items:['x:y']},otherGuild)).status,404);
 assert.equal((await call(path,'POST',{items:[]})).status,400);
 assert.equal((await call(path,'POST',{items:Array.from({length:501},(_,i)=>'u'+i+':p')})).status,400);
});
