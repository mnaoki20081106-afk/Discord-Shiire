import type { Env } from "./types";
import { loadXSettings, saveXSettings, DEFAULT_X_SETTINGS, type XSettings } from "./x-settings";
import {
  inventorySummary,
  listAuditLogs,
  listPurchaseOrders,
  listSupplierProducts,
  todayPurchaseStats,
  ensureXSchema,
  auditX,
  listOpenCircuitBreakers,
  setCircuitBreaker
} from "./x-db";
import { getFundingPlan, jstPeriodStarts } from "./x-funding";
import { runXProcurement } from "./x-engine";
import {
  getBinanceApiRestrictions,
  getBinanceBalance,
  getBinanceLtcCoinInfo,
  getLtcJpyMarketStatus
} from "./providers/binance";
import {
  getHstoraBalance,
  listHstoraCatalog,
  getHstoraProduct
} from "./providers/hstora";

function json(data:unknown,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store"
    }
  });
}

async function requestJson(request:Request){
  try{return await request.json() as Record<string,unknown>;}
  catch{return null;}
}

function publicSettings(settings:XSettings){
  return settings;
}

function safePatch(input:Record<string,unknown>):Partial<XSettings>{
  const allowed=new Set(Object.keys(DEFAULT_X_SETTINGS));
  const out:Record<string,unknown>={};
  for(const [key,value] of Object.entries(input)){
    if(allowed.has(key)) out[key]=value;
  }
  return out as Partial<XSettings>;
}

async function settled<T>(fn:()=>Promise<T>){
  try{return {ok:true as const,data:await fn()};}
  catch(error){
    return {
      ok:false as const,
      error:error instanceof Error?error.message:String(error)
    };
  }
}

export async function handleXAdminApi(
  request:Request,
  env:Env,
  url:URL
):Promise<Response|null>{
  await ensureXSchema(env);

  if(url.pathname==="/api/x/settings"){
    if(request.method==="GET"){
      return json({settings:publicSettings(await loadXSettings(env))});
    }
    if(request.method==="PATCH"||request.method==="POST"||request.method==="PUT"){
      const raw=await requestJson(request);
      if(!raw) return json({error:"INVALID_JSON"},400);
      const current=await loadXSettings(env);
      const source=raw.settings&&typeof raw.settings==="object"
        ?raw.settings as Record<string,unknown>
        :raw;
      const patch=safePatch(source);
      if(current.dry_run===true&&patch.dry_run===false&&raw.confirmLive!==true){
        return json({error:"LIVE_MODE_CONFIRMATION_REQUIRED"},409);
      }
      if(current.emergency_stop===true&&patch.emergency_stop===false){
        return json({error:"USE_EMERGENCY_STOP_RESET_ENDPOINT"},409);
      }
      const settings=await saveXSettings(env,patch);
      return json({ok:true,settings:publicSettings(settings)});
    }
  }

  if(url.pathname==="/api/x/run"&&request.method==="POST"){
    return json(await runXProcurement(env));
  }

  if(url.pathname==="/api/x/products"&&request.method==="GET"){
    return json({products:await listSupplierProducts(env,false)});
  }

  const breakerReset=url.pathname.match(/^\/api\/x\/circuit-breakers\/([^/]+)\/reset$/);
  if(breakerReset&&request.method==="POST"){
    const key=decodeURIComponent(breakerReset[1]!);
    if(!/^[a-z0-9_-]{1,64}$/i.test(key)) return json({error:"INVALID_BREAKER_KEY"},400);
    await setCircuitBreaker(env,key,"CLOSED","ADMIN_RESET");
    return json({ok:true,key,state:"CLOSED"});
  }

  if(url.pathname==="/api/x/funding/paypay-observation"&&request.method==="POST"){
    const raw=await requestJson(request);
    const balanceJpy=Number(raw?.balanceJpy);
    if(!Number.isFinite(balanceJpy)||balanceJpy<0){
      return json({error:"INVALID_PAYPAY_BALANCE"},400);
    }
    const settings=await saveXSettings(env,{
      observed_paypay_balance_jpy:Math.floor(balanceJpy),
      observed_paypay_balance_at:Date.now()
    });
    await auditX(env,{
      kind:"paypay_balance_observed",
      message:"PayPay balance observation updated manually.",
      details:{balanceJpy:Math.floor(balanceJpy)}
    });
    return json({ok:true,settings:publicSettings(settings)});
  }

  if(url.pathname==="/api/x/funding/usd-jpy-observation"&&request.method==="POST"){
    const raw=await requestJson(request);
    const rate=Number(raw?.rate);
    if(!Number.isFinite(rate)||rate<=0){
      return json({error:"INVALID_USD_JPY_RATE"},400);
    }
    const settings=await saveXSettings(env,{
      usd_jpy_rate:rate,
      usd_jpy_rate_updated_at:Date.now()
    });
    await auditX(env,{
      kind:"usd_jpy_rate_observed",
      message:"USD/JPY observation updated manually.",
      details:{rate}
    });
    return json({ok:true,settings:publicSettings(settings)});
  }

  if(url.pathname==="/api/x/bulk-approval"&&request.method==="POST"){
    const raw=await requestJson(request);
    const minutes=Math.max(1,Math.min(60,Math.floor(Number(raw?.minutes??10))));
    const settings=await saveXSettings(env,{
      bulk_approval_until:Date.now()+minutes*60_000
    });
    return json({ok:true,approvedUntil:settings.bulk_approval_until});
  }

  if(url.pathname==="/api/x/funding/pending/cancel"&&request.method==="POST"){
    const current=await loadXSettings(env);
    const settings=await saveXSettings(env,{
      pending_paypay_funding_jpy:0,
      pending_paypay_binance_jpy_baseline:0,
      pending_paypay_requested_at:0
    });
    await auditX(env,{
      kind:"PAYPAY_FUNDING_CANCELLED",
      message:"Pending manual PayPay funding request was cancelled by admin.",
      details:{cancelledAmountJpy:current.pending_paypay_funding_jpy}
    });
    return json({ok:true,settings:publicSettings(settings)});
  }

  if(url.pathname==="/api/x/emergency-stop"&&request.method==="POST"){
    const settings=await saveXSettings(env,{
      emergency_stop:true,
      auto_purchase_enabled:false,
      auto_procurement_enabled:false
    });
    return json({ok:true,settings:publicSettings(settings)});
  }

  if(url.pathname==="/api/x/emergency-stop/reset"&&request.method==="POST"){
    const settings=await saveXSettings(env,{
      emergency_stop:false
    });
    return json({
      ok:true,
      settings:publicSettings(settings),
      note:"Automation remains disabled until separately enabled."
    });
  }

  if(url.pathname==="/api/x/dashboard"&&request.method==="GET"){
    const now=Date.now();
    const dayStart=jstPeriodStarts(now).day;
    const [settings,inventory,today,funding,hstora,market,ltc,jpy,circuitBreakers,recentLogs]=await Promise.all([
      loadXSettings(env),
      inventorySummary(env),
      todayPurchaseStats(env,dayStart),
      settled(()=>getFundingPlan(env,now)),
      settled(()=>getHstoraBalance(env)),
      settled(()=>getLtcJpyMarketStatus()),
      settled(()=>getBinanceBalance(env,"LTC")),
      settled(()=>getBinanceBalance(env,"JPY")),
      listOpenCircuitBreakers(env),
      listAuditLogs(env,50)
    ]);
    return json({
      generatedAt:now,
      settings:publicSettings(settings),
      funding,
      balances:{hstora,binanceLtc:ltc,binanceJpy:jpy},
      market,
      circuitBreakers,
      recentErrors:(recentLogs as any[])
        .filter(row=>String(row.level)==="error")
        .slice(0,10),
      inventory,
      today:{
        ...today,
        approximateJpy:
          settings.usd_jpy_rate>0&&
          settings.usd_jpy_rate_updated_at>0&&
          now-settings.usd_jpy_rate_updated_at<=settings.max_fx_age_ms
            ?today.amount*settings.usd_jpy_rate
            :null,
        approximateAverageJpy:
          settings.usd_jpy_rate>0&&
          settings.usd_jpy_rate_updated_at>0&&
          now-settings.usd_jpy_rate_updated_at<=settings.max_fx_age_ms
            ?today.average*settings.usd_jpy_rate
            :null
      },
      safety:{
        dryRun:settings.dry_run,
        emergencyStop:settings.emergency_stop,
        autoPurchaseEnabled:settings.auto_purchase_enabled,
        autoProcurementEnabled:settings.auto_procurement_enabled
      }
    });
  }

  if(url.pathname==="/api/x/binance"&&request.method==="GET"){
    const [market,restrictions,ltc,jpy,coinInfo]=await Promise.all([
      settled(()=>getLtcJpyMarketStatus()),
      settled(()=>getBinanceApiRestrictions(env)),
      settled(()=>getBinanceBalance(env,"LTC")),
      settled(()=>getBinanceBalance(env,"JPY")),
      settled(()=>getBinanceLtcCoinInfo(env))
    ]);
    return json({market,restrictions,balances:{ltc,jpy},coinInfo});
  }

  if(url.pathname==="/api/x/hstora"&&request.method==="GET"){
    const page=Math.max(1,Number(url.searchParams.get("page")??"1")||1);
    const [balance,catalog]=await Promise.all([
      settled(()=>getHstoraBalance(env)),
      settled(()=>listHstoraCatalog(env,page,20))
    ]);
    return json({balance,catalog});
  }

  if(url.pathname==="/api/x/hstora/product"&&request.method==="GET"){
    const id=Number(url.searchParams.get("id"));
    if(!Number.isInteger(id)||id<=0) return json({error:"INVALID_PRODUCT_ID"},400);
    const product=await settled(()=>getHstoraProduct(env,id));
    return json(product,product.ok?200:502);
  }

  if(url.pathname==="/api/x/inventory"&&request.method==="GET"){
    return json({
      summary:await inventorySummary(env),
      supplierProducts:await listSupplierProducts(env,false)
    });
  }

  if(url.pathname==="/api/x/orders"&&request.method==="GET"){
    return json({orders:await listPurchaseOrders(env,200)});
  }

  if(url.pathname==="/api/x/logs"&&request.method==="GET"){
    return json({logs:await listAuditLogs(env,200)});
  }

  return null;
}

export function xAdminPage():Response{
  const html=`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>X仕入れ管理</title>
<style>
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f5f7fb;background:#0b0d12}
*{box-sizing:border-box}
body{margin:0;background:#0b0d12}
header{position:sticky;top:0;z-index:5;padding:14px 16px;background:rgba(11,13,18,.94);backdrop-filter:blur(12px);border-bottom:1px solid #262a34}
h1{font-size:18px;margin:0 0 10px}
.auth{display:flex;gap:8px}
input,button,select{font:inherit}
input{min-width:0;flex:1;border:1px solid #353b49;border-radius:10px;padding:10px;background:#151922;color:#fff}
textarea{width:100%;min-height:48vh;border:1px solid #353b49;border-radius:10px;padding:10px;background:#0e1218;color:#e7ebf2;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
.formrow{display:flex;gap:8px;margin-top:10px}.formrow input{flex:1}.hint{color:#8f99aa;font-size:12px;line-height:1.5}
button{border:0;border-radius:10px;padding:10px 12px;background:#2b6ef2;color:white;font-weight:700}
button.danger{background:#d93b4a}
nav{display:flex;gap:7px;overflow:auto;padding:10px 14px;border-bottom:1px solid #262a34}
nav button{white-space:nowrap;background:#1a1f29;color:#cfd5e2}
nav button.active{background:#2b6ef2;color:#fff}
main{padding:14px;max-width:900px;margin:auto}
.card{background:#12161e;border:1px solid #252b36;border-radius:14px;padding:14px;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.metric{background:#171c25;border-radius:12px;padding:12px}
.metric small{display:block;color:#8f99aa;margin-bottom:4px}
.metric strong{font-size:18px}
pre{white-space:pre-wrap;word-break:break-word;font-size:12px;color:#cbd2df;max-height:55vh;overflow:auto}
.status{font-size:13px;color:#9fa9bb}
.good{color:#6fe49a}.warn{color:#ffd166}.bad{color:#ff7b87}
@media(min-width:700px){.grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
</style>
</head>
<body>
<header>
<h1>Xアカウント仕入れ管理 <span id="mode" class="status"></span></h1>
<div class="auth">
<input id="token" type="password" autocomplete="off" placeholder="ADMIN_TOKEN">
<button id="connect">接続</button>
<button id="stop" class="danger">EMERGENCY STOP</button>
</div>
</header>
<nav id="nav"></nav>
<main id="main"><div class="card">ADMIN_TOKENを入力して接続してください。</div></main>
<script>
const tabs=["Dashboard","Funding","Binance","LTC Wallet","HStora","Inventory","Orders","Logs","Settings"];
let current="Dashboard";
const token=document.querySelector("#token");
token.value=sessionStorage.getItem("shiireAdminToken")||"";
const main=document.querySelector("#main");
const nav=document.querySelector("#nav");
function esc(v){return String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;","'":"&#039;"}[m]))}
function headers(){return {"Authorization":"Bearer "+token.value.trim(),"Content-Type":"application/json"}}
async function api(path,opts={}){
 const r=await fetch(path,{...opts,headers:{...headers(),...(opts.headers||{})},cache:"no-store"});
 const text=await r.text(); let data; try{data=JSON.parse(text)}catch{data={raw:text}}
 if(!r.ok) throw new Error(data.message||data.error||("HTTP "+r.status));
 return data;
}
function drawNav(){
 nav.innerHTML="";
 tabs.forEach(t=>{const b=document.createElement("button");b.textContent=t;b.className=t===current?"active":"";b.onclick=()=>{current=t;drawNav();load()};nav.appendChild(b)});
}
function card(title,data){return '<section class="card"><strong>'+esc(title)+'</strong><pre>'+esc(JSON.stringify(data,null,2))+'</pre></section>'}
async function runNow(){const d=await api("/api/x/run",{method:"POST",body:"{}"});alert(JSON.stringify(d,null,2));await load()}
async function cancelPendingFunding(){await api("/api/x/funding/pending/cancel",{method:"POST",body:"{}"});await load()}
async function approveBulk(){await api("/api/x/bulk-approval",{method:"POST",body:JSON.stringify({minutes:10})});await load()}
async function resetEmergency(){await api("/api/x/emergency-stop/reset",{method:"POST",body:"{}"});await load()}
function metrics(data){
 const f=data.funding?.data?.allowance;
 const ready=data.inventory?.READY_FOR_DELIVERY??0;
 const err=(data.recentErrors?.length??0)+(data.circuitBreakers?.length??0);
 const todayJpy=data.today?.approximateJpy;
 const avgJpy=data.today?.approximateAverageJpy;
 return '<div class="grid">'+
  '<div class="metric"><small>PayPay使用可能額</small><strong>'+esc(f?.allowedJpy??0)+'円</strong></div>'+
  '<div class="metric"><small>LTC残高</small><strong>'+esc(data.balances?.binanceLtc?.data?.free??"-")+' LTC</strong></div>'+
  '<div class="metric"><small>HStora残高</small><strong>'+esc(data.balances?.hstora?.data?.balance??"-")+' USD</strong></div>'+
  '<div class="metric"><small>X垢在庫</small><strong>'+esc(ready)+'</strong></div>'+
  '<div class="metric"><small>本日の仕入数</small><strong>'+esc(data.today?.count??0)+'</strong></div>'+
  '<div class="metric"><small>本日の仕入金額</small><strong>'+(todayJpy==null?esc(data.today?.amount??0)+' USD':esc(Math.round(todayJpy))+'円')+'</strong></div>'+
  '<div class="metric"><small>平均仕入単価</small><strong>'+(avgJpy==null?esc(data.today?.average??0)+' USD':esc(Math.round(avgJpy))+'円')+'</strong></div>'+
  '<div class="metric"><small>エラー / Breaker</small><strong>'+esc(err)+'</strong></div>'+
  '<div class="metric"><small>自動仕入れ</small><strong>'+(data.safety?.autoProcurementEnabled?'ON':'OFF')+'</strong></div>'+
  '</div>';
}
async function observePayPay(){
 const value=Number(document.querySelector("#paypayBalance")?.value);
 await api("/api/x/funding/paypay-observation",{method:"POST",body:JSON.stringify({balanceJpy:value})});
 await load();
}
async function observeFx(){
 const value=Number(document.querySelector("#usdJpy")?.value);
 await api("/api/x/funding/usd-jpy-observation",{method:"POST",body:JSON.stringify({rate:value})});
 await load();
}
async function saveSettings(){
 const area=document.querySelector("#settingsJson");
 let value; try{value=JSON.parse(area.value)}catch{throw new Error("設定JSONが不正です")}
 const turningLive=value.dry_run===false;
 const confirmed=!turningLive||window.confirm("Dry RunをOFFにすると実資金が動く可能性があります。LIVEモードへ切り替えますか？");
 if(!confirmed) return;
 await api("/api/x/settings",{method:"PATCH",body:JSON.stringify({settings:value,confirmLive:turningLive})});
 await load();
}
async function load(){
 try{
  let data;
  if(current==="Dashboard"){
    data=await api("/api/x/dashboard");
    const s=data.settings||{};
    document.querySelector("#mode").textContent=s.dry_run?"DRY RUN":"LIVE";
    document.querySelector("#mode").className="status "+(s.dry_run?"good":"bad");
    main.innerHTML=metrics(data)+
      '<section class="card"><strong>手動実行</strong><p class="hint">Dry Run中は購入POSTを行いません。</p><button id="runNow">仕入れ判定を実行</button></section>'+
      card(current,data);
    document.querySelector("#runNow").onclick=()=>runNow().catch(e=>alert(e.message));
  }else if(current==="Funding"){
    data=await api("/api/x/dashboard");
    const s=data.settings||{};
    main.innerHTML=metrics(data)+
      '<section class="card"><strong>PayPay残高（手動観測）</strong>'+
      '<p class="hint">PayPay→Binance Japanの入金操作は公式Web/アプリ側で行い、ここには現在残高だけを記録します。古い観測値では自動購入枠は0円になります。</p>'+
      '<div class="formrow"><input id="paypayBalance" inputmode="numeric" type="number" min="0" step="1" value="'+esc(s.observed_paypay_balance_jpy??0)+'"><button id="savePayPay">観測値を保存</button></div>'+
      '</section>'+
      '<section class="card"><strong>USD/JPY（手動観測）</strong>'+
      '<p class="hint">HStoraのUSD建て価格をJPY上限と比較するための換算値です。期限切れなら価格判定を停止します。</p>'+
      '<div class="formrow"><input id="usdJpy" inputmode="decimal" type="number" min="0" step="0.001" value="'+esc(s.usd_jpy_rate??0)+'"><button id="saveFx">換算値を保存</button></div>'+
      '</section>'+
      (s.pending_paypay_funding_jpy>0
        ?'<section class="card"><strong>手動入金待ち</strong><p class="hint">要求額: '+esc(s.pending_paypay_funding_jpy)+'円 / Binance基準残高: '+esc(s.pending_paypay_binance_jpy_baseline)+'円</p><button id="cancelPending" class="danger">この入金要求を取消</button></section>'
        :'')+
      card("Funding detail",data.funding);
    const cancel=document.querySelector("#cancelPending"); if(cancel) cancel.onclick=()=>cancelPendingFunding().catch(e=>alert(e.message));
    document.querySelector("#savePayPay").onclick=()=>observePayPay().catch(e=>alert(e.message));
    document.querySelector("#saveFx").onclick=()=>observeFx().catch(e=>alert(e.message));
  }else if(current==="Binance"){data=await api("/api/x/binance");main.innerHTML=card(current,data)}
  else if(current==="HStora"){data=await api("/api/x/hstora");main.innerHTML=card(current,data)}
  else if(current==="Inventory"){data=await api("/api/x/inventory");main.innerHTML=card(current,data)}
  else if(current==="Orders"){data=await api("/api/x/orders");main.innerHTML=card(current,data)}
  else if(current==="Logs"){data=await api("/api/x/logs");main.innerHTML=card(current,data)}
  else if(current==="LTC Wallet"){
    main.innerHTML='<section class="card"><strong>LTC Wallet</strong><p class="status">専用ホットウォレットは現在無効です。秘密鍵をCloudflare Workerへ保存しません。</p></section>';
  }else{
    data=await api("/api/x/settings");
    main.innerHTML='<section class="card"><strong>Settings</strong><p class="hint">初期状態は dry_run=true / 自動購入OFF / 自動仕入れOFFです。設定変更だけでは秘密鍵やAPI Secretは保存されません。</p><textarea id="settingsJson"></textarea><div class="formrow"><button id="saveSettings">設定を保存</button></div><div class="formrow"><button id="approveBulk">大量購入を10分間承認</button><button id="resetEmergency">Emergency Stop解除</button></div></section>';
    document.querySelector("#settingsJson").value=JSON.stringify(data.settings,null,2);
    document.querySelector("#saveSettings").onclick=()=>saveSettings().catch(e=>alert(e.message));
    document.querySelector("#approveBulk").onclick=()=>approveBulk().catch(e=>alert(e.message));
    document.querySelector("#resetEmergency").onclick=()=>resetEmergency().catch(e=>alert(e.message));
  }
 }catch(e){main.innerHTML='<section class="card bad">'+esc(e.message)+'</section>'}
}
document.querySelector("#connect").onclick=()=>{sessionStorage.setItem("shiireAdminToken",token.value.trim());load()};
document.querySelector("#stop").onclick=async()=>{
 try{await api("/api/x/emergency-stop",{method:"POST",body:"{}"});await load()}catch(e){main.innerHTML='<section class="card bad">'+esc(e.message)+'</section>'}
};
drawNav(); if(token.value) load();
</script>
</body>
</html>`;
  return new Response(html,{
    headers:{
      "Content-Type":"text/html; charset=utf-8",
      "Cache-Control":"no-store",
      "Content-Security-Policy":"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "X-Frame-Options":"DENY",
      "X-Content-Type-Options":"nosniff",
      "Referrer-Policy":"no-referrer"
    }
  });
}
