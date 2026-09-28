import type { Env } from "./types";

export type FundingMode="manual_hstora"|"binance_auto";

export function isBinanceAutoFundingServerEnabled(
  env:Pick<Env,"BINANCE_AUTO_FUNDING_ENABLED">
){
  return (env.BINANCE_AUTO_FUNDING_ENABLED??"").trim().toLowerCase()==="true";
}

export function fundingModeLabel(mode:FundingMode){
  return mode==="binance_auto"
    ?"Binance自動LTC購入"
    :"HStoraへLTC手動補充";
}
