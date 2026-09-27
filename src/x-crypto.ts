import type { Env } from "./types";

function decodeBase64(value:string):Uint8Array{
  const normalized=value.replace(/-/g,"+").replace(/_/g,"/");
  const padded=normalized+"=".repeat((4-normalized.length%4)%4);
  const raw=atob(padded);
  return Uint8Array.from(raw,ch=>ch.charCodeAt(0));
}

function encodeBase64(value:Uint8Array):string{
  let binary="";
  for(const byte of value) binary+=String.fromCharCode(byte);
  return btoa(binary);
}

async function encryptionKey(env:Env):Promise<CryptoKey>{
  const raw=env.CREDENTIALS_ENCRYPTION_KEY?.trim()??"";
  if(!raw) throw new Error("CREDENTIALS_ENCRYPTION_KEY_NOT_CONFIGURED");
  const bytes=decodeBase64(raw);
  if(bytes.byteLength!==32) throw new Error("CREDENTIALS_ENCRYPTION_KEY_MUST_BE_32_BYTES");
  return crypto.subtle.importKey("raw",bytes,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}

export type EncryptedSecret={
  version:1;
  iv:string;
  ciphertext:string;
};

export async function encryptSensitive(env:Env,plaintext:string):Promise<EncryptedSecret>{
  const key=await encryptionKey(env);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt(
    {name:"AES-GCM",iv},
    key,
    new TextEncoder().encode(plaintext)
  );
  return {version:1,iv:encodeBase64(iv),ciphertext:encodeBase64(new Uint8Array(encrypted))};
}

export async function decryptSensitive(env:Env,value:EncryptedSecret):Promise<string>{
  if(value.version!==1) throw new Error("UNSUPPORTED_CIPHERTEXT_VERSION");
  const key=await encryptionKey(env);
  const plain=await crypto.subtle.decrypt(
    {name:"AES-GCM",iv:decodeBase64(value.iv)},
    key,
    decodeBase64(value.ciphertext)
  );
  return new TextDecoder().decode(plain);
}
