import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function source(path:string){
  return fs.readFileSync(new URL("../"+path,import.meta.url),"utf8");
}

const campaign=source("src/invite-campaign.ts");
const rewards=source("src/invite-campaign-rewards.ts");
const index=source("src/index.ts");
const db=source("src/invite-campaign-db.ts");

test("gateway reseed clears stale pending invite deltas",()=>{
  assert.equal(
    campaign.includes(
      "UPDATE invite_campaign_invites SET pending_uses=0 WHERE guild_id=?"
    ),
    true
  );
  assert.equal(campaign.includes('refreshInviteSnapshot(env,id,"baseline")'),true);
});

test("reward delivery uses a conditional claim before DM side effects",()=>{
  assert.equal(rewards.includes("status='CLAIMING'"),true);
  assert.equal(
    rewards.includes('WHERE id=? AND status=?'),
    true
  );
  assert.equal(rewards.includes("status='SENDING'"),true);
});

test("automatic reward retry is scoped to the active campaign guild",()=>{
  assert.equal(
    rewards.includes(
      "WHERE guild_id=? AND status='WAITING_STOCK' ORDER BY created_at ASC LIMIT 20"
    ),
    true
  );
});

test("scheduled sweep reconciles earned rewards before retrying delivery",()=>{
  const reconcile=index.indexOf("await reconcileInviteCampaignRewards(env)");
  const retry=index.indexOf("await retryInviteCampaignRewards(env)");
  assert.ok(reconcile>=0);
  assert.ok(retry>reconcile);
});

test("campaign dashboard scopes progress and rewards to the active guild",()=>{
  assert.equal(
    db.includes("FROM invite_campaign_progress WHERE guild_id=?"),
    true
  );
  assert.equal(
    db.includes("WHERE guild_id=? ORDER BY created_at DESC LIMIT 100"),
    true
  );
});
