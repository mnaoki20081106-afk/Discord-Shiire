import type { FundingProvider, ProviderHealth, WalletProvider, DeliveryProvider } from "./interfaces";
import type { XSettings } from "../x-settings";

export class ManualPayPayFundingProvider implements FundingProvider{
  readonly id="paypay_manual";
  constructor(private settings:XSettings){}
  async health():Promise<ProviderHealth>{
    return {
      ok:this.settings.observed_paypay_balance_at>0,
      provider:this.id,
      mode:"manual",
      details:{
        reason:"No verified public consumer PayPay balance/funding API is used by this integration.",
        observedAt:this.settings.observed_paypay_balance_at||null
      }
    };
  }
  async getObservedJpyBalance(){
    return this.settings.observed_paypay_balance_at>0
      ?this.settings.observed_paypay_balance_jpy
      :null;
  }
}

export class DisabledHotWalletProvider implements WalletProvider{
  readonly id="ltc_hot_wallet_disabled";
  async health():Promise<ProviderHealth>{
    return {
      ok:true,
      provider:this.id,
      mode:"disabled",
      details:{
        reason:"No private key is stored in the Cloudflare Worker. Connect a separately hardened Litecoin Core signer before enabling this adapter."
      }
    };
  }
  async getBalance(_asset:string){return null;}
}

export class ReadyForDeliveryProvider implements DeliveryProvider{
  readonly id="xaccount_bot_future";
  constructor(private pending:number){}
  async deliverReadyInventory(){
    return {delivered:0,pending:this.pending};
  }
}
