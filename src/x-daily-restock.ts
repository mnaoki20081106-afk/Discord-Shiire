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
import { isDailyRestockScheduleMinute } from "./x-daily-restock-policy";
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
  }
){
  return {
    allowed_mentions:{parse:[]},
    embeds:[{
      title:"在庫入荷のお知らせ",
      color:5763719,
      description:config.notification_message,
      fields:[
        {
          name:"No shadow ban",
          value:String(available.noShadowban)+"個",
          inline:true
        },
        {
          name:"Top Search",
          value:String(available.topSearch)+"個",
          inline:true
        }
      ],
      footer:{
        text:"現在の販売可能在庫 / 毎日18:00（JST）入荷"
      },
      timestamp:new Date(state.completed_at||Date.now()).toISOString()
    }]
  };
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

async function publishDailyRestockSummary(
  env:Env,
  state:DailyRestockState,
  config:DailyRestockConfig
){
  await refreshArrivalCounts(env,state);
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
    await saveDailyRestockState(env,state);
    return state;
  }

  await discordJson(
    env,
    "/channels/"+config.notification_channel_id+"/messages",
    {method:"POST",body:JSON.stringify(payload)}
  );
  state.notified_at=Date.now();
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
  if(input.notificationMessage!==undefined){
    const value=String(input.notificationMessage??"").trim();
    if(!value||value.length>2000){
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

export async function continueDailyRestock(env:Env){
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

  if(!xSettings.auto_procurement_enabled||xSettings.dry_run){
    state.status="failed";
    state.completed_at=Date.now();
    state.last_action=xSettings.dry_run
      ?"DRY_RUN_ENABLED"
      :"AUTO_PROCUREMENT_DISABLED";
    state.error=state.last_action;
    await refreshArrivalCounts(env,state);
    await saveDailyRestockState(env,state);
    await auditX(env,{
      level:"warn",
      kind:"DAILY_RESTOCK_FAILED",
      message:"Daily restock did not run because live automatic procurement is disabled.",
      details:{dateKey:state.date_key,reason:state.error}
    });
    return {action:state.error,state};
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

export async function startDailyRestock(
  env:Env,
  now=Date.now(),
  force=false
){
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
  if(
    !force&&
    existing?.date_key===dateKey
  ){
    if(existing.status==="running") return continueDailyRestock(env);
    return {action:"DAILY_RESTOCK_ALREADY_RAN",state:existing};
  }

  const stocks=await currentStocks(env);
  const state:DailyRestockState={
    date_key:dateKey,
    status:"running",
    started_at:Date.now(),
    completed_at:0,
    notified_at:0,
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
  return continueDailyRestock(env);
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

  if(isDailyRestockScheduleMinute(scheduledTime)){
    return startDailyRestock(env,scheduledTime,false);
  }
  return {action:"NO_DAILY_RESTOCK_CRON_ACTION"};
}
