// GH #329: the welcome and the invite note come from one bot, Aether. `welcome to <server> @member 👋` and, under it in
// the same message, who invited the member and (where the CC bot pays it) the CC bot's invite gift
// (src/events/voidWelcome.js, src/services/welcomeInviteNote.js, src/config/ccInviteGift.js). Two servers: one with the
// CC bot's level room and the CC bot in it, one without.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ChannelType, GuildMemberFlags, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import {
  CC_INVITE_GIFT, DEFAULT_CC_BOT_ID, DEFAULT_CC_LEVEL_CHANNEL_ID, ccBotId, ccLevelChannelIds, formatGiftAmount,
  inviteGiftConditions, inviteGiftEnabled,
} from '../src/config/ccInviteGift.js';
import {
  NOTE_WAIT_MS, accountCreatedAt, ccInviteGiftTracked, didRejoin, holdsCcLevelRoom, inviteNoteText, inviteVerdict,
  welcomeInviteNote,
} from '../src/services/welcomeInviteNote.js';
import { cacheGuildInvites, findUsedInvite, isCertainInvite, VANITY } from '../src/services/inviteTrackerService.js';
import { clearAuditRoomCache } from '../src/services/logging/auditRooms.js';
import welcome, { welcomePayload } from '../src/events/voidWelcome.js';
import inviteLogger from '../src/events/inviteLogger.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 24, 12);
const OLD = NOW - 400 * DAY;
const CC_BOT = DEFAULT_CC_BOT_ID;
const INVITER = '200000000000000101';
const MEMBER = '200000000000000102';
const OTHER = '200000000000000103';
const BOT_INVITER = '200000000000000900';
const GIFT_GUILD = '100000000000000011';
const PLAIN_GUILD = '100000000000000012';
const WARNING = String.fromCharCode(0x26a0, 0xfe0f);
const all = () => new PermissionsBitField(PermissionsBitField.All);

const giftLines = (memberId = MEMBER, inviterId = INVITER) => [
  `-# 📨 دعاه <@${inviterId}>`,
  `-# 🎁 <@${inviterId}> هياخد **5,000** 🌀 CC لما <@${memberId}> يوصل لفل 5 ويكتب 50 رسالة`,
].join('\n');

/** A member of the CC bot: in the server, with (or without) Manage Server. */
const ccMember = ({ manage = true, id = CC_BOT } = {}) => ({
  id, user: { id, bot: true },
  permissions: { has: (bit) => manage && bit === PermissionFlagsBits.ManageGuild },
});

/**
 * A server Aether can read the invites of (Manage Server), with a system channel for the welcome and an invites log
 * room. `levelRoom`: the CC bot's level room is in it; `cc`: the CC bot's member (cached), `ccFetch`: only fetchable.
 */
function makeGuild(id, { name = `Server ${id}`, invites = {}, vanity = null, levelRoom = false, cc = null, ccFetch = null } = {}) {
  const sent = [];
  const logs = [];
  const state = { invites: { ...invites }, vanityUses: vanity?.uses ?? 0 };
  const room = { id: `sys_${id}`, type: ChannelType.GuildText, isTextBased: () => true, permissionsFor: all, send: async (payload) => { sent.push(payload); return payload; } };
  const log = { id: `inv_${id}`, type: ChannelType.GuildText, isTextBased: () => true, permissionsFor: all, send: async (payload) => { logs.push(payload); return payload; } };
  const channels = new Map([[room.id, room], [log.id, log]]);
  if (levelRoom) channels.set(DEFAULT_CC_LEVEL_CHANNEL_ID, { id: DEFAULT_CC_LEVEL_CHANNEL_ID, guildId: id, type: ChannelType.GuildText });
  const memberCache = new Map(cc ? [[cc.id, cc]] : []);
  return {
    id, name, sent, logs, state, memberCount: 10,
    vanityURLCode: vanity?.code || null,
    systemChannel: room,
    systemChannelId: room.id,
    channels: { cache: channels },
    members: {
      me: { id: '999999999999999999', permissions: all() },
      cache: memberCache,
      fetch: async (userId) => {
        if (ccFetch && userId === ccFetch.id) return ccFetch;
        throw Object.assign(new Error('Unknown Member'), { code: 10007 });
      },
    },
    invites: {
      fetch: async () => new Map(Object.entries(state.invites).map(([code, invite]) => [code, { code, ...invite }])),
    },
    fetchVanityData: async () => ({ code: vanity?.code, uses: state.vanityUses }),
  };
}

let joins = 0;
function joiner(guild, id = MEMBER, { createdTimestamp = OLD, rejoined = false, bot = false } = {}) {
  joins += 1;
  return {
    id, guild,
    client: { users: { cache: new Map() } },
    joinedTimestamp: NOW + joins,
    flags: { has: (bit) => rejoined && bit === GuildMemberFlags.DidRejoin },
    user: { id, bot, tag: `user${id}`, createdTimestamp, displayAvatarURL: () => 'https://cdn/avatar.png' },
    toString: () => `<@${id}>`,
  };
}

async function start(...guilds) {
  process.env.AUDIT_CHANNELS_JSON = JSON.stringify(Object.fromEntries(guilds.map((guild) => [guild.id, { invites: `inv_${guild.id}` }])));
  for (const guild of guilds) assert.equal(await cacheGuildInvites(guild), true);
}

/** A join as Discord delivers it: every guildMemberAdd listener (the welcome and the join log). */
async function join(member) {
  await Promise.all([welcome.execute(member, {}), inviteLogger.execute(member, {})]);
}

describe('the CC bot\'s invite gift, as Aether tells it (config/ccInviteGift.js)', () => {
  test('the gift\'s numbers, conditions and amount are the CC bot\'s', () => {
    assert.deepEqual({ ...CC_INVITE_GIFT }, { amount: 5000, level: 5, messages: 50, minAccountAgeDays: 7 });
    assert.ok(Object.isFrozen(CC_INVITE_GIFT));
    assert.equal(inviteGiftConditions(), 'يوصل لفل 5 ويكتب 50 رسالة');
    assert.equal(formatGiftAmount(), '**5,000** 🌀 CC');
  });

  test('switched on unless CC_INVITE_GIFT_ENABLED is false; the level rooms and the CC bot\'s ID can be changed', () => {
    assert.equal(inviteGiftEnabled({}), true);
    assert.equal(inviteGiftEnabled({ CC_INVITE_GIFT_ENABLED: 'true' }), true);
    for (const off of ['false', 'FALSE', ' 0 ', 'off', 'no']) assert.equal(inviteGiftEnabled({ CC_INVITE_GIFT_ENABLED: off }), false, off);
    assert.deepEqual([...ccLevelChannelIds({})], [DEFAULT_CC_LEVEL_CHANNEL_ID]);
    assert.deepEqual([...ccLevelChannelIds({ CC_LEVEL_CHANNEL_IDS: ' 300000000000000001, x, 300000000000000002 ' })], ['300000000000000001', '300000000000000002']);
    assert.deepEqual([...ccLevelChannelIds({ CC_LEVEL_CHANNEL_IDS: 'nope' })], [DEFAULT_CC_LEVEL_CHANNEL_ID]);
    assert.equal(ccBotId({}), '1567561044472103103');
    assert.equal(ccBotId({ CC_BOT_ID: '300000000000000009' }), '300000000000000009');
    assert.equal(ccBotId({ CC_BOT_ID: 'bad' }), '1567561044472103103');
  });

  const ccRepo = new URL('../../CC-bot/', import.meta.url);
  const hasCcRepo = existsSync(new URL('src/config/cc.js', ccRepo));
  test('the same as the CC bot\'s own values (a CC-bot checkout next to this one)', { skip: hasCcRepo ? false : 'no ../CC-bot checkout' }, async () => {
    const { CC, formatCC } = await import(new URL('src/config/cc.js', ccRepo).href);
    assert.deepEqual({ ...CC.inviteReward }, { ...CC_INVITE_GIFT }, 'CC.inviteReward changed: change config/ccInviteGift.js too');
    assert.equal(formatCC(CC.inviteReward.amount), formatGiftAmount());
    const invites = readFileSync(new URL('src/config/invites.js', ccRepo), 'utf8');
    assert.equal(/DEFAULT_LEVEL_CHANNEL_ID = '(\d+)'/u.exec(invites)?.[1], DEFAULT_CC_LEVEL_CHANNEL_ID);
    const service = readFileSync(new URL('src/services/cc/inviteRewardService.js', ccRepo), 'utf8');
    assert.ok(service.includes('export const inviteConditions = () => `يوصل لفل ${CC.inviteReward.level} ويكتب ${CC.inviteReward.messages} رسالة`;'),
      'inviteConditions() changed in the CC bot: change inviteGiftConditions() too');
    // The CC bot no longer posts its own invite note under the welcome (GH #329): one message, from Aether.
    const welcomeService = readFileSync(new URL('src/services/welcomeService.js', ccRepo), 'utf8');
    assert.doesNotMatch(welcomeService, /inviteWelcomeNotice|📨/u);
  });
});

describe('which invite, without doubt (inviteTrackerService isCertainInvite)', () => {
  const counts = (entries) => new Map(Object.entries(entries));
  test('one count up is sure; two at once is not; a deleted invite only when it is the only one gone at its last use, no vanity', () => {
    const before = counts({ a: { uses: 1, maxUses: 0 }, b: { uses: 4, maxUses: 0 } });
    const oneUp = counts({ a: { uses: 2, maxUses: 0 }, b: { uses: 4, maxUses: 0 } });
    assert.equal(isCertainInvite(before, oneUp, findUsedInvite(before, oneUp)), true);
    const twoUp = counts({ a: { uses: 2, maxUses: 0 }, b: { uses: 5, maxUses: 0 } });
    assert.equal(findUsedInvite(before, twoUp).code, 'a', 'the log still names the first one');
    assert.equal(isCertainInvite(before, twoUp, findUsedInvite(before, twoUp)), false);

    const limited = counts({ a: { uses: 1, maxUses: 0 }, last: { uses: 2, maxUses: 3 } });
    const gone = counts({ a: { uses: 1, maxUses: 0 } });
    assert.equal(isCertainInvite(limited, gone, findUsedInvite(limited, gone)), true);
    assert.equal(isCertainInvite(limited, gone, findUsedInvite(limited, gone), { vanity: true }), false, 'a vanity join may come with a deletion');
    const twoGone = counts({ a: { uses: 1, maxUses: 0 }, last: { uses: 2, maxUses: 3 }, other: { uses: 0, maxUses: 0 } });
    assert.equal(isCertainInvite(twoGone, gone, findUsedInvite(twoGone, gone)), false);
    assert.equal(isCertainInvite(null, gone, null), false, 'no baseline');
    assert.equal(isCertainInvite(before, before, null), false, 'nothing changed');
  });
});

describe('who invited the member (inviteVerdict)', () => {
  const guild = { id: GIFT_GUILD, members: { cache: new Map() } };
  const sure = (inviterId = INVITER, extra = {}) => ({ used: { code: 'abc', uses: 2, inviterId, ...extra }, certain: true });
  test('a real member\'s invite counts; a rejoin or an account younger than 7 days does not', () => {
    assert.deepEqual(inviteVerdict(joiner(guild), sure(), { now: NOW }), { inviterId: INVITER, reason: null });
    assert.deepEqual(inviteVerdict(joiner(guild, MEMBER, { rejoined: true }), sure(), { now: NOW }), { inviterId: INVITER, reason: 'rejoin' });
    assert.deepEqual(inviteVerdict(joiner(guild, MEMBER, { createdTimestamp: NOW - 2 * DAY }), sure(), { now: NOW }), { inviterId: INVITER, reason: 'fake' });
    assert.deepEqual(inviteVerdict(joiner(guild, MEMBER, { createdTimestamp: NOW - 8 * DAY }), sure(), { now: NOW }), { inviterId: INVITER, reason: null });
    assert.deepEqual(inviteVerdict(joiner(guild, MEMBER, { rejoined: true, createdTimestamp: NOW - DAY }), sure(), { now: NOW }).reason, 'rejoin', 'a rejoin first, like the CC bot');
  });

  test('nobody for an unknown, unsure or vanity join, their own invite, a bot\'s invite or a bad ID', () => {
    const member = joiner(guild);
    assert.equal(inviteVerdict(member, null), null);
    assert.equal(inviteVerdict(member, { used: null, certain: false }), null);
    assert.equal(inviteVerdict(member, { ...sure(), certain: false }), null);
    assert.equal(inviteVerdict(member, { used: { code: VANITY, inviterId: null }, certain: true }), null);
    assert.equal(inviteVerdict(member, sure(null)), null);
    assert.equal(inviteVerdict(member, sure(MEMBER)), null);
    assert.equal(inviteVerdict(member, sure('abc')), null);
    assert.equal(inviteVerdict(member, sure(BOT_INVITER, { inviterBot: true })), null);
    const cached = { id: GIFT_GUILD, members: { cache: new Map([[BOT_INVITER, { user: { id: BOT_INVITER, bot: true } }]]) } };
    assert.equal(inviteVerdict(joiner(cached), sure(BOT_INVITER)), null, 'a bot known from the cache');
  });

  test('DidRejoin and the account age, from the member', () => {
    assert.equal(didRejoin({ flags: { has: (bit) => bit === GuildMemberFlags.DidRejoin } }), true);
    assert.equal(didRejoin({ flags: { bitfield: GuildMemberFlags.DidRejoin } }), true);
    assert.equal(didRejoin({ flags: 0 }), false);
    assert.equal(didRejoin({}), false);
    assert.equal(accountCreatedAt({ user: { createdTimestamp: OLD } }), OLD);
    assert.equal(accountCreatedAt({ id: '175928847299117063', user: {} }), Date.UTC(2016, 3, 30, 11, 18, 25, 796));
  });
});

describe('where the CC bot pays the gift (ccInviteGiftTracked)', () => {
  test('its level room in the server and the CC bot there with Manage Server', async () => {
    assert.equal(await ccInviteGiftTracked(makeGuild(GIFT_GUILD, { levelRoom: true, cc: ccMember() }), { env: {} }), true);
    assert.equal(await ccInviteGiftTracked(makeGuild(GIFT_GUILD, { levelRoom: true, ccFetch: ccMember() }), { env: {} }), true, 'fetched when not cached');
  });

  test('not when switched off, without the level room, without the CC bot, or when it can\'t read the invites', async () => {
    assert.equal(await ccInviteGiftTracked(makeGuild(GIFT_GUILD, { levelRoom: true, cc: ccMember() }), { env: { CC_INVITE_GIFT_ENABLED: 'false' } }), false);
    assert.equal(await ccInviteGiftTracked(makeGuild(PLAIN_GUILD, { cc: ccMember() }), { env: {} }), false);
    assert.equal(await ccInviteGiftTracked(makeGuild(GIFT_GUILD, { levelRoom: true }), { env: {} }), false);
    assert.equal(await ccInviteGiftTracked(makeGuild(GIFT_GUILD, { levelRoom: true, cc: ccMember({ manage: false }) }), { env: {} }), false);
    assert.equal(await ccInviteGiftTracked(makeGuild(GIFT_GUILD, { levelRoom: true, cc: ccMember() }), { env: { CC_LEVEL_CHANNEL_IDS: '300000000000000001' } }), false);
    assert.equal(await ccInviteGiftTracked(null), false);
  });

  test('a level room of another server, seen in the client\'s cache, does not count', () => {
    const guild = { id: PLAIN_GUILD, channels: { cache: new Map() }, client: { channels: { cache: new Map([[DEFAULT_CC_LEVEL_CHANNEL_ID, { guildId: GIFT_GUILD }]]) } } };
    assert.equal(holdsCcLevelRoom(guild, {}), false);
    guild.client.channels.cache.set(DEFAULT_CC_LEVEL_CHANNEL_ID, { guildId: PLAIN_GUILD });
    assert.equal(holdsCcLevelRoom(guild, {}), true);
  });
});

describe('the note under the welcome (inviteNoteText)', () => {
  test('with the gift: who invited and what they get, or why it does not count; the CC bot\'s own words', () => {
    assert.equal(inviteNoteText(MEMBER, { inviterId: INVITER, reason: null }, { gift: true }), giftLines());
    assert.equal(inviteNoteText(MEMBER, { inviterId: INVITER, reason: 'fake' }, { gift: true }), `-# 📨 دعاه <@${INVITER}>\n-# ${WARNING} الدعوة دي مش محسوبة: الحساب عمره أقل من 7 أيام`);
    assert.equal(inviteNoteText(MEMBER, { inviterId: INVITER, reason: 'rejoin' }, { gift: true }), `-# 📨 دعاه <@${INVITER}>\n-# ${WARNING} الدعوة دي مش محسوبة: <@${MEMBER}> كان في السيرفر قبل كده`);
  });

  test('without the gift: only who invited; nothing without an inviter', () => {
    for (const reason of [null, 'fake', 'rejoin']) assert.equal(inviteNoteText(MEMBER, { inviterId: INVITER, reason }), `-# 📨 دعاه <@${INVITER}>`, String(reason));
    assert.equal(inviteNoteText(MEMBER, null, { gift: true }), null);
  });

  test('the welcome never waits more than a moment for it', async () => {
    const guild = makeGuild(GIFT_GUILD, { levelRoom: true, cc: ccMember() });
    const started = Date.now();
    assert.equal(await welcomeInviteNote(joiner(guild), new Promise(() => {}), { env: {}, waitMs: 30 }), null);
    assert.ok(Date.now() - started < 1000);
    assert.ok(NOTE_WAIT_MS <= 5000);
    assert.equal(await welcomeInviteNote(joiner(guild), Promise.reject(new Error('down')), { env: {} }), null);
  });

  test('the payload: one message; only the member and the inviter can be pinged', () => {
    const guild = { id: GIFT_GUILD, name: 'Zen @everyone **x**' };
    const member = { id: MEMBER, guild, client: {} };
    assert.deepEqual(welcomePayload(member), { content: `welcome to Zen \\@everyone \\*\\*x\\*\\* <@${MEMBER}> 👋`, allowedMentions: { users: [MEMBER] } });
    const note = { inviterId: INVITER, text: giftLines() };
    assert.deepEqual(welcomePayload(member, note), {
      content: `welcome to Zen \\@everyone \\*\\*x\\*\\* <@${MEMBER}> 👋\n${giftLines()}`,
      allowedMentions: { users: [MEMBER, INVITER] },
    });
  });
});

describe('a member joining (voidWelcome + the join log), in two servers', () => {
  beforeEach(() => {
    clearAuditRoomCache();
    delete process.env.CC_INVITE_GIFT_ENABLED;
    delete process.env.CC_LEVEL_CHANNEL_IDS;
  });

  test('where the CC bot pays the gift: one welcome with who invited and the gift; the join log once', async () => {
    const guild = makeGuild(GIFT_GUILD, { name: 'CHAOS', levelRoom: true, cc: ccMember(), invites: { abc: { uses: 3, maxUses: 0, inviter: { id: INVITER, bot: false } } } });
    await start(guild);
    guild.state.invites.abc.uses = 4;
    await join(joiner(guild));
    assert.equal(guild.sent.length, 1, 'one message');
    assert.equal(guild.sent[0].content, `welcome to CHAOS <@${MEMBER}> 👋\n${giftLines()}`);
    assert.deepEqual(guild.sent[0].allowedMentions, { users: [MEMBER, INVITER] });
    assert.equal(guild.logs.length, 1, 'the join is logged once');
    assert.match(guild.logs[0].embeds[0].description, new RegExp(`<@${INVITER}>`, 'u'));
  });

  test('a server without the CC bot\'s gift: who invited, no gift line', async () => {
    const guild = makeGuild(PLAIN_GUILD, { name: 'Zenith', invites: { qqq: { uses: 0, maxUses: 0, inviter: { id: OTHER, bot: false } } } });
    await start(guild);
    guild.state.invites.qqq.uses = 1;
    await join(joiner(guild, MEMBER));
    assert.deepEqual(guild.sent.map((payload) => payload.content), [`welcome to Zenith <@${MEMBER}> 👋\n-# 📨 دعاه <@${OTHER}>`]);
    assert.deepEqual(guild.sent[0].allowedMentions, { users: [MEMBER, OTHER] });
  });

  test('the gift switched off here, or the CC bot gone from the server: no gift line', async () => {
    process.env.CC_INVITE_GIFT_ENABLED = 'false';
    const off = makeGuild(GIFT_GUILD, { name: 'CHAOS', levelRoom: true, cc: ccMember(), invites: { abc: { uses: 0, maxUses: 0, inviter: { id: INVITER } } } });
    await start(off);
    off.state.invites.abc.uses = 1;
    await join(joiner(off));
    assert.equal(off.sent[0].content, `welcome to CHAOS <@${MEMBER}> 👋\n-# 📨 دعاه <@${INVITER}>`);

    delete process.env.CC_INVITE_GIFT_ENABLED;
    const gone = makeGuild(GIFT_GUILD, { name: 'CHAOS', levelRoom: true, invites: { abc: { uses: 0, maxUses: 0, inviter: { id: INVITER } } } });
    await start(gone);
    gone.state.invites.abc.uses = 1;
    await join(joiner(gone));
    assert.equal(gone.sent[0].content, `welcome to CHAOS <@${MEMBER}> 👋\n-# 📨 دعاه <@${INVITER}>`);
  });

  test('a fake account or a rejoin: the invite does not count', async () => {
    const guild = makeGuild(GIFT_GUILD, { name: 'CHAOS', levelRoom: true, cc: ccMember(), invites: { abc: { uses: 0, maxUses: 0, inviter: { id: INVITER } } } });
    await start(guild);
    guild.state.invites.abc.uses = 1;
    await join(joiner(guild, MEMBER, { createdTimestamp: Date.now() - DAY }));
    guild.state.invites.abc.uses = 2;
    await join(joiner(guild, OTHER, { rejoined: true }));
    assert.deepEqual(guild.sent.map((payload) => payload.content), [
      `welcome to CHAOS <@${MEMBER}> 👋\n-# 📨 دعاه <@${INVITER}>\n-# ${WARNING} الدعوة دي مش محسوبة: الحساب عمره أقل من 7 أيام`,
      `welcome to CHAOS <@${OTHER}> 👋\n-# 📨 دعاه <@${INVITER}>\n-# ${WARNING} الدعوة دي مش محسوبة: <@${OTHER}> كان في السيرفر قبل كده`,
    ]);
  });

  test('the welcome alone: vanity link, an unknown invite, their own or a bot\'s invite, two invites at once, no Manage Server', async () => {
    const guild = makeGuild(GIFT_GUILD, {
      name: 'CHAOS', levelRoom: true, cc: ccMember(), vanity: { code: 'chaos', uses: 5 },
      invites: { own: { uses: 0, maxUses: 0, inviter: { id: MEMBER } }, bot: { uses: 0, maxUses: 0, inviter: { id: BOT_INVITER, bot: true } }, a: { uses: 0, maxUses: 0, inviter: { id: INVITER } }, b: { uses: 0, maxUses: 0, inviter: { id: OTHER } } },
    });
    await start(guild);
    const plain = (id) => `welcome to CHAOS <@${id}> 👋`;
    guild.state.vanityUses = 6;
    await join(joiner(guild, '200000000000000201'));
    await join(joiner(guild, '200000000000000202'));
    guild.state.invites.own.uses = 1;
    await join(joiner(guild, MEMBER));
    guild.state.invites.bot.uses = 1;
    await join(joiner(guild, '200000000000000203'));
    guild.state.invites.a.uses = 1;
    guild.state.invites.b.uses = 1;
    await join(joiner(guild, '200000000000000204'));
    assert.deepEqual(guild.sent.map((payload) => payload.content), [
      plain('200000000000000201'), plain('200000000000000202'), plain(MEMBER), plain('200000000000000203'), plain('200000000000000204'),
    ]);
    for (const payload of guild.sent) assert.equal(payload.allowedMentions.users.length, 1);

    const closed = makeGuild(PLAIN_GUILD, { name: 'Closed', invites: { a: { uses: 0, maxUses: 0, inviter: { id: INVITER } } } });
    closed.members.me = { id: '999999999999999999', permissions: new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]) };
    closed.state.invites.a.uses = 1;
    await join(joiner(closed));
    assert.deepEqual(closed.sent.map((payload) => payload.content), [`welcome to Closed <@${MEMBER}> 👋`]);
  });

  test('a bot joining gets nothing', async () => {
    const guild = makeGuild(GIFT_GUILD, { levelRoom: true, cc: ccMember(), invites: { abc: { uses: 0, maxUses: 0, inviter: { id: INVITER } } } });
    await start(guild);
    guild.state.invites.abc.uses = 1;
    await join(joiner(guild, BOT_INVITER, { bot: true }));
    assert.equal(guild.sent.length, 0);
  });
});
