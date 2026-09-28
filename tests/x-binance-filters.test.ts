import test from "node:test";
import assert from "node:assert/strict";
import { marketNotionalBounds } from "../src/providers/binance.ts";

test("uses the strictest market minimum across Binance notional filters",()=>{
  assert.deepEqual(marketNotionalBounds([
    {filterType:"MIN_NOTIONAL",minNotional:"1000",applyToMarket:true},
    {filterType:"NOTIONAL",minNotional:"1200",applyMinToMarket:true,maxNotional:"500000",applyMaxToMarket:true}
  ]),{min:1200,max:500000});
});

test("ignores notional sides that Binance marks as not applicable to MARKET",()=>{
  assert.deepEqual(marketNotionalBounds([
    {filterType:"MIN_NOTIONAL",minNotional:"1000",applyToMarket:false},
    {filterType:"NOTIONAL",minNotional:"500",applyMinToMarket:false,maxNotional:"10000",applyMaxToMarket:false}
  ]),{min:null,max:null});
});

test("uses the smallest applicable market maximum",()=>{
  assert.deepEqual(marketNotionalBounds([
    {filterType:"NOTIONAL",minNotional:"1000",applyMinToMarket:true,maxNotional:"100000",applyMaxToMarket:true},
    {filterType:"NOTIONAL",minNotional:"500",applyMinToMarket:true,maxNotional:"75000",applyMaxToMarket:true}
  ]),{min:1000,max:75000});
});
