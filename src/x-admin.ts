import type { Env } from "./types";
import { loadXSettings, saveXSettings, type XSettings } from "./x-settings";
import { fundingModeLabel, isBinanceAutoFundingServerEnabled } from "./x-funding-mode";
import {
  inventorySummary,
  listAuditLogs,
  listPurchaseOrders,
  listSupplierProducts,
  todayPurchaseStats,
  ensureXSchema,
  auditX,
  listOpenCircuitBreakers,
  setCircuitBreaker,
  getProcurementBudgets,
  rebalanceProcurementBudgets,
  pendingPurchaseOrders,
  setXSetting,
  circuitState
} from "./x-db";
import {
  confirmPendingDirectLtcFunding,
  getFundingPlan,
  jstPeriodStarts
} from "./x-funding";
import { runLtcAutoPurchase, runXProcurement } from "./x-engine";
import {
  getInviteCampaignDashboard,
  saveInviteCampaignSettings
} from "./invite-campaign-db";
import { seedInviteCampaignSnapshot } from "./invite-campaign";
import {
  reconcileInviteCampaignRewards,
  retryInviteCampaignReward
} from "./invite-campaign-rewards";
import {
  ensureInviteCampaignGateway,
  stopInviteCampaignGateway
} from "./invite-gateway";
import {
  getBinanceApiRestrictions,
  getBinanceBalance,
  getBinanceLtcCoinInfo,
  getBinanceWithdrawalSafetyStatus,
  getLtcJpyMarketStatus
} from "./providers/binance";
import {
  getHstoraBalance,
  listHstoraCatalog,
  getHstoraProduct
} from "./providers/hstora";
import {
  getDailyRestockDashboard,
  installDailyRestockPanel,
  startDailyRestock,
  updateDailyRestockConfig
} from "./x-daily-restock";

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

const DIRECT_EDITABLE_SETTING_KEYS=new Set<keyof XSettings>([
  "dry_run","emergency_stop","auto_purchase_enabled","auto_procurement_enabled","funding_mode",
  "reserve_jpy","max_purchase_jpy","daily_purchase_limit_jpy",
  "weekly_purchase_limit_jpy","monthly_purchase_limit_jpy","min_purchase_jpy",
  "target_ltc_balance","max_ltc_balance","wallet_target_ltc","wallet_max_ltc",
  "max_unit_price_jpy","max_no_shadowban_unit_price_usd",
  "procurement_strategy","search_visibility_requirement",
  "reorder_point","target_stock","no_shadowban_reorder_point",
  "no_shadowban_target_stock","max_batch_purchase",
  "min_seller_rating","min_product_reviews","min_sales_count",
  "max_dispute_rate","minimum_stock","trial_purchase_count",
  "seller_quality_mode","approved_hstora_product_ids",
  "max_paypay_balance_age_ms","max_fx_age_ms","max_fx_jump_percent",
  "max_price_jump_percent","max_ltc_price_jump_percent",
  "require_bulk_confirmation","bulk_confirmation_threshold"
]);

function publicSettings(settings:XSettings){
  const out:Record<string,unknown>={};
  for(const [key,value] of Object.entries(settings)){
    // Pending funding snapshots are runtime-owned state. They are exposed via
    // getFundingPlan(), not as editable Settings JSON.
    if(key.startsWith("pending_paypay_")) continue;
    if(
      key==="invite_campaign_budget_percent"||
      key==="no_shadowban_budget_percent"||
      key==="top_search_budget_percent"
    ) continue;
    out[key]=value;
  }
  return out;
}

function safePatch(input:Record<string,unknown>):Partial<XSettings>{
  const out:Record<string,unknown>={};
  for(const [key,value] of Object.entries(input)){
    if(DIRECT_EDITABLE_SETTING_KEYS.has(key as keyof XSettings)){
      out[key]=value;
    }
  }
  return out as Partial<XSettings>;
}

function procurementBudgetPercentages(settings:XSettings){
  return {
    INVITE_CAMPAIGN:settings.invite_campaign_budget_percent,
    NO_SHADOWBAN:settings.no_shadowban_budget_percent,
    TOP_SEARCH:settings.top_search_budget_percent
  };
}

async function syncHstoraBudgetBaseline(env:Env,balanceUsd:number){
  await setXSetting(env,"x_hstora_balance_guard",{
    hstoraUsd:Math.max(0,balanceUsd),
    allowedDecreaseUsd:0,
    updatedAt:Date.now()
  });
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

  if(url.pathname==="/api/x/invite-campaign"&&request.method==="GET"){
    return json(await getInviteCampaignDashboard(env));
  }

  if(
    url.pathname==="/api/x/invite-campaign/settings"&&
    (request.method==="POST"||request.method==="PATCH"||request.method==="PUT")
  ){
    const raw=await requestJson(request);
    if(!raw) return json({error:"INVALID_JSON"},400);
    try{
      const settings=await saveInviteCampaignSettings(env,{
        enabled:raw.enabled,
        guildId:raw.guildId,
        invitesPerReward:raw.invitesPerReward,
        targetStock:raw.targetStock
      });
      if(settings.enabled){
        try{
          await ensureInviteCampaignGateway(env);
          await seedInviteCampaignSnapshot(env,settings.guild_id);
          await reconcileInviteCampaignRewards(env);
        }catch(error){
          await saveInviteCampaignSettings(env,{enabled:false});
          await stopInviteCampaignGateway(env).catch(()=>undefined);
          return json({
            error:"INVITE_CAMPAIGN_START_FAILED",
            message:error instanceof Error?error.message:String(error),
            settings:await getInviteCampaignDashboard(env)
          },409);
        }
      }else{
        await stopInviteCampaignGateway(env);
      }
      return json({ok:true,...await getInviteCampaignDashboard(env)});
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      return json({error:message},400);
    }
  }

  if(url.pathname==="/api/x/invite-campaign/seed"&&request.method==="POST"){
    try{
      const result=await seedInviteCampaignSnapshot(env);
      return json({ok:true,result,...await getInviteCampaignDashboard(env)});
    }catch(error){
      return json({
        error:"INVITE_CAMPAIGN_SEED_FAILED",
        message:error instanceof Error?error.message:String(error)
      },409);
    }
  }

  const inviteRewardRetry=url.pathname.match(
    /^\/api\/x\/invite-campaign\/rewards\/([^/]+)\/retry$/
  );
  if(inviteRewardRetry&&request.method==="POST"){
    try{
      const result=await retryInviteCampaignReward(
        env,
        decodeURIComponent(inviteRewardRetry[1]!)
      );
      return json({ok:true,result,...await getInviteCampaignDashboard(env)});
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      return json({error:message},409);
    }
  }

  if(url.pathname==="/api/x/daily-restock"&&request.method==="GET"){
    return json(await getDailyRestockDashboard(env));
  }

  if(url.pathname==="/api/x/daily-restock/settings"&&request.method==="POST"){
    const raw=await requestJson(request);
    if(!raw) return json({error:"INVALID_JSON"},400);
    try{
      return json({
        ok:true,
        ...await updateDailyRestockConfig(env,{
          enabled:raw.enabled,
          topSearchTargetStock:raw.topSearchTargetStock,
          noShadowbanTargetStock:raw.noShadowbanTargetStock,
          notificationChannelId:raw.notificationChannelId,
          notificationMessage:raw.notificationMessage
        })
      });
    }catch(error){
      return json({
        error:error instanceof Error?error.message:String(error)
      },400);
    }
  }

  if(url.pathname==="/api/x/daily-restock/panel"&&request.method==="POST"){
    try{
      return json({ok:true,...await installDailyRestockPanel(env)});
    }catch(error){
      return json({
        error:error instanceof Error?error.message:String(error)
      },409);
    }
  }

  if(url.pathname==="/api/x/daily-restock/run"&&request.method==="POST"){
    try{
      return json(await startDailyRestock(env,Date.now(),true));
    }catch(error){
      return json({
        error:error instanceof Error?error.message:String(error)
      },409);
    }
  }

  if(url.pathname==="/api/x/procurement-budget"&&request.method==="GET"){
    const settings=await loadXSettings(env);
    return json({
      percentages:procurementBudgetPercentages(settings),
      budget:await getProcurementBudgets(env)
    });
  }

  if(url.pathname==="/api/x/procurement-budget"&&request.method==="POST"){
    const raw=await requestJson(request);
    if(!raw) return json({error:"INVALID_JSON"},400);

    const pending=await pendingPurchaseOrders(env);
    if(pending.length>0){
      return json({
        error:"PENDING_HSTORA_ORDER_EXISTS",
        message:"処理中のHStora注文があるため、予算の再配分は注文確定後に行ってください。",
        pendingOrders:pending.length
      },409);
    }

    const hstoraBreaker=await circuitState(env,"hstora");
    if(String(hstoraBreaker?.state??"")==="OPEN"){
      return json({
        error:"HSTORA_CIRCUIT_BREAKER_OPEN",
        message:"HStoraの停止状態を確認・解消してから予算割合を変更してください。"
      },409);
    }

    const inviteCampaignPercent=Number(raw.inviteCampaignPercent);
    const noShadowbanPercent=Number(raw.noShadowbanPercent);
    const topSearchPercent=Number(raw.topSearchPercent);

    let balance;
    try{balance=await getHstoraBalance(env);}
    catch(error){
      return json({
        error:"HSTORA_BALANCE_ERROR",
        message:error instanceof Error?error.message:String(error)
      },502);
    }
    if(String(balance.currency).toUpperCase()!=="USD"){
      return json({error:"HSTORA_CURRENCY_UNSUPPORTED"},409);
    }

    try{
      const settings=await saveXSettings(env,{
        invite_campaign_budget_percent:inviteCampaignPercent,
        no_shadowban_budget_percent:noShadowbanPercent,
        top_search_budget_percent:topSearchPercent
      });
      const percentages=procurementBudgetPercentages(settings);
      const budget=await rebalanceProcurementBudgets(
        env,
        Number(balance.balance),
        percentages
      );
      await syncHstoraBudgetBaseline(env,Number(balance.balance));
      await auditX(env,{
        kind:"PROCUREMENT_BUDGET_ALLOCATION_CHANGED",
        message:"Procurement budget percentages changed and current HStora balance was rebalanced.",
        details:{
          percentages,
          currentHstoraBalanceUsd:Number(balance.balance),
          budget:budget.available
        }
      });
      return json({
        ok:true,
        percentages,
        budget,
        currentHstoraBalanceUsd:Number(balance.balance)
      });
    }catch(error){
      return json({
        error:error instanceof Error?error.message:String(error)
      },400);
    }
  }

  if(
    url.pathname==="/api/x/procurement-budget/rebalance"&&
    request.method==="POST"
  ){
    const pending=await pendingPurchaseOrders(env);
    if(pending.length>0){
      return json({
        error:"PENDING_HSTORA_ORDER_EXISTS",
        message:"処理中のHStora注文があるため、現在残高での再配分はできません。",
        pendingOrders:pending.length
      },409);
    }
    const hstoraBreaker=await circuitState(env,"hstora");
    if(String(hstoraBreaker?.state??"")==="OPEN"){
      return json({
        error:"HSTORA_CIRCUIT_BREAKER_OPEN",
        message:"HStoraの停止状態を確認・解消してから現在残高を再配分してください。"
      },409);
    }
    try{
      const [settings,balance]=await Promise.all([
        loadXSettings(env),
        getHstoraBalance(env)
      ]);
      if(String(balance.currency).toUpperCase()!=="USD"){
        return json({error:"HSTORA_CURRENCY_UNSUPPORTED"},409);
      }
      const percentages=procurementBudgetPercentages(settings);
      const budget=await rebalanceProcurementBudgets(
        env,
        Number(balance.balance),
        percentages
      );
      await syncHstoraBudgetBaseline(env,Number(balance.balance));
      await auditX(env,{
        kind:"PROCUREMENT_BUDGET_REBALANCED",
        message:"Procurement budgets were manually rebalanced from current HStora balance.",
        details:{
          percentages,
          currentHstoraBalanceUsd:Number(balance.balance),
          budget:budget.available
        }
      });
      return json({
        ok:true,
        percentages,
        budget,
        currentHstoraBalanceUsd:Number(balance.balance)
      });
    }catch(error){
      return json({
        error:error instanceof Error?error.message:String(error)
      },502);
    }
  }

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
      if(
        patch.funding_mode==="binance_auto"&&
        !isBinanceAutoFundingServerEnabled(env)
      ){
        return json({
          error:"BINANCE_AUTO_FUNDING_SERVER_LOCKED",
          message:"BINANCE_AUTO_FUNDING_ENABLED must be true before Binance funding can be selected."
        },409);
      }
      const settings=await saveXSettings(env,patch);
      return json({ok:true,settings:publicSettings(settings)});
    }
  }

  if(url.pathname==="/api/x/run"&&request.method==="POST"){
    return json(await runXProcurement(env));
  }

  if(
    url.pathname==="/api/x/funding/auto-purchase/run"&&
    request.method==="POST"
  ){
    return json(await runLtcAutoPurchase(env));
  }

  if(url.pathname==="/api/x/funding/mode"&&request.method==="POST"){
    const raw=await requestJson(request);
    const mode=String(raw?.mode??"");
    if(mode!=="manual_hstora"&&mode!=="binance_auto"){
      return json({error:"INVALID_FUNDING_MODE"},400);
    }
    if(mode==="binance_auto"&&!isBinanceAutoFundingServerEnabled(env)){
      return json({
        error:"BINANCE_AUTO_FUNDING_SERVER_LOCKED",
        message:"BINANCE_AUTO_FUNDING_ENABLED must be true before Binance funding can be selected."
      },409);
    }
    const patch:Partial<XSettings>={funding_mode:mode};
    if(mode==="manual_hstora"){
      Object.assign(patch,{
        auto_purchase_enabled:false,
        pending_paypay_funding_jpy:0,
        pending_paypay_jpy_deposit_required_jpy:0,
        pending_paypay_jpy_credit_required_jpy:0,
        pending_paypay_direct_ltc_budget_jpy:0,
        pending_paypay_path_amounts_captured:false,
        pending_paypay_binance_jpy_baseline:0,
        pending_paypay_binance_ltc_baseline:0,
        pending_paypay_required_ltc:0,
        pending_paypay_ltc_baseline_captured:false,
        pending_paypay_requested_at:0
      });
    }
    const settings=await saveXSettings(env,patch);
    await auditX(env,{
      kind:"FUNDING_MODE_CHANGED",
      message:"Funding mode changed by admin.",
      details:{mode,binanceServerUnlocked:isBinanceAutoFundingServerEnabled(env)}
    });
    return json({
      ok:true,
      fundingMode:settings.funding_mode,
      fundingModeLabel:fundingModeLabel(settings.funding_mode),
      binanceAutoFundingServerEnabled:isBinanceAutoFundingServerEnabled(env),
      settings:publicSettings(settings)
    });
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
    const current=await loadXSettings(env);
    const now=Date.now();
    const previousFresh=
      current.usd_jpy_rate>0&&
      current.usd_jpy_rate_updated_at>0&&
      now-current.usd_jpy_rate_updated_at<=current.max_fx_age_ms;
    if(previousFresh){
      const jump=Math.abs(rate-current.usd_jpy_rate)/current.usd_jpy_rate*100;
      if(jump>current.max_fx_jump_percent){
        await setCircuitBreaker(
          env,
          "fx_rate",
          "OPEN",
          "USDJPY_JUMP:"+jump.toFixed(2)+"%"
        );
        await auditX(env,{
          level:"error",
          kind:"FX_RATE_JUMP",
          message:"USD/JPY observation changed beyond configured threshold.",
          details:{previous:current.usd_jpy_rate,attempted:rate,jumpPercent:jump}
        });
        return json({
          error:"FX_RATE_CIRCUIT_BREAKER",
          previous:current.usd_jpy_rate,
          attempted:rate,
          jumpPercent:jump
        },409);
      }
    }
    const settings=await saveXSettings(env,{
      usd_jpy_rate:rate,
      usd_jpy_rate_updated_at:now
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

  if(
    url.pathname==="/api/x/funding/pending/confirm-direct-ltc"&&
    request.method==="POST"
  ){
    try{
      const result=await confirmPendingDirectLtcFunding(env);
      return json(result);
    }catch(error){
      const code=error instanceof Error?error.message:String(error);
      const status=
        code==="NO_PENDING_DIRECT_LTC_CONFIRMATION"?409:
        code==="LTC_BALANCE_INCREASE_NOT_DETECTED"?409:
        code==="BINANCE_FUNDING_MODE_INACTIVE"?409:
        code==="BINANCE_AUTO_FUNDING_SERVER_LOCKED"?409:
        500;
      return json({error:code},status);
    }
  }

  if(url.pathname==="/api/x/funding/pending/cancel"&&request.method==="POST"){
    const current=await loadXSettings(env);
    const settings=await saveXSettings(env,{
      pending_paypay_funding_jpy:0,
      pending_paypay_jpy_deposit_required_jpy:0,
      pending_paypay_jpy_credit_required_jpy:0,
      pending_paypay_direct_ltc_budget_jpy:0,
      pending_paypay_path_amounts_captured:false,
      pending_paypay_binance_jpy_baseline:0,
      pending_paypay_binance_ltc_baseline:0,
      pending_paypay_required_ltc:0,
      pending_paypay_ltc_baseline_captured:false,
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
    const settings=await loadXSettings(env);
    const binanceActive=
      settings.funding_mode==="binance_auto"&&
      isBinanceAutoFundingServerEnabled(env);
    const inactiveBinance=Promise.resolve({
      ok:false as const,
      error:"BINANCE_FUNDING_INACTIVE"
    });
    const [
      inventory,
      today,
      funding,
      hstora,
      market,
      ltc,
      jpy,
      circuitBreakers,
      recentLogs,
      procurementBudget
    ]=await Promise.all([
      inventorySummary(env),
      todayPurchaseStats(env,dayStart),
      settled(()=>getFundingPlan(env,now)),
      settled(()=>getHstoraBalance(env)),
      binanceActive?settled(()=>getLtcJpyMarketStatus()):inactiveBinance,
      binanceActive?settled(()=>getBinanceBalance(env,"LTC")):inactiveBinance,
      binanceActive?settled(()=>getBinanceBalance(env,"JPY")):inactiveBinance,
      listOpenCircuitBreakers(env),
      listAuditLogs(env,50),
      getProcurementBudgets(env)
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
      procurementBudget:{
        ...procurementBudget,
        percentages:procurementBudgetPercentages(settings)
      },
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
        fundingMode:settings.funding_mode,
        fundingModeLabel:fundingModeLabel(settings.funding_mode),
        binanceAutoFundingServerEnabled:isBinanceAutoFundingServerEnabled(env),
        autoPurchaseEnabled:settings.auto_purchase_enabled,
        autoProcurementEnabled:settings.auto_procurement_enabled
      }
    });
  }

  if(url.pathname==="/api/x/binance"&&request.method==="GET"){
    const [market,restrictions,ltc,jpy,coinInfo,withdrawalSafety]=await Promise.all([
      settled(()=>getLtcJpyMarketStatus()),
      settled(()=>getBinanceApiRestrictions(env)),
      settled(()=>getBinanceBalance(env,"LTC")),
      settled(()=>getBinanceBalance(env,"JPY")),
      settled(()=>getBinanceLtcCoinInfo(env)),
      settled(()=>getBinanceWithdrawalSafetyStatus(env))
    ]);
    return json({
      market,
      tradeApi:{restrictions},
      balances:{ltc,jpy},
      coinInfo,
      withdrawalSafety
    });
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
const tabs=["Dashboard","Funding","Binance","LTC Wallet","HStora","招待キャンペーン","18:00入荷","Inventory","Orders","Logs","Settings"];
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
async function runLtcNow(){const d=await api("/api/x/funding/auto-purchase/run",{method:"POST",body:"{}"});alert(JSON.stringify(d,null,2));await load()}
async function saveFundingMode(){
 const el=document.querySelector("#fundingMode");
 const mode=String(el?.value||"manual_hstora");
 if(mode==="binance_auto"&&!window.confirm("Binance自動LTC購入モードへ切り替えますか？ サーバー側ロックが解除済みの場合だけ有効になります。")) return;
 await api("/api/x/funding/mode",{method:"POST",body:JSON.stringify({mode})});
 await load();
}
async function cancelPendingFunding(){await api("/api/x/funding/pending/cancel",{method:"POST",body:"{}"});await load()}
async function saveProcurementBudget(){
 const inviteCampaignPercent=Number(document.querySelector("#budgetInvite")?.value);
 const noShadowbanPercent=Number(document.querySelector("#budgetNoShadow")?.value);
 const topSearchPercent=Number(document.querySelector("#budgetTop")?.value);
 if(
  !Number.isInteger(inviteCampaignPercent)||
  !Number.isInteger(noShadowbanPercent)||
  !Number.isInteger(topSearchPercent)||
  inviteCampaignPercent<0||noShadowbanPercent<0||topSearchPercent<0||
  inviteCampaignPercent>100||noShadowbanPercent>100||topSearchPercent>100
 ){
  throw new Error("割合は0〜100の整数で入力してください。");
 }
 if(inviteCampaignPercent+noShadowbanPercent+topSearchPercent!==100){
  throw new Error("3項目の合計を100%にしてください。");
 }
 await api("/api/x/procurement-budget",{
  method:"POST",
  body:JSON.stringify({
   inviteCampaignPercent,
   noShadowbanPercent,
   topSearchPercent
  })
 });
 await load();
}
async function rebalanceProcurementBudget(){
 if(!window.confirm("現在のHStora残高を基準に3つの仕入れ予算を作り直します。未確認の注文がないことを確認してください。")) return;
 await api("/api/x/procurement-budget/rebalance",{method:"POST",body:"{}"});
 await load();
}
async function approveBulk(){await api("/api/x/bulk-approval",{method:"POST",body:JSON.stringify({minutes:10})});await load()}
async function resetEmergency(){await api("/api/x/emergency-stop/reset",{method:"POST",body:"{}"});await load()}
async function saveInviteCampaign(){
 const enabled=Boolean(document.querySelector("#inviteEnabled")?.checked);
 const guildId=String(document.querySelector("#inviteGuildId")?.value||"").trim();
 const invitesPerReward=Number(document.querySelector("#invitesPerReward")?.value);
 const targetStock=Number(document.querySelector("#inviteTargetStock")?.value);
 await api("/api/x/invite-campaign/settings",{
  method:"POST",
  body:JSON.stringify({enabled,guildId,invitesPerReward,targetStock})
 });
 await load();
}
async function seedInviteCampaign(){
 await api("/api/x/invite-campaign/seed",{method:"POST",body:"{}"});
 await load();
}
async function retryInviteReward(id){
 await api("/api/x/invite-campaign/rewards/"+encodeURIComponent(id)+"/retry",{
  method:"POST",body:"{}"
 });
 await load();
}
async function saveDailyRestock(){
 const enabled=Boolean(document.querySelector("#dailyRestockEnabled")?.checked);
 const topSearchTargetStock=Number(document.querySelector("#dailyTopTarget")?.value);
 const noShadowbanTargetStock=Number(document.querySelector("#dailyNoShadowTarget")?.value);
 const notificationChannelId=String(document.querySelector("#dailyNotifyChannel")?.value||"").trim();
 const notificationMessage=String(document.querySelector("#dailyNotifyMessage")?.value||"").trim();
 if(!Number.isInteger(topSearchTargetStock)||topSearchTargetStock<0||topSearchTargetStock>10000){
  throw new Error("Top Searchの恒常在庫は0〜10000の整数で入力してください。");
 }
 if(!Number.isInteger(noShadowbanTargetStock)||noShadowbanTargetStock<0||noShadowbanTargetStock>10000){
  throw new Error("No shadow banの恒常在庫は0〜10000の整数で入力してください。");
 }
 if(notificationChannelId&&!/^\\d{15,22}$/.test(notificationChannelId)){
  throw new Error("通知チャンネルIDが不正です。");
 }
 if(!notificationMessage) throw new Error("通知文言を入力してください。");
 await api("/api/x/daily-restock/settings",{
  method:"POST",
  body:JSON.stringify({
   enabled,
   topSearchTargetStock,
   noShadowbanTargetStock,
   notificationChannelId,
   notificationMessage
  })
 });
 await load();
}
async function installDailyRestockPanelNow(){
 await api("/api/x/daily-restock/panel",{method:"POST",body:"{}"});
 await load();
}
async function runDailyRestockNow(){
 if(!window.confirm("18:00を待たず、現在在庫と恒常在庫の差分を今すぐ仕入れますか？")) return;
 const d=await api("/api/x/daily-restock/run",{method:"POST",body:"{}"});
 alert(JSON.stringify(d,null,2));
 await load();
}
function metrics(data){
 const f=data.funding?.data?.allowance;
 const ready=data.inventory?.READY_FOR_DELIVERY??0;
 const err=(data.recentErrors?.length??0)+(data.circuitBreakers?.length??0);
 const todayJpy=data.today?.approximateJpy;
 const avgJpy=data.today?.approximateAverageJpy;
 const manual=data.safety?.fundingMode==="manual_hstora";
 return '<div class="grid">'+
  '<div class="metric"><small>資金モード</small><strong>'+esc(data.safety?.fundingModeLabel??"-")+'</strong></div>'+
  '<div class="metric"><small>'+(manual?'補充先':'Binance LTC残高')+'</small><strong>'+(manual?'HStora Main Wallet':esc(data.balances?.binanceLtc?.data?.free??"-")+' LTC')+'</strong></div>'+
  (manual?'':'<div class="metric"><small>LTC購入上限</small><strong>'+esc(f?.allowedJpy??0)+'円</strong></div>')+
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
    const binanceButton=s.funding_mode==="binance_auto"
      ?'<button id="runLtcNow">LTC自動購入判定</button>'
      :'';
    main.innerHTML=metrics(data)+
      '<section class="card"><strong>手動実行</strong><p class="hint">Dry Run中は実購入POSTを行いません。HStoraへのLTC入金反映は1分ごとに検知して仕入れ予算へ反映します。通常のNo shadow ban / Top Search在庫は毎日18:00（JST）に恒常在庫との差分を入荷します。</p><div class="formrow">'+binanceButton+'<button id="runNow">仕入れ判定を実行</button></div></section>'+
      card(current,data);
    const runLtc=document.querySelector("#runLtcNow"); if(runLtc) runLtc.onclick=()=>runLtcNow().catch(e=>alert(e.message));
    document.querySelector("#runNow").onclick=()=>runNow().catch(e=>alert(e.message));
  }else if(current==="Funding"){
    data=await api("/api/x/dashboard");
    const s=data.settings||{};
    const manual=s.funding_mode==="manual_hstora";
    const unlocked=Boolean(data.safety?.binanceAutoFundingServerEnabled);
    const procurementBudget=data.procurementBudget||{};
    const budgetPercentages=procurementBudget.percentages||{};
    const budgetAvailable=procurementBudget.available||{};
    const modeCard=
      '<section class="card"><strong>LTC補充方法</strong>'+
      '<p class="hint">通常はHStora Main WalletへLTCを手動補充します。残高反映は1分Cronで検知してカテゴリ別の仕入れ予算へ反映します。No shadow ban / Top Searchの通常在庫は毎日18:00（JST）に差分入荷し、招待キャンペーン在庫は従来どおり随時補充します。Binanceモードはサーバー側ロックを解除した場合だけ選択できます。</p>'+
      '<div class="formrow"><select id="fundingMode" style="flex:1;border:1px solid #353b49;border-radius:10px;padding:10px;background:#151922;color:#fff">'+
      '<option value="manual_hstora" '+(manual?'selected':'')+'>HStoraへLTC手動補充</option>'+
      '<option value="binance_auto" '+(!manual?'selected':'')+' '+(unlocked?'':'disabled')+'>Binance自動LTC購入'+(unlocked?'':'（ロック中）')+'</option>'+
      '</select><button id="saveFundingMode">切り替え</button></div>'+
      '<p class="status '+(unlocked?'good':'warn')+'">Binanceサーバーロック: '+(unlocked?'解除済み':'有効')+'</p></section>';
    const budgetCard=
      '<section class="card"><strong>仕入れ資金の配分</strong>'+
      '<p class="hint">HStoraへ補充された資金を、招待用 / No shadow ban / Top Search の3枠へ分けます。0%のカテゴリは在庫が不足していても自動仕入れをスキップします。割合変更時は現在のHStora残高を新しい比率で再配分します。</p>'+
      '<div class="grid">'+
      '<div class="metric"><small>招待用 予算残</small><strong>'+esc(Number(budgetAvailable.INVITE_CAMPAIGN??0).toFixed(4))+' USD</strong></div>'+
      '<div class="metric"><small>No shadow ban 予算残</small><strong>'+esc(Number(budgetAvailable.NO_SHADOWBAN??0).toFixed(4))+' USD</strong></div>'+
      '<div class="metric"><small>Top Search 予算残</small><strong>'+esc(Number(budgetAvailable.TOP_SEARCH??0).toFixed(4))+' USD</strong></div>'+
      '<div class="metric"><small>配分状態</small><strong>'+(procurementBudget.initialized?'有効':'初期化待ち')+'</strong></div>'+
      '</div>'+
      '<div class="formrow"><input id="budgetInvite" type="number" min="0" max="100" step="1" value="'+esc(budgetPercentages.INVITE_CAMPAIGN??0)+'" placeholder="招待用 %"><input id="budgetNoShadow" type="number" min="0" max="100" step="1" value="'+esc(budgetPercentages.NO_SHADOWBAN??50)+'" placeholder="No shadow ban %"><input id="budgetTop" type="number" min="0" max="100" step="1" value="'+esc(budgetPercentages.TOP_SEARCH??50)+'" placeholder="Top Search %"></div>'+
      '<div class="hint">左から 招待用 / No shadow ban / Top Search。3項目の合計は必ず100%。</div>'+
      '<div class="formrow"><button id="saveProcurementBudget">割合を保存して現在残高へ適用</button><button id="rebalanceProcurementBudget">現在残高で再配分</button></div>'+
      '</section>';
    const manualCard=
      '<section class="card"><strong>現在の運用: LTC手動補充</strong>'+
      '<p class="hint">HStoraの Wallet → Add Funds からLTCで補充してください。BOTはHStora残高を1分Cronで確認し、増加分を設定済みの仕入れ割合へ自動配分します。通常在庫の実仕入れは毎日18:00（JST）に行い、現在在庫と恒常在庫の差分だけを補充します。</p>'+
      '<div class="grid"><div class="metric"><small>HStora Main Wallet</small><strong>'+esc(data.balances?.hstora?.data?.balance??"-")+' USD</strong></div><div class="metric"><small>自動仕入れ</small><strong>'+(data.safety?.autoProcurementEnabled?'ON':'OFF')+'</strong></div></div></section>';
    const binanceCards=
      '<section class="card"><strong>Binance自動LTC購入</strong>'+
      '<p class="hint">auto_purchase_enabled がONなら1分CronでBinance JPY残高からLTC/JPYを購入します。1回・日・週・月・max_ltc_balance・現行注文上限を尊重し、実発注はサーバー側フラグでも二重ロックされています。</p>'+
      '<button id="runLtcFundingNow">今すぐLTC購入判定</button></section>'+
      '<section class="card"><strong>PayPay残高（手動観測）</strong>'+
      '<p class="hint">Binanceモード用の既存経路です。BOTはPayPayへログインせず、観測残高とreserve_jpyから新規投入可能額を計算します。</p>'+
      '<div class="formrow"><input id="paypayBalance" inputmode="numeric" type="number" min="0" step="1" value="'+esc(s.observed_paypay_balance_jpy??0)+'"><button id="savePayPay">観測値を保存</button></div></section>';
    const fxCard=
      '<section class="card"><strong>USD/JPY（手動観測）</strong>'+
      '<p class="hint">HStoraのUSD建て商品をJPY上限と比較するための換算値です。</p>'+
      '<div class="formrow"><input id="usdJpy" inputmode="decimal" type="number" min="0" step="0.001" value="'+esc(s.usd_jpy_rate??0)+'"><button id="saveFx">換算値を保存</button></div></section>';
    main.innerHTML=metrics(data)+modeCard+budgetCard+(manual?manualCard:binanceCards)+fxCard+
      (!manual&&data.funding?.data?.pendingManualFunding
        ?'<section class="card"><strong>PayPay手動操作待ち</strong><p class="hint">最大予約額: '+esc(data.funding.data.pendingManualFunding.amountJpy)+'円。残高増加を確認後に再開します。</p><button id="cancelPending" class="danger">この要求を取消</button></section>'
        :'')+
      card("Funding detail",data.funding);
    document.querySelector("#saveFundingMode").onclick=()=>saveFundingMode().catch(e=>alert(e.message));
    document.querySelector("#saveProcurementBudget").onclick=()=>saveProcurementBudget().catch(e=>alert(e.message));
    document.querySelector("#rebalanceProcurementBudget").onclick=()=>rebalanceProcurementBudget().catch(e=>alert(e.message));
    const cancel=document.querySelector("#cancelPending"); if(cancel) cancel.onclick=()=>cancelPendingFunding().catch(e=>alert(e.message));
    const runLtcFunding=document.querySelector("#runLtcFundingNow"); if(runLtcFunding) runLtcFunding.onclick=()=>runLtcNow().catch(e=>alert(e.message));
    const savePayPay=document.querySelector("#savePayPay"); if(savePayPay) savePayPay.onclick=()=>observePayPay().catch(e=>alert(e.message));
    document.querySelector("#saveFx").onclick=()=>observeFx().catch(e=>alert(e.message));
  }else if(current==="Binance"){data=await api("/api/x/binance");main.innerHTML=card(current,data)}
  else if(current==="HStora"){data=await api("/api/x/hstora");main.innerHTML=card(current,data)}
  else if(current==="招待キャンペーン"){
    data=await api("/api/x/invite-campaign");
    const s=data.settings||{};
    const guildOptions=(data.guilds||[]).map(g=>
      '<option value="'+esc(g.guild_id)+'">'+esc(g.name)+'</option>'
    ).join("");
    const progress=(data.progress||[]).slice(0,30).map(row=>
      '<div class="metric"><small>'+esc(row.inviter_user_id)+'</small>'+
      '<strong>'+esc(row.valid_invites)+'人</strong>'+
      '<div class="hint">対象外 '+esc(row.excluded_invites)+' / 報酬 '+esc(row.rewards_earned)+'</div></div>'
    ).join("");
    const rewards=(data.rewards||[]).slice(0,30).map(row=>{
      const retryable=row.status==="WAITING_STOCK"||row.status==="DM_FAILED"||row.status==="ERROR";
      return '<div class="metric"><small>'+esc(row.inviter_user_id)+' / #'+esc(row.ordinal)+'</small>'+
        '<strong>'+esc(row.status)+'</strong>'+
        (row.error?'<div class="hint">'+esc(row.error)+'</div>':'')+
        (retryable?'<div class="formrow"><button data-retry-reward="'+esc(row.id)+'">再試行</button></div>':'')+
        '</div>';
    }).join("");
    main.innerHTML=
      '<section class="card"><strong>招待キャンペーン設定</strong>'+
      '<p class="hint">ユーザーはDiscord標準の「招待を作成」から普段どおり招待URLを発行します。BOTが招待URLごとの作成者と使用回数を照合し、有効招待が設定人数に達するたびキャンペーン専用在庫からXアカウントを1個DMで自動配布します。ユーザー向けSlash Commandは不要です。</p>'+
      '<p class="hint">ユーザー側には招待を作るチャンネルの「招待を作成」権限が必要です。1回限定リンク・参加直後に削除されたリンク・異なる招待者のリンクが同時に増えた場合は、誤った人へ報酬を出さないよう帰属不能として対象外にします。</p>'+
      '<div class="formrow"><label style="display:flex;align-items:center;gap:8px"><input id="inviteEnabled" type="checkbox" style="flex:0" '+(s.enabled?'checked':'')+'>キャンペーンを有効化</label></div>'+
      '<datalist id="inviteGuildOptions">'+guildOptions+'</datalist>'+
      '<div class="formrow"><input id="inviteGuildId" list="inviteGuildOptions" placeholder="対象サーバーID" value="'+esc(s.guild_id||"")+'"></div>'+
      '<div class="formrow"><input id="invitesPerReward" type="number" min="1" max="1000" step="1" value="'+esc(s.invites_per_reward||5)+'" placeholder="何人ごとに1垢"><input id="inviteTargetStock" type="number" min="1" max="10000" step="1" value="'+esc(s.target_stock||20)+'" placeholder="恒常在庫数"></div>'+
      '<div class="hint">左: 何人招待ごとに1垢 / 右: キャンペーン専用の恒常在庫数</div>'+
      '<div class="formrow"><button id="saveInviteCampaign">設定を保存</button><button id="seedInviteCampaign">招待状態を再同期</button><button id="runInviteProcurement">在庫補充判定</button></div>'+
      '</section>'+
      '<div class="grid">'+
      '<div class="metric"><small>キャンペーン在庫</small><strong>'+esc(data.stock?.available??0)+' / '+esc(data.stock?.target??20)+'</strong></div>'+
      '<div class="metric"><small>不足数</small><strong>'+esc(data.stock?.deficit??0)+'</strong></div>'+
      '<div class="metric"><small>未解決の報酬</small><strong>'+esc(data.unresolvedRewards??0)+'</strong></div>'+
      '<div class="metric"><small>Gateway</small><strong>'+(data.runtime?.gateway_ready_at?'接続済み':'未接続')+'</strong></div>'+
      '<div class="metric"><small>招待方式</small><strong>Discord標準URL</strong></div>'+
      '<div class="metric"><small>帰属不能</small><strong>'+esc((data.attribution?.ambiguous??0)+(data.attribution?.unresolved??0))+'人</strong><div class="hint">同時使用 '+esc(data.attribution?.ambiguous??0)+' / 特定不能 '+esc(data.attribution?.unresolved??0)+'</div></div>'+
      '</div>'+
      (data.runtime?.last_error?'<section class="card bad"><strong>Gateway / キャンペーンエラー</strong><pre>'+esc(data.runtime.last_error)+'</pre></section>':'')+
      '<section class="card"><strong>招待実績</strong><div class="grid" style="margin-top:10px">'+(progress||'<div class="hint">まだ招待実績はありません。</div>')+'</div></section>'+
      '<section class="card"><strong>報酬履歴</strong><div class="grid" style="margin-top:10px">'+(rewards||'<div class="hint">まだ報酬履歴はありません。</div>')+'</div></section>';
    document.querySelector("#saveInviteCampaign").onclick=()=>saveInviteCampaign().catch(e=>alert(e.message));
    document.querySelector("#seedInviteCampaign").onclick=()=>seedInviteCampaign().catch(e=>alert(e.message));
    document.querySelector("#runInviteProcurement").onclick=()=>runNow().catch(e=>alert(e.message));
    document.querySelectorAll("[data-retry-reward]").forEach(el=>{
      el.onclick=()=>retryInviteReward(el.getAttribute("data-retry-reward")).catch(e=>alert(e.message));
    });
  }
  else if(current==="18:00入荷"){
    data=await api("/api/x/daily-restock");
    const cfg=data.config||{};
    const state=data.state||{};
    const top=data.stock?.TOP_SEARCH||{};
    const noShadow=data.stock?.NO_SHADOWBAN||{};
    const stateText=state.status
      ?esc(state.status)+" / "+esc(state.date_key||"-")
      :"未実行";
    main.innerHTML=
      '<section class="card"><strong>毎日18:00 在庫入荷</strong>'+
      '<p class="hint">毎日18:00（日本時間）に、現在在庫と恒常在庫の差分だけをHStoraから仕入れます。仕入れ資金の配分とHStora商品優先順位は既存設定をそのまま使用します。HStoraが処理中の場合は1分Cronで納品完了まで追跡し、全体が終わってから集計通知を1回だけ送ります。</p>'+
      '<div class="formrow"><label style="display:flex;align-items:center;gap:8px"><input id="dailyRestockEnabled" type="checkbox" style="flex:0" '+(cfg.enabled?'checked':'')+'>18:00自動入荷を有効化</label></div>'+
      '<div class="formrow"><input id="dailyNoShadowTarget" type="number" min="0" max="10000" step="1" value="'+esc(cfg.no_shadowban_target_stock??50)+'" placeholder="No shadow ban 恒常在庫"><input id="dailyTopTarget" type="number" min="0" max="10000" step="1" value="'+esc(cfg.top_search_target_stock??50)+'" placeholder="Top Search 恒常在庫"></div>'+
      '<div class="hint">左: No shadow ban / 右: Top Search。18:00時点の在庫との差分だけを入荷します。</div>'+
      '<div class="formrow"><input id="dailyNotifyChannel" value="'+esc(cfg.notification_channel_id||"")+'" placeholder="通知先DiscordチャンネルID"></div>'+
      '<p class="hint">入荷処理が完了したら、このチャンネルへまとめて通知します。</p>'+
      '<textarea id="dailyNotifyMessage" style="min-height:120px;font:inherit">'+esc(cfg.notification_message||"")+'</textarea>'+
      '<p class="hint">この文言の下に、通知送信時点で実際に販売可能な在庫数として「No shadow ban 〇個」「Top Search □個」を自動表示します。今回の入荷数ではありません。</p>'+
      '<div class="formrow"><button id="saveDailyRestock">設定を保存</button><button id="installDailyRestockPanel">通知パネルを設置 / 更新</button><button id="runDailyRestockNow">今すぐ差分入荷</button></div>'+
      '</section>'+
      '<div class="grid">'+
      '<div class="metric"><small>No shadow ban</small><strong>'+esc(noShadow.current??0)+' / '+esc(noShadow.target??0)+'</strong><div class="hint">不足 '+esc(noShadow.deficit??0)+'個</div></div>'+
      '<div class="metric"><small>Top Search</small><strong>'+esc(top.current??0)+' / '+esc(top.target??0)+'</strong><div class="hint">不足 '+esc(top.deficit??0)+'個</div></div>'+
      '<div class="metric"><small>次回入荷</small><strong>18:00 JST</strong></div>'+
      '<div class="metric"><small>前回ジョブ</small><strong>'+stateText+'</strong></div>'+
      '</div>'+
      (state.started_at
        ?'<section class="card"><strong>前回 / 実行中の入荷結果</strong><div class="grid" style="margin-top:10px">'+
          '<div class="metric"><small>No shadow ban 入荷数</small><strong>'+esc(state.added_no_shadowban??0)+'個</strong></div>'+
          '<div class="metric"><small>Top Search 入荷数</small><strong>'+esc(state.added_top_search??0)+'個</strong></div>'+
          '<div class="metric"><small>最終状態</small><strong>'+esc(state.last_action||state.status||"-")+'</strong></div>'+
          '<div class="metric"><small>通知</small><strong>'+(state.notified_at?'送信済み':'未送信')+'</strong></div>'+
          '</div>'+(state.error?'<pre class="bad">'+esc(state.error)+'</pre>':'')+'</section>'
        :'');
    document.querySelector("#saveDailyRestock").onclick=()=>saveDailyRestock().catch(e=>alert(e.message));
    document.querySelector("#installDailyRestockPanel").onclick=()=>installDailyRestockPanelNow().catch(e=>alert(e.message));
    document.querySelector("#runDailyRestockNow").onclick=()=>runDailyRestockNow().catch(e=>alert(e.message));
  }
  else if(current==="Inventory"){data=await api("/api/x/inventory");main.innerHTML=card(current,data)}
  else if(current==="Orders"){data=await api("/api/x/orders");main.innerHTML=card(current,data)}
  else if(current==="Logs"){data=await api("/api/x/logs");main.innerHTML=card(current,data)}
  else if(current==="LTC Wallet"){
    data=await api("/api/x/dashboard");
    main.innerHTML='<section class="card"><strong>LTC Wallet</strong><p class="hint">現在は専用ホットウォレットの秘密鍵をCloudflare Workerへ保存しません。手動補充モードの入金先はHStora Main Walletです。HStoraの公式APIに入金先取得/入金実行APIが追加されるまでは、ここから勝手にオンチェーン送金しません。</p><div class="grid"><div class="metric"><small>資金モード</small><strong>'+esc(data.safety?.fundingModeLabel??"-")+'</strong></div><div class="metric"><small>HStora残高</small><strong>'+esc(data.balances?.hstora?.data?.balance??"-")+' USD</strong></div></div></section>';
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
