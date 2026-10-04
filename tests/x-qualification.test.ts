import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyProcurementClass,
  detectOldAccountEvidence,
  qualifyHstoraProduct
} from "../src/x-qualification.ts";

function settings(overrides={}){
  return {
    dry_run:true,
    emergency_stop:false,
    auto_purchase_enabled:false,
    auto_procurement_enabled:false,
    funding_mode:"manual_hstora",
    reserve_jpy:20_000,
    max_purchase_jpy:10_000,
    daily_purchase_limit_jpy:50_000,
    weekly_purchase_limit_jpy:100_000,
    monthly_purchase_limit_jpy:300_000,
    min_purchase_jpy:1_000,
    target_ltc_balance:1,
    max_ltc_balance:2,
    wallet_target_ltc:0,
    wallet_max_ltc:0,
    max_unit_price_jpy:80,
    max_no_shadowban_unit_price_usd:0.35,
    procurement_strategy:"cheapest_first",
    search_visibility_requirement:"top",
    reorder_point:10,
    target_stock:50,
    no_shadowban_reorder_point:10,
    no_shadowban_target_stock:50,
    max_batch_purchase:20,
    invite_campaign_budget_percent:0,
    no_shadowban_budget_percent:50,
    top_search_budget_percent:50,
    min_seller_rating:0,
    min_product_reviews:0,
    min_sales_count:0,
    max_dispute_rate:0,
    minimum_stock:1,
    trial_purchase_count:10,
    seller_quality_mode:"trial_only",
    approved_hstora_product_ids:[],
    observed_paypay_balance_jpy:50_000,
    observed_paypay_balance_at:Date.now(),
    max_paypay_balance_age_ms:86_400_000,
    pending_paypay_funding_jpy:0,
    pending_paypay_jpy_deposit_required_jpy:0,
    pending_paypay_jpy_credit_required_jpy:0,
    pending_paypay_direct_ltc_budget_jpy:0,
    pending_paypay_path_amounts_captured:false,
    pending_paypay_binance_jpy_baseline:0,
    pending_paypay_binance_ltc_baseline:0,
    pending_paypay_required_ltc:0,
    pending_paypay_ltc_baseline_captured:false,
    pending_paypay_requested_at:0,
    usd_jpy_rate:150,
    usd_jpy_rate_updated_at:Date.now(),
    max_fx_age_ms:21_600_000,
    max_fx_jump_percent:10,
    max_price_jump_percent:25,
    max_ltc_price_jump_percent:15,
    require_bulk_confirmation:true,
    bulk_confirmation_threshold:20,
    bulk_approval_until:0,
    ...overrides
  };
}

function product(overrides={}){
  return {
    id:123,
    name:"Twitter No Shadowban TOP+Latest 2006-2025",
    slug:"twitter-no-shadowban-top-latest-2006-2025",
    short_description:"No Shadowban / Search Visible",
    description:"Old Twitter accounts. Top and latest search visible.",
    price:0.25,
    currency:"USD",
    delivery_type:"instant",
    stock_available:100,
    product_url:"https://hstora.com/example",
    updated_at:new Date().toISOString(),
    price_tiers:[],
    rules:{delivery_type:"instant",instant_delivery:true,delivery_data_exposed:true},
    ...overrides
  };
}

test("② requires No Shadowban + search visibility + old-account evidence",()=>{
  const q=qualifyHstoraProduct(product(),settings(),1);
  assert.equal(q.qualified,true);
  assert.equal(q.procurement_class,"TOP_SEARCH");
  assert.equal(q.unit_price_source,0.25);
  assert.equal(q.unit_price_jpy,37.5);
  assert.ok(q.search_visibility.includes("No Shadowban"));
  assert.ok(q.evidence.some(value=>value.includes("Year range 2006-2025")));
});

test("① accepts a No Shadowban account even when it is not old",()=>{
  const p=product({
    id:4841,
    name:"Twitter NO SHADOW BAN TOP+latest 2fa/token 10 followers",
    slug:"twitter-no-shadowban-top-latest",
    short_description:"No Shadowban",
    description:"TOP+Latest search.",
    price:0.27
  });
  const q=qualifyHstoraProduct(p,settings(),1);
  assert.equal(q.qualified,true);
  assert.equal(q.procurement_class,"NO_SHADOWBAN");
  assert.ok(q.search_visibility.includes("No Shadowban"));
  assert.equal(detectOldAccountEvidence(p).old,false);
});

test("5132 is blocked even if a fixture price falls below 35 cents",()=>{
  const q=qualifyHstoraProduct(
    product({id:5132,price:0.20}),
    settings(),
    1
  );
  assert.equal(q.qualified,false);
  assert.ok(q.reasons.includes("HSTORA_PRODUCT_BLOCKED_BY_POLICY"));
});

test("② rejects an old search-visible account without No Shadowban evidence",()=>{
  const p=product({
    name:"Twitter TOP+Latest 2006-2025",
    slug:"twitter-top-latest-2006-2025",
    short_description:"Search Visible",
    description:"Old account, visible in search."
  });
  assert.equal(classifyProcurementClass(p),null);
  const q=qualifyHstoraProduct(p,settings(),1,Date.now(),"TOP_SEARCH");
  assert.equal(q.qualified,false);
  assert.ok(q.reasons.includes("NO_SHADOWBAN_EVIDENCE_NOT_CONFIRMED"));
});

test("② rejects search-visible No Shadowban accounts without old evidence",()=>{
  const q=qualifyHstoraProduct(
    product({
      name:"Twitter NO SHADOW BAN TOP+latest",
      slug:"twitter-no-shadowban-top-latest",
      short_description:"No Shadowban / Search Visible",
      description:"TOP+Latest search.",
      price:0.27
    }),
    settings(),
    1,
    Date.now(),
    "TOP_SEARCH"
  );
  assert.equal(q.qualified,false);
  assert.ok(q.reasons.includes("OLD_ACCOUNT_EVIDENCE_NOT_CONFIRMED"));
});

test("② accepts generic Search Visible wording when old and No Shadowban are proven",()=>{
  const q=qualifyHstoraProduct(
    product({
      name:"Twitter Accounts 2007-20",
      slug:"twitter-accounts-2007-20",
      short_description:"No Shadowban",
      description:"Search Visible."
    }),
    settings(),
    1
  );
  assert.equal(q.qualified,true);
  assert.equal(q.procurement_class,"TOP_SEARCH");
  assert.ok(q.search_visibility.includes("Search Visible"));
});

test("old-account detection accepts abbreviated year ranges",()=>{
  const old=detectOldAccountEvidence(product({
    name:"Twitter 2007-20 No Shadowban",
    slug:"twitter-2007-20",
    short_description:"No Shadowban",
    description:"Search Visible"
  }),Date.UTC(2026,9,4));
  assert.equal(old.old,true);
  assert.ok(old.evidence.some(value=>value.includes("2007-2020")));
});

test("current-year aged wording is not enough to count as OLD",()=>{
  const p=product({
    name:"HQ Aged 2026 Twitter Accounts",
    slug:"hq-aged-2026-twitter-accounts",
    short_description:"No Shadowban",
    description:"Search Visible"
  });
  const old=detectOldAccountEvidence(p,Date.UTC(2026,9,4));
  assert.equal(old.old,false);
});

test("21+ Days (Aged & Trusted) is not treated as the OLD premium class",()=>{
  const p=product({
    id:1609,
    name:"No shadow bans - Twitter accounts - no bans",
    slug:"no-shadow-bans-twitter-accounts-no-bans",
    short_description:"No shadow bans",
    description:"Account Age: 21+ Days (Aged & Trusted).",
    price:0.21
  });
  const q=qualifyHstoraProduct(p,settings(),1);
  assert.equal(q.qualified,true);
  assert.equal(q.procurement_class,"NO_SHADOWBAN");
  assert.equal(detectOldAccountEvidence(p).old,false);
});

test("35 cents is allowed and anything above it is rejected",()=>{
  const atLimit=qualifyHstoraProduct(
    product({price:0.35}),
    settings(),
    1
  );
  const overLimit=qualifyHstoraProduct(
    product({price:0.351}),
    settings(),
    1
  );
  assert.equal(atLimit.qualified,true);
  assert.equal(overLimit.qualified,false);
  assert.ok(overLimit.reasons.includes("HSTORA_X_UNIT_PRICE_ABOVE_USD_LIMIT"));
});

test("forced ① classification still requires No Shadowban evidence",()=>{
  const q=qualifyHstoraProduct(
    product({
      name:"Twitter 2006-2025 Search Visible",
      slug:"twitter-2006-2025-search-visible",
      short_description:"Search Visible",
      description:"Search Visible",
      price:0.20
    }),
    settings(),
    1,
    Date.now(),
    "NO_SHADOWBAN"
  );
  assert.equal(q.qualified,false);
  assert.ok(q.reasons.includes("NO_SHADOWBAN_EVIDENCE_NOT_CONFIRMED"));
});

test("non-X products are rejected even when keywords match",()=>{
  const q=qualifyHstoraProduct(
    product({
      name:"Instagram TOP Search 2006-2025",
      slug:"instagram-top-search-2006-2025",
      short_description:"No Shadowban / Search Visible",
      description:"Search Visible."
    }),
    settings(),
    1
  );
  assert.equal(q.qualified,false);
  assert.ok(q.reasons.includes("NOT_X_ACCOUNT_PRODUCT"));
});

test("strict seller-quality mode still blocks when HStora API lacks seller metrics",()=>{
  const q=qualifyHstoraProduct(
    product(),
    settings({seller_quality_mode:"strict_api"}),
    1
  );
  assert.equal(q.qualified,false);
  assert.ok(q.reasons.includes("SELLER_QUALITY_FIELDS_UNAVAILABLE_IN_HSTORA_API"));
});

test("stale USDJPY still fails closed",()=>{
  const q=qualifyHstoraProduct(
    product(),
    settings({usd_jpy_rate_updated_at:1,max_fx_age_ms:60_000}),
    1,
    Date.now()
  );
  assert.equal(q.qualified,false);
  assert.ok(q.reasons.includes("USDJPY_RATE_MISSING_OR_STALE"));
});
