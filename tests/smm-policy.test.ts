import test from "node:test";
import assert from "node:assert/strict";
import {
  SMM_LINK_KINDS_BY_SNS,
  isSmmSns,
  isJpyCurrency,
  isRetryableSupplierRejection,
  mapSmmSupplierStatus,
  normalizeSmmLink,
  parseSmmQuantity,
  placeRetryDecision,
  shouldExpireSmmOrder,
  smmCost,
  smmQuantityBounds,
  smmQuote,
  smmQuoteIsProfitable,
  smmRefundAmount
} from "../src/smm-policy.ts";

test("quote adds markup and fee on top of rate per 1000",()=>{
  assert.equal(smmQuote(500,1000,{markup_percent:30,fee_jpy:0}),650);
  assert.equal(smmQuote(500,1000,{markup_percent:30,fee_jpy:50}),700);
  assert.equal(smmQuote(1.5,10,{markup_percent:0,fee_jpy:0}),1);
});

test("quote always rounds up so fractions never become a loss",()=>{
  const total=smmQuote(333,1000,{markup_percent:10,fee_jpy:0});
  assert.ok(total>=smmCost(333,1000)*1.1);
  assert.equal(total,Math.ceil(333*1.1));
});

test("quote rejects invalid rates",()=>{
  assert.throws(()=>smmQuote(Number.NaN,1000,{markup_percent:30,fee_jpy:0}));
  assert.throws(()=>smmQuote(-1,1000,{markup_percent:30,fee_jpy:0}));
});

test("profit guard blocks sales below cost or below the margin floor",()=>{
  assert.equal(smmQuoteIsProfitable(650,500,1000,0),true);
  assert.equal(smmQuoteIsProfitable(500,500,1000,0),true);
  assert.equal(smmQuoteIsProfitable(499,500,1000,0),false);
  assert.equal(smmQuoteIsProfitable(650,500,1000,20),true);
  assert.equal(smmQuoteIsProfitable(650,600,1000,20),false);
  assert.equal(smmQuoteIsProfitable(0,0,1000,0),false);
});

test("quantity bounds intersect supplier and product limits",()=>{
  assert.deepEqual(
    smmQuantityBounds({min:10,max:10000},{min_qty:100,max_qty:5000}),
    {min:100,max:5000}
  );
  assert.deepEqual(
    smmQuantityBounds({min:10,max:10000},{min_qty:1,max_qty:0}),
    {min:10,max:10000}
  );
});

test("quantity parsing accepts commas and full-width digits but not junk",()=>{
  const bounds={min:10,max:5000};
  assert.equal(parseSmmQuantity("1,000",bounds),1000);
  assert.equal(parseSmmQuantity("１０００",bounds),1000);
  assert.equal(parseSmmQuantity("9",bounds),null);
  assert.equal(parseSmmQuantity("5001",bounds),null);
  assert.equal(parseSmmQuantity("10.5",bounds),null);
  assert.equal(parseSmmQuantity("1e3",bounds),null);
  assert.equal(parseSmmQuantity("-100",bounds),null);
});

test("X profile links are normalized and reserved paths are rejected",()=>{
  assert.equal(normalizeSmmLink("x_profile","https://twitter.com/foo_bar?s=20"),"https://x.com/foo_bar");
  assert.equal(normalizeSmmLink("x_profile","https://x.com/foo_bar/"),"https://x.com/foo_bar");
  assert.equal(normalizeSmmLink("x_profile","https://x.com/home"),null);
  assert.equal(normalizeSmmLink("x_profile","https://x.com/foo/status/123"),null);
  assert.equal(normalizeSmmLink("x_profile","http://x.com/foo"),null);
  assert.equal(normalizeSmmLink("x_profile","https://evil.example/foo"),null);
  assert.equal(normalizeSmmLink("x_profile","https://x.com.evil.example/foo"),null);
  assert.equal(normalizeSmmLink("x_profile","https://user:pw@x.com/foo"),null);
});

test("X post links must contain a numeric status id",()=>{
  assert.equal(
    normalizeSmmLink("x_post","https://mobile.twitter.com/foo/status/1234567890?lang=ja"),
    "https://x.com/foo/status/1234567890"
  );
  assert.equal(normalizeSmmLink("x_post","https://x.com/foo"),null);
  assert.equal(normalizeSmmLink("x_post","https://x.com/foo/status/abc"),null);
});

test("generic url links must be https without whitespace or credentials",()=>{
  assert.equal(normalizeSmmLink("url","https://example.com/a"),"https://example.com/a");
  assert.equal(normalizeSmmLink("url","ftp://example.com/a"),null);
  assert.equal(normalizeSmmLink("url","https://example.com/a b"),null);
  assert.equal(normalizeSmmLink("url","javascript:alert(1)"),null);
});

test("supplier status mapping is conservative about unknown values",()=>{
  assert.deepEqual(mapSmmSupplierStatus("In progress"),{kind:"active"});
  assert.deepEqual(mapSmmSupplierStatus("Pending"),{kind:"active"});
  assert.deepEqual(mapSmmSupplierStatus("Completed"),{kind:"completed"});
  assert.deepEqual(mapSmmSupplierStatus("Partial"),{kind:"partial"});
  assert.deepEqual(mapSmmSupplierStatus("Canceled"),{kind:"canceled"});
  assert.equal(mapSmmSupplierStatus("Something new").kind,"unknown");
});

test("partial refunds are proportional and never exceed the total",()=>{
  assert.equal(smmRefundAmount(650,1000,250,"partial"),162);
  assert.equal(smmRefundAmount(650,1000,5000,"partial"),650);
  assert.equal(smmRefundAmount(650,1000,0,"partial"),0);
  assert.equal(smmRefundAmount(650,1000,1000,"canceled"),650);
});

test("only balance-like rejections are retried automatically",()=>{
  assert.equal(isRetryableSupplierRejection("Not enough funds on balance"),true);
  assert.equal(isRetryableSupplierRejection("残高が不足しています"),true);
  assert.equal(isRetryableSupplierRejection("Incorrect link"),false);
  assert.equal(isRetryableSupplierRejection("Quantity less than minimum"),false);
});

test("retry budget is bounded",()=>{
  assert.equal(placeRetryDecision(1),"retry");
  assert.equal(placeRetryDecision(11),"give_up");
});

test("only unpaid orders past their window expire",()=>{
  assert.equal(shouldExpireSmmOrder("awaiting_payment",100,200),true);
  assert.equal(shouldExpireSmmOrder("payment_pending",100,200),false);
  assert.equal(shouldExpireSmmOrder("paid",100,200),false);
  assert.equal(shouldExpireSmmOrder("awaiting_payment",null,200),false);
});

test("only JPY supplier balances are accepted",()=>{
  assert.equal(isJpyCurrency("JPY"),true);
  assert.equal(isJpyCurrency("円"),true);
  assert.equal(isJpyCurrency("USD"),false);
  assert.equal(isJpyCurrency(""),false);
});

test("Instagram links are normalized per kind",()=>{
  assert.equal(normalizeSmmLink("instagram_profile","https://instagram.com/some.user?igsh=1"),"https://www.instagram.com/some.user/");
  assert.equal(normalizeSmmLink("instagram_profile","https://www.instagram.com/p/ABCDE12345/"),null);
  assert.equal(normalizeSmmLink("instagram_profile","https://www.instagram.com/explore"),null);
  assert.equal(normalizeSmmLink("instagram_post","https://www.instagram.com/reel/ABCDE12345/?utm=1"),"https://www.instagram.com/reel/ABCDE12345/");
  assert.equal(normalizeSmmLink("instagram_post","https://www.instagram.com/some.user/"),null);
  assert.equal(normalizeSmmLink("instagram_post","https://x.com/p/ABCDE12345"),null);
});

test("TikTok links need an @handle and numeric video id",()=>{
  assert.equal(normalizeSmmLink("tiktok_profile","https://www.tiktok.com/@some.user?lang=ja"),"https://www.tiktok.com/@some.user");
  assert.equal(normalizeSmmLink("tiktok_profile","https://www.tiktok.com/some.user"),null);
  assert.equal(normalizeSmmLink("tiktok_video","https://tiktok.com/@some.user/video/7234567890123456789"),"https://www.tiktok.com/@some.user/video/7234567890123456789");
  assert.equal(normalizeSmmLink("tiktok_video","https://www.tiktok.com/@some.user"),null);
  assert.equal(normalizeSmmLink("tiktok_video","https://vm.tiktok.com/ZMabc/"),null);
});

test("YouTube channel and video links resolve to canonical forms",()=>{
  assert.equal(normalizeSmmLink("youtube_channel","https://www.youtube.com/@some_handle"),"https://www.youtube.com/@some_handle");
  assert.equal(normalizeSmmLink("youtube_channel","https://youtube.com/channel/UCabcdefghijklmnopqrstuv"),"https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv");
  assert.equal(normalizeSmmLink("youtube_channel","https://www.youtube.com/watch?v=dQw4w9WgXcQ"),null);
  assert.equal(normalizeSmmLink("youtube_video","https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s"),"https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(normalizeSmmLink("youtube_video","https://youtu.be/dQw4w9WgXcQ?si=abc"),"https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(normalizeSmmLink("youtube_video","https://www.youtube.com/shorts/dQw4w9WgXcQ"),"https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(normalizeSmmLink("youtube_video","https://www.youtube.com/watch?v=short"),null);
  assert.equal(normalizeSmmLink("youtube_video","https://evil.example/watch?v=dQw4w9WgXcQ"),null);
});

test("each SNS only allows its own link kinds plus a generic URL",()=>{
  assert.deepEqual(SMM_LINK_KINDS_BY_SNS.x,["x_profile","x_post","url"]);
  assert.ok(SMM_LINK_KINDS_BY_SNS.instagram.every(kind=>kind==="url"||kind.startsWith("instagram")));
  assert.deepEqual(SMM_LINK_KINDS_BY_SNS.other,["url"]);
  assert.equal(isSmmSns("tiktok"),true);
  assert.equal(isSmmSns("myspace"),false);
});
