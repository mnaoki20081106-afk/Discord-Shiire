export const DEFAULT_INVITES_PER_REWARD=5;
export const DEFAULT_INVITE_CAMPAIGN_TARGET_STOCK=20;

export function normalizePositiveInteger(
  value:unknown,
  fallback:number,
  max:number
):number{
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<1) return fallback;
  return Math.min(max,n);
}

export function earnedRewardCount(
  validInvites:number,
  invitesPerReward:number
):number{
  const valid=Math.max(0,Math.floor(Number(validInvites)||0));
  const threshold=Math.max(1,Math.floor(Number(invitesPerReward)||1));
  return Math.floor(valid/threshold);
}

export function effectiveEarnedRewardCount(
  validInvites:number,
  invitesPerReward:number,
  previousEarned:number
):number{
  const previous=Math.max(0,Math.floor(Number(previousEarned)||0));
  return Math.max(
    previous,
    earnedRewardCount(validInvites,invitesPerReward)
  );
}

export function remainingUntilNextReward(
  validInvites:number,
  invitesPerReward:number
):number{
  const valid=Math.max(0,Math.floor(Number(validInvites)||0));
  const threshold=Math.max(1,Math.floor(Number(invitesPerReward)||1));
  const remainder=valid%threshold;
  return remainder===0?threshold:threshold-remainder;
}

export function inviteUsesDelta(
  previousUses:unknown,
  currentUses:unknown
):number{
  const before=Math.max(0,Math.floor(Number(previousUses)||0));
  const after=Math.max(0,Math.floor(Number(currentUses)||0));
  return Math.max(0,after-before);
}

export type InviteAttributionCandidate={
  code:string;
  ownerUserId:string|null;
  pendingUses:number;
  lastSeenAt:number;
};

export type InviteAttributionDecision=
  |{kind:"none"}
  |{kind:"resolved";code:string}
  |{kind:"ambiguous";codes:string[]};

export function decideInviteAttribution(
  input:InviteAttributionCandidate[]
):InviteAttributionDecision{
  const candidates=input
    .filter(item=>Number(item.pendingUses)>0)
    .map(item=>({
      ...item,
      pendingUses:Math.max(0,Math.floor(Number(item.pendingUses)||0)),
      lastSeenAt:Number(item.lastSeenAt)||0
    }))
    .sort((a,b)=>
      b.pendingUses-a.pendingUses||
      b.lastSeenAt-a.lastSeenAt||
      a.code.localeCompare(b.code)
    );

  if(candidates.length===0) return {kind:"none"};
  if(candidates.length===1){
    return {kind:"resolved",code:candidates[0]!.code};
  }

  const owners=new Set(candidates.map(item=>item.ownerUserId));
  const soleOwner=owners.size===1?[...owners][0]:null;
  if(soleOwner){
    return {kind:"resolved",code:candidates[0]!.code};
  }

  return {
    kind:"ambiguous",
    codes:candidates.map(item=>item.code)
  };
}

export type RewardRecoveryStatus=
  |"WAITING_STOCK"
  |"DELIVERY_UNCERTAIN"
  |null;

export function staleRewardRecoveryStatus(
  status:string,
  updatedAt:number,
  now:number,
  staleAfterMs=5*60*1000
):RewardRecoveryStatus{
  if(!Number.isFinite(updatedAt)||now-updatedAt<staleAfterMs) return null;
  if(status==="CLAIMING"||status==="RESERVED") return "WAITING_STOCK";
  if(status==="SENDING") return "DELIVERY_UNCERTAIN";
  return null;
}

export function rewardStatusCanBeClaimed(status:string):boolean{
  return status==="WAITING_STOCK"||status==="DM_FAILED"||status==="ERROR";
}
