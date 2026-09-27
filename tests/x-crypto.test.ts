import test from "node:test";
import assert from "node:assert/strict";
import { encryptSensitive, decryptSensitive } from "../src/x-crypto.ts";

const keyBytes=new Uint8Array(32);
for(let i=0;i<keyBytes.length;i++) keyBytes[i]=i+1;
const key=Buffer.from(keyBytes).toString("base64");
const env={CREDENTIALS_ENCRYPTION_KEY:key};

test("credential payload round-trips through AES-GCM",async()=>{
  const plaintext="user@example.test:password:2fa-secret";
  const encrypted=await encryptSensitive(env,plaintext);
  const decrypted=await decryptSensitive(env,encrypted);
  assert.equal(decrypted,plaintext);
  assert.notEqual(encrypted.ciphertext,plaintext);
  assert.equal(encrypted.version,1);
});

test("different encryptions use different IVs",async()=>{
  const a=await encryptSensitive(env,"same-value");
  const b=await encryptSensitive(env,"same-value");
  assert.notEqual(a.iv,b.iv);
  assert.notEqual(a.ciphertext,b.ciphertext);
});
