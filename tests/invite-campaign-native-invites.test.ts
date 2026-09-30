import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const indexSource=fs.readFileSync(
  new URL("../src/index.ts",import.meta.url),
  "utf8"
);
const campaignSource=fs.readFileSync(
  new URL("../src/invite-campaign.ts",import.meta.url),
  "utf8"
);
const discordSource=fs.readFileSync(
  new URL("../src/invite-campaign-discord.ts",import.meta.url),
  "utf8"
);

test("invite campaign does not expose a member-facing slash command",()=>{
  assert.equal(indexSource.includes('name:"invite-link"'),false);
  assert.equal(indexSource.includes("createInviteCampaignLink"),false);
});

test("invite campaign attributes Discord-native invites by inviter and use delta",()=>{
  assert.equal(campaignSource.includes("fetchDiscordGuildInvites"),true);
  assert.equal(campaignSource.includes("invite.inviter?.id"),true);
  assert.equal(campaignSource.includes("nextPendingInviteUses"),true);
});

test("campaign bot no longer creates invite URLs itself",()=>{
  assert.equal(discordSource.includes("createDiscordCampaignInvite"),false);
  assert.equal(campaignSource.includes("createInviteCampaignLink"),false);
});
