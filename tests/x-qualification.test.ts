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
    max_unit_price_jpy:100,
    reorder_point:10,
    target_stock:50,
    max_batch_purchase:20,
    min_seller_rating:0,
    min_product_reviews:0,
    min_sales_count:0,
    max_dispute_rate:0,
    minimum_stock:1,
    trial_purchase_count:10,
    seller_quality_mode:"manual_product_approval",
    approved_hstora_product_ids:[123],
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

test("approved visible product under 100 JPY qualifies",()=>{
  const q=qualifyHstoraProduct(product(),settings(),1);
  assert.equal(q.qualified,true);
  assert.equal(q.unit_price_jpy,75);
  assert.ok(q.search_visibility.includes("TOP+Latest"));
  assert.equal(q.seller_quality,"manual_approval");
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
  assert.ok(q.reasons.includes("UNIT_PRICE_ABOVE_LIMIT"));
});
