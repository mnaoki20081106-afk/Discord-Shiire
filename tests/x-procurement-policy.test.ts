import test from "node:test";
import assert from "node:assert/strict";
import {
  DUAL_TOP_SPLIT_MODE,
  PREFERRED_NO_SHADOWBAN_HSTORA_PRODUCT_IDS,
  PREFERRED_TOP_HSTORA_PRODUCT_IDS,
  evenSplitPurchaseQuantity,
  hasDualTopNoShadowbanEvidence,
  isTopSearchFallbackEligible,
  isPreferredNoShadowbanHstoraSource,
  isPreferredTopHstoraSource,
  procurementClassOverrideForHstoraProduct,
  splitProcurementClassAtRank
} from "../src/x-procurement-policy.ts";

test("trusted preferred TOP sources are 4841 and 5132",()=>{
  assert.deepEqual([...PREFERRED_TOP_HSTORA_PRODUCT_IDS],[4841,5132]);
  assert.equal(isPreferredTopHstoraSource(4841),true);
  assert.equal(isPreferredTopHstoraSource("5132"),true);
  assert.equal(isPreferredTopHstoraSource(9999),false);
});

test("HStora 4521 is a preferred no-shadowban-only exception",()=>{
  assert.deepEqual([...PREFERRED_NO_SHADOWBAN_HSTORA_PRODUCT_IDS],[4521]);
  assert.equal(isPreferredNoShadowbanHstoraSource(4521),true);
  assert.equal(isPreferredNoShadowbanHstoraSource("4521"),true);
  assert.equal(isPreferredNoShadowbanHstoraSource(4841),false);
  assert.equal(procurementClassOverrideForHstoraProduct(4521),"NO_SHADOWBAN");
  assert.equal(procurementClassOverrideForHstoraProduct(5132),null);
});

test("dual split mode is generic and not tied to a product id",()=>{
  assert.equal(DUAL_TOP_SPLIT_MODE,"TOP_SEARCH_NO_SHADOWBAN_50_50");
});

test("dual capability requires explicit TOP and No Shadowban evidence",()=>{
  assert.equal(
    hasDualTopNoShadowbanEvidence(["TOP Search","No Shadowban"]),
    true
  );
  assert.equal(
    hasDualTopNoShadowbanEvidence(["TOP+Latest","No Shadowban"]),
    true
  );
  assert.equal(
    hasDualTopNoShadowbanEvidence(["TOP Search"]),
    false
  );
  assert.equal(
    hasDualTopNoShadowbanEvidence(["No Shadowban"]),
    false
  );
  assert.equal(
    hasDualTopNoShadowbanEvidence(["Latest Search","No Shadowban"]),
    false
  );
});

test("dual-capability split purchases are forced to an even quantity",()=>{
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


test("preferred TOP products bypass generic fallback labeling",()=>{
  assert.equal(
    isTopSearchFallbackEligible(4841,["TOP Search"]),
    true
  );
  assert.equal(
    isTopSearchFallbackEligible(5132,["TOP+Latest"]),
    true
  );
});

test("generic TOP fallback must also prove No Shadowban",()=>{
  assert.equal(
    isTopSearchFallbackEligible(9999,["TOP Search"]),
    false
  );
  assert.equal(
    isTopSearchFallbackEligible(9999,["TOP Search","No Shadowban"]),
    true
  );
  assert.equal(
    isTopSearchFallbackEligible(9999,["TOP+Latest","No Shadowban"]),
    true
  );
});
