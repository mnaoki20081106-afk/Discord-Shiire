import test from "node:test";
import assert from "node:assert/strict";
import {
  dailyRestockPauseReason,
  isDailyRestockFundingWaitAction,
  isDailyRestockScheduleMinute,
  jstDateKey,
  shouldNotifyDailyRestock
} from "../src/x-daily-restock-policy.ts";

test("JST date key crosses UTC day correctly",()=>{
  assert.equal(
    jstDateKey(Date.UTC(2026,8,30,8,59,0)),
    "2026-09-30"
  );
  assert.equal(
    jstDateKey(Date.UTC(2026,8,30,15,1,0)),
    "2026-10-01"
  );
});

test("daily restock schedule is exactly 18:00 JST",()=>{
  assert.equal(
    isDailyRestockScheduleMinute(Date.UTC(2026,8,30,9,0,0)),
    true
  );
  assert.equal(
    isDailyRestockScheduleMinute(Date.UTC(2026,8,30,8,59,0)),
    false
  );
  assert.equal(
    isDailyRestockScheduleMinute(Date.UTC(2026,8,30,9,1,0)),
    false
  );
});


test("daily restock notifies only when at least one stock class actually gained inventory",()=>{
  assert.equal(
    shouldNotifyDailyRestock({addedTopSearch:0,addedNoShadowban:0}),
    false
  );
  assert.equal(
    shouldNotifyDailyRestock({addedTopSearch:1,addedNoShadowban:0}),
    true
  );
  assert.equal(
    shouldNotifyDailyRestock({addedTopSearch:0,addedNoShadowban:3}),
    true
  );
});

test("daily restock pause reason distinguishes safe operator states",()=>{
  assert.equal(
    dailyRestockPauseReason({dryRun:true,autoProcurementEnabled:true}),
    "DRY_RUN_ENABLED"
  );
  assert.equal(
    dailyRestockPauseReason({dryRun:false,autoProcurementEnabled:false}),
    "AUTO_PROCUREMENT_DISABLED"
  );
  assert.equal(
    dailyRestockPauseReason({dryRun:false,autoProcurementEnabled:true}),
    null
  );
});

test("daily restock keeps waiting for manual HStora funding",()=>{
  assert.equal(isDailyRestockFundingWaitAction("PROCUREMENT_BUDGET_EXHAUSTED"),true);
  assert.equal(isDailyRestockFundingWaitAction("MANUAL_HSTORA_LTC_TOPUP_REQUIRED"),true);
  assert.equal(isDailyRestockFundingWaitAction("NO_AFFORDABLE_HSTORA_PRODUCT"),false);
});
