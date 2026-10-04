import { restockMessagePayload, validateRestockMessage, isRestockMention } from "./shiire-restock-message";
import { withNamedRunLock } from "./x-run-lock";
import type { Env } from "./types";
import {
  auditX,
  availableInventoryCountByClass,
  pendingPurchaseOrders,
  purchasedAccountsByClassSince,
  readyInventoryCountByClass
} from "./x-db";
import {
  reconcilePendingXOrders,
  runXProcurement,
  type XRunResult
} from "./x-engine";
import { loadXSettings } from "./x-settings";
import {
  dailyRestockPauseReason,
  isDailyRestockFundingWaitAction,
  isDailyRestockScheduleWindow,
  shouldNotifyDailyRestock,
  type DailyRestockPauseReason
} from "./x-daily-restock-policy";
import {
  jstDateKey,
  loadDailyRestockConfig,
  loadDailyRestockState,
  saveDailyRestockConfig,
  saveDailyRestockState,
  type DailyRestockConfig,
  type DailyRestockState
} from "./x-daily-restock-state";

const MAX_STEPS_PER_TICK=8;

async function discordJson<T>(
  env:Env,
  path:string,
  init:RequestInit
):Promise<T>{
  const token=env.DISCORD_BOT_TOKEN?.trim()??"";
  if(!token) throw new Error("DISCORD_BOT_TOKEN_NOT_CONFIGURED");
  const response=await fetch("https://discord.com/api/v10"+path,{
    ...init,
    headers:{
      Authorization:"Bot "+token,
      "Content-Type":"application/json",
      ...(init.headers??{})
    }
  });
  if(!response.ok){
    throw new Error(
      "DISCORD_API_"+response.status+":"+
      (await response.text()).slice(0,300)
    );
  }
  if(response.status===204) return {} as T;
  return response.json() as Promise<T>;
}

function notificationPayload(
  config:DailyRestockConfig,
  state:DailyRestockState,
  available:{
    topSearch:number;
    noShadowban:number;
  },
  notify=false
){
  return restockMessagePayload(config.notification_message,{
    normal_stock:available.noShadowban,
    normal_added:state.added_no_shadowban,
    old_stock:available.topSearch,
    old_added:state.added_top_search
  },notify,config.notification_mention);
}

async function currentStocks(env:Env){
  const [top,noShadow]=await Promise.all([
    readyInventoryCountByClass(env,"TOP_SEARCH"),
    readyInventoryCountByClass(env,"NO_SHADOWBAN")
  ]);
  return {top,noShadow};
}

async function actualAvailableStocks(env:Env){
  const [topSearch,noShadowban]=await Promise.all([
    availableInventoryCountByClass(env,"TOP_SEARCH"),
    availableInventoryCountByClass(env,"NO_SHADOWBAN")
  ]);
  return {topSearch,noShadowban};
}

async function refreshArrivalCounts(
  env:Env,
  state:DailyRestockState
){
  const [stocks,arrivals]=await Promise.all([
    currentStocks(env),
    purchasedAccountsByClassSince(env,state.started_at)
  ]);
  state.final_top_search=stocks.top;
  state.final_no_shadowban=stocks.noShadow;
  state.added_top_search=arrivals.TOP_SEARCH;
  state.added_no_shadowban=arrivals.NO_SHADOWBAN;
  return state;
}

async function skipDailyRestock(
  env:Env,
  state:DailyRestockState,
  reason:DailyRestockPauseReason
){
  state.status="skipped";
  state.completed_at=Date.now();
  state.last_action=reason;
  state.error="";
  state.notification_skipped_reason=reason;
  await refreshArrivalCounts(env,state);
  await saveDailyRestockState(env,state);
  await auditX(env,{
    level:"info",
    kind:"DAILY_RESTOCK_SKIPPED",
    message:reason==="DRY_RUN_ENABLED"
      ?"Daily 18:00 restock was skipped because Dry Run is enabled."
      :"Daily 18:00 restock was skipped because automatic procurement is paused.",
    details:{dateKey:state.date_key,reason}
  });
  return state;
}

async function publishDailyRestockSummary(
  env:Env,
  state:DailyRestockState,
  config:DailyRestockConfig
){
  await refreshArrivalCounts(env,state);
  const addedAny=shouldNotifyDailyRestock({
    addedTopSearch:state.added_top_search,
    addedNoShadowban:state.added_no_shadowban
  });

  if(!addedAny){
    if(state.notified_at<=0){
      state.notified_at=Date.now();
      state.notification_skipped_reason="NO_STOCK_ADDED";
      await saveDailyRestockState(env,state);
      await auditX(env,{
        kind:"DAILY_RESTOCK_NOTIFICATION_SKIPPED",
        message:"Daily restock notification was skipped because no sellable stock was added.",
        details:{
          dateKey:state.date_key,
          status:state.status,
          addedNoShadowban:state.added_no_shadowban,
          addedTopSearch:state.added_top_search
        }
      });
    }
    return state;
  }

  const available=await actualAvailableStocks(env);
  const payload=notificationPayload(config,state,available);

  if(config.panel_channel_id&&config.panel_message_id){
    try{
      await discordJson(
        env,
        "/channels/"+config.panel_channel_id+
          "/messages/"+config.panel_message_id,
        {method:"PATCH",body:JSON.stringify(payload)}
      );
    }catch(error){
      await auditX(env,{
        level:"warn",
        kind:"DAILY_RESTOCK_PANEL_UPDATE_FAILED",
        message:error instanceof Error?error.message:String(error),
        details:{
          channelId:config.panel_channel_id,
          messageId:config.panel_message_id,
          dateKey:state.date_key
        }
      });
    }
  }

  if(state.notified_at>0) return state;
  if(!config.notification_channel_id){
    await auditX(env,{
      level:"warn",
      kind:"DAILY_RESTOCK_NOTIFICATION_SKIPPED",
      message:"Daily restock finished but no notification channel is configured.",
      details:{dateKey:state.date_key,status:state.status}
    });
    state.notified_at=Date.now();
    state.notification_skipped_reason="NO_NOTIFICATION_CHANNEL";
    await saveDailyRestockState(env,state);
    return state;
  }

  await discordJson(
    env,
    "/channels/"+config.notification_channel_id+"/messages",
    {method:"POST",body:JSON.stringify({...notificationPayload(config,state,available,true),
      nonce:"restock-"+String(state.started_at),enforce_nonce:true})}
  );
  state.notified_at=Date.now();
  state.notification_skipped_reason="";
  await saveDailyRestockState(env,state);
  await auditX(env,{
    kind:"DAILY_RESTOCK_NOTIFICATION_SENT",
    message:"Daily 18:00 restock summary was sent to Discord.",
    details:{
      dateKey:state.date_key,
      status:state.status,
      channelId:config.notification_channel_id,
      addedNoShadowban:state.added_no_shadowban,
      addedTopSearch:state.added_top_search,
      finalNoShadowban:state.final_no_shadowban,
      finalTopSearch:state.final_top_search,
      availableNoShadowban:available.noShadowban,
      availableTopSearch:available.topSearch
    }
  });
  return state;
}

async function finishDailyRestock(
  env:Env,
  state:DailyRestockState,
  config:DailyRestockConfig,
  status:"completed"|"partial",
  lastAction:string,
  error=""
){
  state.status=status;
  state.completed_at=Date.now();
  state.last_action=lastAction;
  state.error=error;
  await refreshArrivalCounts(env,state);
  await saveDailyRestockState(env,state);
  await auditX(env,{
    level:status==="partial"?"warn":"info",
    kind:status==="partial"
      ?"DAILY_RESTOCK_PARTIAL"
      :"DAILY_RESTOCK_COMPLETED",
    message:status==="partial"
      ?"Daily 18:00 restock ended before both steady-stock targets were met."
      :"Daily 18:00 restock reached both steady-stock targets.",
    details:{
      dateKey:state.date_key,
      lastAction,
      error,
      addedNoShadowban:state.added_no_shadowban,
      addedTopSearch:state.added_top_search,
      finalNoShadowban:state.final_no_shadowban,
      targetNoShadowban:state.target_no_shadowban,
      finalTopSearch:state.final_top_search,
      targetTopSearch:state.target_top_search
    }
  });
  return publishDailyRestockSummary(env,state,config);
}

function isPurchaseProgress(result:XRunResult){
  return result.action==="HSTORA_PURCHASE_DELIVERED"||
    result.action==="HSTORA_ORDER_RECOVERED"||
    result.action==="INVENTORY_RECLASSIFIED_OK";
}

export async function getDailyRestockDashboard(env:Env){
  const xSettings=await loadXSettings(env);
  const [config,state,stocks]=await Promise.all([
    loadDailyRestockConfig(env,{
      top_search_target_stock:xSettings.target_stock,
      no_shadowban_target_stock:xSettings.no_shadowban_target_stock
    }),
    loadDailyRestockState(env),
    currentStocks(env)
  ]);
  return {
    schedule:{
      timezone:"Asia/Tokyo",
      time:"18:00",
      cronSource:"minute-cron"
    },
    config,
    state,
    stock:{
      TOP_SEARCH:{
        current:stocks.top,
        target:config.top_search_target_stock,
        deficit:Math.max(0,config.top_search_target_stock-stocks.top)
      },
      NO_SHADOWBAN:{
        current:stocks.noShadow,
        target:config.no_shadowban_target_stock,
        deficit:Math.max(0,config.no_shadowban_target_stock-stocks.noShadow)
      }
    }
  };
}

export async function updateDailyRestockConfig(
  env:Env,
  input:{
    enabled?:unknown;
    topSearchTargetStock?:unknown;
    noShadowbanTargetStock?:unknown;
    notificationChannelId?:unknown;
    notificationMessage?:unknown;
    notificationMention?:unknown;
  }
){
  const xSettings=await loadXSettings(env);
  const current=await loadDailyRestockConfig(env,{
    top_search_target_stock:xSettings.target_stock,
    no_shadowban_target_stock:xSettings.no_shadowban_target_stock
  });
  const patch:Partial<DailyRestockConfig>={};

  if(input.enabled!==undefined){
    if(typeof input.enabled!=="boolean"){
      throw new Error("DAILY_RESTOCK_ENABLED_INVALID");
    }
    patch.enabled=input.enabled;
  }
  if(input.topSearchTargetStock!==undefined){
    const value=Number(input.topSearchTargetStock);
    if(!Number.isSafeInteger(value)||value<0||value>10000){
      throw new Error("TOP_SEARCH_TARGET_INVALID");
    }
    patch.top_search_target_stock=value;
  }
  if(input.noShadowbanTargetStock!==undefined){
    const value=Number(input.noShadowbanTargetStock);
    if(!Number.isSafeInteger(value)||value<0||value>10000){
      throw new Error("NO_SHADOWBAN_TARGET_INVALID");
    }
    patch.no_shadowban_target_stock=value;
  }
  if(input.notificationChannelId!==undefined){
    const value=String(input.notificationChannelId??"").trim();
    if(value&&!/^\d{15,22}$/.test(value)){
      throw new Error("NOTIFICATION_CHANNEL_ID_INVALID");
    }
    patch.notification_channel_id=value;
    if(value!==current.notification_channel_id){
      patch.panel_channel_id="";
      patch.panel_message_id="";
    }
  }
  if(input.notificationMention!==undefined){
    if(typeof input.notificationMention!=="string"||!isRestockMention(input.notificationMention)) throw new Error("NOTIFICATION_MENTION_INVALID");
    patch.notification_mention=input.notificationMention;
  }
  if(input.notificationMessage!==undefined){
    const value=String(input.notificationMessage??"").trim();
    if(!validateRestockMessage(value)){
      throw new Error("NOTIFICATION_MESSAGE_INVALID");
    }
    patch.notification_message=value;
  }

  const config=await saveDailyRestockConfig(
    env,
    patch,
    {
      top_search_target_stock:xSettings.target_stock,
      no_shadowban_target_stock:xSettings.no_shadowban_target_stock
    }
  );
  await auditX(env,{
    kind:"DAILY_RESTOCK_CONFIG_CHANGED",
    message:"Daily 18:00 restock configuration changed.",
    details:{
      enabled:config.enabled,
      topSearchTargetStock:config.top_search_target_stock,
      noShadowbanTargetStock:config.no_shadowban_target_stock,
      notificationChannelId:config.notification_channel_id,
      panelInstalled:Boolean(config.panel_message_id)
    }
  });
  return getDailyRestockDashboard(env);
}

export async function installDailyRestockPanel(env:Env){
  const dashboard=await getDailyRestockDashboard(env);
  const config=dashboard.config;
  if(!config.notification_channel_id){
    throw new Error("NOTIFICATION_CHANNEL_REQUIRED");
  }

  const previousState=dashboard.state;
  const preview:DailyRestockState=previousState??{
    date_key:jstDateKey(),
    status:"completed",
    started_at:0,
    completed_at:Date.now(),
    notified_at:0,
    notification_skipped_reason:"",
    initial_top_search:dashboard.stock.TOP_SEARCH.current,
    initial_no_shadowban:dashboard.stock.NO_SHADOWBAN.current,
    target_top_search:config.top_search_target_stock,
    target_no_shadowban:config.no_shadowban_target_stock,
    final_top_search:dashboard.stock.TOP_SEARCH.current,
    final_no_shadowban:dashboard.stock.NO_SHADOWBAN.current,
    added_top_search:0,
    added_no_shadowban:0,
    last_action:"PANEL_PREVIEW",
    error:""
  };
  const available=await actualAvailableStocks(env);
  const payload=notificationPayload(config,preview,available);

  let messageId="";
  if(
    config.panel_channel_id===config.notification_channel_id&&
    config.panel_message_id
  ){
    try{
      await discordJson(
        env,
        "/channels/"+config.panel_channel_id+
          "/messages/"+config.panel_message_id,
        {method:"PATCH",body:JSON.stringify(payload)}
      );
      messageId=config.panel_message_id;
    }catch{
      messageId="";
    }
  }
  if(!messageId){
    const message=await discordJson<{id:string}>(
      env,
      "/channels/"+config.notification_channel_id+"/messages",
      {method:"POST",body:JSON.stringify(payload)}
    );
    messageId=String(message.id);
  }

  const saved=await saveDailyRestockConfig(
    env,
    {
      panel_channel_id:config.notification_channel_id,
      panel_message_id:messageId
    },
    {
      top_search_target_stock:config.top_search_target_stock,
      no_shadowban_target_stock:config.no_shadowban_target_stock
    }
  );
  await auditX(env,{
    kind:"DAILY_RESTOCK_PANEL_INSTALLED",
    message:"Daily restock notification panel was installed or updated.",
    details:{
      channelId:saved.panel_channel_id,
      messageId:saved.panel_message_id
    }
  });
  return getDailyRestockDashboard(env);
}

export async function continueDailyRestock(env:Env):Promise<any>{
  return withNamedRunLock<any>(env,"daily-restock",()=>continueDailyRestockLocked(env),
    async()=>({action:"DAILY_RESTOCK_LOCKED"}));
}

async function continueDailyRestockLocked(env:Env){
  const state=await loadDailyRestockState(env);
  if(!state){
    return {action:"NO_DAILY_RESTOCK_STATE"};
  }
  const xSettings=await loadXSettings(env);
  const config=await loadDailyRestockConfig(env,{
    top_search_target_stock:xSettings.target_stock,
    no_shadowban_target_stock:xSettings.no_shadowban_target_stock
  });

  if(state.status!=="running"){
    if(
      (state.status==="completed"||state.status==="partial")&&
      state.notified_at===0
    ){
      try{
        await publishDailyRestockSummary(env,state,config);
      }catch(error){
        return {
          action:"DAILY_RESTOCK_NOTIFICATION_RETRY_FAILED",
          error:error instanceof Error?error.message:String(error)
        };
      }
    }
    return {action:"DAILY_RESTOCK_NOT_RUNNING",state};
  }

  const pauseReason=dailyRestockPauseReason({
    dryRun:xSettings.dry_run,
    autoProcurementEnabled:xSettings.auto_procurement_enabled
  });
  if(pauseReason){
    const skipped=await skipDailyRestock(env,state,pauseReason);
    return {action:pauseReason,state:skipped};
  }

  for(let step=0;step<MAX_STEPS_PER_TICK;step++){
    await reconcilePendingXOrders(env);
    const stocks=await currentStocks(env);
    if(
      stocks.top>=state.target_top_search&&
      stocks.noShadow>=state.target_no_shadowban
    ){
      const done=await finishDailyRestock(
        env,state,config,"completed","TARGET_REACHED"
      );
      return {action:"DAILY_RESTOCK_COMPLETED",state:done};
    }

    const pending=await pendingPurchaseOrders(env);
    if(pending.length>0){
      state.last_action="WAITING_HSTORA_ORDER";
      await refreshArrivalCounts(env,state);
      await saveDailyRestockState(env,state);
      return {
        action:"WAITING_HSTORA_ORDER",
        pendingOrders:pending.length,
        state
      };
    }

    const result=await runXProcurement(env,{
      targetClasses:["TOP_SEARCH","NO_SHADOWBAN"],
      targetStockOverride:{
        TOP_SEARCH:state.target_top_search,
        NO_SHADOWBAN:state.target_no_shadowban
      }
    });
    state.last_action=result.action;
    await refreshArrivalCounts(env,state);
    await saveDailyRestockState(env,state);

    if(
      state.final_top_search>=state.target_top_search&&
      state.final_no_shadowban>=state.target_no_shadowban
    ){
      const done=await finishDailyRestock(
        env,state,config,"completed",result.action
      );
      return {action:"DAILY_RESTOCK_COMPLETED",state:done};
    }

    const pendingAfter=await pendingPurchaseOrders(env);
    if(pendingAfter.length>0||result.action==="HSTORA_PURCHASE_PROCESSING"){
      return {
        action:"WAITING_HSTORA_ORDER",
        pendingOrders:pendingAfter.length,
        state
      };
    }

    if(result.action==="FINANCIAL_RUN_LOCKED"||result.action==="HSTORA_PENDING_ORDER"){
      return {action:"DAILY_RESTOCK_CONTINUES_NEXT_TICK",state};
    }
    if(isDailyRestockFundingWaitAction(result.action)){
      const alreadyWaiting=state.last_action==="WAITING_HSTORA_FUNDING";
      state.last_action="WAITING_HSTORA_FUNDING";
      state.error="";
      await refreshArrivalCounts(env,state);
      await saveDailyRestockState(env,state);
      if(!alreadyWaiting){
        await auditX(env,{
          level:"info",
          kind:"DAILY_RESTOCK_WAITING_FOR_FUNDS",
          message:"Daily restock is waiting for HStora funding and will resume automatically after the balance credit is detected.",
          details:{dateKey:state.date_key,reason:result.action}
        });
      }
      return {
        action:"WAITING_HSTORA_FUNDING",
        result,
        state
      };
    }
    if(isPurchaseProgress(result)) continue;

    const partial=await finishDailyRestock(
      env,
      state,
      config,
      "partial",
      result.action,
      "TARGET_NOT_REACHED"
    );
    return {
      action:"DAILY_RESTOCK_PARTIAL",
      result,
      state:partial
    };
  }

  await refreshArrivalCounts(env,state);
  await saveDailyRestockState(env,state);
  return {action:"DAILY_RESTOCK_CONTINUES_NEXT_TICK",state};
}

export async function startDailyRestock(env:Env,now=Date.now(),force=false):Promise<any>{
  return withNamedRunLock<any>(env,"daily-restock",()=>startDailyRestockLocked(env,now,force),
    async()=>({action:"DAILY_RESTOCK_LOCKED"}));
}

async function startDailyRestockLocked(env:Env,now:number,force:boolean){
  const xSettings=await loadXSettings(env);
  const config=await loadDailyRestockConfig(env,{
    top_search_target_stock:xSettings.target_stock,
    no_shadowban_target_stock:xSettings.no_shadowban_target_stock
  });
  if(!config.enabled&&!force){
    return {action:"DAILY_RESTOCK_DISABLED"};
  }

  const dateKey=jstDateKey(now);
  const existing=await loadDailyRestockState(env);
  if(existing?.status==="running") return continueDailyRestockLocked(env);
  const pauseReason=dailyRestockPauseReason({
    dryRun:xSettings.dry_run,
    autoProcurementEnabled:xSettings.auto_procurement_enabled
  });
  const canResumeSkippedToday=
    existing?.status==="skipped"&&
    existing.date_key===dateKey&&
    pauseReason===null;
  if(
    !force&&
    existing?.date_key===dateKey&&
    !canResumeSkippedToday
  ){
    return {action:"DAILY_RESTOCK_ALREADY_RAN",state:existing};
  }

  const stocks=await currentStocks(env);
  const state:DailyRestockState={
    date_key:dateKey,
    status:"running",
    started_at:Date.now(),
    completed_at:0,
    notified_at:0,
    notification_skipped_reason:"",
    initial_top_search:stocks.top,
    initial_no_shadowban:stocks.noShadow,
    target_top_search:config.top_search_target_stock,
    target_no_shadowban:config.no_shadowban_target_stock,
    final_top_search:stocks.top,
    final_no_shadowban:stocks.noShadow,
    added_top_search:0,
    added_no_shadowban:0,
    last_action:"STARTED",
    error:""
  };
  if(pauseReason){
    const skipped=await skipDailyRestock(env,state,pauseReason);
    return {action:pauseReason,state:skipped};
  }

  await saveDailyRestockState(env,state);
  await auditX(env,{
    kind:"DAILY_RESTOCK_STARTED",
    message:"Daily 18:00 steady-stock replenishment started.",
    details:{
      dateKey,
      initialTopSearch:stocks.top,
      targetTopSearch:state.target_top_search,
      initialNoShadowban:stocks.noShadow,
      targetNoShadowban:state.target_no_shadowban
    }
  });
  return continueDailyRestockLocked(env);
}

export async function handleDailyRestockCron(
  env:Env,
  scheduledTime:number
){
  const state=await loadDailyRestockState(env);
  if(state?.status==="running"){
    return continueDailyRestock(env);
  }
  if(
    state&&
    (state.status==="completed"||state.status==="partial")&&
    state.notified_at===0
  ){
    return continueDailyRestock(env);
  }

  if(isDailyRestockScheduleWindow(scheduledTime)){
    return startDailyRestock(env,scheduledTime,false);
  }
  return {action:"NO_DAILY_RESTOCK_CRON_ACTION"};
}
