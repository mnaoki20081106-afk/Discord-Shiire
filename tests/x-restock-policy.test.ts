import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseRestockClass,
  restockCycleComplete
} from "../src/x-restock-policy.ts";

test("reorder trigger keeps replenishing to target across split batches",()=>{
  const first=chooseRestockClass({
    topInventory:8,
    topReorderPoint:10,
    topTargetStock:50,
    topCycleActive:false,
    noShadowInventory:50,
    noShadowReorderPoint:10,
    noShadowTargetStock:50,
    noShadowCycleActive:false
  });
  assert.deepEqual(first,{
    targetClass:"TOP_SEARCH",
    classInventory:8,
    classTarget:50,
    triggeredNow:true
  });

  const afterFirstBatch=chooseRestockClass({
    topInventory:28,
    topReorderPoint:10,
    topTargetStock:50,
    topCycleActive:true,
    noShadowInventory:50,
    noShadowReorderPoint:10,
    noShadowTargetStock:50,
    noShadowCycleActive:false
  });
  assert.deepEqual(afterFirstBatch,{
    targetClass:"TOP_SEARCH",
    classInventory:28,
    classTarget:50,
    triggeredNow:false
  });

  const afterSecondBatch=chooseRestockClass({
    topInventory:48,
    topReorderPoint:10,
    topTargetStock:50,
    topCycleActive:true,
    noShadowInventory:50,
    noShadowReorderPoint:10,
    noShadowTargetStock:50,
    noShadowCycleActive:false
  });
  assert.equal(afterSecondBatch?.classInventory,48);
  assert.equal(afterSecondBatch?.classTarget,50);
});

test("restock cycle stops when target stock is reached",()=>{
  assert.equal(restockCycleComplete(50,50),true);
  assert.equal(restockCycleComplete(49,50),false);
  assert.equal(chooseRestockClass({
    topInventory:50,
    topReorderPoint:10,
    topTargetStock:50,
    topCycleActive:true,
    noShadowInventory:50,
    noShadowReorderPoint:10,
    noShadowTargetStock:50,
    noShadowCycleActive:false
  }),null);
});

test("inventory above reorder does not start a new cycle by itself",()=>{
  assert.equal(chooseRestockClass({
    topInventory:28,
    topReorderPoint:10,
    topTargetStock:50,
    topCycleActive:false,
    noShadowInventory:50,
    noShadowReorderPoint:10,
    noShadowTargetStock:50,
    noShadowCycleActive:false
  }),null);
});

test("TOP_SEARCH has priority when both restock cycles need work",()=>{
  const decision=chooseRestockClass({
    topInventory:5,
    topReorderPoint:10,
    topTargetStock:50,
    topCycleActive:false,
    noShadowInventory:3,
    noShadowReorderPoint:10,
    noShadowTargetStock:50,
    noShadowCycleActive:false
  });
  assert.equal(decision?.targetClass,"TOP_SEARCH");
});
