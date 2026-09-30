import test from "node:test";
import assert from "node:assert/strict";
import {
  SHIIRE_VENDING_SALES_COPY,
  shiireSalesCopyForClass
} from "../src/shiire-vending-sales-copy.ts";

test("NO_SHADOWBAN uses the standard 350 yen sales copy",()=>{
  assert.deepEqual(SHIIRE_VENDING_SALES_COPY.NO_SHADOWBAN,{
    name:"Search Top + No shadow ban",
    description:"検索上位に載るシャドバンされてない垢です。",
    priceJpy:350
  });
});

test("TOP_SEARCH uses the old 500 yen sales copy",()=>{
  assert.deepEqual(SHIIRE_VENDING_SALES_COPY.TOP_SEARCH,{
    name:"【old】Search Top + No shadow ban",
    description:"検索上位にのるシャドバンされていないOld垢です。より運用向きです！",
    priceJpy:500
  });
});

test("unknown sources do not receive class sales copy",()=>{
  assert.equal(shiireSalesCopyForClass("INVITE_CAMPAIGN"),null);
  assert.equal(shiireSalesCopyForClass(null),null);
});
