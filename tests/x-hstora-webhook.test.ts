import test from "node:test";
import assert from "node:assert/strict";
import { hmacHex, sha256Hex } from "../src/crypto.ts";
import { HstoraApiError, verifyHstoraWebhook } from "../src/providers/hstora.ts";

async function signedRequest(input?:{signatureOverride?:string;eventType?:string}){
  const secret="test-webhook-secret";
  const timestamp="1770000000";
  const deliveryId="delivery-test-001";
  const eventId="event-test-001";
  const eventType=input?.eventType??"order.delivered";
  const body=JSON.stringify({type:eventType,data:{order_id:123}});
  const bodyHash=await sha256Hex(body);
  const canonical=[timestamp,deliveryId,eventId,eventType,bodyHash].join("\n");
  const signature=input?.signatureOverride??await hmacHex(secret,canonical);
  const request=new Request("https://example.test/webhooks/hstora",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-HStore-Webhook-Timestamp":timestamp,
      "X-HStore-Delivery-Id":deliveryId,
      "X-HStore-Event-Id":eventId,
      "X-HStore-Webhook-Event":eventType,
      "X-HStore-Signature-Version":"v1",
      "X-HStore-Webhook-Signature":signature
    },
    body
  });
  return {request,body,env:{HSTORA_WEBHOOK_SECRET:secret}};
}

test("accepts an official-format HStora webhook signature",async()=>{
  const {request,body,env}=await signedRequest();
  const result=await verifyHstoraWebhook(env as any,request,body);
  assert.equal(result.deliveryId,"delivery-test-001");
  assert.equal(result.eventId,"event-test-001");
  assert.equal(result.eventType,"order.delivered");
});

test("rejects an invalid HStora webhook signature",async()=>{
  const {request,body,env}=await signedRequest({signatureOverride:"0".repeat(64)});
  await assert.rejects(
    ()=>verifyHstoraWebhook(env as any,request,body),
    (error:unknown)=>{
      assert.ok(error instanceof HstoraApiError);
      assert.equal(error.code,"HSTORA_WEBHOOK_SIGNATURE_INVALID");
      return true;
    }
  );
});

test("rejects unsupported HStora webhook signature version",async()=>{
  const {request,body,env}=await signedRequest();
  const headers=new Headers(request.headers);
  headers.set("X-HStore-Signature-Version","v2");
  const changed=new Request(request.url,{method:"POST",headers,body});
  await assert.rejects(
    ()=>verifyHstoraWebhook(env as any,changed,body),
    (error:unknown)=>{
      assert.ok(error instanceof HstoraApiError);
      assert.equal(error.code,"HSTORA_WEBHOOK_VERSION_UNSUPPORTED");
      return true;
    }
  );
});
