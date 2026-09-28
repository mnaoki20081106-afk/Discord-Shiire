import test from "node:test";
import assert from "node:assert/strict";
import { comparableEffectivePriceJumpPercent } from "../src/x-price-policy.ts";

test("same quantity and currency compares effective tier prices",()=>{
  const jump=comparableEffectivePriceJumpPercent({
    previousUnitPrice:0.40,
    previousCurrency:"USD",
    previousPlannedQuantity:20,
    currentUnitPrice:0.55,
    currentCurrency:"usd",
    currentPlannedQuantity:20
  });
  assert.ok(jump!==null);
  assert.ok(Math.abs(Number(jump)-37.5)<1e-9);
});

test("trial-to-bulk quantity change is not treated as a price jump",()=>{
  assert.equal(comparableEffectivePriceJumpPercent({
    previousUnitPrice:0.50,
    previousCurrency:"USD",
    previousPlannedQuantity:10,
    currentUnitPrice:0.40,
    currentCurrency:"USD",
    currentPlannedQuantity:20
  }),null);
});

test("currency change is not directly comparable",()=>{
  assert.equal(comparableEffectivePriceJumpPercent({
    previousUnitPrice:50,
    previousCurrency:"JPY",
    previousPlannedQuantity:10,
    currentUnitPrice:0.30,
    currentCurrency:"USD",
    currentPlannedQuantity:10
  }),null);
});
