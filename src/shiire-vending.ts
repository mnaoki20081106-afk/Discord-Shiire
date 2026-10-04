import { panelPayload, isPanelColor, PANEL_FORMAT_VERSION } from "./shiire-panel-payload";
import type { Env } from "./types";
import { hmacHex, sha256Hex } from "./crypto";
import { loadXSettings, saveXSettings } from "./x-settings";
import { fundingModeLabel, isBinanceAutoFundingServerEnabled } from "./x-funding-mode";
import {
  confirmPendingDirectLtcFunding,
  getFundingPlan,
  jstPeriodStarts
} from "./x-funding";
import {
  getBinanceApiRestrictions,
  getBinanceBalance,
  getBinanceLtcCoinInfo,
  getBinanceWithdrawalSafetyStatus,
  getLtcJpyMarketStatus
} from "./providers/binance";
import {
  getHstoraBalance,
  listHstoraCatalog
} from "./providers/hstora";
import { DisabledHotWalletProvider } from "./providers/manual";
import { SHIIRE_DISCORD_BOT_PERMISSIONS, deliveryNonce, paymentMethodEnabled, paymentPrice } from "./shiire-vending-policy";
import {
  inventorySummary,
  inventoryClassSummary,
  purchaseStatsByClass,
  purchaseOrderStatusSummary,
  todayPurchaseStats,
  listPurchaseOrders,
  listAuditLogs,
  listOpenCircuitBreakers,
  listSupplierProducts,
  recentFundingEvents,
  recentCryptoTransactions,
  auditX,
  setCircuitBreaker,
  getProcurementBudgets,
  rebalanceProcurementBudgets,
  pendingPurchaseOrders,
  circuitState,
  getXSetting,
  setXSetting
} from "./x-db";
import { receiveMainPayment, getMainPaymentStatus } from "./main-bot";
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
  ensureShiireVendingSchema,
  listShiireMachines,
  getShiireMachine,
  createShiireMachine,
  updateShiireMachine,
  deleteShiireMachine,
  ensureShiireDefaultProducts,
  saveShiirePanelImage,
  deleteShiirePanelImage,
  getShiirePanelImage,
  listShiireSourceProducts,
  listShiireProducts,
  getShiireProduct,
  createShiireProduct,
  updateShiireProduct,
  deleteShiireProduct,
  listShiireCoupons,
  getShiireCoupon,
  createShiireCoupon,
  deleteShiireCoupon,
  getShiireStockNotification,
  saveShiireStockNotification,
  deleteShiireStockNotification,
  reserveShiireOrder,
  getShiireOrder,
  attachShiirePaymentLink,
  clearShiirePaymentLink,
  readShiirePaymentLink,
  markShiirePaid,
  claimShiireDelivery,
  resetShiireDelivery,
  markShiireDeliverySent,
  decryptReservedShiireAccounts,
  finishShiireDelivery,
  cleanShiireVendingExpired,
  listPendingShiirePayments,
  listShiireDeliverySent,
  listShiireOrders,
  saveShiirePanel,
  listShiirePanels,
  deleteShiirePanelRecord,
  machinesForSupplierProduct,
  type ShiireVendingMachine,
  type ShiireVendingProduct,
  type ShiireVendingOrder
} from "./shiire-vending-db";
import {
  SHIIRE_VENDING_SALES_COPY_VERSION,
  shiireSalesCopyForClass
} from "./shiire-vending-sales-copy";

const BRIDGE_MAX_SKEW_MS=5*60_000;
let bridgeReady=false;

export class ShiireVendingError extends Error{
  status:number;
  constructor(status:number,message:string){
    super(message);
    this.name="ShiireVendingError";
    this.status=status;
  }
}

async function operationSettled<T>(fn:()=>Promise<T>){
  try{return {ok:true as const,data:await fn()};}
  catch(error){
    return {
      ok:false as const,
      error:error instanceof Error?error.message:String(error)
    };
  }
}

function safeProcurementSettings(settings:Awaited<ReturnType<typeof loadXSettings>>){
  return {
    dry_run:settings.dry_run,
    emergency_stop:settings.emergency_stop,
    auto_purchase_enabled:settings.auto_purchase_enabled,
    auto_procurement_enabled:settings.auto_procurement_enabled,
    funding_mode:settings.funding_mode,
    reserve_jpy:settings.reserve_jpy,
    max_purchase_jpy:settings.max_purchase_jpy,
    daily_purchase_limit_jpy:settings.daily_purchase_limit_jpy,
    weekly_purchase_limit_jpy:settings.weekly_purchase_limit_jpy,
    monthly_purchase_limit_jpy:settings.monthly_purchase_limit_jpy,
    min_purchase_jpy:settings.min_purchase_jpy,
    target_ltc_balance:settings.target_ltc_balance,
    max_ltc_balance:settings.max_ltc_balance,
    wallet_target_ltc:settings.wallet_target_ltc,
    wallet_max_ltc:settings.wallet_max_ltc,
    max_unit_price_jpy:settings.max_unit_price_jpy,
    max_no_shadowban_unit_price_usd:settings.max_no_shadowban_unit_price_usd,
    reorder_point:settings.reorder_point,
    target_stock:settings.target_stock,
    no_shadowban_reorder_point:settings.no_shadowban_reorder_point,
    no_shadowban_target_stock:settings.no_shadowban_target_stock,
    trial_purchase_count:settings.trial_purchase_count,
    max_batch_purchase:settings.max_batch_purchase,
    invite_campaign_budget_percent:settings.invite_campaign_budget_percent,
    no_shadowban_budget_percent:settings.no_shadowban_budget_percent,
    top_search_budget_percent:settings.top_search_budget_percent,
    min_seller_rating:settings.min_seller_rating,
    min_product_reviews:settings.min_product_reviews,
    min_sales_count:settings.min_sales_count,
    max_dispute_rate:settings.max_dispute_rate,
    minimum_stock:settings.minimum_stock,
    seller_quality_mode:settings.seller_quality_mode,
    approved_hstora_product_ids:settings.approved_hstora_product_ids,
    max_paypay_balance_age_ms:settings.max_paypay_balance_age_ms,
    max_fx_age_ms:settings.max_fx_age_ms,
    max_fx_jump_percent:settings.max_fx_jump_percent,
    max_price_jump_percent:settings.max_price_jump_percent,
    max_ltc_price_jump_percent:settings.max_ltc_price_jump_percent,
    require_bulk_confirmation:settings.require_bulk_confirmation,
    bulk_confirmation_threshold:settings.bulk_confirmation_threshold,
    observed_paypay_balance_jpy:settings.observed_paypay_balance_jpy,
    observed_paypay_balance_at:settings.observed_paypay_balance_at,
    pending_paypay_funding_jpy:settings.pending_paypay_funding_jpy,
    usd_jpy_rate:settings.usd_jpy_rate,
    usd_jpy_rate_updated_at:settings.usd_jpy_rate_updated_at,
    bulk_approval_until:settings.bulk_approval_until
  };
}

function procurementBudgetPercentages(
  settings:Awaited<ReturnType<typeof loadXSettings>>
){
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

async function operationsOverview(env:Env){
  const now=Date.now();
  const settings=await loadXSettings(env);
  const dayStart=jstPeriodStarts(now).day;
  const hotWallet=new DisabledHotWalletProvider();
  const binanceActive=
    settings.funding_mode==="binance_auto"&&
    isBinanceAutoFundingServerEnabled(env);

  const inactiveBinance={ok:false as const,error:"BINANCE_FUNDING_INACTIVE"};
  const [
    funding,
    hstora,
    withdrawalSafety,
    hotWalletHealth,
    hotWalletBalance,
    inventory,
    inventoryByClass,
    today,
    todayByClass,
    orderStatuses,
    breakers,
    logs,
    recentOrders
  ]=await Promise.all([
    operationSettled(()=>getFundingPlan(env,now)),
    operationSettled(()=>getHstoraBalance(env)),
    binanceActive
      ?operationSettled(()=>getBinanceWithdrawalSafetyStatus(env))
      :Promise.resolve(inactiveBinance),
    hotWallet.health(),
    hotWallet.getBalance("LTC"),
    inventorySummary(env),
    inventoryClassSummary(env),
    todayPurchaseStats(env,dayStart),
    purchaseStatsByClass(env,dayStart),
    purchaseOrderStatusSummary(env),
    listOpenCircuitBreakers(env),
    listAuditLogs(env,40),
    listPurchaseOrders(env,12)
  ]);

  let market:{ok:true;data:any}|{ok:false;error:string}=inactiveBinance;
  let ltc:{ok:true;data:any}|{ok:false;error:string}=inactiveBinance;
  let jpy:{ok:true;data:any}|{ok:false;error:string}=inactiveBinance;

  if(binanceActive&&funding.ok&&funding.data.binance){
    market={ok:true,data:funding.data.binance.market};
    ltc={
      ok:true,
      data:{
        free:funding.data.binance.ltcFree,
        locked:funding.data.binance.ltcLocked
      }
    };
    jpy={
      ok:true,
      data:{
        free:funding.data.binance.jpyFree,
        locked:0
      }
    };
  }else if(binanceActive){
    [market,ltc,jpy]=await Promise.all([
      operationSettled(()=>getLtcJpyMarketStatus()),
      operationSettled(()=>getBinanceBalance(env,"LTC")),
      operationSettled(()=>getBinanceBalance(env,"JPY"))
    ]);
  }

  const recentErrors=(logs as any[])
    .filter(row=>String(row.level)==="error")
    .slice(0,8);
  const latestActivity=(logs as any[])[0]??null;

  const providerIssues:Array<{provider:string;error:string}>=[];
  for(const [provider,result] of [
    ["Funding",funding],
    ["HStora",hstora]
  ] as const){
    if(!result.ok){
      providerIssues.push({
        provider,
        error:String(result.error).slice(0,300)
      });
    }
  }
  if(binanceActive){
    for(const [provider,result] of [
      ["LTC/JPY",market],
      ["Binance LTC",ltc],
      ["Binance JPY",jpy],
      ["Binance Withdrawal",withdrawalSafety]
    ] as const){
      if(!result.ok){
        providerIssues.push({
          provider,
          error:String(result.error).slice(0,300)
        });
      }
    }
  }

  return {
    generatedAt:now,
    safety:{
      dryRun:settings.dry_run,
      emergencyStop:settings.emergency_stop,
      fundingMode:settings.funding_mode,
      fundingModeLabel:fundingModeLabel(settings.funding_mode),
      binanceAutoFundingServerEnabled:isBinanceAutoFundingServerEnabled(env),
      autoPurchaseEnabled:settings.auto_purchase_enabled,
      autoProcurementEnabled:settings.auto_procurement_enabled
    },
    settings:safeProcurementSettings(settings),
    funding,
    market,
    balances:{
      hstora,
      binanceLtc:ltc,
      binanceJpy:jpy,
      hotWallet:{
        health:hotWalletHealth,
        balanceLtc:hotWalletBalance
      }
    },
    withdrawalSafety,
    providerIssues,
    inventory,
    inventoryByClass,
    today:{
      ...today,
      byClass:todayByClass,
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
    orderStatuses,
    circuitBreakers:breakers,
    recentErrors,
    latestActivity,
    recentOrders,
    integrations:{
      binanceAutoFundingServerEnabled:isBinanceAutoFundingServerEnabled(env),
      binanceTradeConfigured:Boolean(env.BINANCE_API_KEY&&env.BINANCE_API_SECRET),
      binanceWithdrawConfigured:Boolean(
        env.BINANCE_WITHDRAW_API_KEY&&env.BINANCE_WITHDRAW_API_SECRET
      ),
      hstoraConfigured:Boolean(env.HSTORA_API_KEY&&env.HSTORA_API_SECRET),
      hstoraWebhookConfigured:Boolean(env.HSTORA_WEBHOOK_SECRET),
      credentialsEncryptionConfigured:Boolean(env.CREDENTIALS_ENCRYPTION_KEY),
      discordBotConfigured:Boolean(env.DISCORD_BOT_TOKEN&&env.DISCORD_APPLICATION_ID),
      discordNotifyConfigured:Boolean(env.DISCORD_NOTIFY_WEBHOOK_URL),
      dedicatedHotWallet:"disabled"
    }
  };
}

function responseJson(data:unknown,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store"
    }
  });
}

async function ensureBridgeSchema(env:Env){
  if(bridgeReady) return;
  await ensureShiireVendingSchema(env);
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS shiire_main_bridge_nonces ("+
    "nonce TEXT PRIMARY KEY,expires_at INTEGER NOT NULL)"
  ).run();
  bridgeReady=true;
}

function safeHexEqual(left:string,right:string){
  const a=left.toLowerCase(),b=right.toLowerCase();
  if(!/^[0-9a-f]+$/.test(a)||a.length!==b.length) return false;
  let diff=0;
  for(let i=0;i<a.length;i++) diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}

async function verifyMainBridgeRequest(
  request:Request,
  env:Env,
  url:URL,
  rawBody:string
){
  const secret=env.SHIIRE_BRIDGE_SECRET?.trim()??"";
  if(secret.length<32) throw new ShiireVendingError(503,"SHIIRE_BRIDGE_SECRET_NOT_CONFIGURED");
  const timestamp=request.headers.get("X-Shiire-Timestamp")?.trim()??"";
  const nonce=request.headers.get("X-Shiire-Nonce")?.trim()??"";
  const signature=request.headers.get("X-Shiire-Signature")?.trim()??"";
  const ts=Number(timestamp);
  if(!/^\d{10,16}$/.test(timestamp)||!Number.isFinite(ts)){
    throw new ShiireVendingError(401,"INVALID_BRIDGE_TIMESTAMP");
  }
  if(Math.abs(Date.now()-ts)>BRIDGE_MAX_SKEW_MS){
    throw new ShiireVendingError(401,"STALE_BRIDGE_TIMESTAMP");
  }
  if(!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)){
    throw new ShiireVendingError(401,"INVALID_BRIDGE_NONCE");
  }
  const canonical=
    timestamp+"\n"+
    nonce+"\n"+
    request.method.toUpperCase()+"\n"+
    url.pathname+url.search+"\n"+
    rawBody;
  const expected=await hmacHex(secret,canonical);
  if(!safeHexEqual(expected,signature)){
    throw new ShiireVendingError(401,"INVALID_BRIDGE_SIGNATURE");
  }
  await ensureBridgeSchema(env);
  const now=Date.now();
  await env.DB.prepare(
    "DELETE FROM shiire_main_bridge_nonces WHERE expires_at<?"
  ).bind(now).run();
  try{
    await env.DB.prepare(
      "INSERT INTO shiire_main_bridge_nonces(nonce,expires_at) VALUES (?,?)"
    ).bind(nonce,now+BRIDGE_MAX_SKEW_MS).run();
  }catch{
    throw new ShiireVendingError(401,"REPLAYED_BRIDGE_NONCE");
  }
}

function discordToken(env:Env){
  const token=env.DISCORD_BOT_TOKEN?.trim()??"";
  if(!token) throw new ShiireVendingError(503,"DISCORD_BOT_NOT_CONFIGURED");
  return token;
}

async function discordFetch(
  env:Env,
  path:string,
  init:RequestInit={}
){
  const headers=new Headers(init.headers);
  headers.set("Authorization","Bot "+discordToken(env));
  if(init.body&&typeof init.body==="string"&&!headers.has("Content-Type")){
    headers.set("Content-Type","application/json");
  }
  const response=await fetch("https://discord.com/api/v10"+path,{...init,headers});
  if(!response.ok){
    const text=await response.text();
    throw new ShiireVendingError(
      response.status===403?403:502,
      "DISCORD_"+response.status+":"+text.slice(0,300)
    );
  }
  return response;
}

async function discordJson<T>(
  env:Env,
  path:string,
  init:RequestInit={}
):Promise<T>{
  const response=await discordFetch(env,path,init);
  const text=await response.text();
  return (text?JSON.parse(text):{}) as T;
}

async function requireGuildOnShiire(env:Env,guildId:string){
  return discordJson<{id:string;name:string;icon?:string|null}>(
    env,
    "/guilds/"+guildId
  );
}

async function requireChannelInGuild(
  env:Env,
  guildId:string,
  channelId:string
){
  const channel=await discordJson<{id:string;guild_id?:string;type?:number;name?:string}>(
    env,
    "/channels/"+channelId
  );
  if(channel.guild_id!==guildId){
    throw new ShiireVendingError(400,"CHANNEL_NOT_IN_GUILD");
  }
  return channel;
}

async function requireRoleInGuild(
  env:Env,
  guildId:string,
  roleId:string
){
  const roles=await discordJson<Array<{id:string;name:string}>>(
    env,
    "/guilds/"+guildId+"/roles"
  );
  if(!roles.some(role=>role.id===roleId)){
    throw new ShiireVendingError(400,"ROLE_NOT_IN_GUILD");
  }
}


async function refreshMachinePanels(env:Env,machineId:string){
  const machine=await getShiireMachine(env,machineId);
  if(!machine) return true;
  const products=await listShiireProducts(env,machineId);
  const panels=(await env.DB.prepare(
    "SELECT channel_id,message_id FROM shiire_vending_panels WHERE vending_machine_id=?"
  ).bind(machineId).all<{channel_id:string;message_id:string}>()).results;
  let ok=true;
  for(const panel of panels){
    try{
      await discordJson(
        env,
        "/channels/"+panel.channel_id+"/messages/"+panel.message_id,
        {method:"PATCH",body:JSON.stringify(panelPayload(machine,products))}
      );
    }catch(error){
      ok=false;
      console.error("shiire vending panel refresh failed",machineId,panel,error);
    }
  }
  return ok;
}

async function ensureVendingSalesCopy(env:Env,guildId:string){
  const key="shiire_vending_sales_copy:"+guildId;
  if(await getXSetting<string>(env,key)===SHIIRE_VENDING_SALES_COPY_VERSION) return;

  const machines=await listShiireMachines(env,guildId);
  let panelsOk=true;
  let updated=0;
  for(const machine of machines){
    const products=await listShiireProducts(env,machine.id);
    const classProducts=products.filter(product=>Boolean(shiireSalesCopyForClass(product.procurement_class)));
    for(const product of classProducts){
      const preset=shiireSalesCopyForClass(product.procurement_class)!;
      if(
        product.name!==preset.name||
        product.description!==preset.description||
        product.price_paypay!==preset.priceJpy||
        product.price_kyash!==preset.priceJpy
      ){
        await updateShiireProduct(env,product.id,{
          name:preset.name,
          description:preset.description,
          pricePayPay:preset.priceJpy,
          priceKyash:preset.priceJpy
        });
        updated++;
      }
    }
    if(classProducts.length>0){
      panelsOk=(await refreshMachinePanels(env,machine.id))&&panelsOk;
    }
  }

  // The 350/500 prices are only an initial migration/default. Persist the
  // migration version even if a Discord panel refresh failed so a later admin
  // price edit can never be overwritten by this migration on the next GET.
  await setXSetting(env,key,SHIIRE_VENDING_SALES_COPY_VERSION);
  if(updated>0||!panelsOk){
    await auditX(env,{
      level:panelsOk?"info":"warn",
      kind:"SHIIRE_VENDING_SALES_COPY_UPDATED",
      message:panelsOk
        ?"Class-backed vending products were updated to the initial sales copy and prices."
        :"Initial vending copy/prices were saved, but at least one existing Discord panel could not be refreshed.",
      details:{
        guildId,
        updated,
        version:SHIIRE_VENDING_SALES_COPY_VERSION,
        panelRefreshOk:panelsOk
      }
    }).catch(()=>undefined);
  }
}

async function deleteDiscordMessage(
  env:Env,
  channelId:string,
  messageId:string
){
  const response=await fetch(
    "https://discord.com/api/v10/channels/"+
      encodeURIComponent(channelId)+
      "/messages/"+
      encodeURIComponent(messageId),
    {
      method:"DELETE",
      headers:{Authorization:"Bot "+discordToken(env)}
    }
  );
  if(response.ok||response.status===404) return {
    ok:true,
    missing:response.status===404
  };
  return {
    ok:false,
    missing:false,
    status:response.status,
    error:(await response.text()).slice(0,300)
  };
}

async function repostMachinePanels(env:Env,machineId:string){
  const machine=await getShiireMachine(env,machineId);
  if(!machine) throw new ShiireVendingError(404,"VENDING_MACHINE_NOT_FOUND");
  const oldPanels=await listShiirePanels(env,machineId);
  if(oldPanels.length===0){
    throw new ShiireVendingError(409,"NO_VENDING_PANEL_TO_REPOST");
  }

  const products=await listShiireProducts(env,machineId);
  const channels=[...new Set(oldPanels.map(panel=>panel.channel_id))];
  let posted=0;
  let removed=0;
  const failures:Array<{channelId:string;messageId:string;error:string}>=[];

  for(const channelId of channels){
    await requireChannelInGuild(env,machine.guild_id,channelId);
    const message=await sendJsonMessage(
      env,
      channelId,
      panelPayload(machine,products)
    );
    await saveShiirePanel(
      env,
      machine.id,
      machine.guild_id,
      channelId,
      message.id
    );
    posted++;

    for(const panel of oldPanels.filter(row=>row.channel_id===channelId)){
      const deleted=await deleteDiscordMessage(
        env,
        channelId,
        panel.message_id
      );
      if(deleted.ok){
        await deleteShiirePanelRecord(
          env,
          machine.id,
          channelId,
          panel.message_id
        );
        removed++;
      }else{
        failures.push({
          channelId,
          messageId:panel.message_id,
          error:"DISCORD_"+String(deleted.status)+":"+deleted.error
        });
      }
    }
  }

  await auditX(env,{
    level:failures.length?"warn":"info",
    kind:"SHIIRE_VENDING_PANELS_REPOSTED",
    message:failures.length
      ?"Vending panels were reposted, but some old messages could not be deleted."
      :"Vending panels were deleted and reposted after a product update.",
    details:{
      machineId,
      guildId:machine.guild_id,
      channels,
      posted,
      removed,
      failures
    }
  }).catch(()=>undefined);

  return {
    ok:failures.length===0,
    posted,
    removed,
    failedDeletes:failures.length,
    failures
  };
}

async function sendJsonMessage(
  env:Env,
  channelId:string,
  payload:Record<string,unknown>
){
  return discordJson<{id:string}>(
    env,
    "/channels/"+channelId+"/messages",
    {method:"POST",body:JSON.stringify(payload)}
  );
}

async function sendDeliveryMessage(
  env:Env,
  channelId:string,
  order:ShiireVendingOrder,
  content:string,
  embed:unknown
){
  const nonce=deliveryNonce(order.id);
  if(content.length<=1800){
    return sendJsonMessage(env,channelId,{
      content,
      embeds:[embed],
      allowed_mentions:{parse:[]},
      nonce,
      enforce_nonce:true
    });
  }

  const form=new FormData();
  form.set(
    "payload_json",
    JSON.stringify({
      embeds:[embed],
      allowed_mentions:{parse:[]},
      nonce,
      enforce_nonce:true,
      attachments:[{id:0,filename:"purchase_"+order.id+".txt"}]
    })
  );
  form.set(
    "files[0]",
    new File([content],"purchase_"+order.id+".txt",{type:"text/plain;charset=utf-8"})
  );
  const response=await discordFetch(
    env,
    "/channels/"+channelId+"/messages",
    {method:"POST",body:form}
  );
  return response.json() as Promise<{id:string}>;
}

async function persistDeliverySent(
  env:Env,
  orderId:string,
  channelId:string,
  messageId:string
){
  let lastError:unknown=null;
  for(let attempt=0;attempt<3;attempt++){
    try{
      await markShiireDeliverySent(env,orderId,channelId,messageId);
      return;
    }catch(error){
      lastError=error;
    }
  }
  throw lastError instanceof Error
    ?lastError
    :new Error("DELIVERY_SENT_STATE_WRITE_FAILED");
}

async function deliverOrder(env:Env,order:ShiireVendingOrder):Promise<boolean>{
  if(order.status==="delivery_sent"){
    await finishShiireDelivery(env,order);
    return true;
  }
  if(order.status==="delivered") return true;
  if(order.status!=="paid") return false;
  if(!(await claimShiireDelivery(env,order.id))) return false;

  let sent=false;
  try{
    const machine=await getShiireMachine(env,order.vending_machine_id);
    const product=await getShiireProduct(env,order.product_id);
    if(!machine||!product) throw new Error("ORDER_DATA_MISSING");
    const items=await decryptReservedShiireAccounts(env,order.id);
    if(items.length!==order.quantity) throw new Error("RESERVED_STOCK_MISSING");
    const deliveryText=items.map(item=>item.content).join("\n");
    const dm=await discordJson<{id:string}>(
      env,
      "/users/@me/channels",
      {method:"POST",body:JSON.stringify({recipient_id:order.user_id})}
    );
    const embed={
      title:"購入が完了しました",
      color:5763719,
      fields:[
        {name:"商品名",value:product.name,inline:true},
        {name:"購入数",value:String(order.quantity)+"個",inline:true},
        {name:"支払金額",value:String(order.total_amount)+"円",inline:true},
        {name:"決済方法",value:order.payment_method.toUpperCase(),inline:true}
      ],
      timestamp:new Date().toISOString()
    };
    const message=await sendDeliveryMessage(env,dm.id,order,deliveryText,embed);
    sent=true;
    await persistDeliverySent(env,order.id,dm.id,message.id);

    if(machine.role_id){
      try{
        await discordFetch(
          env,
          "/guilds/"+order.guild_id+"/members/"+order.user_id+"/roles/"+machine.role_id,
          {method:"PUT"}
        );
      }catch(error){
        await auditX(env,{
          level:"warn",
          kind:"SHIIRE_VENDING_ROLE_ASSIGN_FAILED",
          message:"Buyer delivery succeeded, but the configured post-purchase Discord role could not be assigned.",
          details:{
            orderId:order.id,
            guildId:order.guild_id,
            roleId:machine.role_id,
            error:error instanceof Error?error.message:String(error)
          }
        }).catch(()=>undefined);
      }
    }

    const logPayload={
      embeds:[{
        title:"購入完了",
        color:5763719,
        fields:[
          {name:"商品",value:product.name,inline:true},
          {name:"個数",value:String(order.quantity),inline:true},
          {name:"金額",value:String(order.total_amount)+"円",inline:true},
          {name:"購入者",value:"<@"+order.user_id+">",inline:true},
          {name:"決済",value:order.payment_method.toUpperCase(),inline:true}
        ]
      }],
      allowed_mentions:{parse:[]}
    };
    for(const channelId of [machine.public_log_channel_id,machine.private_log_channel_id]){
      if(channelId) await sendJsonMessage(env,channelId,logPayload).catch(()=>undefined);
    }

    const sentOrder=await getShiireOrder(env,order.id);
    if(!sentOrder) throw new Error("ORDER_NOT_FOUND_AFTER_SEND");
    await finishShiireDelivery(env,sentOrder);
    await refreshMachinePanels(env,machine.id);
    return true;
  }catch(error){
    if(!sent){
      await resetShiireDelivery(env,order.id).catch(()=>undefined);
    }
    throw error;
  }
}

async function paymentIdempotencyKey(order:ShiireVendingOrder,link:string){
  const hash=await sha256Hex(link);
  return "shiire-pay:"+order.id+":"+hash.slice(0,16);
}

async function processPaymentLink(
  env:Env,
  order:ShiireVendingOrder,
  link:string
){
  if(order.payment_method!=="paypay"&&order.payment_method!=="kyash"){
    throw new ShiireVendingError(409,"PAYMENT_METHOD_INVALID");
  }
  const result=await receiveMainPayment(env,{
    method:order.payment_method,
    link,
    amount:order.total_amount,
    idempotencyKey:await paymentIdempotencyKey(order,link)
  });
  if(result.status==="completed"||result.ok){
    if(!result.ok||result.status!=="completed"||!Number.isSafeInteger(result.amount)||result.amount<order.total_amount){
      throw new Error("PAYMENT_COMPLETION_AMOUNT_MISMATCH");
    }
    await markShiirePaid(env,order.id);
    const paid=await getShiireOrder(env,order.id);
    if(!paid) throw new Error("PAID_ORDER_NOT_FOUND");
    return {status:"completed",delivered:await deliverOrder(env,paid)};
  }
  if(result.status==="pending"){
    return {status:"pending",delivered:false};
  }
  await clearShiirePaymentLink(env,order.id);
  return {status:"rejected",delivered:false,reason:result.reason};
}

function ephemeral(content:string,components?:unknown[],embeds?:unknown[]){
  return {
    type:4,
    data:{
      content,
      flags:64,
      ...(components?{components}:{}),
      ...(embeds?{embeds}:{})
    }
  };
}

function interactionResponse(payload:unknown){
  return new Response(JSON.stringify(payload),{
    headers:{"Content-Type":"application/json; charset=utf-8"}
  });
}

function interactionUserId(interaction:any){
  return String(interaction?.member?.user?.id??interaction?.user?.id??"");
}

function selectOptions(
  products:Array<ShiireVendingProduct&{stock_count:number}>,
  method:"paypay"|"kyash"
){
  return products
    .filter(product=>product.stock_count>0&&paymentMethodEnabled(product,method))
    .slice(0,25)
    .map(product=>({
      label:product.name.slice(0,100),
      value:product.id,
      description:(
        paymentPrice(product,method)+
        "円 / 在庫 "+product.stock_count
      ).slice(0,100),
      ...(product.emoji?{emoji:{name:product.emoji}}:{})
    }));
}

export async function handleShiireVendingInteraction(
  interaction:any,
  env:Env
):Promise<Response|null>{
  await ensureShiireVendingSchema(env);

  if(interaction.type===3){
    const id=String(interaction.data?.custom_id??"");

    if(id.startsWith("svm:buy:")){
      const machineId=id.slice(8);
      const machine=await getShiireMachine(env,machineId);
      if(!machine) return interactionResponse(ephemeral("自販機が見つかりません。"));
      const payment=await getMainPaymentStatus(env).catch(()=>({paypay:false,kyash:false}));
      const products=await listShiireProducts(env,machineId);
      const options=[];
      if(
        payment.paypay&&
        products.some(product=>product.stock_count>0&&paymentMethodEnabled(product,"paypay"))
      ){
        options.push({label:"PayPay",value:"paypay",emoji:{name:"💴"}});
      }
      if(
        payment.kyash&&
        products.some(product=>product.stock_count>0&&paymentMethodEnabled(product,"kyash"))
      ){
        options.push({label:"Kyash",value:"kyash",emoji:{name:"💳"}});
      }
      if(!options.length){
        return interactionResponse(ephemeral(
          products.some(product=>product.stock_count>0)
            ?"現在利用できる決済方法がありません。商品価格と販売者の決済設定を確認してください。"
            :"現在購入できる在庫がありません。"
        ));
      }
      return interactionResponse(ephemeral(
        "決済方法を選択してください。",
        [{type:1,components:[{
          type:3,
          custom_id:"svm:method:"+machineId,
          placeholder:"決済方法",
          options
        }]}]
      ));
    }

    if(id.startsWith("svm:stock:")){
      const machineId=id.slice(10);
      const products=await listShiireProducts(env,machineId);
      return interactionResponse(ephemeral("",undefined,[{
        title:"在庫・販売数情報",
        color:5793266,
        fields:products.slice(0,25).map(product=>({
          name:product.name,
          value:"在庫: "+product.stock_count+"\n販売数: "+product.sales_count,
          inline:false
        }))
      }]));
    }

    if(id.startsWith("svm:method:")){
      const machineId=id.slice(11);
      const method=String(interaction.data?.values?.[0]??"") as "paypay"|"kyash";
      if(method!=="paypay"&&method!=="kyash"){
        return interactionResponse(ephemeral("決済方法が不正です。"));
      }
      const products=await listShiireProducts(env,machineId);
      const options=selectOptions(products,method);
      if(!options.length){
        return interactionResponse(ephemeral("現在購入できる在庫がありません。"));
      }
      return interactionResponse(ephemeral(
        "購入する商品を選択してください。",
        [{type:1,components:[{
          type:3,
          custom_id:"svm:product:"+machineId+":"+method,
          placeholder:"商品を選択",
          options
        }]}]
      ));
    }

    if(id.startsWith("svm:product:")){
      const parts=id.split(":");
      const machineId=parts[2]??"";
      const method=parts[3]??"";
      const productId=String(interaction.data?.values?.[0]??"");
      if(!machineId||!productId||(method!=="paypay"&&method!=="kyash")){
        return interactionResponse(ephemeral("商品情報が不正です。"));
      }
      return interactionResponse({
        type:9,
        data:{
          custom_id:"svm:order:"+machineId+":"+method+":"+productId,
          title:"購入情報入力",
          components:[
            {type:1,components:[{
              type:4,
              custom_id:"quantity",
              label:"購入数",
              style:1,
              value:"1",
              required:true,
              max_length:5
            }]},
            {type:1,components:[{
              type:4,
              custom_id:"coupon",
              label:"クーポンコード（任意）",
              style:1,
              required:false,
              max_length:50
            }]}
          ]
        }
      });
    }

    if(id.startsWith("svm:pay:")){
      const orderId=id.slice(8);
      const order=await getShiireOrder(env,orderId);
      if(!order||order.user_id!==interactionUserId(interaction)||order.status!=="awaiting_payment"){
        return interactionResponse(ephemeral("支払い可能な注文が見つかりません。"));
      }
      return interactionResponse({
        type:9,
        data:{
          custom_id:"svm:paymodal:"+orderId,
          title:(order.payment_method==="paypay"?"PayPay":"Kyash")+"決済",
          components:[{type:1,components:[{
            type:4,
            custom_id:"link",
            label:"送金リンク",
            style:1,
            required:true,
            max_length:1000,
            placeholder:order.payment_method==="paypay"
              ?"https://pay.paypay.ne.jp/..."
              :"https://kyash.me/payments/..."
          }]}]
        }
      });
    }

    if(id.startsWith("svm:retry:")){
      const orderId=id.slice(10);
      const order=await getShiireOrder(env,orderId);
      if(!order||order.user_id!==interactionUserId(interaction)){
        return interactionResponse(ephemeral("再試行できる注文がありません。"));
      }
      try{
        const delivered=await deliverOrder(env,order);
        return interactionResponse(ephemeral(
          delivered
            ?"納品が完了しました。DMを確認してください。"
            :"現在は納品を再試行できません。"
        ));
      }catch{
        return interactionResponse(ephemeral(
          "納品できませんでした。DM受信設定を確認して、もう一度試してください。",
          [{type:1,components:[{
            type:2,
            style:1,
            label:"納品を再試行",
            custom_id:"svm:retry:"+order.id
          }]}]
        ));
      }
    }
  }

  if(interaction.type===5){
    const id=String(interaction.data?.custom_id??"");

    if(id.startsWith("svm:order:")){
      const parts=id.split(":");
      const machineId=parts[2]??"";
      const method=parts[3] as "paypay"|"kyash";
      const productId=parts[4]??"";
      const machine=await getShiireMachine(env,machineId);
      const product=await getShiireProduct(env,productId);
      if(!machine||!product||product.vending_machine_id!==machine.id){
        return interactionResponse(ephemeral("商品が見つかりません。"));
      }
      if(!paymentMethodEnabled(product,method)){
        return interactionResponse(ephemeral("この商品では選択した決済方法は利用できません。"));
      }
      if(String(interaction.guild_id??"")!==machine.guild_id){
        return interactionResponse(ephemeral("このサーバーの自販機ではありません。"));
      }
      const fields=interaction.data?.components?.flatMap((row:any)=>row.components??[])??[];
      const quantity=Number(fields.find((field:any)=>field.custom_id==="quantity")?.value??1);
      const couponCode=String(
        fields.find((field:any)=>field.custom_id==="coupon")?.value??""
      ).trim();
      if(!Number.isInteger(quantity)||quantity<1||quantity>100){
        return interactionResponse(ephemeral("購入数が不正です。"));
      }
      const coupon=couponCode?await getShiireCoupon(env,machine.id,couponCode):null;
      if(couponCode&&!coupon){
        return interactionResponse(ephemeral("無効なクーポンコードです。"));
      }
      let order:ShiireVendingOrder|null=null;
      try{
        order=await reserveShiireOrder(env,{
          machine,
          product,
          guildId:machine.guild_id,
          userId:interactionUserId(interaction),
          method,
          quantity,
          discount:coupon?.discount??0
        });
      }catch(error){
        return interactionResponse(ephemeral(
          error instanceof Error&&error.message.includes("OUT_OF_STOCK")
            ?"在庫が不足しています。"
            :"在庫確保に失敗しました。"
        ));
      }
      if(!order) return interactionResponse(ephemeral("注文作成に失敗しました。"));
      await refreshMachinePanels(env,machine.id);

      if(order.total_amount===0){
        try{
          const delivered=await deliverOrder(env,order);
          return interactionResponse(ephemeral(
            delivered
              ?"購入完了しました。DMを確認してください。"
              :"購入済みですが納品待ちです。",
            delivered?undefined:[{type:1,components:[{
              type:2,style:1,label:"納品を再試行",custom_id:"svm:retry:"+order.id
            }]}]
          ));
        }catch{
          return interactionResponse(ephemeral(
            "購入は完了しましたがDM納品に失敗しました。",
            [{type:1,components:[{
              type:2,style:1,label:"納品を再試行",custom_id:"svm:retry:"+order.id
            }]}]
          ));
        }
      }

      return interactionResponse(ephemeral(
        "**"+product.name+"** × "+order.quantity+
        "\n支払額: **"+order.total_amount+"円**"+
        "\n10分以内に送金リンクを入力してください。",
        [{type:1,components:[{
          type:2,
          style:3,
          label:"送金リンクを入力",
          custom_id:"svm:pay:"+order.id
        }]}]
      ));
    }

    if(id.startsWith("svm:paymodal:")){
      const orderId=id.slice(13);
      const order=await getShiireOrder(env,orderId);
      if(!order||order.user_id!==interactionUserId(interaction)||order.status!=="awaiting_payment"){
        return interactionResponse(ephemeral("注文が失効しています。"));
      }
      const link=String(
        interaction.data?.components?.[0]?.components?.[0]?.value??""
      ).trim();
      if(!link||link.length>1000){
        return interactionResponse(ephemeral("送金リンクが不正です。"));
      }
      await attachShiirePaymentLink(env,order.id,link);
      const result=await processPaymentLink(env,order,link);
      if(result.status==="completed"){
        return interactionResponse(ephemeral(
          result.delivered
            ?"決済と納品が完了しました。DMを確認してください。"
            :"決済は完了しました。納品を再試行してください。",
          result.delivered?undefined:[{type:1,components:[{
            type:2,style:1,label:"納品を再試行",custom_id:"svm:retry:"+order.id
          }]}]
        ));
      }
      if(result.status==="pending"){
        return interactionResponse(ephemeral(
          "決済受取が保留されています。1分ごとに自動確認します。"
        ));
      }
      return interactionResponse(ephemeral(
        "決済を確認できませんでした。別の有効な送金リンクを入力してください。"
      ));
    }
  }

  return null;
}

function decodeBase64(value:string){
  const raw=atob(value);
  const bytes=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i);
  return bytes;
}

function parsePanelDataUrl(dataUrl:string){
  const match=dataUrl.match(/^data:(image\/(?:webp|png|jpeg|gif));base64,([A-Za-z0-9+/=]+)$/);
  if(!match) throw new ShiireVendingError(400,"INVALID_PANEL_IMAGE");
  if(dataUrl.length>1_250_000) throw new ShiireVendingError(413,"PANEL_IMAGE_TOO_LARGE");
  return {mime:match[1]!,base64:match[2]!};
}

export async function handleShiireVendingMedia(
  request:Request,
  env:Env,
  url:URL
):Promise<Response|null>{
  const match=url.pathname.match(/^\/media\/shiire-vending\/([^/]+)\/panel-image$/);
  if(!match) return null;
  if(request.method!=="GET") return responseJson({error:"METHOD_NOT_ALLOWED"},405);
  const image=await getShiirePanelImage(env,match[1]!);
  if(!image?.panel_image_mime||!image.panel_image_base64){
    return responseJson({error:"NOT_FOUND"},404);
  }
  return new Response(decodeBase64(image.panel_image_base64),{
    headers:{
      "Content-Type":image.panel_image_mime,
      "Cache-Control":"public, max-age=3600",
      "X-Content-Type-Options":"nosniff"
    }
  });
}

async function parseBridgeJson(rawBody:string){
  if(!rawBody) return {};
  try{return JSON.parse(rawBody) as Record<string,unknown>;}
  catch{throw new ShiireVendingError(400,"INVALID_JSON");}
}

async function machineInGuild(env:Env,machineId:string,guildId:string){
  const machine=await getShiireMachine(env,machineId);
  if(!machine||machine.guild_id!==guildId){
    throw new ShiireVendingError(404,"VENDING_MACHINE_NOT_FOUND");
  }
  return machine;
}

async function productInMachine(
  env:Env,
  productId:string,
  machine:ShiireVendingMachine
){
  const product=await getShiireProduct(env,productId);
  if(!product||product.vending_machine_id!==machine.id){
    throw new ShiireVendingError(404,"VENDING_PRODUCT_NOT_FOUND");
  }
  return product;
}

export async function handleShiireMainBridge(
  request:Request,
  env:Env,
  url:URL
):Promise<Response|null>{
  const root=url.pathname.match(/^\/bridge\/main\/guilds\/(\d+)(\/.*)?$/);
  if(!root) return null;
  const guildId=root[1]!;
  const suffix=root[2]??"";
  const rawBody=["GET","HEAD"].includes(request.method)?"":await request.text();
  await verifyMainBridgeRequest(request,env,url,rawBody);

  if(suffix==="/status"&&request.method==="GET"){
    let guild:null|{id:string;name:string;icon?:string|null}=null;
    let discordError:string|null=null;
    try{guild=await requireGuildOnShiire(env,guildId);}
    catch(error){discordError=error instanceof Error?error.message:String(error);}
    const payment=await getMainPaymentStatus(env).catch(()=>({paypay:false,kyash:false}));
    return responseJson({
      panelFormat:PANEL_FORMAT_VERSION,
      configured:Boolean(env.DISCORD_BOT_TOKEN&&env.DISCORD_APPLICATION_ID),
      installed:Boolean(guild),
      guild,
      discordError,
      payment,
      inviteUrl:env.DISCORD_APPLICATION_ID
        ?"https://discord.com/oauth2/authorize?client_id="+
          encodeURIComponent(env.DISCORD_APPLICATION_ID)+
          "&permissions="+encodeURIComponent(String(SHIIRE_DISCORD_BOT_PERMISSIONS))+"&integration_type=0&scope=bot%20applications.commands"
        :null
    });
  }

  if(suffix==="/operations/overview"&&request.method==="GET"){
    return responseJson(await operationsOverview(env));
  }

  if(
    suffix==="/operations/funding/confirm-direct-ltc"&&
    request.method==="POST"
  ){
    try{
      return responseJson(await confirmPendingDirectLtcFunding(env));
    }catch(error){
      const code=error instanceof Error?error.message:String(error);
      const status=
        code==="NO_PENDING_DIRECT_LTC_CONFIRMATION"||
        code==="LTC_BALANCE_INCREASE_NOT_DETECTED"||
        code==="BINANCE_FUNDING_MODE_INACTIVE"||
        code==="BINANCE_AUTO_FUNDING_SERVER_LOCKED"
          ?409
          :500;
      return responseJson({error:code},status);
    }
  }

  if(suffix==="/operations/binance"&&request.method==="GET"){
    const [market,restrictions,ltc,jpy,coinInfo,withdrawalSafety]=await Promise.all([
      operationSettled(()=>getLtcJpyMarketStatus()),
      operationSettled(()=>getBinanceApiRestrictions(env)),
      operationSettled(()=>getBinanceBalance(env,"LTC")),
      operationSettled(()=>getBinanceBalance(env,"JPY")),
      operationSettled(()=>getBinanceLtcCoinInfo(env)),
      operationSettled(()=>getBinanceWithdrawalSafetyStatus(env))
    ]);
    return responseJson({
      market,
      restrictions,
      balances:{ltc,jpy},
      coinInfo,
      withdrawalSafety
    });
  }

  if(suffix==="/operations/hstora"&&request.method==="GET"){
    const [balance,catalog]=await Promise.all([
      operationSettled(()=>getHstoraBalance(env)),
      operationSettled(()=>listHstoraCatalog(env,1,20))
    ]);
    return responseJson({
      balance,
      catalog,
      cachedProducts:await listSupplierProducts(env,false)
    });
  }

  if(suffix==="/operations/inventory"&&request.method==="GET"){
    return responseJson({
      summary:await inventorySummary(env),
      byClass:await inventoryClassSummary(env),
      supplierProducts:await listSupplierProducts(env,false)
    });
  }

  if(suffix==="/operations/orders"&&request.method==="GET"){
    return responseJson({
      statusSummary:await purchaseOrderStatusSummary(env),
      orders:await listPurchaseOrders(env,200)
    });
  }

  if(suffix==="/operations/logs"&&request.method==="GET"){
    const [logs,breakers,fundingEvents,cryptoTransactions]=await Promise.all([
      listAuditLogs(env,200),
      listOpenCircuitBreakers(env),
      recentFundingEvents(env,60),
      recentCryptoTransactions(env,60)
    ]);
    return responseJson({logs,breakers,fundingEvents,cryptoTransactions});
  }

  if(suffix==="/procurement-budget"&&request.method==="GET"){
    const settings=await loadXSettings(env);
    return responseJson({
      percentages:procurementBudgetPercentages(settings),
      budget:await getProcurementBudgets(env)
    });
  }

  if(suffix==="/procurement-budget"&&request.method==="POST"){
    const input=await parseBridgeJson(rawBody);
    const pending=await pendingPurchaseOrders(env);
    if(pending.length>0){
      throw new ShiireVendingError(409,"PENDING_HSTORA_ORDER_EXISTS");
    }
    const hstoraBreaker=await circuitState(env,"hstora");
    if(String(hstoraBreaker?.state??"")==="OPEN"){
      throw new ShiireVendingError(409,"HSTORA_CIRCUIT_BREAKER_OPEN");
    }
    const inviteCampaignPercent=Number(input.inviteCampaignPercent);
    const noShadowbanPercent=Number(input.noShadowbanPercent);
    const topSearchPercent=Number(input.topSearchPercent);
    const balance=await getHstoraBalance(env);
    if(String(balance.currency).toUpperCase()!=="USD"){
      throw new ShiireVendingError(409,"HSTORA_CURRENCY_UNSUPPORTED");
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
        message:"Procurement budget percentages changed from the authenticated main dashboard.",
        details:{
          percentages,
          currentHstoraBalanceUsd:Number(balance.balance),
          budget:budget.available
        }
      });
      return responseJson({
        ok:true,
        percentages,
        budget,
        currentHstoraBalanceUsd:Number(balance.balance)
      });
    }catch(error){
      if(error instanceof ShiireVendingError) throw error;
      throw new ShiireVendingError(
        400,
        error instanceof Error?error.message:"PROCUREMENT_BUDGET_INVALID"
      );
    }
  }

  if(suffix==="/procurement-budget/rebalance"&&request.method==="POST"){
    const pending=await pendingPurchaseOrders(env);
    if(pending.length>0){
      throw new ShiireVendingError(409,"PENDING_HSTORA_ORDER_EXISTS");
    }
    const hstoraBreaker=await circuitState(env,"hstora");
    if(String(hstoraBreaker?.state??"")==="OPEN"){
      throw new ShiireVendingError(409,"HSTORA_CIRCUIT_BREAKER_OPEN");
    }
    const [settings,balance]=await Promise.all([
      loadXSettings(env),
      getHstoraBalance(env)
    ]);
    if(String(balance.currency).toUpperCase()!=="USD"){
      throw new ShiireVendingError(409,"HSTORA_CURRENCY_UNSUPPORTED");
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
      message:"Procurement budgets were manually rebalanced from the authenticated main dashboard.",
      details:{
        percentages,
        currentHstoraBalanceUsd:Number(balance.balance),
        budget:budget.available
      }
    });
    return responseJson({
      ok:true,
      percentages,
      budget,
      currentHstoraBalanceUsd:Number(balance.balance)
    });
  }

  if(suffix==="/daily-restock"&&request.method==="GET"){
    const {getDailyRestockDashboard}=await import("./x-daily-restock");
    return responseJson(await getDailyRestockDashboard(env));
  }

  if(suffix==="/daily-restock/settings"&&request.method==="POST"){
    const {updateDailyRestockConfig}=await import("./x-daily-restock");
    const input=await parseBridgeJson(rawBody);
    if(input.notificationChannelId!==undefined){
      const channelId=String(input.notificationChannelId??"").trim();
      if(channelId) await requireChannelInGuild(env,guildId,channelId);
    }
    try{
      return responseJson({
        ok:true,
        ...await updateDailyRestockConfig(env,{
          enabled:input.enabled,
          topSearchTargetStock:input.topSearchTargetStock,
          noShadowbanTargetStock:input.noShadowbanTargetStock,
          notificationChannelId:input.notificationChannelId,
          notificationMessage:input.notificationMessage
        })
      });
    }catch(error){
      throw new ShiireVendingError(
        400,
        error instanceof Error?error.message:"DAILY_RESTOCK_SETTINGS_INVALID"
      );
    }
  }

  if(suffix==="/daily-restock/panel"&&request.method==="POST"){
    const {
      getDailyRestockDashboard,
      installDailyRestockPanel
    }=await import("./x-daily-restock");
    const dashboard=await getDailyRestockDashboard(env);
    const channelId=String(dashboard.config.notification_channel_id??"").trim();
    if(!channelId) throw new ShiireVendingError(409,"NOTIFICATION_CHANNEL_REQUIRED");
    await requireChannelInGuild(env,guildId,channelId);
    try{
      return responseJson({ok:true,...await installDailyRestockPanel(env)});
    }catch(error){
      throw new ShiireVendingError(
        409,
        error instanceof Error?error.message:"DAILY_RESTOCK_PANEL_FAILED"
      );
    }
  }

  if(suffix==="/daily-restock/run"&&request.method==="POST"){
    const {startDailyRestock}=await import("./x-daily-restock");
    try{
      return responseJson(await startDailyRestock(env,Date.now(),true));
    }catch(error){
      throw new ShiireVendingError(
        409,
        error instanceof Error?error.message:"DAILY_RESTOCK_RUN_FAILED"
      );
    }
  }

  if(suffix==="/invite-campaign"&&request.method==="GET"){
    const dashboard=await getInviteCampaignDashboard(env);
    return responseJson({
      ...dashboard,
      currentGuildId:guildId,
      currentGuildSelected:dashboard.settings.guild_id===guildId
    });
  }

  if(suffix==="/invite-campaign/settings"&&request.method==="POST"){
    const input=await parseBridgeJson(rawBody);
    try{
      const settings=await saveInviteCampaignSettings(env,{
        enabled:input.enabled,
        guildId,
        invitesPerReward:input.invitesPerReward,
        targetStock:input.targetStock
      });
      if(settings.enabled){
        try{
          await ensureInviteCampaignGateway(env);
          await seedInviteCampaignSnapshot(env,guildId);
          await reconcileInviteCampaignRewards(env);
        }catch(error){
          await saveInviteCampaignSettings(env,{enabled:false,guildId});
          await stopInviteCampaignGateway(env).catch(()=>undefined);
          throw new ShiireVendingError(
            409,
            "INVITE_CAMPAIGN_START_FAILED:"+
            (error instanceof Error?error.message:String(error))
          );
        }
      }else{
        await stopInviteCampaignGateway(env);
      }
      return responseJson({
        ok:true,
        ...await getInviteCampaignDashboard(env),
        currentGuildId:guildId,
        currentGuildSelected:true
      });
    }catch(error){
      if(error instanceof ShiireVendingError) throw error;
      throw new ShiireVendingError(
        400,
        error instanceof Error?error.message:"INVITE_CAMPAIGN_SETTINGS_INVALID"
      );
    }
  }

  if(suffix==="/invite-campaign/seed"&&request.method==="POST"){
    const settings=await getInviteCampaignDashboard(env);
    if(settings.settings.guild_id!==guildId){
      throw new ShiireVendingError(409,"INVITE_CAMPAIGN_DIFFERENT_GUILD");
    }
    try{
      const result=await seedInviteCampaignSnapshot(env,guildId);
      return responseJson({
        ok:true,
        result,
        ...await getInviteCampaignDashboard(env),
        currentGuildId:guildId,
        currentGuildSelected:true
      });
    }catch(error){
      throw new ShiireVendingError(
        409,
        error instanceof Error?error.message:"INVITE_CAMPAIGN_SEED_FAILED"
      );
    }
  }

  const inviteRewardRetry=suffix.match(
    /^\/invite-campaign\/rewards\/([^/]+)\/retry$/
  );
  if(inviteRewardRetry&&request.method==="POST"){
    const dashboard=await getInviteCampaignDashboard(env);
    if(dashboard.settings.guild_id!==guildId){
      throw new ShiireVendingError(409,"INVITE_CAMPAIGN_DIFFERENT_GUILD");
    }
    const rewardId=decodeURIComponent(inviteRewardRetry[1]!);
    if(!(dashboard.rewards as Array<{id:string}>).some(row=>row.id===rewardId)){
      throw new ShiireVendingError(404,"INVITE_REWARD_NOT_FOUND_IN_GUILD");
    }
    try{
      const result=await retryInviteCampaignReward(env,rewardId);
      return responseJson({
        ok:true,
        result,
        ...await getInviteCampaignDashboard(env),
        currentGuildId:guildId,
        currentGuildSelected:true
      });
    }catch(error){
      throw new ShiireVendingError(
        409,
        error instanceof Error?error.message:"INVITE_REWARD_RETRY_FAILED"
      );
    }
  }

  if(suffix==="/run"&&request.method==="POST"){
    const {runXProcurement}=await import("./x-engine");
    return responseJson(await runXProcurement(env));
  }

  if(suffix==="/funding/auto-purchase/run"&&request.method==="POST"){
    const {runLtcAutoPurchase}=await import("./x-engine");
    return responseJson(await runLtcAutoPurchase(env));
  }

  if(suffix==="/funding/mode"&&request.method==="POST"){
    const input=await parseBridgeJson(rawBody);
    const mode=String(input.mode??"");
    if(mode!=="manual_hstora"&&mode!=="binance_auto"){
      throw new ShiireVendingError(400,"INVALID_FUNDING_MODE");
    }
    if(mode==="binance_auto"&&!isBinanceAutoFundingServerEnabled(env)){
      throw new ShiireVendingError(409,"BINANCE_AUTO_FUNDING_SERVER_LOCKED");
    }
    const settings=await saveXSettings(env,mode==="manual_hstora"?{
      funding_mode:"manual_hstora",
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
    }:{
      funding_mode:"binance_auto"
    });
    await auditX(env,{
      kind:"FUNDING_MODE_CHANGED",
      message:"Funding mode changed from the authenticated main dashboard.",
      details:{mode:settings.funding_mode}
    });
    return responseJson({
      ok:true,
      funding_mode:settings.funding_mode,
      fundingModeLabel:fundingModeLabel(settings.funding_mode),
      binanceAutoFundingServerEnabled:isBinanceAutoFundingServerEnabled(env)
    });
  }

  if(suffix==="/funding-settings"){
    if(request.method==="GET"){
      const settings=await loadXSettings(env);
      return responseJson({
        reserve_jpy:settings.reserve_jpy,
        max_purchase_jpy:settings.max_purchase_jpy,
        daily_purchase_limit_jpy:settings.daily_purchase_limit_jpy,
        weekly_purchase_limit_jpy:settings.weekly_purchase_limit_jpy,
        monthly_purchase_limit_jpy:settings.monthly_purchase_limit_jpy,
        min_purchase_jpy:settings.min_purchase_jpy,
        target_ltc_balance:settings.target_ltc_balance,
        max_ltc_balance:settings.max_ltc_balance,
        wallet_target_ltc:settings.wallet_target_ltc,
        wallet_max_ltc:settings.wallet_max_ltc,
        max_paypay_balance_age_ms:settings.max_paypay_balance_age_ms,
        max_fx_age_ms:settings.max_fx_age_ms,
        max_fx_jump_percent:settings.max_fx_jump_percent,
        max_ltc_price_jump_percent:settings.max_ltc_price_jump_percent,
        observed_paypay_balance_jpy:settings.observed_paypay_balance_jpy,
        observed_paypay_balance_at:settings.observed_paypay_balance_at,
        usd_jpy_rate:settings.usd_jpy_rate,
        usd_jpy_rate_updated_at:settings.usd_jpy_rate_updated_at
      });
    }
    if(request.method==="PATCH"){
      const input=await parseBridgeJson(rawBody);
      const patch:Record<string,number>={};
      const integerKeys=[
        "reserve_jpy",
        "max_purchase_jpy",
        "daily_purchase_limit_jpy",
        "weekly_purchase_limit_jpy",
        "monthly_purchase_limit_jpy",
        "min_purchase_jpy"
      ] as const;
      const numberKeys=[
        "target_ltc_balance",
        "max_ltc_balance",
        "wallet_target_ltc",
        "wallet_max_ltc",
        "max_fx_jump_percent",
        "max_ltc_price_jump_percent"
      ] as const;
      const extraIntegerKeys=[
        "max_paypay_balance_age_ms",
        "max_fx_age_ms"
      ] as const;
      for(const key of integerKeys){
        if(input[key]===undefined) continue;
        const value=Number(input[key]);
        if(!Number.isSafeInteger(value)||value<0){
          throw new ShiireVendingError(400,"INVALID_FUNDING_SETTING_"+key.toUpperCase());
        }
        patch[key]=value;
      }
      for(const key of numberKeys){
        if(input[key]===undefined) continue;
        const value=Number(input[key]);
        if(!Number.isFinite(value)||value<0){
          throw new ShiireVendingError(400,"INVALID_FUNDING_SETTING_"+key.toUpperCase());
        }
        patch[key]=value;
      }
      for(const key of extraIntegerKeys){
        if(input[key]===undefined) continue;
        const value=Number(input[key]);
        if(!Number.isSafeInteger(value)||value<0){
          throw new ShiireVendingError(400,"INVALID_FUNDING_SETTING_"+key.toUpperCase());
        }
        patch[key]=value;
      }
      try{
        const settings=await saveXSettings(env,patch);
        await auditX(env,{
          kind:"FUNDING_SETTINGS_UPDATED",
          message:"Funding limits were updated from the authenticated main dashboard.",
          details:{keys:Object.keys(patch)}
        });
        return responseJson({
          ok:true,
          settings:{
            reserve_jpy:settings.reserve_jpy,
            max_purchase_jpy:settings.max_purchase_jpy,
            daily_purchase_limit_jpy:settings.daily_purchase_limit_jpy,
            weekly_purchase_limit_jpy:settings.weekly_purchase_limit_jpy,
            monthly_purchase_limit_jpy:settings.monthly_purchase_limit_jpy,
            min_purchase_jpy:settings.min_purchase_jpy,
            target_ltc_balance:settings.target_ltc_balance,
            max_ltc_balance:settings.max_ltc_balance,
            wallet_target_ltc:settings.wallet_target_ltc,
            wallet_max_ltc:settings.wallet_max_ltc,
            max_paypay_balance_age_ms:settings.max_paypay_balance_age_ms,
            max_fx_age_ms:settings.max_fx_age_ms,
            max_fx_jump_percent:settings.max_fx_jump_percent,
            max_ltc_price_jump_percent:settings.max_ltc_price_jump_percent
          }
        });
      }catch(error){
        throw new ShiireVendingError(
          400,
          error instanceof Error?error.message:"FUNDING_SETTINGS_INVALID"
        );
      }
    }
  }

  if(suffix==="/funding/paypay-observation"&&request.method==="POST"){
    const input=await parseBridgeJson(rawBody);
    const balanceJpy=Number(input.balanceJpy);
    if(!Number.isSafeInteger(balanceJpy)||balanceJpy<0){
      throw new ShiireVendingError(400,"INVALID_PAYPAY_BALANCE");
    }
    const settings=await saveXSettings(env,{
      observed_paypay_balance_jpy:balanceJpy,
      observed_paypay_balance_at:Date.now()
    });
    await auditX(env,{
      kind:"paypay_balance_observed",
      message:"PayPay balance observation updated from the authenticated main dashboard.",
      details:{balanceJpy}
    });
    return responseJson({
      ok:true,
      balanceJpy:settings.observed_paypay_balance_jpy,
      observedAt:settings.observed_paypay_balance_at
    });
  }

  if(suffix==="/funding/usd-jpy-observation"&&request.method==="POST"){
    const input=await parseBridgeJson(rawBody);
    const rate=Number(input.rate);
    if(!Number.isFinite(rate)||rate<=0){
      throw new ShiireVendingError(400,"INVALID_USD_JPY_RATE");
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
        throw new ShiireVendingError(409,"FX_RATE_CIRCUIT_BREAKER");
      }
    }
    const settings=await saveXSettings(env,{
      usd_jpy_rate:rate,
      usd_jpy_rate_updated_at:now
    });
    await auditX(env,{
      kind:"usd_jpy_rate_observed",
      message:"USD/JPY observation updated from the authenticated main dashboard.",
      details:{rate}
    });
    return responseJson({
      ok:true,
      rate:settings.usd_jpy_rate,
      observedAt:settings.usd_jpy_rate_updated_at
    });
  }

  if(suffix==="/funding/pending/cancel"&&request.method==="POST"){
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
      message:"Pending manual PayPay funding request was cancelled from the authenticated main dashboard.",
      details:{cancelledAmountJpy:current.pending_paypay_funding_jpy}
    });
    return responseJson({
      ok:true,
      pending:false,
      observedPayPayBalanceJpy:settings.observed_paypay_balance_jpy
    });
  }

  if(suffix==="/automation-settings"){
    if(request.method==="GET"){
      const settings=await loadXSettings(env);
      return responseJson({
        dry_run:settings.dry_run,
        emergency_stop:settings.emergency_stop,
        auto_purchase_enabled:settings.auto_purchase_enabled,
        auto_procurement_enabled:settings.auto_procurement_enabled
      });
    }
    if(request.method==="PATCH"){
      const input=await parseBridgeJson(rawBody);
      const current=await loadXSettings(env);
      const patch:Partial<{
        dry_run:boolean;
        auto_purchase_enabled:boolean;
        auto_procurement_enabled:boolean;
      }>={};
      for(const key of [
        "dry_run",
        "auto_purchase_enabled",
        "auto_procurement_enabled"
      ] as const){
        if(input[key]===undefined) continue;
        if(typeof input[key]!=="boolean"){
          throw new ShiireVendingError(400,"INVALID_AUTOMATION_SETTING_"+key.toUpperCase());
        }
        patch[key]=input[key] as boolean;
      }
      if(current.emergency_stop&&(
        patch.auto_purchase_enabled===true||
        patch.auto_procurement_enabled===true||
        patch.dry_run===false
      )){
        throw new ShiireVendingError(409,"EMERGENCY_STOP_ACTIVE");
      }
      const nextDryRun=patch.dry_run??current.dry_run;
      const enablingLiveAutomation=
        nextDryRun===false&&(
          (patch.auto_purchase_enabled===true&&!current.auto_purchase_enabled)||
          (patch.auto_procurement_enabled===true&&!current.auto_procurement_enabled)
        );
      const leavingDryRun=current.dry_run===true&&patch.dry_run===false;
      if((enablingLiveAutomation||leavingDryRun)&&input.confirmLive!==true){
        throw new ShiireVendingError(409,"LIVE_MODE_CONFIRMATION_REQUIRED");
      }
      try{
        const settings=await saveXSettings(env,patch);
        await auditX(env,{
          kind:"AUTOMATION_SETTINGS_UPDATED",
          message:"Automation safety settings were updated from the authenticated main dashboard.",
          details:{
            dryRun:settings.dry_run,
            autoPurchaseEnabled:settings.auto_purchase_enabled,
            autoProcurementEnabled:settings.auto_procurement_enabled
          }
        });
        return responseJson({
          ok:true,
          dry_run:settings.dry_run,
          emergency_stop:settings.emergency_stop,
          auto_purchase_enabled:settings.auto_purchase_enabled,
          auto_procurement_enabled:settings.auto_procurement_enabled
        });
      }catch(error){
        throw new ShiireVendingError(
          400,
          error instanceof Error?error.message:"AUTOMATION_SETTINGS_INVALID"
        );
      }
    }
  }

  if(suffix==="/emergency-stop"&&request.method==="POST"){
    const settings=await saveXSettings(env,{
      emergency_stop:true,
      auto_purchase_enabled:false,
      auto_procurement_enabled:false
    });
    await auditX(env,{
      level:"warn",
      kind:"EMERGENCY_STOP_ENABLED",
      message:"Emergency Stop was enabled from the authenticated main dashboard."
    });
    return responseJson({
      ok:true,
      emergency_stop:settings.emergency_stop,
      auto_purchase_enabled:settings.auto_purchase_enabled,
      auto_procurement_enabled:settings.auto_procurement_enabled
    });
  }

  if(suffix==="/emergency-stop/reset"&&request.method==="POST"){
    const settings=await saveXSettings(env,{emergency_stop:false});
    await auditX(env,{
      kind:"EMERGENCY_STOP_RESET",
      message:"Emergency Stop was reset from the authenticated main dashboard. Automation remains unchanged."
    });
    return responseJson({
      ok:true,
      emergency_stop:settings.emergency_stop,
      auto_purchase_enabled:settings.auto_purchase_enabled,
      auto_procurement_enabled:settings.auto_procurement_enabled,
      note:"Automation is not re-enabled automatically."
    });
  }

  const breakerReset=suffix.match(/^\/circuit-breakers\/([^/]+)\/reset$/);
  if(breakerReset&&request.method==="POST"){
    const key=decodeURIComponent(breakerReset[1]!);
    if(!/^[a-z0-9_-]{1,64}$/i.test(key)){
      throw new ShiireVendingError(400,"INVALID_BREAKER_KEY");
    }
    await setCircuitBreaker(env,key,"CLOSED","MAIN_DASHBOARD_RESET");
    await auditX(env,{
      kind:"CIRCUIT_BREAKER_RESET",
      message:"Circuit Breaker was reset from the authenticated main dashboard.",
      details:{key}
    });
    return responseJson({ok:true,key,state:"CLOSED"});
  }

  if(suffix==="/bulk-approval"&&request.method==="POST"){
    const input=await parseBridgeJson(rawBody);
    const minutes=Math.max(1,Math.min(60,Math.floor(Number(input.minutes??10))));
    const settings=await saveXSettings(env,{
      bulk_approval_until:Date.now()+minutes*60_000
    });
    await auditX(env,{
      kind:"BULK_PURCHASE_APPROVED",
      message:"Bulk procurement was temporarily approved from the authenticated main dashboard.",
      details:{minutes,approvedUntil:settings.bulk_approval_until}
    });
    return responseJson({ok:true,approvedUntil:settings.bulk_approval_until});
  }

  if(suffix==="/procurement-settings"){
    if(request.method==="GET"){
      const settings=await loadXSettings(env);
      return responseJson({
        max_unit_price_jpy:settings.max_unit_price_jpy,
        max_no_shadowban_unit_price_usd:settings.max_no_shadowban_unit_price_usd,
        reorder_point:settings.reorder_point,
        target_stock:settings.target_stock,
        no_shadowban_reorder_point:settings.no_shadowban_reorder_point,
        no_shadowban_target_stock:settings.no_shadowban_target_stock,
        trial_purchase_count:settings.trial_purchase_count,
        max_batch_purchase:settings.max_batch_purchase,
        min_seller_rating:settings.min_seller_rating,
        min_product_reviews:settings.min_product_reviews,
        min_sales_count:settings.min_sales_count,
        max_dispute_rate:settings.max_dispute_rate,
        minimum_stock:settings.minimum_stock,
        seller_quality_mode:settings.seller_quality_mode,
        approved_hstora_product_ids:settings.approved_hstora_product_ids,
        max_price_jump_percent:settings.max_price_jump_percent,
        require_bulk_confirmation:settings.require_bulk_confirmation,
        bulk_confirmation_threshold:settings.bulk_confirmation_threshold,
        procurement_strategy:settings.procurement_strategy,
        search_visibility_requirement:settings.search_visibility_requirement,
        dry_run:settings.dry_run,
        auto_procurement_enabled:settings.auto_procurement_enabled
      });
    }
    if(request.method==="PATCH"){
      const input=await parseBridgeJson(rawBody);
      const patch:Record<string,unknown>={};
      const integerKeys=[
        "reorder_point",
        "target_stock",
        "no_shadowban_reorder_point",
        "no_shadowban_target_stock",
        "trial_purchase_count",
        "max_batch_purchase",
        "min_product_reviews",
        "min_sales_count",
        "minimum_stock",
        "bulk_confirmation_threshold"
      ] as const;
      const numberKeys=[
        "max_unit_price_jpy",
        "max_no_shadowban_unit_price_usd",
        "min_seller_rating",
        "max_dispute_rate",
        "max_price_jump_percent"
      ] as const;
      for(const key of integerKeys){
        if(input[key]===undefined) continue;
        const value=Number(input[key]);
        if(!Number.isSafeInteger(value)||value<0){
          throw new ShiireVendingError(400,"INVALID_PROCUREMENT_SETTING_"+key.toUpperCase());
        }
        patch[key]=value;
      }
      for(const key of numberKeys){
        if(input[key]===undefined) continue;
        const value=Number(input[key]);
        if(!Number.isFinite(value)||value<0){
          throw new ShiireVendingError(400,"INVALID_PROCUREMENT_SETTING_"+key.toUpperCase());
        }
        patch[key]=value;
      }
      if(input.require_bulk_confirmation!==undefined){
        if(typeof input.require_bulk_confirmation!=="boolean"){
          throw new ShiireVendingError(400,"INVALID_PROCUREMENT_SETTING_REQUIRE_BULK_CONFIRMATION");
        }
        patch.require_bulk_confirmation=input.require_bulk_confirmation;
      }
      if(input.seller_quality_mode!==undefined){
        const mode=String(input.seller_quality_mode);
        if(!["strict_api","manual_product_approval","trial_only"].includes(mode)){
          throw new ShiireVendingError(400,"INVALID_SELLER_QUALITY_MODE");
        }
        patch.seller_quality_mode=mode;
      }
      if(input.approved_hstora_product_ids!==undefined){
        if(!Array.isArray(input.approved_hstora_product_ids)){
          throw new ShiireVendingError(400,"INVALID_APPROVED_HSTORA_PRODUCT_IDS");
        }
        const ids=[...new Set(input.approved_hstora_product_ids.map(Number))];
        if(ids.some(id=>!Number.isSafeInteger(id)||id<=0)){
          throw new ShiireVendingError(400,"INVALID_APPROVED_HSTORA_PRODUCT_IDS");
        }
        patch.approved_hstora_product_ids=ids;
      }
      try{
        const settings=await saveXSettings(env,patch);
        await auditX(env,{
          kind:"PROCUREMENT_SETTINGS_UPDATED",
          message:"Procurement settings were updated from the authenticated main dashboard.",
          details:{keys:Object.keys(patch)}
        });
        return responseJson({
          ok:true,
          settings:{
            max_unit_price_jpy:settings.max_unit_price_jpy,
            max_no_shadowban_unit_price_usd:settings.max_no_shadowban_unit_price_usd,
            reorder_point:settings.reorder_point,
            target_stock:settings.target_stock,
            no_shadowban_reorder_point:settings.no_shadowban_reorder_point,
            no_shadowban_target_stock:settings.no_shadowban_target_stock,
            trial_purchase_count:settings.trial_purchase_count,
            max_batch_purchase:settings.max_batch_purchase,
            min_seller_rating:settings.min_seller_rating,
            min_product_reviews:settings.min_product_reviews,
            min_sales_count:settings.min_sales_count,
            max_dispute_rate:settings.max_dispute_rate,
            minimum_stock:settings.minimum_stock,
            seller_quality_mode:settings.seller_quality_mode,
            approved_hstora_product_ids:settings.approved_hstora_product_ids,
            max_price_jump_percent:settings.max_price_jump_percent,
            require_bulk_confirmation:settings.require_bulk_confirmation,
            bulk_confirmation_threshold:settings.bulk_confirmation_threshold
          }
        });
      }catch(error){
        throw new ShiireVendingError(
          400,
          error instanceof Error?error.message:"PROCUREMENT_SETTINGS_INVALID"
        );
      }
    }
  }

  if(suffix==="/source-products"&&request.method==="GET"){
    return responseJson({products:await listShiireSourceProducts(env)});
  }

  if(suffix==="/orders"&&request.method==="GET"){
    return responseJson({orders:await listShiireOrders(env,guildId,200)});
  }

  if(suffix==="/payment-status"&&request.method==="GET"){
    return responseJson(await getMainPaymentStatus(env));
  }

  if(suffix==="/vending"){
    if(request.method==="GET"){
      await ensureVendingSalesCopy(env,guildId);
      const machines=await listShiireMachines(env,guildId);
      const enriched=[];
      for(const machine of machines){
        const added=await ensureShiireDefaultProducts(env,machine.id);
        if(added>0) await refreshMachinePanels(env,machine.id);
        enriched.push({
          ...machine,
          products:await listShiireProducts(env,machine.id),
          panels:await listShiirePanels(env,machine.id),
          stockNotification:await getShiireStockNotification(env,machine.id)
        });
      }
      return responseJson(enriched);
    }
    if(request.method==="POST"){
      const input=await parseBridgeJson(rawBody);
      const name=String(input.name??"").trim();
      if(!name||name.length>80){
        throw new ShiireVendingError(400,"INVALID_MACHINE_NAME");
      }
      return responseJson(await createShiireMachine(env,guildId,name),201);
    }
  }

  const machineMatch=suffix.match(/^\/vending\/([^/]+)$/);
  if(machineMatch){
    const machine=await machineInGuild(env,machineMatch[1]!,guildId);
    if(request.method==="GET"){
      const added=await ensureShiireDefaultProducts(env,machine.id);
      if(added>0) await refreshMachinePanels(env,machine.id);
      return responseJson({
        ...machine,
        products:await listShiireProducts(env,machine.id),
        panels:await listShiirePanels(env,machine.id),
        coupons:await listShiireCoupons(env,machine.id),
        stockNotification:await getShiireStockNotification(env,machine.id)
      });
    }
    if(request.method==="PATCH"){
      const input=await parseBridgeJson(rawBody);
      const patch:{
        name?:string;
        publicLogChannelId?:string|null;
        privateLogChannelId?:string|null;
        roleId?:string|null;
        panelTitle?:string|null;
        panelDescription?:string|null;
        panelColor?:number;
      }={};
      if(input.name!==undefined){
        const name=String(input.name).trim();
        if(!name||name.length>80) throw new ShiireVendingError(400,"INVALID_MACHINE_NAME");
        patch.name=name;
      }
      for(const [key,target] of [
        ["publicLogChannelId","publicLogChannelId"],
        ["privateLogChannelId","privateLogChannelId"]
      ] as const){
        if(input[key]!==undefined){
          const value=String(input[key]??"").trim();
          if(value) await requireChannelInGuild(env,guildId,value);
          patch[target]=value||null;
        }
      }
      if(input.roleId!==undefined){
        const roleId=String(input.roleId??"").trim();
        if(roleId) await requireRoleInGuild(env,guildId,roleId);
        patch.roleId=roleId||null;
      }
      if(input.panelTitle!==undefined){
        patch.panelTitle=String(input.panelTitle??"").slice(0,256)||null;
      }
      if(input.panelDescription!==undefined){
        patch.panelDescription=String(input.panelDescription??"").slice(0,3000)||null;
      }
      if(input.panelColor!==undefined){
        if(!isPanelColor(input.panelColor)) throw new ShiireVendingError(400,"INVALID_PANEL_COLOR");
        patch.panelColor=input.panelColor;
      }
      await updateShiireMachine(env,machine.id,patch);
      const panelRefreshOk=await refreshMachinePanels(env,machine.id);
      if(!panelRefreshOk){
        await auditX(env,{
          level:"warn",
          kind:"SHIIRE_VENDING_PANEL_REFRESH_FAILED",
          message:"Vending machine changes were saved, but one or more Discord panels could not be refreshed.",
          details:{
            guildId,
            machineId:machine.id
          }
        }).catch(()=>undefined);
        return responseJson({
          ok:false,
          saved:true,
          panelRefreshOk:false,
          error:"VENDING_PANEL_REFRESH_FAILED",
          message:"自販機設定は保存されましたが、Discord自販機パネルへの反映に失敗しました。再試行してください。"
        },502);
      }
      return responseJson({ok:true,saved:true,panelRefreshOk:true});
    }
    if(request.method==="DELETE"){
      await cleanShiireVendingExpired(env);
      try{await deleteShiireMachine(env,machine.id);}
      catch(error){
        if(error instanceof Error&&error.message==="SHIIRE_MACHINE_HAS_OPEN_ORDERS"){
          return responseJson({message:"支払い待ち・決済処理中・納品中の注文があります。注文の完了または期限切れ後に削除してください。"},409);
        }
        throw error;
      }
      const panelErrors=[];
      for(const panel of await listShiirePanels(env,machine.id)){
        try{
          const result=await deleteDiscordMessage(env,panel.channel_id,panel.message_id);
          if(!result.ok) throw new Error("DISCORD_"+result.status);
          await deleteShiirePanelRecord(env,machine.id,panel.channel_id,panel.message_id);
        }catch(error){
          panelErrors.push({channelId:panel.channel_id,messageId:panel.message_id,error:error instanceof Error?error.message:String(error)});
        }
      }
      return responseJson({ok:true,panelErrors});
    }
  }

  const productsMatch=suffix.match(/^\/vending\/([^/]+)\/products$/);
  if(productsMatch){
    const machine=await machineInGuild(env,productsMatch[1]!,guildId);
    if(request.method==="GET"){
      return responseJson(await listShiireProducts(env,machine.id));
    }
    if(request.method==="POST"){
      const input=await parseBridgeJson(rawBody);
      const existingProducts=await listShiireProducts(env,machine.id);
      if(existingProducts.length>=25){
        throw new ShiireVendingError(409,"VENDING_PRODUCT_LIMIT_REACHED");
      }
      const name=String(input.name??"").trim();
      const supplierProductId=String(input.supplierProductId??"").trim();
      const procurementClass=
        input.procurementClass==="TOP_SEARCH"||
        input.procurementClass==="NO_SHADOWBAN"
          ?input.procurementClass
          :null;
      const pricePayPay=Number(input.pricePayPay??0);
      const priceKyash=Number(input.priceKyash??0);
      if(
        !name||name.length>80||
        (!supplierProductId&&!procurementClass)||
        (supplierProductId&&procurementClass)||
        !Number.isSafeInteger(pricePayPay)||pricePayPay<0||
        !Number.isSafeInteger(priceKyash)||priceKyash<0
      ){
        throw new ShiireVendingError(400,"INVALID_PRODUCT");
      }
      const product=await createShiireProduct(env,machine.id,{
        supplierProductId:supplierProductId||undefined,
        procurementClass,
        name,
        description:String(input.description??"").slice(0,500),
        pricePayPay,
        priceKyash,
        emoji:input.emoji?String(input.emoji).slice(0,64):null
      });
      await refreshMachinePanels(env,machine.id);
      return responseJson(product,201);
    }
  }

  const productMatch=suffix.match(/^\/vending\/([^/]+)\/products\/([^/]+)$/);
  if(productMatch){
    const machine=await machineInGuild(env,productMatch[1]!,guildId);
    const product=await productInMachine(env,productMatch[2]!,machine);
    if(request.method==="PATCH"){
      const input=await parseBridgeJson(rawBody);
      const patch:any={};
      if(input.procurementClass!==undefined){
        if(
          input.procurementClass!==null&&
          input.procurementClass!=="TOP_SEARCH"&&
          input.procurementClass!=="NO_SHADOWBAN"
        ){
          throw new ShiireVendingError(400,"INVALID_PROCUREMENT_CLASS");
        }
        patch.procurementClass=input.procurementClass;
      }
      if(input.supplierProductId!==undefined){
        patch.supplierProductId=String(input.supplierProductId).trim();
      }
      if(
        input.procurementClass!==undefined&&
        input.supplierProductId!==undefined
      ){
        throw new ShiireVendingError(400,"VENDING_SOURCE_CONFLICT");
      }
      if(input.name!==undefined){
        const name=String(input.name).trim();
        if(!name||name.length>80) throw new ShiireVendingError(400,"INVALID_PRODUCT_NAME");
        patch.name=name;
      }
      if(input.description!==undefined) patch.description=String(input.description).slice(0,500);
      for(const key of ["pricePayPay","priceKyash"] as const){
        if(input[key]!==undefined){
          const value=Number(input[key]);
          if(!Number.isSafeInteger(value)||value<0){
            throw new ShiireVendingError(400,"INVALID_PRODUCT_PRICE");
          }
          patch[key]=value;
        }
      }
      if(input.emoji!==undefined) patch.emoji=input.emoji?String(input.emoji).slice(0,64):null;
      await updateShiireProduct(env,product.id,patch);
      if(input.repostPanels===true){
        return responseJson({
          ok:true,
          panelRepost:await repostMachinePanels(env,machine.id)
        });
      }
      const panelRefreshOk=await refreshMachinePanels(env,machine.id);
      if(!panelRefreshOk){
        await auditX(env,{
          level:"warn",
          kind:"SHIIRE_VENDING_PANEL_REFRESH_FAILED",
          message:"Product changes were saved, but one or more Discord vending panels could not be refreshed.",
          details:{
            guildId,
            machineId:machine.id,
            productId:product.id
          }
        }).catch(()=>undefined);
        return responseJson({
          ok:false,
          saved:true,
          panelRefreshOk:false,
          error:"VENDING_PANEL_REFRESH_FAILED",
          message:"商品情報は保存されましたが、Discord自販機パネルへの反映に失敗しました。再投稿してください。"
        },502);
      }
      return responseJson({ok:true,saved:true,panelRefreshOk:true});
    }
    if(request.method==="DELETE"){
      const ok=await deleteShiireProduct(env,product.id);
      await refreshMachinePanels(env,machine.id);
      return responseJson({ok});
    }
  }

  const notifyMatch=suffix.match(/^\/vending\/([^/]+)\/stock-notification$/);
  if(notifyMatch){
    const machine=await machineInGuild(env,notifyMatch[1]!,guildId);
    if(request.method==="GET"){
      return responseJson(await getShiireStockNotification(env,machine.id));
    }
    if(request.method==="POST"){
      const input=await parseBridgeJson(rawBody);
      const current=await getShiireStockNotification(env,machine.id);
      const channelId=String(input.channelId??current?.channel_id??"").trim();
      const roleId=String(input.roleId??current?.role_id??"").trim();
      const enabled=Boolean(input.enabled);
      if((channelId&&!roleId)||(!channelId&&roleId)){
        throw new ShiireVendingError(400,"NOTIFICATION_CHANNEL_ROLE_REQUIRED");
      }
      if(enabled&&(!channelId||!roleId)){
        throw new ShiireVendingError(400,"NOTIFICATION_CONFIG_REQUIRED");
      }
      if(channelId) await requireChannelInGuild(env,guildId,channelId);
      if(roleId) await requireRoleInGuild(env,guildId,roleId);
      if(!channelId&&!roleId){
        await deleteShiireStockNotification(env,machine.id);
        return responseJson({ok:true,enabled:false});
      }
      await saveShiireStockNotification(
        env,machine.id,guildId,channelId,roleId,enabled
      );
      return responseJson({ok:true,enabled});
    }
    if(request.method==="DELETE"){
      await deleteShiireStockNotification(env,machine.id);
      return responseJson({ok:true});
    }
  }

  const couponMatch=suffix.match(/^\/vending\/([^/]+)\/coupons$/);
  if(couponMatch){
    const machine=await machineInGuild(env,couponMatch[1]!,guildId);
    if(request.method==="GET"){
      return responseJson(await listShiireCoupons(env,machine.id));
    }
    if(request.method==="POST"){
      const input=await parseBridgeJson(rawBody);
      const code=String(input.code??"").trim();
      const discount=Number(input.discount);
      if(!code||code.length>50||!Number.isSafeInteger(discount)||discount<=0){
        throw new ShiireVendingError(400,"INVALID_COUPON");
      }
      try{await createShiireCoupon(env,machine.id,code,discount);}
      catch{throw new ShiireVendingError(409,"COUPON_EXISTS");}
      return responseJson({ok:true},201);
    }
  }

  const couponDelete=suffix.match(/^\/vending\/([^/]+)\/coupons\/([^/]+)$/);
  if(couponDelete&&request.method==="DELETE"){
    const machine=await machineInGuild(env,couponDelete[1]!,guildId);
    return responseJson({
      ok:await deleteShiireCoupon(
        env,
        machine.id,
        decodeURIComponent(couponDelete[2]!)
      )
    });
  }

  const panelMatch=suffix.match(/^\/vending\/([^/]+)\/panel$/);
  if(panelMatch&&request.method==="POST"){
    const machine=await machineInGuild(env,panelMatch[1]!,guildId);
    const input=await parseBridgeJson(rawBody);
    const channelId=String(input.channelId??"").trim();
    if(!channelId) throw new ShiireVendingError(400,"CHANNEL_REQUIRED");
    await requireChannelInGuild(env,guildId,channelId);
    const products=await listShiireProducts(env,machine.id);
    const message=await sendJsonMessage(
      env,
      channelId,
      panelPayload(machine,products)
    );
    await saveShiirePanel(env,machine.id,guildId,channelId,message.id);
    return responseJson({ok:true,messageId:message.id});
  }

  const panelRepost=suffix.match(/^\/vending\/([^/]+)\/panel\/repost$/);
  if(panelRepost&&request.method==="POST"){
    const machine=await machineInGuild(env,panelRepost[1]!,guildId);
    return responseJson(await repostMachinePanels(env,machine.id));
  }

  const panelUpdate=suffix.match(/^\/vending\/([^/]+)\/panel\/update$/);
  if(panelUpdate&&request.method==="POST"){
    const machine=await machineInGuild(env,panelUpdate[1]!,guildId);
    const input=await parseBridgeJson(rawBody);
    const match=String(input.messageUrl??"").match(
      /discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/
    );
    if(!match||match[1]!==guildId){
      throw new ShiireVendingError(400,"INVALID_DISCORD_MESSAGE_URL");
    }
    const channelId=match[2]!,messageId=match[3]!;
    await requireChannelInGuild(env,guildId,channelId);
    const products=await listShiireProducts(env,machine.id);
    await discordJson(
      env,
      "/channels/"+channelId+"/messages/"+messageId,
      {method:"PATCH",body:JSON.stringify(panelPayload(machine,products))}
    );
    await saveShiirePanel(env,machine.id,guildId,channelId,messageId);
    return responseJson({ok:true});
  }

  throw new ShiireVendingError(404,"NOT_FOUND");
}

export async function notifyShiireVendingStockArrival(
  env:Env,
  supplierProductId:string,
  added:number,
  addedByClass?:Partial<Record<"TOP_SEARCH"|"NO_SHADOWBAN"|"INVITE_CAMPAIGN",number>>
){
  if(added<=0) return;
  const machines=await machinesForSupplierProduct(env,supplierProductId);
  for(const machine of machines){
    const machineClass:"TOP_SEARCH"|"NO_SHADOWBAN"|null=
      machine.procurement_class==="TOP_SEARCH"
        ?"TOP_SEARCH"
        :machine.procurement_class==="NO_SHADOWBAN"
          ?"NO_SHADOWBAN"
          :null;
    const addedForMachine=
      machineClass
        ?Math.max(0,Number(addedByClass?.[machineClass]??added))
        :Math.max(
          0,
          added-Math.max(0,Number(addedByClass?.INVITE_CAMPAIGN??0))
        );
    if(addedForMachine<=0) continue;

    const notification=await getShiireStockNotification(env,machine.id);
    if(!notification?.enabled) continue;
    try{
      await sendJsonMessage(env,notification.channel_id,{
        content:"<@&"+notification.role_id+">",
        allowed_mentions:{roles:[notification.role_id]},
        embeds:[{
          title:"在庫追加のお知らせ",
          color:5763719,
          description:"**"+machine.product_name+"** の在庫が追加されました。",
          fields:[
            {name:"追加数",value:String(addedForMachine)+"個",inline:true},
            {name:"自販機",value:String(machine.name),inline:true}
          ]
        }]
      });
      await refreshMachinePanels(env,machine.id);
    }catch(error){
      console.error("shiire vending stock notification failed",machine.id,error);
    }
  }
}

export async function shiireVendingSweep(env:Env){
  await cleanShiireVendingExpired(env);

  for(const order of await listPendingShiirePayments(env,8)){
    const link=await readShiirePaymentLink(env,order);
    if(!link) continue;
    try{
      const result=await processPaymentLink(env,order,link);
      if(result.status==="rejected"){
        await clearShiirePaymentLink(env,order.id);
      }
    }catch(error){
      console.error("shiire vending payment sweep failed",order.id,error);
    }
  }

  for(const order of await listShiireDeliverySent(env,20)){
    try{
      await finishShiireDelivery(env,order);
      await refreshMachinePanels(env,order.vending_machine_id);
    }catch(error){
      console.error("shiire vending delivery finalize failed",order.id,error);
    }
  }
}
