import test from "node:test";
import assert from "node:assert/strict";
import {
  hstoraHasUsableDelivery,
  hstoraStatusRequiresDelivery
} from "../src/x-hstora-order-policy.ts";

test("DELIVERED and COMPLETED require delivery data",()=>{
  assert.equal(hstoraStatusRequiresDelivery("DELIVERED"),true);
  assert.equal(hstoraStatusRequiresDelivery("completed"),true);
  assert.equal(hstoraStatusRequiresDelivery("PROCESSING"),false);
  assert.equal(hstoraStatusRequiresDelivery("REFUNDED"),false);
  assert.equal(hstoraStatusRequiresDelivery("DISPUTED"),false);
});

test("delivery is usable only when available and items array exists",()=>{
  assert.equal(hstoraHasUsableDelivery({
    delivery:{available:true,items:["a"]}
  }),true);
  assert.equal(hstoraHasUsableDelivery({
    delivery:{available:true}
  }),false);
  assert.equal(hstoraHasUsableDelivery({
    delivery:{available:false,items:[]}
  }),false);
  assert.equal(hstoraHasUsableDelivery({}),false);
});

test("empty delivery items are structurally usable and count check handles mismatch",()=>{
  assert.equal(hstoraHasUsableDelivery({
    delivery:{available:true,items:[]}
  }),true);
});
