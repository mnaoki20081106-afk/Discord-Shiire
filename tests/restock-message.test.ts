import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RESTOCK_MESSAGE, normalizeRestockMessage, renderRestockMessage, restockMessagePayload, validateRestockMessage } from "../src/shiire-restock-message.ts";
const counts={normal_stock:20,normal_added:3,old_stock:40,old_added:12};
test("requested notification preserves wording and distinguishes current stock from additions",()=>{
 assert.equal(renderRestockMessage(DEFAULT_RESTOCK_MESSAGE,counts),`@everyone

***在庫入荷のお知らせ***
本日の在庫を入荷しました！
*①Search Top + No shadow ban*
現在在庫 : 20個（+3個）

*②【Old】Top Search + No shadow ban*
現在在庫 : 40個（+12個）

🌙Paypay、Kyashでの購入が可能です！
/毎日18:00（JST）入荷`);
});
test("custom templates substitute repeated tokens and preserve custom text",()=>{
 assert.equal(renderRestockMessage('通常 {normal_stock} (+{normal_added}) / Old {old_stock} (+{old_added}) / {normal_stock}',counts),'通常 20 (+3) / Old 40 (+12) / 20');
 assert.equal(normalizeRestockMessage('本日の在庫を入荷しました！'),DEFAULT_RESTOCK_MESSAGE);
 assert.equal(normalizeRestockMessage('手動で設定した文章'),'手動で設定した文章');
});
test("only actual notification permits everyone; previews and panel updates remain silent",()=>{
 assert.deepEqual(restockMessagePayload(DEFAULT_RESTOCK_MESSAGE,counts).allowed_mentions,{parse:[]});
 assert.deepEqual(restockMessagePayload(DEFAULT_RESTOCK_MESSAGE,counts,true).allowed_mentions,{parse:['everyone']});
 assert.deepEqual(restockMessagePayload(DEFAULT_RESTOCK_MESSAGE,counts,true).embeds,[]);
});
test("reject message that would exceed Discord limit after stock substitution",()=>{
 assert.equal(validateRestockMessage(DEFAULT_RESTOCK_MESSAGE),true);
 assert.equal(validateRestockMessage('x'.repeat(1986)+'{normal_stock}'),false);
 assert.equal(validateRestockMessage(''),false);
 assert.equal(renderRestockMessage('{normal_added}',{...counts,normal_added:NaN}),'0');
});
