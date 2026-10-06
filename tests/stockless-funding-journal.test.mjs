import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
const bundle=await build({stdin:{contents:`import {handleFundingRehearsalApi} from './src/stockless-funding-journal';
export default {async fetch(req,env){return await handleFundingRehearsalApi(req,env,new URL(req.url))??new Response('missing',{status:404});}};`,resolveDir:process.cwd(),sourcefile:'journal-fixture.ts'},bundle:true,write:false,format:'esm',platform:'browser'});
const input={orderId:'order_1',quantity:5,reservedQuantity:2,saleAmountJpy:1500,confirmedPayPayMoneyJpy:1500,directPurchaseJpy:1000,minimumPurchaseJpy:1000};
async function fixture(t){
  const calls=[];
  const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-06',d1Databases:['DB'],outboundService:async req=>{calls.push(req.url);throw new Error('Unexpected provider call');}});
  t.after(()=>mf.dispose());
  const base='https://fixture/api/x/funding/stockless/rehearsals';
  const call=(id,body)=>mf.dispatchFetch(base+(id?'/'+id:''),body===undefined?{}:{method:'POST',body:JSON.stringify(body)});
  const event=body=>call(input.orderId,body);
  const read=async()=> (await (await call(input.orderId)).json()).job;
  const create=async(patch={})=> (await (await call('',{...input,...patch})).json()).job;
  return {calls,call,event,read,create,db:await mf.getD1Database('DB')};
}
function confirmation(job){
  const step=job.draft.next;
  return {action:'confirm',revision:job.revision,attemptId:job.attemptId,step,evidence:{
    operationKey:`simulation:${input.orderId}:${step}`,providerReference:`simulation:${input.orderId}:${step}:ok`,
    ...(step==='direct_purchase'?{spentJpy:1000,acquiredLtcAtomic:100}:{}),
    ...(step==='transfer'?{transferredLtcAtomic:90,feeLtcAtomic:10}:{}),
    ...(step==='supplier_credit'?{creditedUsdMicros:1000000}:{}),
    ...(step==='procurement'?{quantity:3}:{}),
    ...(step==='delivery'?{quantity:5}:{})
  }};
}
test('durable shortfall workflow resumes from storage, confirms each stage and rejects conflicting replays',async t=>{
  const f=await fixture(t);
  await f.create();
  let finalEvent;
  for(const step of ['direct_purchase','transfer','supplier_credit','procurement','delivery']){
    let job=await f.read();assert.equal(job.draft.next,step);assert.equal(job.state,'ready');
    assert.equal((await f.event({action:'claim',revision:job.revision})).status,200);
    // Each fetch reloads durable state; no in-memory draft is carried across requests.
    job=await f.read();finalEvent=confirmation(job);
    assert.equal((await f.event(finalEvent)).status,200);
    const revision=(await f.read()).revision;
    assert.equal((await f.event(finalEvent)).status,200);
    assert.equal((await f.read()).revision,revision);
  }
  assert.equal((await f.read()).state,'complete');
  assert.equal((await f.event({...finalEvent,evidence:{...finalEvent.evidence,quantity:6}})).status,409);
  assert.equal((await f.create()).state,'complete');
  assert.equal((await f.call('',{...input,quantity:6})).status,409);
  assert.deepEqual(f.calls,[]);
  const tables=(await f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results;
  assert.deepEqual(tables.map(x=>x.name),['stockless_funding_rehearsals']);
});
test('concurrent claims have one winner and old attempts cannot confirm a retry',async t=>{
  const f=await fixture(t);await f.create();
  const results=await Promise.all([f.event({action:'claim',revision:0}),f.event({action:'claim',revision:0})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const old=await f.read();
  assert.equal((await f.event({action:'rejected',revision:old.revision,attemptId:old.attemptId})).status,200);
  let job=await f.read();
  assert.equal((await f.event({action:'retry',revision:job.revision})).status,200);
  job=await f.read();await f.event({action:'claim',revision:job.revision});
  job=await f.read();assert.notEqual(job.attemptId,old.attemptId);
  assert.equal((await f.event({...confirmation(old),revision:job.revision})).status,409);
  assert.equal((await f.event(confirmation(job))).status,200);
});
test('unknown results and worker crashes require reconciliation, not a second purchase',async t=>{
  const f=await fixture(t);await f.create();await f.event({action:'claim',revision:0});
  let job=await f.read();
  await f.event({action:'uncertain',revision:job.revision,attemptId:job.attemptId});
  job=await f.read();assert.equal(job.state,'reconcile');
  for(const action of ['claim','retry']) assert.equal((await f.event({action,revision:job.revision})).status,409);
  assert.equal((await f.event(confirmation(job))).status,200);
  job=await f.read();await f.event({action:'claim',revision:job.revision});
  job=await f.read();job.leaseUntil=1;
  await f.db.prepare('UPDATE stockless_funding_rehearsals SET job_json=? WHERE order_id=?').bind(JSON.stringify(job),input.orderId).run();
  await f.event({action:'claim',revision:job.revision});
  const recovered=await f.read();assert.equal(recovered.state,'reconcile');assert.equal(recovered.attemptId,job.attemptId);
  assert.equal((await f.event({action:'claim',revision:recovered.revision})).status,409);
  assert.equal((await f.event(confirmation(recovered))).status,200);
});
test('in-stock, blocked amounts and live flags cannot start a rehearsal stage',async t=>{
  const f=await fixture(t);
  let job=await f.create({reservedQuantity:5});assert.equal(job.state,'not_required');
  assert.equal((await f.event({action:'claim',revision:0})).status,409);
  for(const flags of [{live:true},{dryRun:false},{mode:'live'}]){
    assert.equal((await f.call('',{...input,...flags})).status,409);
    assert.equal((await f.event({action:'claim',revision:0,...flags})).status,409);
  }
  assert.equal((await f.call('missing')).status,404);
  assert.equal((await f.call('',{...input,orderId:'low',directPurchaseJpy:200})).status,200);
  assert.equal((await (await f.call('low')).json()).job.state,'blocked');
  assert.equal((await f.call('low',{action:'claim',revision:0})).status,409);
  assert.deepEqual(f.calls,[]);
});
