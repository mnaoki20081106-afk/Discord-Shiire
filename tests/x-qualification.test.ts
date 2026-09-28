import test from "node:test";
import assert from "node:assert/strict";
import { qualifyHstoraProduct } from "../src/x-qualification.ts";

function settings(overrides={}){
  return {
    dry_run:true,
    emergency_stop:false,
    auto_purchase_enabled:false,
    auto_procurement_enabled:false,
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
    max_no_shadowban_unit_price_usd:0.60,
    procurement_strategy:"cheapest_first",
    search_visibility_requirement:"top",
    reorder_point:10,
    target_stock:50,
    no_shadowban_reorder_point:10,
    no_shadowban_target_stock:50,
    max_batch_purchase:20,
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
    pending_paypay_binance_jpy_baseline:0,
    pending_paypay_requested_at:0,
    usd_jpy_rate:150,
    usd_jpy_rate_updated_at:Date.now(),
    max_fx_age_ms:21_600_000,
    auto_ltc_withdraw_enabled:false,
    max_single_withdraw_ltc:0,
    max_price_jump_percent:25,
    max_ltc_price_jump_percent:15,
    max_consecutive_failures:3,
    require_bulk_confirmation:true,
    bulk_confirmation_threshold:20,
    bulk_approval_until:0,
    hstora_ltc_deposit_address:"",
    hstora_ltc_network:"LTC",
    ...overrides
  };
}

function product(overrides={}){
  return {
    id:123,
    name:"X account TOP+Latest",
    slug:"x-account",
    short_description:"No Shadowban / Search Visible",
    description:"TOP Search and Latest Search visible.",
    price:0.50,
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

test("X TOP-search product under 80 JPY qualifies in trial-only discovery",()=>{
  const q=qualifyHstoraProduct(product(),settings(),1);
  assert.equal(q.qualified,true);
  assert.equal(q.unit_price_jpy,75);
  assert.ok(q.search_visibility.includes("TOP+Latest"));
  assert.equal(q.procurement_class,"TOP_SEARCH");
  assert.equal(q.seller_quality,"trial_only");
});

test("latest-only X product is rejected because TOP search is required",()=>{
  const q=qualifyHstoraProduct(
    product({
      name:"Twitter X Latest Search",
      short_description:"Latest Search visible",
      description:"Latest Search only."
    }),
    settings(),
    1
  );
  assert.equal(q.qualified,false);
  assert.ok(q.reasons.includes("SUPPORTED_X_PRODUCT_CLASS_NOT_CONFIRMED"));
});

test("non-X product is rejected even if it says TOP Search",()=>{
  const q=qualifyHstoraProduct(
    product({
      name:"Instagram TOP Search account",
      slug:"instagram-top-search",
      short_description:"TOP Search",
      description:"Search visible."
    }),
    settings(),
    1
  );
  assert.equal(q.qualified,false);
  assert.ok(q.reasons.includes("NOT_X_ACCOUNT_PRODUCT"));
});

test("actual trial quantity must qualify for the tier price",()=>{
  const tiered=product({
    price:0.60,
    price_tiers:[{min_quantity:20,unit_price:0.40}]
  });
  const trial=qualifyHstoraProduct(tiered,settings({usd_jpy_rate:150}),10);
  const bulk=qualifyHstoraProduct(tiered,settings({usd_jpy_rate:150}),20);
  assert.equal(trial.unit_price_jpy,90);
  assert.equal(trial.qualified,false);
  assert.ok(trial.reasons.includes("TOP_SEARCH_UNIT_PRICE_ABOVE_JPY_LIMIT"));
  assert.equal(bulk.unit_price_jpy,60);
  assert.equal(bulk.qualified,true);
});

test("strict seller-quality mode blocks when HStora API has no seller metrics",()=>{
  const q=qualifyHstoraProduct(product(),settings({seller_quality_mode:"strict_api"}),1);
  assert.equal(q.qualified,false);
  assert.ok(q.reasons.includes("SELLER_QUALITY_FIELDS_UNAVAILABLE_IN_HSTORA_API"));
});

test("stale USDJPY blocks USD product qualification",()=>{
  const q=qualifyHstoraProduct(
    product(),
    settings({usd_jpy_rate_updated_at:1,max_fx_age_ms:60_000}),
    1,
    Date.now()
  );
  assert.equal(q.qualified,false);
  assert.ok(q.reasons.includes("USDJPY_RATE_MISSING_OR_STALE"));
});

test("product above JPY unit price ceiling is rejected",()=>{
  const q=qualifyHstoraProduct(product({price:1}),settings({usd_jpy_rate:150}),1);
  assert.equal(q.unit_price_jpy,150);
  assert.equal(q.qualified,false);
  assert.ok(q.reasons.includes("TOP_SEARCH_UNIT_PRICE_ABOVE_JPY_LIMIT"));
});


test("TOP+Latest with No Shadowban is classified only as TOP_SEARCH",()=>{
  const q=qualifyHstoraProduct(
    product({
      name:"Twitter X TOP+Latest",
      short_description:"No Shadowban / TOP Search",
      description:"Top and latest search visible."
    }),
    settings(),
    1
  );
  assert.equal(q.qualified,true);
  assert.equal(q.procurement_class,"TOP_SEARCH");
});

test("No Shadowban without TOP wording is a separate NO_SHADOWBAN product",()=>{
  const q=qualifyHstoraProduct(
    product({
      name:"Twitter X Accounts",
      short_description:"No Shadow Ban",
      description:"Search Visible, no shadow banned accounts.",
      price:0.58
    }),
    settings(),
    1
  );
  assert.equal(q.qualified,true);
  assert.equal(q.procurement_class,"NO_SHADOWBAN");
  assert.ok(q.search_visibility.includes("No Shadowban"));
});

test("No Shadowban product above 0.60 USD is rejected",()=>{
  const q=qualifyHstoraProduct(
    product({
      name:"Twitter X Accounts",
      short_description:"No Shadowban",
      description:"No shadow banned.",
      price:0.61
    }),
    settings(),
    1
  );
  assert.equal(q.procurement_class,"NO_SHADOWBAN");
  assert.equal(q.qualified,false);
  assert.ok(q.reasons.includes("NO_SHADOWBAN_UNIT_PRICE_ABOVE_USD_LIMIT"));
});

test("Search Visible without TOP or No Shadowban is not a procurement product class",()=>{
  const q=qualifyHstoraProduct(
    product({
      name:"Twitter X Accounts",
      short_description:"Search Visible",
      description:"Visible in search.",
      price:0.20
    }),
    settings(),
    1
  );
  assert.equal(q.procurement_class,null);
  assert.equal(q.qualified,false);
  assert.ok(q.reasons.includes("SUPPORTED_X_PRODUCT_CLASS_NOT_CONFIRMED"));
});
