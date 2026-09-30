import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateProcurementBudget,
  procurementBudgetTotal,
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
