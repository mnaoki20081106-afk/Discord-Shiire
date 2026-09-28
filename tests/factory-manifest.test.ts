import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const manifest=JSON.parse(
  fs.readFileSync(new URL("../bot-factory.json",import.meta.url),"utf8")
) as {
  setup:{
    fields:Array<{key:string;type:string;required?:boolean;pattern?:string}>;
    discord?:{
      permissions?:Array<{id:string;required?:boolean}>;
      checks?:Array<{id:string;required?:boolean}>;
    };
  };
};

function field(key:string){
  const value=manifest.setup.fields.find(item=>item.key===key);
  assert.ok(value,"missing Factory field: "+key);
  return value;
}

test("Factory bridge URL accepts a real workers.dev HTTPS origin",()=>{
  const pattern=field("XACCOUNT_BOT_BASE_URL").pattern;
  assert.ok(pattern);
  const re=new RegExp(pattern);
  assert.equal(re.test("https://xaccount-bot.mnaoki20081106.workers.dev"),true);
  assert.equal(re.test("https://example.com/"),true);
  assert.equal(re.test("https://example.com/path"),false);
});

test("Factory URL fields reject whitespace and non-HTTPS schemes",()=>{
  for(const key of [
    "MAIN_BOT_BASE_URL",
    "XACCOUNT_BOT_BASE_URL",
    "DISCORD_NOTIFY_WEBHOOK_URL"
  ]){
    const pattern=field(key).pattern;
    assert.ok(pattern,key);
    const re=new RegExp(pattern);
    assert.equal(re.test("https://example.com/path value"),false,key);
    assert.equal(re.test("http://example.com"),false,key);
  }
});

test("Factory critical secret fields keep intended requirements",()=>{
  assert.equal(field("CREDENTIALS_ENCRYPTION_KEY").required,true);
  assert.equal(field("SHIIRE_BRIDGE_SECRET").required,true);
  assert.equal(field("XACCOUNT_BOT_BASE_URL").required,true);
});


test("Factory includes Manage Roles for vending buyer-role fulfillment",()=>{
  const permission=manifest.setup.discord?.permissions?.find(
    item=>item.id==="manage-roles"
  );
  assert.ok(permission);
  assert.equal(permission.required,true);

  const roleOrder=manifest.setup.discord?.checks?.find(
    item=>item.id==="role-order-shiire"
  );
  assert.ok(roleOrder);
  assert.equal(roleOrder.required,true);
});
