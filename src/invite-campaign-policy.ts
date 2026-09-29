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
