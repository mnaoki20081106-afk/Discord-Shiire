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
};

export type BinanceBalance={asset:string;free:number;locked:number};

function apiKey(env:Env){
  const key=env.BINANCE_API_KEY?.trim()??"";
  if(!key) throw new BinanceApiError(503,"BINANCE_API_KEY_NOT_CONFIGURED",false,"Binance API key is not configured");
  return key;
}

function apiSecret(env:Env){
  const secret=env.BINANCE_API_SECRET?.trim()??"";
  if(!secret) throw new BinanceApiError(503,"BINANCE_API_SECRET_NOT_CONFIGURED",false,"Binance API secret is not configured");
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
  params:Record<string,string|number|boolean|undefined>
):Promise<T>{
  const values=new URLSearchParams();
  for(const [key,value] of Object.entries(params)){
    if(value!==undefined) values.set(key,String(value));
  }
  if(!values.has("timestamp")) values.set("timestamp",String(Date.now()));
  if(!values.has("recvWindow")) values.set("recvWindow","5000");
  const unsigned=values.toString();
  const signature=await hmacHex(apiSecret(env),unsigned);
  values.set("signature",signature);

  const headers:Record<string,string>={
    "X-MBX-APIKEY":apiKey(env),
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

export async function getLtcJpyMarketStatus():Promise<BinanceMarketStatus>{
  const [exchange,price]=await Promise.all([
    publicGet<ExchangeInfo>("/api/v3/exchangeInfo",{symbol:SYMBOL}),
    publicGet<{symbol:string;price:string}>("/api/v3/ticker/price",{symbol:SYMBOL})
  ]);
  const symbol=exchange.symbols?.find(s=>s.symbol===SYMBOL);
  if(!symbol) throw new BinanceApiError(409,"LTCJPY_NOT_LISTED",false,"LTCJPY is not present in exchangeInfo");
  if(symbol.baseAsset!=="LTC"||symbol.quoteAsset!=="JPY"){
    throw new BinanceApiError(409,"LTCJPY_SCHEMA_MISMATCH",false,"Unexpected LTCJPY asset mapping");
  }
  const p=Number(price.price);
  if(!Number.isFinite(p)||p<=0) throw new BinanceApiError(502,"LTCJPY_PRICE_INVALID",true,"Invalid LTCJPY ticker price");
  return {
    symbol:SYMBOL,
    status:symbol.status,
    baseAsset:symbol.baseAsset,
    quoteAsset:symbol.quoteAsset,
    isSpotTradingAllowed:symbol.isSpotTradingAllowed===true,
    quoteOrderQtyMarketAllowed:symbol.quoteOrderQtyMarketAllowed===true,
    priceJpy:p
  };
}

export async function getBinanceAccount(env:Env){
  return signedRequest<{
    balances:Array<{asset:string;free:string;locked:string}>;
    canTrade?:boolean;
    canWithdraw?:boolean;
    permissions?:string[];
  }>(env,"GET","/api/v3/account",{});
}

export async function getBinanceBalance(env:Env,asset:string):Promise<BinanceBalance>{
  const wanted=asset.trim().toUpperCase();
  const account=await getBinanceAccount(env);
  const row=account.balances?.find(b=>b.asset===wanted);
  return {
    asset:wanted,
    free:Number(row?.free??0),
    locked:Number(row?.locked??0)
  };
}

export async function getBinanceApiRestrictions(env:Env){
  return signedRequest<{
    ipRestrict:boolean;
    enableReading:boolean;
    enableWithdrawals:boolean;
    enableSpotAndMarginTrading:boolean;
  }>(env,"GET","/sapi/v1/account/apiRestrictions",{});
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
  return signedRequest<any>(env,"POST","/api/v3/order",{
    symbol:SYMBOL,
    side:"BUY",
    type:"MARKET",
    quoteOrderQty:amount,
    newClientOrderId:input.clientOrderId,
    newOrderRespType:"FULL"
  });
}

export async function getBinanceOrder(env:Env,input:{orderId?:number;origClientOrderId?:string}){
  if(!input.orderId&&!input.origClientOrderId){
    throw new BinanceApiError(400,"ORDER_IDENTIFIER_REQUIRED",false,"orderId or origClientOrderId is required");
  }
  return signedRequest<any>(env,"GET","/api/v3/order",{
    symbol:SYMBOL,
    orderId:input.orderId,
    origClientOrderId:input.origClientOrderId
  });
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

export async function getBinanceLtcCoinInfo(env:Env){
  const all=await signedRequest<Array<{
    coin:string;
    free:string;
    withdrawAllEnable:boolean;
    networkList:BinanceNetworkInfo[];
  }>>(env,"GET","/sapi/v1/capital/config/getall",{});
  const ltc=all.find(c=>c.coin==="LTC");
  if(!ltc) throw new BinanceApiError(409,"LTC_COIN_INFO_MISSING",false,"LTC is missing from Binance capital configuration");
  return ltc;
}

export async function getBinanceWithdrawAddresses(env:Env){
  return signedRequest<Array<{
    address:string;
    addressTag:string;
    coin:string;
    name:string;
    network:string;
    origin:string;
    originType:string;
    whiteStatus:boolean;
  }>>(env,"GET","/sapi/v1/capital/withdraw/address/list",{});
}

export async function getBinanceWithdrawQuota(env:Env){
  return signedRequest<{wdQuota:string;usedWdQuota:string}>(
    env,"GET","/sapi/v1/capital/withdraw/quota",{}
  );
}

export async function getTravelRuleRequirement(env:Env){
  return signedRequest<{questionnaireCountryCode?:string}>(
    env,"GET","/sapi/v1/localentity/questionnaire-requirements",{}
  );
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
  });
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
    getBinanceApiRestrictions(env),
    getBinanceLtcCoinInfo(env),
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
      }
    );
  }

  return signedRequest<{id:string}>(env,"POST","/sapi/v1/capital/withdraw/apply",{
    coin:"LTC",
    address,
    amount,
    network,
    withdrawOrderId:input.withdrawOrderId
  });
}

export function newBinanceClientOrderId(){
  return "xproc"+randomId().slice(0,26);
}

export function newBinanceWithdrawOrderId(){
  return "xw"+randomId().slice(0,28);
}
