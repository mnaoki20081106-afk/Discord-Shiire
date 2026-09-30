import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DAILY_RESTOCK_CONFIG,
  jstDateKey,
  sanitizeDailyRestockConfig
} from "../src/x-daily-restock-state.ts";

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

test("daily restock config keeps steady stock and custom notification",()=>{
  const config=sanitizeDailyRestockConfig({
    enabled:true,
    top_search_target_stock:80,
    no_shadowban_target_stock:40,
    notification_channel_id:"123456789012345678",
    notification_message:"入荷しました",
    panel_channel_id:"",
    panel_message_id:""
  });
  assert.equal(config.top_search_target_stock,80);
  assert.equal(config.no_shadowban_target_stock,40);
  assert.equal(config.notification_message,"入荷しました");
  assert.equal(config.notification_channel_id,"123456789012345678");
});

test("invalid channel ids are discarded safely",()=>{
  const config=sanitizeDailyRestockConfig({
    ...DEFAULT_DAILY_RESTOCK_CONFIG,
    notification_channel_id:"not-a-channel"
  });
  assert.equal(config.notification_channel_id,"");
});
