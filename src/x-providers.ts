import type { Env } from "./types";
import {
  binanceBalance,
  binanceLtcJpyPrice,
  binanceMarketBuyLtcWithJpy,
  binanceQueryOrder,
  binanceWithdrawLtc,
  binanceWithdrawStatus
} from "./x-binance";
import {
  hstoraBalance,
  hstoraCatalog,
  hstoraCreateOrder,
  hstoraLookupOrder,
  hstoraOrder,
  hstoraProduct
} from "./x-hstora";

export interface FundingProvider{
  id:string;
  supportsAutomaticFunding:boolean;
  getObservedBalanceJpy():Promise<number|null>;
  requestFunding(amountJpy:number):Promise<{mode:"manual";message:string}>;
}

export interface CryptoExchangeProvider{
  id:string;
  getBalance(asset:"JPY"|"LTC"):Promise<number>;
  getLtcJpyPrice():Promise<number>;
  buyLtcWithJpy(amountJpy:number,idempotencyId:string):Promise<unknown>;
  getOrder(idempotencyId:string):Promise<unknown>;
  withdrawLtc(input:{
    address:string;amount:number;withdrawOrderId:string;network?:string;addressTag?:string;
  }):Promise<unknown>;
  getWithdrawal(withdrawOrderId:string,travelRule:boolean):Promise<unknown>;
}

export interface WalletProvider{
  id:string;
  mode:"manual_external_wallet"|"exchange_direct";
  getLtcBalance():Promise<number|null>;
  sendLtc?(input:{address:string;amount:number;idempotencyId:string}):Promise<unknown>;
}

export interface SupplierProvider{
  id:string;
  getBalance():Promise<{balance:number;pending_balance:number;currency:string}>;
  listProducts():Promise<unknown>;
  getProduct(productId:number):Promise<unknown>;
  purchase(input:{
    productId:number;quantity:number;externalOrderId:string;idempotencyKey:string;
  }):Promise<unknown>;
  getOrder(orderId:number):Promise<unknown>;
  lookupOrder(externalOrderId:string):Promise<unknown>;
}

export interface DeliveryProvider{
  id:string;
  deliverReadyItems():Promise<{delivered:number;mode:string}>;
}

export class ManualPayPayFundingProvider implements FundingProvider{
  id="paypay_manual";
  supportsAutomaticFunding=false;
  constructor(private observedBalance:number|null){}
  async getObservedBalanceJpy(){return this.observedBalance;}
  async requestFunding(amountJpy:number){
    return {
      mode:"manual" as const,
      message:"Binance JapanへPayPay経由で "+Math.ceil(amountJpy)+"円のJPY入金を行ってください。"+
        "完了後、BOTがBinance JPY残高の増加を公式APIで検知して処理を再開します。"
    };
  }
}

export class BinanceJapanProvider implements CryptoExchangeProvider{
  id="binance_japan";
  constructor(private env:Env){}
  async getBalance(asset:"JPY"|"LTC"){
    return (await binanceBalance(this.env,asset)).free;
  }
  getLtcJpyPrice(){return binanceLtcJpyPrice();}
  buyLtcWithJpy(amountJpy:number,idempotencyId:string){
    return binanceMarketBuyLtcWithJpy(this.env,amountJpy,idempotencyId);
  }
  getOrder(idempotencyId:string){return binanceQueryOrder(this.env,idempotencyId);}
  withdrawLtc(input:{address:string;amount:number;withdrawOrderId:string;network?:string;addressTag?:string}){
    return binanceWithdrawLtc(this.env,input);
  }
  getWithdrawal(withdrawOrderId:string,travelRule:boolean){
    return binanceWithdrawStatus(this.env,{withdrawOrderId,travelRule});
  }
}

export class ManualExternalLtcWalletProvider implements WalletProvider{
  id="ltc_external_manual";
  mode="manual_external_wallet" as const;
  async getLtcBalance(){return null;}
}

export class ExchangeDirectWalletProvider implements WalletProvider{
  id="binance_direct";
  mode="exchange_direct" as const;
  constructor(private exchange:CryptoExchangeProvider){}
  getLtcBalance(){return this.exchange.getBalance("LTC");}
}

export class HStoraSupplierProvider implements SupplierProvider{
  id="hstora";
  constructor(private env:Env){}
  getBalance(){return hstoraBalance(this.env);}
  listProducts(){return hstoraCatalog(this.env,{page:1,limit:100});}
  getProduct(productId:number){return hstoraProduct(this.env,productId);}
  purchase(input:{productId:number;quantity:number;externalOrderId:string;idempotencyKey:string}){
    return hstoraCreateOrder(this.env,input);
  }
  getOrder(orderId:number){return hstoraOrder(this.env,orderId);}
  lookupOrder(externalOrderId:string){return hstoraLookupOrder(this.env,externalOrderId);}
}

export class ReadyForDeliveryProvider implements DeliveryProvider{
  id="xaccount_bot_future";
  async deliverReadyItems(){
    return {delivered:0,mode:"READY_FOR_DELIVERY_ONLY"};
  }
}
