import type { Env } from './types';
import {
  prepareStocklessFunding,advanceFundingDraft,fundingOperationKey,
  type FundingDraft,type FundingDraftInput,type FundingStep,type FundingEvidence
} from './stockless-funding-preparation';

// Durable rehearsal state only. No real order table or provider is accessed.
export type FundingJob={
  draft:FundingDraft;
  revision:number;
  state:'ready'|'running'|'reconcile'|'rejected'|'complete'|'blocked'|'not_required';
  attemptId:string|null;
  leaseUntil:number|null;
  reason:string|null;
};
const TABLE='stockless_funding_rehearsals';
const steps:readonly string[]=['direct_purchase','transfer','supplier_credit','procurement','delivery'];
function stepOf(job:FundingJob):FundingStep{
  if(!steps.includes(job.draft.next)) throw new Error('FUNDING_JOB_NOT_ACTIONABLE');
  return job.draft.next as FundingStep;
}
async function schema(env:Env){
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    order_id TEXT PRIMARY KEY,input_json TEXT NOT NULL,job_json TEXT NOT NULL,
    revision INTEGER NOT NULL,updated_at INTEGER NOT NULL
  )`).run();
}
export async function getFundingRehearsal(env:Env,orderId:string):Promise<FundingJob>{
  await schema(env);
  const row=await env.DB.prepare(`SELECT job_json FROM ${TABLE} WHERE order_id=?`)
    .bind(orderId).first<{job_json:string}>();
  if(!row) throw new Error('FUNDING_JOB_NOT_FOUND');
  return JSON.parse(row.job_json) as FundingJob;
}
export async function createFundingRehearsal(env:Env,input:FundingDraftInput):Promise<FundingJob>{
  const draft=prepareStocklessFunding(input);
  // Canonical validated fields; ignore unrelated JSON properties and key order.
  const canonical=JSON.stringify({
    ...draft,confirmedPayPayMoneyJpy:input.confirmedPayPayMoneyJpy,
    minimumPurchaseJpy:input.minimumPurchaseJpy
  });
  const job:FundingJob={draft,revision:0,state:steps.includes(draft.next)?'ready':draft.next as FundingJob['state'],
    attemptId:null,leaseUntil:null,reason:draft.reason};
  await schema(env);
  await env.DB.prepare(`INSERT OR IGNORE INTO ${TABLE}(order_id,input_json,job_json,revision,updated_at) VALUES (?,?,?,0,?)`)
    .bind(draft.orderId,canonical,JSON.stringify(job),Date.now()).run();
  const row=await env.DB.prepare(`SELECT input_json,job_json FROM ${TABLE} WHERE order_id=?`)
    .bind(draft.orderId).first<{input_json:string;job_json:string}>();
  if(!row||row.input_json!==canonical) throw new Error('FUNDING_JOB_INPUT_CONFLICT');
  return JSON.parse(row.job_json) as FundingJob;
}
async function save(env:Env,old:FundingJob,next:FundingJob):Promise<FundingJob>{
  next={...next,revision:old.revision+1};
  const result=await env.DB.prepare(`UPDATE ${TABLE} SET job_json=?,revision=?,updated_at=? WHERE order_id=? AND revision=?`)
    .bind(JSON.stringify(next),next.revision,Date.now(),old.draft.orderId,old.revision).run();
  if(Number(result.meta.changes??0)!==1) throw new Error('FUNDING_JOB_CONCURRENT_UPDATE');
  return next;
}
export type FundingJobAction=
  |{action:'claim';revision:number}
  |{action:'uncertain';revision:number;attemptId:string}
  |{action:'rejected';revision:number;attemptId:string}
  |{action:'retry';revision:number}
  |{action:'confirm';revision:number;attemptId:string;step:FundingStep;evidence:FundingEvidence};

export async function updateFundingRehearsal(env:Env,orderId:string,event:FundingJobAction):Promise<FundingJob>{
  if(!event||!Number.isSafeInteger(event.revision)||event.revision<0) throw new Error('INVALID_JOB_EVENT');
  const job=await getFundingRehearsal(env,orderId);
  // Repeated successful confirmation is accepted even with the old revision.
  if(event.action==='confirm'&&job.draft.receipts[event.step]){
    advanceFundingDraft(job.draft,event.step,event.evidence);
    return job;
  }
  if(job.revision!==event.revision) throw new Error('FUNDING_JOB_CONCURRENT_UPDATE');
  const step=stepOf(job);
  if(event.action==='claim'){
    if(job.state==='running'&&job.leaseUntil!==null&&job.leaseUntil<=Date.now()){
      // Expiry proves only that the worker stopped waiting, not that a payment failed.
      return save(env,job,{...job,state:'reconcile',reason:'RESULT_UNKNOWN'});
    }
    if(job.state!=='ready') throw new Error('FUNDING_JOB_NOT_READY');
    return save(env,job,{...job,state:'running',attemptId:crypto.randomUUID(),leaseUntil:Date.now()+60_000,reason:null});
  }
  if(event.action==='retry'){
    if(job.state!=='rejected') throw new Error('FUNDING_RECONCILIATION_REQUIRED');
    return save(env,job,{...job,state:'ready',attemptId:null,leaseUntil:null,reason:null});
  }
  if(event.action!=='confirm'&&event.action!=='uncertain'&&event.action!=='rejected') throw new Error('INVALID_JOB_EVENT');
  if(!job.attemptId||event.attemptId!==job.attemptId) throw new Error('FUNDING_ATTEMPT_MISMATCH');
  if(job.state!=='running'&&job.state!=='reconcile') throw new Error('FUNDING_JOB_NOT_RUNNING');
  if(event.action==='uncertain') return save(env,job,{...job,state:'reconcile',leaseUntil:null,reason:'RESULT_UNKNOWN'});
  if(event.action==='rejected') return save(env,job,{...job,state:'rejected',leaseUntil:null,reason:'SIMULATED_DEFINITIVE_REJECTION'});
  if(event.step!==step) throw new Error('FUNDING_STAGE_MISMATCH');
  if(event.evidence.operationKey!==fundingOperationKey(orderId,step)) throw new Error('FUNDING_ORDER_REFERENCE_MISMATCH');
  const draft=advanceFundingDraft(job.draft,step,event.evidence);
  return save(env,job,{...job,draft,state:draft.next==='complete'?'complete':'ready',attemptId:null,leaseUntil:null,reason:null});
}

export async function handleFundingRehearsalApi(request:Request,env:Env,url:URL):Promise<Response|null>{
  const base='/api/x/funding/stockless/rehearsals';
  if(url.pathname!==base&&!url.pathname.startsWith(base+'/')) return null;
  const respond=(data:unknown,status=200)=>Response.json(data,{status});
  let input:Record<string,unknown>={};
  if(request.method==='POST'){
    try{input=await request.json() as Record<string,unknown>;}catch{return respond({error:'INVALID_JSON'},400);}
    if(!input||typeof input!=='object'||Array.isArray(input)) return respond({error:'INVALID_JSON'},400);
    if(input.live===true||input.dryRun===false||input.mode==='live') return respond({error:'LIVE_FUNDING_NOT_IMPLEMENTED'},409);
  }
  try{
    let job:FundingJob;
    if(url.pathname===base&&request.method==='POST') job=await createFundingRehearsal(env,input as unknown as FundingDraftInput);
    else{
      const id=url.pathname.slice(base.length+1);
      if(!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return respond({error:'INVALID_ORDER_ID'},400);
      if(request.method==='GET') job=await getFundingRehearsal(env,id);
      else if(request.method==='POST') job=await updateFundingRehearsal(env,id,input as unknown as FundingJobAction);
      else return respond({error:'METHOD_NOT_ALLOWED'},405);
    }
    return respond({simulation:true,live:false,providerCalls:0,job});
  }catch(error){
    const code=error instanceof Error?error.message:'FUNDING_JOB_ERROR';
    const status=code==='FUNDING_JOB_NOT_FOUND'?404:code.startsWith('INVALID_')?400:409;
    return respond({error:code},status);
  }
}
