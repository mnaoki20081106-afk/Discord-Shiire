function hex(bytes:ArrayBuffer):string{
  return [...new Uint8Array(bytes)]
    .map(value=>value.toString(16).padStart(2,"0"))
    .join("");
}

export async function sha256Hex(value:string):Promise<string>{
  return hex(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  ));
}

export async function hmacHex(secret:string,value:string):Promise<string>{
  const key=await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {name:"HMAC",hash:"SHA-256"},
    false,
    ["sign"]
  );
  return hex(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  ));
}

export function randomId():string{
  return crypto.randomUUID().replace(/-/g,"");
}
