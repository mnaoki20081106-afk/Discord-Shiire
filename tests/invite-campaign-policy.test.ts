import test from "node:test";
import assert from "node:assert/strict";
import {
  earnedRewardCount,
  inviteUsesDelta,
  remainingUntilNextReward
} from "../src/invite-campaign-policy.ts";

test("invite reward progress is periodic",()=>{
  assert.equal(earnedRewardCount(0,5),0);
  assert.equal(earnedRewardCount(4,5),0);
  assert.equal(earnedRewardCount(5,5),1);
  assert.equal(earnedRewardCount(12,5),2);
  assert.equal(remainingUntilNextReward(0,5),5);
  assert.equal(remainingUntilNextReward(1,5),4);
  assert.equal(remainingUntilNextReward(5,5),5);
  assert.equal(remainingUntilNextReward(9,5),1);
});

test("invite use deltas never go negative",()=>{
  assert.equal(inviteUsesDelta(3,5),2);
  assert.equal(inviteUsesDelta(5,3),0);
  assert.equal(inviteUsesDelta(undefined,4),4);
});
