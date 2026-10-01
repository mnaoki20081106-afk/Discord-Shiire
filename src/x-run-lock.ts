import type { Env } from "./types";
import type { XRunResult } from "./x-engine";
import { randomId } from "./crypto";
import { loadXSettings } from "./x-settings";

export type AssertFinancialLease = () => Promise<void>;

// Shared by manual runs, cron procurement and LTC rebalancing. A lease covers
// the whole balance/limit/read/order sequence, not only the HTTP POST.
export async function withFinancialRunLock(
  env:Env,
  run:(assertLease:AssertFinancialLease)=>Promise<XRunResult>
):Promise<XRunResult>{
  return withNamedRunLock(env,"x-finance",run,async()=>({
    action:"FINANCIAL_RUN_LOCKED",dryRun:(await loadXSettings(env)).dry_run
  }));
}

export async function withNamedRunLock<T>(
  env:Env,
  name:string,
  run:(assertLease:AssertFinancialLease)=>Promise<T>,
  busy:()=>Promise<T>
):Promise<T>{
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS financial_run_lock (id TEXT PRIMARY KEY,token TEXT NOT NULL,expires_at INTEGER NOT NULL)").run();
  const token=randomId(), now=Date.now();
  const acquired=await env.DB.prepare(
    "INSERT INTO financial_run_lock(id,token,expires_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE financial_run_lock.expires_at<?"
  ).bind(name,token,now+30*60_000,now).run();
  if(Number(acquired.meta.changes??0)!==1){
    return busy();
  }
  const assertLease=async()=>{
    const lease=await env.DB.prepare("SELECT token FROM financial_run_lock WHERE id=? AND token=? AND expires_at>?").bind(name,token,Date.now()).first();
    if(!lease) throw new Error("FINANCIAL_RUN_LEASE_LOST");
  };
  try{return await run(assertLease);}
  finally{
    await env.DB.prepare("DELETE FROM financial_run_lock WHERE id=? AND token=?").bind(name,token).run();
  }
}
