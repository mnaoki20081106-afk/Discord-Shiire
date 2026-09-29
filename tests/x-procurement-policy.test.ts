import test from "node:test";
import assert from "node:assert/strict";
import {
  PRIMARY_SPLIT_HSTORA_PRODUCT_ID,
  evenSplitPurchaseQuantity,
  isPrimarySplitHstoraProduct,
  splitProcurementClassAtRank
} from "../src/x-procurement-policy.ts";

test("HStora product 4841 is the primary split source",()=>{
  assert.equal(PRIMARY_SPLIT_HSTORA_PRODUCT_ID,4841);
  assert.equal(isPrimarySplitHstoraProduct(4841),true);
  assert.equal(isPrimarySplitHstoraProduct("4841"),true);
  assert.equal(isPrimarySplitHstoraProduct(4842),false);
});

test("primary split purchases are forced to an even quantity",()=>{
  assert.equal(evenSplitPurchaseQuantity(20),20);
  assert.equal(evenSplitPurchaseQuantity(19),18);
  assert.equal(evenSplitPurchaseQuantity(2),2);
  assert.equal(evenSplitPurchaseQuantity(1),0);
});

test("split class allocation is exactly 50-50 for even batches",()=>{
  const classes=Array.from({length:20},(_,rank)=>
    splitProcurementClassAtRank(rank,20)
  );
  assert.equal(classes.filter(value=>value==="TOP_SEARCH").length,10);
  assert.equal(classes.filter(value=>value==="NO_SHADOWBAN").length,10);
});

test("odd legacy batches differ by at most one account",()=>{
  const classes=Array.from({length:5},(_,rank)=>
    splitProcurementClassAtRank(rank,5)
  );
  assert.equal(classes.filter(value=>value==="TOP_SEARCH").length,3);
  assert.equal(classes.filter(value=>value==="NO_SHADOWBAN").length,2);
});
