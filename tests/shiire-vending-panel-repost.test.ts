import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const source=readFileSync(
  new URL("../src/shiire-vending.ts",import.meta.url),
  "utf8"
);

test("vending bridge exposes tracked panel repost support",()=>{
  assert.match(source,/async function repostMachinePanels/);
  assert.match(source,/\/panel\\\/repost/);
  assert.match(source,/repostPanels===true/);
  assert.match(source,/deleteDiscordMessage/);
});

test("initial 350\/500 migration cannot overwrite later admin prices",()=>{
  const setVersion=source.indexOf(
    'await setXSetting(env,key,SHIIRE_VENDING_SALES_COPY_VERSION)'
  );
  const conditional=source.indexOf("if(updated>0||!panelsOk)");
  assert.ok(setVersion>=0);
  assert.ok(conditional>=0);
  assert.ok(
    setVersion<conditional,
    "migration version must persist independently of panel refresh success"
  );
});
