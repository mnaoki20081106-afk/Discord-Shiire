import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateProcurementBudget,
  procurementBudgetTotal,
  procurementBudgetCharges,
  maxAffordableQuantityForBudget,
  validateProcurementBudgetPercentages
} from "../src/x-budget.ts";

test("allocates HStora funding by configured percentages",()=>{
  assert.deepEqual(
    allocateProcurementBudget(100,{
      INVITE_CAMPAIGN:10,
      NO_SHADOWBAN:30,
      TOP_SEARCH:60
    }),
    {
      INVITE_CAMPAIGN:10,
      NO_SHADOWBAN:30,
      TOP_SEARCH:60
    }
  );
});

test("zero percent keeps invite campaign from receiving procurement funds",()=>{
  assert.deepEqual(
    allocateProcurementBudget(7.35,{
      INVITE_CAMPAIGN:0,
      NO_SHADOWBAN:50,
      TOP_SEARCH:50
    }),
    {
      INVITE_CAMPAIGN:0,
      NO_SHADOWBAN:3.675,
      TOP_SEARCH:3.675
    }
  );
});

test("rounding never loses the total funding amount",()=>{
  const allocated=allocateProcurementBudget(1,{
    INVITE_CAMPAIGN:33,
    NO_SHADOWBAN:33,
    TOP_SEARCH:34
  });
  assert.equal(procurementBudgetTotal(allocated),1);
});

test("percentages must total exactly 100",()=>{
  assert.throws(
    ()=>validateProcurementBudgetPercentages({
      INVITE_CAMPAIGN:20,
      NO_SHADOWBAN:20,
      TOP_SEARCH:20
    }),
    /PROCUREMENT_BUDGET_PERCENT_TOTAL_NOT_100/
  );
});

test("percentages must be whole values from 0 through 100",()=>{
  assert.throws(
    ()=>validateProcurementBudgetPercentages({
      INVITE_CAMPAIGN:0.5,
      NO_SHADOWBAN:49.5,
      TOP_SEARCH:50
    }),
    /PROCUREMENT_BUDGET_PERCENT_INVALID/
  );
});


test("dual TOP and NoShadow purchase charges both buckets equally",()=>{
  assert.deepEqual(
    procurementBudgetCharges("TOP_SEARCH",true,4),
    {
      INVITE_CAMPAIGN:0,
      NO_SHADOWBAN:2,
      TOP_SEARCH:2
    }
  );
});

test("dual purchase cannot spend when either half-budget is missing",()=>{
  assert.equal(
    maxAffordableQuantityForBudget(
      "TOP_SEARCH",
      true,
      0.20,
      20,
      {
        INVITE_CAMPAIGN:0,
        NO_SHADOWBAN:0,
        TOP_SEARCH:100
      }
    ),
    0
  );
});

test("dual purchase quantity is even and bounded by both buckets",()=>{
  assert.equal(
    maxAffordableQuantityForBudget(
      "NO_SHADOWBAN",
      true,
      0.20,
      9,
      {
        INVITE_CAMPAIGN:0,
        NO_SHADOWBAN:0.61,
        TOP_SEARCH:1.00
      }
    ),
    6
  );
});

test("single-class purchase only consumes its own budget",()=>{
  assert.equal(
    maxAffordableQuantityForBudget(
      "TOP_SEARCH",
      false,
      0.20,
      20,
      {
        INVITE_CAMPAIGN:0,
        NO_SHADOWBAN:0,
        TOP_SEARCH:1.01
      }
    ),
    5
  );
});
