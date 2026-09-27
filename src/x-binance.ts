import type { Env } from "./types";
import { hmacHex } from "./crypto";

const BASE_URL="https://api.binance.com";
const SYMBOL="LTCJPY";

export class BinanceError extends Error{
  constructor(
    public code:string,
    public status:number,
    public retryable:boolean,
    message?:string
  ){super(message??code);}
}

function credentials(env:Env){
  const apiKey=env.BINANCE_API_KEY?.trim()??"";
  const secret=env.BINANCE_API_SECRET?.trim()??"";
  if(!apiKey||!secret) throw new BinanceError("BINANCE_KEYS_NOT_CONFIGURED",503,false);
  return {apiKey,secret};
}

async function jsonResponse<T>(response:Response):Promise<T>{
  const text=await response.text();
  let parsed:any=null;
  try{parsed=text?JSON.parse(text):null;}catch{}
  if(!response.ok){
    const code=String(parsed?.code??("BINANCE_HTTP_"+response.status));
    const message=String(parsed?.msg??parsed?.message??("Binance HTTP "+response.status));
    throw new BinanceError(
      code,
      response.status,
      response.status===418||response.status===429||response.status>=500,
      message
    );
  }
  return parsed as T;
}

async function publicGet<T>(path:string,params:Record<string,string|number|undefined>={}):Promise<T>{
  const qs=new URLSearchParams();
  for(const [key,value] of Object.entries(params)){
    if(value!==undefined) qs.set(key,String(value));
  }
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),12_000);
  try{
    const response=await fetch(BASE_URL+path+(qs.size?"?"+qs.toString():""),{signal:controller.signal});
    return await jsonResponse<T>(response);
  }catch(error){
    if(error instanceof BinanceError) throw error;
    throw new BinanceError("BINANCE_NETWORK_ERROR",0,true,error instanceof Error?error.message:"Network error");
  }finally{clearTimeout(timer);}
}

async function signedRequest<T>(
  env:Env,
  method:"GET"|"POST",
  path:string,
  params:Record<string,string|number|boolean|undefined>={}
):Promise<T>{
  const {apiKey,secret}=credentials(env);
  const qs=new URLSearchParams();
  for(const [key,value] of Object.entries(params)){
    if(value!==undefined) qs.set(key,String(value));
  }
  if(!qs.has("recvWindow")) qs.set("recvWindow","5000");
  qs.set("timestamp",String(Date.now()));
  const unsigned=qs.toString();
  qs.set("signature",await hmacHex(secret,unsigned));

  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15_000);
  try{
    const response=await fetch(BASE_URL+path+"?"+qs.toString(),{
      method,
      headers:{"X-MBX-APIKEY":apiKey},
      signal:controller.signal
    });
    return await jsonResponse<T>(response);
  }catch(error){
    if(error instanceof BinanceError) throw error;
    throw new BinanceError("BINANCE_NETWORK_ERROR",0,true,error instanceof Error?error.message:"Network error");
  }finally{clearTimeout(timer);}
}

export type BinanceExchangeInfo={
  timezone?:string;
  serverTime?:number;
  symbols:Array<{
    symbol:string;
    status:string;
    baseAsset:string;
    quoteAsset:string;
    orderTypes?:string[];
    quoteOrderQtyMarketAllowed?:boolean;
    filters?:Array<Record<string,unknown>>;
  }>;
};

export async function binanceExchangeInfo():Promise<BinanceExchangeInfo>{
  return publicGet<BinanceExchangeInfo>("/api/v3/exchangeInfo",{symbol:SYMBOL});
}

export async function assertLtcJpyTradable(){
  const info=await binanceExchangeInfo();
  const symbol=info.symbols?.find(item=>item.symbol===SYMBOL);
  if(!symbol) throw new BinanceError("LTCJPY_NOT_AVAILABLE",409,false);
  if(symbol.status!=="TRADING") throw new BinanceError("LTCJPY_NOT_TRADING",409,false,symbol.status);
  if(symbol.baseAsset!=="LTC"||symbol.quoteAsset!=="JPY"){
    throw new BinanceError("LTCJPY_ASSET_MISMATCH",409,false);
  }
  if(!(symbol.orderTypes??[]).includes("MARKET")){
    throw new BinanceError("LTCJPY_MARKET_ORDER_UNAVAILABLE",409,false);
  }
  if(symbol.quoteOrderQtyMarketAllowed===false){
    throw new BinanceError("LTCJPY_QUOTE_ORDER_QTY_UNAVAILABLE",409,false);
  }
  return symbol;
}

export async function binanceLtcJpyPrice():Promise<number>{
  const data=await publicGet<{symbol:string;price:string}>("/api/v3/ticker/price",{symbol:SYMBOL});
  const price=Number(data.price);
  if(data.symbol!==SYMBOL||!Number.isFinite(price)||price<=0){
    throw new BinanceError("LTCJPY_PRICE_INVALID",502,false);
  }
  return price;
}

export type BinanceAccount={
  canTrade?:boolean;
  canWithdraw?:boolean;
  canDeposit?:boolean;
  balances?:Array<{asset:string;free:string;locked:string}>;
  permissions?:string[];
};

export async function binanceAccount(env:Env):Promise<BinanceAccount>{
  return signedRequest<BinanceAccount>(env,"GET","/api/v3/account",{omitZeroBalances:false});
}

export async function binanceBalance(env:Env,asset:"JPY"|"LTC"){
  const account=await binanceAccount(env);
  const row=account.balances?.find(item=>item.asset===asset);
  const free=Number(row?.free??0);
  const locked=Number(row?.locked??0);
  if(!Number.isFinite(free)||!Number.isFinite(locked)){
    throw new BinanceError("BINANCE_BALANCE_INVALID",502,false);
  }
  return {asset,free,locked,total:free+locked,canTrade:account.canTrade,canWithdraw:account.canWithdraw};
}

export type BinanceOrder={
  symbol:string;
  orderId:number;
  clientOrderId:string;
  transactTime?:number;
  price?:string;
  origQty?:string;
  executedQty?:string;
  cummulativeQuoteQty?:string;
  status:string;
  type:string;
  side:string;
  origQuoteOrderQty?:string;
};

export async function binanceMarketBuyLtcWithJpy(
  env:Env,
  quoteOrderQtyJpy:number,
  clientOrderId:string
):Promise<BinanceOrder>{
  if(!Number.isInteger(quoteOrderQtyJpy)||quoteOrderQtyJpy<=0){
    throw new BinanceError("INVALID_JPY_ORDER_AMOUNT",400,false);
  }
  await assertLtcJpyTradable();
  return signedRequest<BinanceOrder>(env,"POST","/api/v3/order",{
    symbol:SYMBOL,
    side:"BUY",
    type:"MARKET",
    quoteOrderQty:String(quoteOrderQtyJpy),
    newClientOrderId:clientOrderId,
    newOrderRespType:"FULL"
  });
}

export async function binanceQueryOrder(
  env:Env,
  clientOrderId:string
):Promise<BinanceOrder>{
  return signedRequest<BinanceOrder>(env,"GET","/api/v3/order",{
    symbol:SYMBOL,
    origClientOrderId:clientOrderId
  });
}

export type BinanceNetworkInfo={
  network?:string;
  coin?:string;
  isDefault?:boolean;
  withdrawEnable?:boolean;
  withdrawDesc?:string;
  specialWithdrawTips?:string;
  withdrawFee?:string;
  withdrawMin?:string;
  withdrawMax?:string;
  withdrawTag?:boolean;
  busy?:boolean;
};

export type BinanceCoinInfo={
  coin:string;
  free?:string;
  locked?:string;
  freeze?:string;
  withdrawing?:string;
  networkList?:BinanceNetworkInfo[];
};

export async function binanceAllCoins(env:Env):Promise<BinanceCoinInfo[]>{
  return signedRequest<BinanceCoinInfo[]>(env,"GET","/sapi/v1/capital/config/getall");
}

export async function binanceLtcNetwork(env:Env,network="LTC"){
  const coins=await binanceAllCoins(env);
  const ltc=coins.find(item=>item.coin==="LTC");
  if(!ltc) throw new BinanceError("BINANCE_LTC_ASSET_MISSING",502,false);
  const net=ltc.networkList?.find(item=>item.network===network);
  if(!net) throw new BinanceError("BINANCE_LTC_NETWORK_MISSING",409,false,network);
  const fee=Number(net.withdrawFee??NaN);
  const min=Number(net.withdrawMin??NaN);
  const max=Number(net.withdrawMax??NaN);
  return {
    ...net,
    withdrawFee:Number.isFinite(fee)?fee:null,
    withdrawMin:Number.isFinite(min)?min:null,
    withdrawMax:Number.isFinite(max)?max:null
  };
}

export async function binanceTravelRuleRequirement(env:Env){
  return signedRequest<{questionnaireCountryCode?:string}>(
    env,"GET","/sapi/v1/localentity/questionnaire-requirements"
  );
}

function travelRuleRequired(response:{questionnaireCountryCode?:string}):boolean{
  const code=String(response.questionnaireCountryCode??"").trim().toUpperCase();
  return Boolean(code&&code!=="NIL");
}

export type BinanceWithdrawResult={
  id?:string;
  trId?:number|string;
};

export async function binanceWithdrawLtc(env:Env,input:{
  address:string;
  amount:number;
  withdrawOrderId:string;
  network?:string;
  addressTag?:string;
}):Promise<{mode:"standard"|"travel_rule";result:BinanceWithdrawResult}>{
  if(!input.address.trim()) throw new BinanceError("WITHDRAW_ADDRESS_REQUIRED",400,false);
  if(!Number.isFinite(input.amount)||input.amount<=0) throw new BinanceError("WITHDRAW_AMOUNT_INVALID",400,false);
  const network=input.network??"LTC";
  const net=await binanceLtcNetwork(env,network);
  if(!net.withdrawEnable||net.busy){
    throw new BinanceError("LTC_WITHDRAWAL_UNAVAILABLE",409,true,net.withdrawDesc??net.specialWithdrawTips);
  }
  if(net.withdrawMin!==null&&input.amount<net.withdrawMin){
    throw new BinanceError("LTC_WITHDRAWAL_BELOW_MIN",409,false);
  }
  if(net.withdrawMax!==null&&input.amount>net.withdrawMax){
    throw new BinanceError("LTC_WITHDRAWAL_ABOVE_MAX",409,false);
  }
  if(net.withdrawTag===true&&!input.addressTag){
    throw new BinanceError("LTC_ADDRESS_TAG_REQUIRED",409,false);
  }
  if(net.withdrawTag===false&&input.addressTag){
    throw new BinanceError("LTC_ADDRESS_TAG_NOT_SUPPORTED",409,false);
  }

  const requirement=await binanceTravelRuleRequirement(env);
  if(travelRuleRequired(requirement)){
    const questionnaire=env.BINANCE_TRAVEL_RULE_QUESTIONNAIRE?.trim()??"";
    if(!questionnaire){
      throw new BinanceError(
        "BINANCE_TRAVEL_RULE_QUESTIONNAIRE_REQUIRED",
        409,
        false,
        "Travel Rule questionnaire is required for this API key/entity"
      );
    }
    const result=await signedRequest<BinanceWithdrawResult>(
      env,"POST","/sapi/v1/localentity/withdraw/apply",{
        coin:"LTC",
        address:input.address,
        amount:String(input.amount),
        questionnaire,
        withdrawOrderId:input.withdrawOrderId,
        network,
        addressTag:input.addressTag
      }
    );
    return {mode:"travel_rule",result};
  }

  const result=await signedRequest<BinanceWithdrawResult>(
    env,"POST","/sapi/v1/capital/withdraw/apply",{
      coin:"LTC",
      address:input.address,
      amount:String(input.amount),
      withdrawOrderId:input.withdrawOrderId,
      network,
      addressTag:input.addressTag
    }
  );
  return {mode:"standard",result};
}

export async function binanceWithdrawStatus(env:Env,input:{
  withdrawOrderId:string;
  travelRule:boolean;
}):Promise<unknown[]>{
  if(!input.withdrawOrderId.trim()) throw new BinanceError("WITHDRAW_ORDER_ID_REQUIRED",400,false);
  return signedRequest<unknown[]>(
    env,
    "GET",
    input.travelRule?"/sapi/v1/localentity/withdraw/history":"/sapi/v1/capital/withdraw/history",
    {withdrawOrderId:input.withdrawOrderId}
  );
}
