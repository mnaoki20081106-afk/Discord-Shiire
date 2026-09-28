import type { Env } from "./types";

function decodeBase64(value:string):ArrayBuffer{
  const normalized=value.replace(/-/g,"+").replace(/_/g,"/");
  const padded=normalized+"=".repeat((4-normalized.length%4)%4);
  const raw=atob(padded);
  const bytes=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i);
  return bytes.buffer;
}

function encodeBase64(value:ArrayBuffer):string{
  const bytes=new Uint8Array(value);
  let binary="";
  for(const byte of bytes) binary+=String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToArrayBuffer(bytes:Uint8Array):ArrayBuffer{
  const copy=new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
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
  const iv=bytesToArrayBuffer(crypto.getRandomValues(new Uint8Array(12)));
  const plaintextBuffer=bytesToArrayBuffer(new TextEncoder().encode(plaintext));
  const encrypted=await crypto.subtle.encrypt(
    {name:"AES-GCM",iv},
    key,
    plaintextBuffer
  );
  return {version:1,iv:encodeBase64(iv),ciphertext:encodeBase64(encrypted)};
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
