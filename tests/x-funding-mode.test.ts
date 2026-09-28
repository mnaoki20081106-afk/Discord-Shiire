import test from "node:test";
import assert from "node:assert/strict";
import {
  fundingModeLabel,
  isBinanceAutoFundingServerEnabled
} from "../src/x-funding-mode.ts";

test("Binance auto funding server gate defaults locked",()=>{
  assert.equal(isBinanceAutoFundingServerEnabled({}),false);
  assert.equal(isBinanceAutoFundingServerEnabled({BINANCE_AUTO_FUNDING_ENABLED:"false"}),false);
  assert.equal(isBinanceAutoFundingServerEnabled({BINANCE_AUTO_FUNDING_ENABLED:"1"}),false);
});

test("Binance auto funding server gate requires explicit true",()=>{
  assert.equal(isBinanceAutoFundingServerEnabled({BINANCE_AUTO_FUNDING_ENABLED:"true"}),true);
  assert.equal(isBinanceAutoFundingServerEnabled({BINANCE_AUTO_FUNDING_ENABLED:" TRUE "}),true);
});

test("funding mode labels are explicit",()=>{
  assert.equal(fundingModeLabel("manual_hstora"),"HStoraへLTC手動補充");
  assert.equal(fundingModeLabel("binance_auto"),"Binance自動LTC購入");
});
