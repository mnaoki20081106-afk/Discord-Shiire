import test from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKED_HSTORA_PRODUCT_IDS,
  DUAL_TOP_SPLIT_MODE,
  HSTORA_X_MAX_UNIT_PRICE_USD,
  HSTORA_X_PREFERRED_PRICE_CEILING_USD,
  PREFERRED_NO_SHADOWBAN_HSTORA_PRODUCT_IDS,
  PREFERRED_TOP_HSTORA_PRODUCT_IDS,
  evenSplitPurchaseQuantity,
  hasDualTopNoShadowbanEvidence,
  hstoraPricePriorityTier,
  hstoraProcurementPriorityTier,
  isBlockedHstoraSource,
  isTopSearchFallbackEligible,
  isPreferredNoShadowbanHstoraSource,
  isPreferredTopHstoraSource,
  procurementClassOverrideForHstoraProduct,
  splitProcurementClassAtRank
} from "../src/x-procurement-policy.ts";

test("normal HStora X procurement has a hard 35-cent ceiling",()=>{
  assert.equal(HSTORA_X_MAX_UNIT_PRICE_USD,0.35);
  assert.equal(HSTORA_X_PREFERRED_PRICE_CEILING_USD,0.30);
  assert.equal(hstoraPricePriorityTier(0.19),0);
  assert.equal(hstoraPricePriorityTier(0.20),0);
  assert.equal(hstoraPricePriorityTier(0.29),0);
  assert.equal(hstoraPricePriorityTier(0.30),1);
  assert.equal(hstoraPricePriorityTier(0.35),1);
  assert.equal(hstoraPricePriorityTier(0.351),2);
});

test("5132 is explicitly blocked and removed from preferred TOP sources",()=>{
  assert.deepEqual([...BLOCKED_HSTORA_PRODUCT_IDS],[5132]);
  assert.deepEqual([...PREFERRED_TOP_HSTORA_PRODUCT_IDS],[]);
  assert.equal(isBlockedHstoraSource(5132),true);
  assert.equal(isPreferredTopHstoraSource(5132),false);
  assert.equal(isTopSearchFallbackEligible(5132,["TOP+Latest","No Shadowban"]),false);
  assert.equal(hstoraProcurementPriorityTier(5132,"TOP_SEARCH"),99);
});

test("4521 and 1609 remain preferred no-shadowban sources",()=>{
  assert.deepEqual([...PREFERRED_NO_SHADOWBAN_HSTORA_PRODUCT_IDS],[4521,1609]);
  assert.equal(isPreferredNoShadowbanHstoraSource(4521),true);
  assert.equal(isPreferredNoShadowbanHstoraSource(1609),true);
  assert.equal(procurementClassOverrideForHstoraProduct(4521),"NO_SHADOWBAN");
  assert.equal(procurementClassOverrideForHstoraProduct(1609),"NO_SHADOWBAN");
});

test("dual capability requires search evidence and No Shadowban",()=>{
  assert.equal(
    hasDualTopNoShadowbanEvidence(["TOP Search","No Shadowban"]),
    true
  );
  assert.equal(
    hasDualTopNoShadowbanEvidence(["Search Visible","No Shadowban"]),
    true
  );
  assert.equal(
    hasDualTopNoShadowbanEvidence(["No Shadowban"]),
    false
  );
});

test("generic search fallback must also prove No Shadowban and not be blocked",()=>{
  assert.equal(
    isTopSearchFallbackEligible(9999,["TOP Search"]),
    false
  );
  assert.equal(
    isTopSearchFallbackEligible(9999,["TOP Search","No Shadowban"]),
    true
  );
  assert.equal(
    isTopSearchFallbackEligible(9999,["Search Visible","No Shadowban"]),
    true
  );
});

test("dual-capability split purchases are forced to an even quantity",()=>{
  assert.equal(DUAL_TOP_SPLIT_MODE,"TOP_SEARCH_NO_SHADOWBAN_50_50");
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

test("No Shadowban tie priority remains selected sources then generic",()=>{
  assert.equal(hstoraProcurementPriorityTier(4521,"NO_SHADOWBAN"),0);
  assert.equal(hstoraProcurementPriorityTier(1609,"NO_SHADOWBAN"),0);
  assert.equal(hstoraProcurementPriorityTier(4841,"NO_SHADOWBAN"),1);
  assert.equal(hstoraProcurementPriorityTier(9999,"NO_SHADOWBAN"),1);
});
