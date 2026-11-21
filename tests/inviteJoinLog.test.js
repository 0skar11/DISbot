import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import inviteCacheEvent from '../src/events/inviteCache.js';
import inviteCreateEvent from '../src/events/inviteCreate.js';
import inviteLoggerEvent from '../src/events/inviteLogger.js';
import { clearAuditRoomCache } from '../src/services/logging/auditRooms.js';

// The "📨 عضو دخل" log in the invites room: DISbot posts it, CC-bot pays the invite rewards.
const dbWrites = [];
const client = {
  guilds: { cache: new Map() },
  db: {
    get: async () => null,
    set: async (key) => { dbWrites.push(key); },
    delete: async (key) => { dbWrites.push(key); },
  },
};

function makeGuild(id, { invites = {}, vanity = null, manageGuild = true } = {}) {
  const sent = [];
  const channelId = `invites_${id}`;
  const state = { invites: { ...invites }, vanityUses: vanity?.uses ?? 0 };
  const guild = {
    id,
    name: `Server ${id}`,
    memberCount: 42,
    client,
    vanityURLCode: vanity?.code || null,
    sent,
    state,
    members: { me: { id: 'bot', permissions: { has: () => manageGuild } } },
    channels: { cache: new Map([[channelId, { id: channelId, isTextBased: () => true, send: async (payload) => { sent.push(payload); return payload; } }]]) },
    invites: {
      fetch: async () => {
        if (!manageGuild) throw new Error('Missing Permissions');
        return new Map(Object.entries(state.invites).map(([code, invite]) => [code, { code, ...invite }]));
      },
    },
    fetchVanityData: async () => ({ code: vanity?.code, uses: state.vanityUses }),
  };
  return guild;
}

let joinCount = 0;
function makeMember(guild, userId) {
  joinCount += 1;
  return {
    id: userId,
    guild,
    client,
    joinedTimestamp: 1_700_000_000_000 + joinCount,
    user: { id: userId, tag: `user${userId}`, bot: false, createdTimestamp: 1_600_000_000_000, displayAvatarURL: () => 'https://cdn/avatar.png' },
    toString: () => `<@${userId}>`,
  };
}

async function startWith(...guilds) {
  client.guilds.cache = new Map(guilds.map((guild) => [guild.id, guild]));
  process.env.AUDIT_CHANNELS_JSON = JSON.stringify(Object.fromEntries(guilds.map((guild) => [guild.id, { invites: `invites_${guild.id}` }])));
  await inviteCacheEvent.execute(client);
}

const descriptionOf = (guild) => guild.sent.at(-1)?.embeds?.[0]?.description || '';

describe('invite join log (log only)', () => {
  beforeEach(() => {
    clearAuditRoomCache();
    dbWrites.length = 0;
  });

  test('posts the join embed with the inviter, code, uses and invite count, in two servers', async () => {
    const home = makeGuild('g_home', { invites: { abc: { uses: 3, maxUses: 0, inviterId: 'u1' }, xyz: { uses: 2, maxUses: 0, inviterId: 'u1' } } });
    const other = makeGuild('g_other', { invites: { qqq: { uses: 0, maxUses: 0, inviterId: 'u9' } } });
    await startWith(home, other);

    home.state.invites.abc.uses = 4;
    await inviteLoggerEvent.execute(makeMember(home, 'm1'));
    other.state.invites.qqq.uses = 1;
    await inviteLoggerEvent.execute(makeMember(other, 'm2'));

    assert.equal(home.sent.length, 1);
    const embed = home.sent[0].embeds[0];
    assert.equal(embed.title, '📨 عضو دخل');
    assert.deepEqual(home.sent[0].allowedMentions, { parse: [] });
    assert.match(descriptionOf(home), /<@m1>/);
    assert.match(descriptionOf(home), /\*\*دعاه:\*\* <@u1> \(u1\) — عنده 6 دعوة/);
    assert.match(descriptionOf(home), /`abc` \(4 استخدام\)/);
    assert.match(descriptionOf(home), /\*\*عدد الأعضاء:\*\* 42/);

    assert.equal(other.sent.length, 1);
    assert.match(descriptionOf(other), /<@u9>/);
    assert.match(descriptionOf(other), /`qqq` \(1 استخدام\)/);
  });

  test('a new invite made after startup is counted from zero (inviteCreate)', async () => {
    const guild = makeGuild('g_new_invite');
    await startWith(guild);
    const invite = { code: 'fresh', uses: 0, maxUses: 1, inviter: { id: 'u5' }, guild };
    guild.state.invites.fresh = { uses: 0, maxUses: 1, inviterId: 'u5' };
    inviteCreateEvent.execute(invite);
    delete guild.state.invites.fresh; // max uses reached: Discord deletes it as the member joins

    await inviteLoggerEvent.execute(makeMember(guild, 'm3'));
    assert.match(descriptionOf(guild), /<@u5>/);
    assert.match(descriptionOf(guild), /`fresh` \(1 استخدام\)/);
  });

  test('vanity and unknown joins are logged', async () => {
    const vanity = makeGuild('g_vanity', { vanity: { code: 'chaos', uses: 10 } });
    const unknown = makeGuild('g_unknown', { invites: { abc: { uses: 1, maxUses: 0, inviterId: 'u1' } } });
    await startWith(vanity, unknown);

    vanity.state.vanityUses = 11;
    await inviteLoggerEvent.execute(makeMember(vanity, 'm4'));
    await inviteLoggerEvent.execute(makeMember(unknown, 'm5'));

    assert.match(descriptionOf(vanity), /رابط السيرفر \(discord\.gg\/chaos\)/);
    assert.match(descriptionOf(unknown), /\*\*دعاه:\*\* غير معروف/);
    assert.match(descriptionOf(unknown), /\*\*الدعوة:\*\* غير معروفة/);
  });

  test('without Manage Server nothing is posted and nothing throws', async () => {
    const guild = makeGuild('g_noperm', { manageGuild: false });
    await startWith(guild);
    await inviteLoggerEvent.execute(makeMember(guild, 'm6'));
    assert.equal(guild.sent.length, 0);
  });

  test('bots joining are skipped', async () => {
    const guild = makeGuild('g_bot');
    await startWith(guild);
    const member = makeMember(guild, 'b1');
    member.user.bot = true;
    await inviteLoggerEvent.execute(member);
    assert.equal(guild.sent.length, 0);
  });

  test('no invite reward is registered: CC-bot pays rewards', async () => {
    const guild = makeGuild('g_reward', { invites: { abc: { uses: 0, maxUses: 0, inviterId: 'u1' } } });
    await startWith(guild);
    guild.state.invites.abc.uses = 1;
    await inviteLoggerEvent.execute(makeMember(guild, 'm7'));

    assert.equal(guild.sent.length, 1);
    assert.deepEqual(dbWrites, []);
    const source = readFileSync(new URL('../src/services/inviteTrackerService.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /inviteRewardService|registerJoin/);
  });
});
