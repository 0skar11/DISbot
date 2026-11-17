import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildStorePanel } from '../src/services/cc/storeUi.js';
import { holdingsEmbed, pricesEmbed } from '../src/services/cc/bourseUi.js';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import { CHAOS_GUILD_ID, WELCOME_CHANNEL_ID } from '../src/config/inviteRewards.js';
import welcome from '../src/events/voidWelcome.js';
import { PermissionsBitField } from 'discord.js';

describe('balance on متجر and ممتلكاتي (report #174)', () => {
  test('the store panel shows the member\'s balance only when given', () => {
    const guild = { id: HOME_GUILD_ID };
    assert.match(buildStorePanel(guild, { balance: 12345 }).embeds[0].description, /💰 رصيدك: \*\*12,345\*\*/u);
    assert.doesNotMatch(buildStorePanel(guild).embeds[0].description || '', /رصيدك/u);
  });

  test('prices: the balance replaces the 🔥 demand mark and its legend; without a balance nothing changes', () => {
    const asset = { emoji: '🚗', name: 'عربية' };
    const market = { quotes: [{ asset, price: 1300, changePercent: 2, raised: true }], nextChangeAt: Date.now() + 1000 };
    const ours = pricesEmbed(market, { balance: 12345 });
    assert.equal(ours.footer.text.includes('🔥'), false);
    assert.match(ours.footer.text, /💰 رصيدك: 12,345 CC/u);
    assert.equal(ours.fields[0].value.includes('🔥'), false);
    const old = pricesEmbed(market);
    assert.match(old.footer.text, /🔥 = عليها طلب/u);
    assert.match(old.fields[0].value, /🔥/u);
  });

  test('holdings show the balance, with or without assets', () => {
    const user = { toString: () => '<@u>' };
    const empty = holdingsEmbed(user, { rows: [], totalValue: 0, totalPaid: 0, totalIfSold: 0 }, { balance: 500 });
    assert.equal(empty.fields.at(-1).name, '💰 رصيدك');
    const asset = { emoji: '🚗', name: 'عربية' };
    const full = holdingsEmbed(user, { rows: [{ asset, qty: 1, paid: 1000, value: 1100, ifSold: 1080, profit: 80 }], totalValue: 1100, totalPaid: 1000, totalIfSold: 1080 }, { balance: 42 });
    assert.match(full.fields.at(-1).value, /42/u);
    assert.ok(!holdingsEmbed(user, { rows: [], totalValue: 0, totalPaid: 0, totalIfSold: 0 }).fields);
  });
});

describe('welcome message (report #175)', () => {
  test('uses the bot\'s own copy of the emoji, uploaded once, or 👋 until then (report #177)', async () => {
    const { ensureWelcomeEmoji, getWelcomeEmoji, WELCOME_EMOJI_URL } = await import('../src/services/welcomeEmojiService.js');
    assert.equal(getWelcomeEmoji({}), '👋');
    const created = [];
    const store = new Map();
    const client = { application: { emojis: {
      cache: store,
      fetch: async () => store,
      create: async ({ attachment, name }) => { created.push(attachment); const e = { name, toString: () => '<a:smileywave:999>' }; store.set('999', e); return e; },
    } } };
    assert.equal(await ensureWelcomeEmoji(client), '<a:smileywave:999>');
    assert.equal(await ensureWelcomeEmoji(client), '<a:smileywave:999>');
    assert.deepEqual(created, [WELCOME_EMOJI_URL]);
    assert.equal(getWelcomeEmoji(client), '<a:smileywave:999>');
  });

  test('ends with the waving emoji', async () => {
    const sent = [];
    const channel = { isTextBased: () => true, permissionsFor: () => new PermissionsBitField(PermissionsBitField.All), send: async (payload) => { sent.push(payload); } };
    const member = {
      id: '200000000000000001',
      toString: () => '<@200000000000000001>',
      user: { bot: false, tag: 'new' },
      guild: { id: CHAOS_GUILD_ID, members: { me: {} }, channels: { cache: new Map([[WELCOME_CHANNEL_ID, channel]]) }, invites: { fetch: async () => new Map() } },
    };
    await welcome.execute(member);
    assert.equal(sent[0].content, 'welcome to chaos <@200000000000000001> <a:smileywave:999>');
  });

  test('Zenith gets welcome in its own room, escapes name and pings only member', async () => {
    const ZENITH = '1569932761471524874';
    const ZENITH_WELCOME = '1570728122259611779';
    const sent = [];
    const room = { id: ZENITH_WELCOME, isTextBased: () => true, permissionsFor: () => new PermissionsBitField(PermissionsBitField.All), send: async (p) => { sent.push(p); } };
    const member = {
      id: '200000000000000002',
      user: { bot: false, tag: 'zenith_user' },
      guild: {
        id: ZENITH,
        name: 'Zenith **Club** @everyone',
        members: { me: {} },
        channels: { cache: new Map([[ZENITH_WELCOME, room]]) },
      },
    };
    await welcome.execute(member);
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /^welcome to Zenith \\\*\\\*Club\\\*\\\* \\@everyone <@200000000000000002>/);
    assert.deepEqual(sent[0].allowedMentions, { users: ['200000000000000002'] });

    // Bots skipped
    sent.length = 0;
    await welcome.execute({ ...member, user: { bot: true } });
    assert.equal(sent.length, 0);
  });

  test('falls back to system channel, then text channel named welcome', async () => {
    const OTHER_GUILD = '100000000000000999';
    const sentSystem = [];
    const systemRoom = { id: 'sys1', isTextBased: () => true, permissionsFor: () => new PermissionsBitField(PermissionsBitField.All), send: async (p) => { sentSystem.push(p); } };
    const member = {
      id: '200000000000000003',
      user: { bot: false },
      guild: {
        id: OTHER_GUILD,
        name: 'Other',
        members: { me: {} },
        systemChannelId: 'sys1',
        systemChannel: systemRoom,
        channels: { cache: new Map([['sys1', systemRoom]]) },
      },
    };
    await welcome.execute(member);
    assert.equal(sentSystem.length, 1);
    assert.match(sentSystem[0].content, /^welcome to Other <@200000000000000003>/);

    // Named welcome channel fallback
    const sentNamed = [];
    const namedRoom = { id: 'named1', name: '👋・welcome', isTextBased: () => true, permissionsFor: () => new PermissionsBitField(PermissionsBitField.All), send: async (p) => { sentNamed.push(p); } };
    const member2 = {
      id: '200000000000000004',
      user: { bot: false },
      guild: {
        id: OTHER_GUILD,
        name: 'NamedServer',
        members: { me: {} },
        systemChannel: null,
        channels: { cache: new Map([['named1', namedRoom]]) },
      },
    };
    await welcome.execute(member2);
    assert.equal(sentNamed.length, 1);
    assert.match(sentNamed[0].content, /^welcome to NamedServer <@200000000000000004>/);
  });
});
