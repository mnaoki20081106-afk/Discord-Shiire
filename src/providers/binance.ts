import type { Env } from "../types";
import { hmacHex, randomId } from "../crypto";

const BASE_URL="https://api.binance.com";
const SYMBOL="LTCJPY";

export class BinanceApiError extends Error{
  constructor(
    public status:number,
    public code:string,
    public retryable:boolean,
    message:string
  ){super(message);}
}

type ExchangeInfo={
  symbols?:Array<{
    symbol:string;
    status:string;
    baseAsset:string;
    quoteAsset:string;
    isSpotTradingAllowed?:boolean;
    quoteOrderQtyMarketAllowed?:boolean;
    filters?:Array<Record<string,unknown>>;
  }>;
};

export type BinanceMarketStatus={
  symbol:string;
  status:string;
  baseAsset:string;
  quoteAsset:string;
  isSpotTradingAllowed:boolean;
  quoteOrderQtyMarketAllowed:boolean;
  priceJpy:number;
  minMarketNotionalJpy:number|null;
  maxMarketNotionalJpy:number|null;
};

export type BinanceBalance={asset:string;free:number;locked:number};

export type BinanceOrderView={
  symbol:string;
  orderId:number;
  clientOrderId:string;
  status:string;
  executedQty:string;
  cummulativeQuoteQty?:string;
  origQuoteOrderQty?:string;
};

function object(value:unknown):value is Record<string,unknown>{
  return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
}

function schemaError(context:string):never{
  throw new BinanceApiError(
    502,
    "BINANCE_SCHEMA_CHANGED",
    false,
    "Unexpected Binance "+context+" response structure"
  );
}

function validateOrder(value:unknown):BinanceOrderView{
  if(
    !object(value)||
    typeof value.symbol!=="string"||
    !Number.isFinite(Number(value.orderId))||
    typeof value.clientOrderId!=="string"||
    typeof value.status!=="string"||
    typeof value.executedQty!=="string"
  ) schemaError("order");
  return value as unknown as BinanceOrderView;
}

type CredentialPurpose="trade"|"withdraw";

function apiKey(env:Env,purpose:CredentialPurpose="trade"){
  const key=(purpose==="withdraw"
    ?env.BINANCE_WITHDRAW_API_KEY
    :env.BINANCE_API_KEY)?.trim()??"";
  if(!key){
    throw new BinanceApiError(
      503,
      purpose==="withdraw"
        ?"BINANCE_WITHDRAW_API_KEY_NOT_CONFIGURED"
        :"BINANCE_API_KEY_NOT_CONFIGURED",
      false,
      purpose==="withdraw"
        ?"Binance withdrawal API key is not configured"
        :"Binance API key is not configured"
    );
  }
  return key;
}

function apiSecret(env:Env,purpose:CredentialPurpose="trade"){
  const secret=(purpose==="withdraw"
    ?env.BINANCE_WITHDRAW_API_SECRET
    :env.BINANCE_API_SECRET)?.trim()??"";
  if(!secret){
    throw new BinanceApiError(
      503,
      purpose==="withdraw"
        ?"BINANCE_WITHDRAW_API_SECRET_NOT_CONFIGURED"
        :"BINANCE_API_SECRET_NOT_CONFIGURED",
      false,
      purpose==="withdraw"
        ?"Binance withdrawal API secret is not configured"
        :"Binance API secret is not configured"
    );
  }
  return secret;
}

async function parseResponse<T>(response:Response):Promise<T>{
  const text=await response.text();
  let payload:any=null;
  try{payload=text?JSON.parse(text):null;}catch{}
  if(!response.ok){
    const code=String(payload?.code??("BINANCE_HTTP_"+response.status));
    const message=String(payload?.msg??"Binance API request failed").slice(0,500);
    throw new BinanceApiError(
      response.status,
      code,
      response.status===429||response.status>=500,
      message
    );
  }
  return payload as T;
}

async function publicGet<T>(path:string,params:Record<string,string>):Promise<T>{
  const query=new URLSearchParams(params).toString();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15_000);
  try{
    const response=await fetch(BASE_URL+path+(query?"?"+query:""),{
      headers:{Accept:"application/json"},
      signal:controller.signal
    });
    return parseResponse<T>(response);
  }catch(error){
    if(error instanceof BinanceApiError) throw error;
    throw new BinanceApiError(0,"BINANCE_NETWORK_ERROR",true,error instanceof Error?error.message:"Binance network error");
  }finally{clearTimeout(timer);}
}

async function signedRequest<T>(
  env:Env,
  method:"GET"|"POST",
  path:string,
  params:Record<string,string|number|boolean|undefined>,
  purpose:CredentialPurpose="trade"
):Promise<T>{
  const values=new URLSearchParams();
  for(const [key,value] of Object.entries(params)){
    if(value!==undefined) values.set(key,String(value));
  }
  if(!values.has("timestamp")) values.set("timestamp",String(Date.now()));
  if(!values.has("recvWindow")) values.set("recvWindow","5000");
  const unsigned=values.toString();
  const signature=await hmacHex(apiSecret(env,purpose),unsigned);
  values.set("signature",signature);

  const headers:Record<string,string>={
    "X-MBX-APIKEY":apiKey(env,purpose),
    "Accept":"application/json"
  };
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),20_000);
  try{
    const response=method==="GET"
      ?await fetch(BASE_URL+path+"?"+values.toString(),{method,headers,signal:controller.signal})
      :await fetch(BASE_URL+path,{
          method,
          headers:{...headers,"Content-Type":"application/x-www-form-urlencoded"},
          body:values.toString(),
          signal:controller.signal
        });
    return parseResponse<T>(response);
  }catch(error){
    if(error instanceof BinanceApiError) throw error;
    throw new BinanceApiError(0,"BINANCE_NETWORK_ERROR",true,error instanceof Error?error.message:"Binance network error");
  }finally{clearTimeout(timer);}
}

export function marketNotionalBounds(
  filters:Array<Record<string,unknown>>|undefined
):{min:number|null;max:number|null}{
  const minimums:number[]=[];
  const maximums:number[]=[];

  for(const filter of filters??[]){
    const type=String(filter.filterType??"");
    if(type==="MIN_NOTIONAL"){
      const min=Number(filter.minNotional);
      if(
        Number.isFinite(min)&&min>0&&
        filter.applyToMarket!==false
      ){
        minimums.push(min);
      }
    }else if(type==="NOTIONAL"){
      const min=Number(filter.minNotional);
      const max=Number(filter.maxNotional);
      if(
        Number.isFinite(min)&&min>0&&
        filter.applyMinToMarket!==false
      ){
        minimums.push(min);
      }
      if(
        Number.isFinite(max)&&max>0&&
        filter.applyMaxToMarket!==false
      ){
        maximums.push(max);
      }
    }
  }

  return {
    min:minimums.length?Math.max(...minimums):null,
    max:maximums.length?Math.min(...maximums):null
  };
}

export async function getLtcJpyMarketStatus():Promise<BinanceMarketStatus>{
  const [exchange,price]=await Promise.all([
    publicGet<ExchangeInfo>("/api/v3/exchangeInfo",{symbol:SYMBOL}),
    publicGet<{symbol:string;price:string}>("/api/v3/ticker/price",{symbol:SYMBOL})
  ]);
  if(!Array.isArray(exchange?.symbols)||typeof price?.symbol!=="string"||typeof price?.price!=="string"){
    schemaError("market");
  }
  const symbol=exchange.symbols.find(s=>s.symbol===SYMBOL);
  if(!symbol) throw new BinanceApiError(409,"LTCJPY_NOT_LISTED",false,"LTCJPY is not present in exchangeInfo");
  if(
    typeof symbol.status!=="string"||
    typeof symbol.baseAsset!=="string"||
    typeof symbol.quoteAsset!=="string"
  ) schemaError("exchangeInfo symbol");
  if(symbol.baseAsset!=="LTC"||symbol.quoteAsset!=="JPY"){
    throw new BinanceApiError(409,"LTCJPY_SCHEMA_MISMATCH",false,"Unexpected LTCJPY asset mapping");
  }
  const p=Number(price.price);
  if(!Number.isFinite(p)||p<=0) throw new BinanceApiError(502,"LTCJPY_PRICE_INVALID",true,"Invalid LTCJPY ticker price");
  const notional=marketNotionalBounds(symbol.filters);
  return {
    symbol:SYMBOL,
    status:symbol.status,
    baseAsset:symbol.baseAsset,
    quoteAsset:symbol.quoteAsset,
    isSpotTradingAllowed:symbol.isSpotTradingAllowed===true,
    quoteOrderQtyMarketAllowed:symbol.quoteOrderQtyMarketAllowed===true,
    priceJpy:p,
    minMarketNotionalJpy:notional.min,
    maxMarketNotionalJpy:notional.max
  };
}

export async function getBinanceAccount(env:Env){
  const account=await signedRequest<unknown>(env,"GET","/api/v3/account",{});
  if(!object(account)||!Array.isArray(account.balances)) schemaError("account");
  for(const row of account.balances){
    if(
      !object(row)||
      typeof row.asset!=="string"||
      typeof row.free!=="string"||
      typeof row.locked!=="string"||
      !Number.isFinite(Number(row.free))||
      !Number.isFinite(Number(row.locked))
    ) schemaError("account balance");
  }
  return account as unknown as {
    balances:Array<{asset:string;free:string;locked:string}>;
    canTrade?:boolean;
    canWithdraw?:boolean;
    permissions?:string[];
  };
}

export async function getBinanceBalance(env:Env,asset:string):Promise<BinanceBalance>{
  const wanted=asset.trim().toUpperCase();
  const account=await getBinanceAccount(env);
  const row=account.balances.find(b=>b.asset===wanted);
  if(!row){
    throw new BinanceApiError(
      409,
      "BINANCE_ASSET_BALANCE_MISSING",
      false,
      wanted+" is missing from Binance account balances"
    );
  }
  const free=Number(row.free);
  const locked=Number(row.locked);
  if(!Number.isFinite(free)||!Number.isFinite(locked)) schemaError("balance");
  return {asset:wanted,free,locked};
}

export async function getBinanceApiRestrictions(
  env:Env,
  purpose:CredentialPurpose="trade"
){
  const value=await signedRequest<unknown>(
    env,"GET","/sapi/v1/account/apiRestrictions",{},purpose
  );
  if(
    !object(value)||
    typeof value.ipRestrict!=="boolean"||
    typeof value.enableReading!=="boolean"||
    typeof value.enableWithdrawals!=="boolean"||
    typeof value.enableSpotAndMarginTrading!=="boolean"
  ) schemaError("API restrictions");
  return value as {
    ipRestrict:boolean;
    enableReading:boolean;
    enableWithdrawals:boolean;
    enableSpotAndMarginTrading:boolean;
  };
}

export async function placeLtcJpyMarketBuy(env:Env,input:{
  quoteJpy:number;
  clientOrderId:string;
  live:boolean;
}){
  const amount=Math.floor(input.quoteJpy);
  if(!Number.isFinite(amount)||amount<=0) throw new BinanceApiError(400,"PURCHASE_AMOUNT_INVALID",false,"JPY purchase amount must be positive");
  const market=await getLtcJpyMarketStatus();
  if(market.status!=="TRADING"||!market.isSpotTradingAllowed){
    throw new BinanceApiError(409,"LTCJPY_NOT_TRADING",false,"LTCJPY is not currently tradable");
  }
  if(!market.quoteOrderQtyMarketAllowed){
    throw new BinanceApiError(409,"QUOTE_ORDER_QTY_NOT_ALLOWED",false,"LTCJPY does not currently allow quoteOrderQty market buys");
  }
  if(
    market.minMarketNotionalJpy!==null&&
    amount<Math.ceil(market.minMarketNotionalJpy)
  ){
    throw new BinanceApiError(
      409,
      "LTCJPY_BELOW_MARKET_MIN_NOTIONAL",
      false,
      "JPY market-buy amount is below the current LTCJPY exchangeInfo minimum."
    );
  }
  if(
    market.maxMarketNotionalJpy!==null&&
    amount>Math.floor(market.maxMarketNotionalJpy)
  ){
    throw new BinanceApiError(
      409,
      "LTCJPY_ABOVE_MARKET_MAX_NOTIONAL",
      false,
      "JPY market-buy amount is above the current LTCJPY exchangeInfo maximum."
    );
  }
  if(!input.live){
    return {
      dryRun:true,
      symbol:SYMBOL,
      side:"BUY",
      type:"MARKET",
      quoteOrderQty:amount,
      newClientOrderId:input.clientOrderId
    };
  }
  return validateOrder(await signedRequest<unknown>(env,"POST","/api/v3/order",{
    symbol:SYMBOL,
    side:"BUY",
    type:"MARKET",
    quoteOrderQty:amount,
    newClientOrderId:input.clientOrderId,
    newOrderRespType:"FULL"
  }));
}

export async function getBinanceOrder(env:Env,input:{orderId?:number;origClientOrderId?:string}){
  if(!input.orderId&&!input.origClientOrderId){
    throw new BinanceApiError(400,"ORDER_IDENTIFIER_REQUIRED",false,"orderId or origClientOrderId is required");
  }
  return validateOrder(await signedRequest<unknown>(env,"GET","/api/v3/order",{
    symbol:SYMBOL,
    orderId:input.orderId,
    origClientOrderId:input.origClientOrderId
  }));
}

export type BinanceNetworkInfo={
  network:string;
  coin:string;
  isDefault:boolean;
  withdrawEnable:boolean;
  withdrawFee:string;
  withdrawMin:string;
  withdrawMax:string;
  minConfirm:number;
  busy:boolean;
  withdrawTag?:boolean;
};

export async function getBinanceLtcCoinInfo(
  env:Env,
  purpose:CredentialPurpose="trade"
){
  const all=await signedRequest<unknown>(
    env,"GET","/sapi/v1/capital/config/getall",{},purpose
  );
  if(!Array.isArray(all)) schemaError("coin configuration");
  const ltc=all.find(item=>object(item)&&item.coin==="LTC");
  if(!object(ltc)||!Array.isArray(ltc.networkList)) schemaError("LTC coin configuration");
  for(const network of ltc.networkList){
    if(
      !object(network)||
      typeof network.network!=="string"||
      typeof network.coin!=="string"||
      typeof network.withdrawEnable!=="boolean"||
      typeof network.withdrawFee!=="string"||
      typeof network.withdrawMin!=="string"||
      typeof network.withdrawMax!=="string"||
      typeof network.busy!=="boolean"
    ) schemaError("LTC network configuration");
  }
  const typed=ltc as unknown as {
    coin:string;
    free:string;
    withdrawAllEnable:boolean;
    networkList:BinanceNetworkInfo[];
  };
  const ltcFound=typed;
  if(!ltcFound) throw new BinanceApiError(409,"LTC_COIN_INFO_MISSING",false,"LTC is missing from Binance capital configuration");
  return ltcFound;
}

export async function getBinanceWithdrawAddresses(env:Env){
  const value=await signedRequest<unknown>(
    env,"GET","/sapi/v1/capital/withdraw/address/list",{},"withdraw"
  );
  if(!Array.isArray(value)) schemaError("withdraw address list");
  for(const row of value){
    if(
      !object(row)||
      typeof row.address!=="string"||
      typeof row.coin!=="string"||
      typeof row.network!=="string"||
      typeof row.whiteStatus!=="boolean"
    ) schemaError("withdraw address");
  }
  return value as Array<{
    address:string;
    addressTag?:string;
    coin:string;
    name?:string;
    network:string;
    origin?:string;
    originType?:string;
    whiteStatus:boolean;
  }>;
}

export async function getBinanceWithdrawQuota(env:Env){
  const value=await signedRequest<unknown>(
    env,"GET","/sapi/v1/capital/withdraw/quota",{},"withdraw"
  );
  if(
    !object(value)||
    typeof value.wdQuota!=="string"||
    typeof value.usedWdQuota!=="string"||
    !Number.isFinite(Number(value.wdQuota))||
    !Number.isFinite(Number(value.usedWdQuota))
  ) schemaError("withdraw quota");
  return value as {wdQuota:string;usedWdQuota:string};
}

export async function getTravelRuleRequirement(env:Env){
  const value=await signedRequest<unknown>(
    env,"GET","/sapi/v1/localentity/questionnaire-requirements",{},"withdraw"
  );
  if(
    !object(value)||
    (
      value.questionnaireCountryCode!==undefined&&
      typeof value.questionnaireCountryCode!=="string"
    )
  ) schemaError("Travel Rule requirement");
  return value as {questionnaireCountryCode?:string};
}

export async function getBinanceWithdrawHistory(env:Env,input?:{
  coin?:string;
  withdrawOrderId?:string;
  startTime?:number;
  endTime?:number;
}){
  return signedRequest<any[]>(env,"GET","/sapi/v1/capital/withdraw/history",{
    coin:input?.coin,
    withdrawOrderId:input?.withdrawOrderId,
    startTime:input?.startTime,
    endTime:input?.endTime
  },"withdraw");
}

export async function requestLtcWithdrawal(env:Env,input:{
  address:string;
  network:string;
  amountLtc:number;
  withdrawOrderId:string;
  live:boolean;
}){
  const address=input.address.trim();
  const network=input.network.trim();
  const amount=input.amountLtc;
  if(!address||!network||!Number.isFinite(amount)||amount<=0){
    throw new BinanceApiError(400,"WITHDRAW_INPUT_INVALID",false,"Invalid LTC withdrawal input");
  }

  const [restrictions,coinInfo,addresses,travelRule]=await Promise.all([
    getBinanceApiRestrictions(env,"withdraw"),
    getBinanceLtcCoinInfo(env,"withdraw"),
    getBinanceWithdrawAddresses(env),
    getTravelRuleRequirement(env)
  ]);

  if(!restrictions.ipRestrict){
    throw new BinanceApiError(409,"BINANCE_IP_RESTRICTION_REQUIRED",false,"Withdrawal automation requires an IP-restricted API key");
  }
  if(!restrictions.enableWithdrawals){
    throw new BinanceApiError(409,"BINANCE_WITHDRAW_PERMISSION_DISABLED",false,"API key withdrawal permission is disabled");
  }

  const configured=coinInfo.networkList.find(n=>n.network===network);
  if(!configured) throw new BinanceApiError(409,"LTC_NETWORK_NOT_AVAILABLE",false,"Configured LTC network is not available");
  if(!configured.withdrawEnable||configured.busy){
    throw new BinanceApiError(409,"LTC_WITHDRAWAL_UNAVAILABLE",true,"LTC withdrawal network is disabled or busy");
  }
  const min=Number(configured.withdrawMin);
  const max=Number(configured.withdrawMax);
  if((Number.isFinite(min)&&amount<min)||(Number.isFinite(max)&&amount>max)){
    throw new BinanceApiError(409,"LTC_WITHDRAWAL_OUTSIDE_NETWORK_LIMITS",false,"LTC withdrawal amount is outside current Binance network limits");
  }

  const whitelisted=addresses.some(row=>
    row.coin==="LTC"&&row.network===network&&row.address===address&&row.whiteStatus===true
  );
  if(!whitelisted){
    throw new BinanceApiError(409,"WITHDRAW_ADDRESS_NOT_WHITELISTED",false,"Destination LTC address is not an enabled withdrawal whitelist entry");
  }

  const travelRequired=(travelRule.questionnaireCountryCode??"NIL").toUpperCase()!=="NIL";

  if(!input.live){
    return {
      dryRun:true,
      coin:"LTC",
      address,
      amount,
      network,
      withdrawOrderId:input.withdrawOrderId,
      dynamicFeeLtc:Number(configured.withdrawFee),
      travelRuleRequired:travelRequired
    };
  }

  if((env.BINANCE_FIXED_EGRESS_CONFIRMED??"").trim().toLowerCase()!=="true"){
    throw new BinanceApiError(
      409,
      "BINANCE_FIXED_EGRESS_NOT_CONFIRMED",
      false,
      "Live Binance withdrawal is disabled until the deployment has a fixed allowlisted egress IP."
    );
  }

  if(travelRequired){
    const questionnaire=env.BINANCE_TRAVEL_RULE_QUESTIONNAIRE?.trim()??"";
    if(!questionnaire){
      throw new BinanceApiError(
        409,
        "BINANCE_TRAVEL_RULE_QUESTIONNAIRE_REQUIRED",
        false,
        "Travel Rule questionnaire is required. Store the accurate questionnaire JSON as a Worker Secret; it is never logged."
      );
    }
    return signedRequest<{trId?:number|string;id?:string}>(
      env,
      "POST",
      "/sapi/v1/localentity/withdraw/apply",
      {
        coin:"LTC",
        address,
        amount,
        questionnaire,
        withdrawOrderId:input.withdrawOrderId,
        network
      },
      "withdraw"
    );
  }

  return signedRequest<{id:string}>(env,"POST","/sapi/v1/capital/withdraw/apply",{
    coin:"LTC",
    address,
    amount,
    network,
    withdrawOrderId:input.withdrawOrderId
  },"withdraw");
}

export function newBinanceClientOrderId(){
  return "xproc"+randomId().slice(0,26);
}

export function newBinanceWithdrawOrderId(){
  return "xw"+randomId().slice(0,28);
}


export async function getBinanceWithdrawalSafetyStatus(env:Env){
  const configured=Boolean(
    env.BINANCE_WITHDRAW_API_KEY?.trim()&&
    env.BINANCE_WITHDRAW_API_SECRET?.trim()
  );
  const fixedEgressConfirmed=
    (env.BINANCE_FIXED_EGRESS_CONFIRMED??"").trim().toLowerCase()==="true";
  if(!configured){
    return {
      configured:false,
      fixedEgressConfirmed,
      readyForLiveWithdrawal:false,
      reason:"WITHDRAWAL_KEY_NOT_CONFIGURED"
    };
  }

  const [restrictions,coinInfo,addresses,quota,travelRule]=await Promise.all([
    getBinanceApiRestrictions(env,"withdraw"),
    getBinanceLtcCoinInfo(env,"withdraw"),
    getBinanceWithdrawAddresses(env),
    getBinanceWithdrawQuota(env),
    getTravelRuleRequirement(env)
  ]);
  const network=coinInfo.networkList.find(row=>row.network==="LTC")??null;
  const travelCode=(travelRule.questionnaireCountryCode??"NIL").toUpperCase();
  const travelRuleRequired=travelCode!=="NIL";
  const questionnaireConfigured=Boolean(
    env.BINANCE_TRAVEL_RULE_QUESTIONNAIRE?.trim()
  );
  const allowlistedLtcAddressCount=addresses.filter(
    row=>row.coin==="LTC"&&row.network==="LTC"&&row.whiteStatus===true
  ).length;
  const readyForLiveWithdrawal=Boolean(
    restrictions.ipRestrict&&
    restrictions.enableReading&&
    restrictions.enableWithdrawals&&
    fixedEgressConfirmed&&
    network?.withdrawEnable&&
    !network?.busy&&
    allowlistedLtcAddressCount>0&&
    (!travelRuleRequired||questionnaireConfigured)
  );

  return {
    configured:true,
    fixedEgressConfirmed,
    readyForLiveWithdrawal,
    restrictions,
    network:network?{
      network:network.network,
      withdrawEnable:network.withdrawEnable,
      busy:network.busy,
      withdrawFee:network.withdrawFee,
      withdrawMin:network.withdrawMin,
      withdrawMax:network.withdrawMax,
      withdrawTag:network.withdrawTag??false
    }:null,
    quota,
    allowlistedLtcAddressCount,
    travelRule:{
      required:travelRuleRequired,
      questionnaireCountryCode:travelCode,
      questionnaireConfigured
    }
  };
}
