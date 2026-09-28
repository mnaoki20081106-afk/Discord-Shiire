import test from "node:test";
import assert from "node:assert/strict";
import {
  SHIIRE_DISCORD_BOT_PERMISSIONS,
  canReleaseReservedOrder,
  deliveryNonce,
  paymentMethodEnabled,
  paymentPrice,
  shouldExpireUnpaidOrder
} from "../src/shiire-vending-policy.ts";

test("zero price disables the payment method",()=>{
  const product={price_paypay:0,price_kyash:500};
  assert.equal(paymentMethodEnabled(product,"paypay"),false);
  assert.equal(paymentMethodEnabled(product,"kyash"),true);
  assert.equal(paymentPrice(product,"paypay"),0);
  assert.equal(paymentPrice(product,"kyash"),500);
});

test("payment_pending order never expires through the unpaid reservation timeout",()=>{
  const now=1_000_000;
  assert.equal(
    shouldExpireUnpaidOrder("payment_pending",now-1,now),
    false
  );
  assert.equal(canReleaseReservedOrder("payment_pending"),false);
});

test("awaiting_payment order expires after its reservation deadline",()=>{
  const now=1_000_000;
  assert.equal(
    shouldExpireUnpaidOrder("awaiting_payment",now-1,now),
    true
  );
  assert.equal(canReleaseReservedOrder("awaiting_payment"),true);
});

test("paid and delivery states cannot release reserved credentials",()=>{
  for(const status of ["paid","delivering","delivery_sent","delivered"]){
    assert.equal(canReleaseReservedOrder(status),false,status);
  }
});

test("delivery nonce is stable and Discord-sized",()=>{
  const a=deliveryNonce("order-abc_123");
  const b=deliveryNonce("order-abc_123");
  assert.equal(a,b);
  assert.ok(a.length<=25);
  assert.match(a,/^[A-Za-z0-9]+$/);
});


test("Discord invite permission mask contains every vending permission",()=>{
  const mask=BigInt(SHIIRE_DISCORD_BOT_PERMISSIONS);
  const required=[
    1n<<10n, // View Channel
    1n<<11n, // Send Messages
    1n<<14n, // Embed Links
    1n<<15n, // Attach Files
    1n<<16n, // Read Message History
    1n<<28n  // Manage Roles
  ];
  for(const permission of required){
    assert.notEqual(mask&permission,0n);
  }
  assert.equal(mask&(1n<<17n),0n,"Mention Everyone remains intentionally disabled");
});
