import test from "node:test";
import assert from "node:assert/strict";
import {
  isDailyRestockScheduleMinute,
  jstDateKey
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
