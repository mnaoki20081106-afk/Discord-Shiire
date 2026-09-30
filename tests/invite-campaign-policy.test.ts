import test from "node:test";
import assert from "node:assert/strict";
import {
  decideInviteAttribution,
  earnedRewardCount,
  effectiveEarnedRewardCount,
  inviteUsesDelta,
  remainingUntilNextReward,
  rewardStatusCanBeClaimed,
  staleRewardRecoveryStatus
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

test("earned invite rewards are never revoked when threshold changes",()=>{
  assert.equal(effectiveEarnedRewardCount(10,5,2),2);
  assert.equal(effectiveEarnedRewardCount(10,20,2),2);
  assert.equal(effectiveEarnedRewardCount(10,3,2),3);
});

test("invite attribution resolves one changed invite",()=>{
  assert.deepEqual(
    decideInviteAttribution([
      {code:"abc",ownerUserId:"1",pendingUses:1,lastSeenAt:10}
    ]),
    {kind:"resolved",code:"abc"}
  );
});

test("invite attribution is safe when multiple changed links share one owner",()=>{
  assert.deepEqual(
    decideInviteAttribution([
      {code:"b",ownerUserId:"1",pendingUses:1,lastSeenAt:10},
      {code:"a",ownerUserId:"1",pendingUses:2,lastSeenAt:9}
    ]),
    {kind:"resolved",code:"a"}
  );
});

test("invite attribution fails closed for different owners",()=>{
  assert.deepEqual(
    decideInviteAttribution([
      {code:"a",ownerUserId:"1",pendingUses:1,lastSeenAt:10},
      {code:"b",ownerUserId:"2",pendingUses:1,lastSeenAt:10}
    ]),
    {kind:"ambiguous",codes:["a","b"]}
  );
});

test("invite attribution fails closed when an owner is unknown",()=>{
  const result=decideInviteAttribution([
    {code:"known",ownerUserId:"1",pendingUses:1,lastSeenAt:10},
    {code:"unknown",ownerUserId:null,pendingUses:1,lastSeenAt:10}
  ]);
  assert.equal(result.kind,"ambiguous");
});

test("stale pre-send reward states recover safely",()=>{
  const now=10*60*1000;
  assert.equal(staleRewardRecoveryStatus("CLAIMING",0,now),"WAITING_STOCK");
  assert.equal(staleRewardRecoveryStatus("RESERVED",0,now),"WAITING_STOCK");
  assert.equal(staleRewardRecoveryStatus("SENDING",0,now),"DELIVERY_UNCERTAIN");
  assert.equal(staleRewardRecoveryStatus("SENDING",now-1000,now),null);
});

test("only retry-safe reward states can be claimed",()=>{
  for(const status of ["WAITING_STOCK","DM_FAILED","ERROR"]){
    assert.equal(rewardStatusCanBeClaimed(status),true,status);
  }
  for(const status of ["CLAIMING","RESERVED","SENDING","DELIVERY_UNCERTAIN","DELIVERED"]){
    assert.equal(rewardStatusCanBeClaimed(status),false,status);
  }
});
