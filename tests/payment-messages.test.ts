import assert from "node:assert/strict";
import { test } from "node:test";
import { paymentPendingMessage, paymentRejectedMessage } from "../src/payment-messages.ts";

test("bridge reasons map to specific buyer messages", () => {
  assert.match(paymentRejectedMessage("PAYPAY_AMOUNT_MISMATCH"), /一致しません/);
  assert.match(paymentRejectedMessage("PAYPAY_MONEY_LIGHT_NOT_ALLOWED"), /マネーライト/);
  assert.match(paymentRejectedMessage("EXPIRED"), /有効期限/);
  assert.match(paymentPendingMessage("LOGIN_REQUIRED"), /再ログイン/);
  assert.match(paymentPendingMessage("TEMPORARY_HOLD"), /一時保留/);
});

test("unknown reasons fall back to the generic messages", () => {
  assert.match(paymentRejectedMessage("SOMETHING_NEW"), /決済を確認できませんでした/);
  assert.match(paymentPendingMessage(undefined), /1分ごとに自動確認/);
});
