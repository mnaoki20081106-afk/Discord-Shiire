export type ProviderHealth={
  ok:boolean;
  provider:string;
  mode:"live"|"manual"|"disabled";
  details?:Record<string,unknown>;
};

export interface FundingProvider{
  readonly id:string;
  health():Promise<ProviderHealth>;
  /**
   * Returns an observed balance only. A provider that has no official consumer
   * balance API must return null rather than scrape or automate login flows.
   */
  getObservedJpyBalance():Promise<number|null>;
}

export interface CryptoExchangeProvider{
  readonly id:string;
  health():Promise<ProviderHealth>;
  getAssetBalance(asset:string):Promise<number>;
}

export interface WalletProvider{
  readonly id:string;
  health():Promise<ProviderHealth>;
  getBalance(asset:string):Promise<number|null>;
}

export interface SupplierProvider{
  readonly id:string;
  health():Promise<ProviderHealth>;
  getBalance():Promise<{amount:number;currency:string}>;
}

export interface DeliveryProvider{
  readonly id:string;
  /**
   * Current implementation intentionally does not send credentials anywhere.
   * Purchased accounts remain READY_FOR_DELIVERY until the Xaccount-Bot
   * delivery contract is explicitly connected later.
   */
  deliverReadyInventory():Promise<{delivered:number;pending:number}>;
}
