import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

const secret='fixture-budget-bridge-secret-at-least-32-characters';
const bundle=await build({stdin:{contents:`import {handleShiireMainBridge} from './src/shiire-vending';
export default {async fetch(request,env){try{return await handleShiireMainBridge(request,env,new URL(request.url))??new Response('missing',{status:404});}catch(error){return Response.json({message:error.message},{status:error.status??500});}}};`,resolveDir:process.cwd(),sourcefile:'budget-bridge-fixture.ts'},bundle:true,write:false,format:'esm',platform:'browser'});

test('signed budget GET returns all three zero balances before any deposit or HStora configuration',async t=>{
 let externalCalls=0;
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{SHIIRE_BRIDGE_SECRET:secret},outboundService:async()=>{externalCalls++;throw new Error('Budget GET must not call HStora or Discord');}});
 t.after(()=>mf.dispose());
 const path='/bridge/main/guilds/123456789012345678/procurement-budget';
 const timestamp=String(Date.now()),nonce=randomUUID();
 const signature=createHmac('sha256',secret).update([timestamp,nonce,'GET',path,''].join('\n')).digest('hex');
 const response=await mf.dispatchFetch('https://fixture.example'+path,{headers:{'X-Shiire-Timestamp':timestamp,'X-Shiire-Nonce':nonce,'X-Shiire-Signature':signature}});
 assert.equal(response.status,200,await response.clone().text());
 const data=await response.json();
 assert.deepEqual(data.budget.available,{INVITE_CAMPAIGN:0,NO_SHADOWBAN:0,TOP_SEARCH:0});
 assert.equal(data.budget.totalAvailableUsd,0);
 assert.equal(data.budget.initialized,false);
 assert.equal(data.percentages.INVITE_CAMPAIGN+data.percentages.NO_SHADOWBAN+data.percentages.TOP_SEARCH,100);
 assert.equal(externalCalls,0);
});
