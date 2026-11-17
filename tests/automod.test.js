import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import { SERVER_OWNER_IDS, isServerOwner } from '../src/config/serverOwners.js';
import { getGuildConfigKey } from '../src/utils/database.js';
import { checkText } from '../src/services/moderation/chatFilterRules.js';
import { handleChatFilter } from '../src/services/moderation/chatFilterService.js';
import { clearRepeats } from '../src/services/moderation/chatFilterRepeats.js';
import {
  AUTOMOD_KEY, MAX_CUSTOM_WORDS, addAutomodWord, enableAutomodWord, getAutomodState, loadAutomodRules, removeAutomodWord,
  resetAutomodStore,
} from '../src/services/moderation/automodStore.js';
import {
  AUTOMOD_BUTTON, AUTOMOD_FORM, ROOM_REPLY_DELETE_MS, automodListPayload, automodPages, handleAutomodButton, handleAutomodForm,
  handleAutomodMessage, parseAutomod,
} from '../src/services/moderation/automodCommand.js';
import { handlePrefixCommand } from '../src/events/messageCreate.js';
import automodButton from '../src/interactions/buttons/moderation/automod.js';
import automodForm from '../src/interactions/modals/moderation/automod.js';

const OWNER = '1159601661392715906';
const TRUST_MANAGER = '626263734704275487';
const MEMBER = '200000000000000301';
const AUDIT_ROOM = '300000000000000301';
const ROOM = '300000000000000302';
const OTHER_GUILD = '100000000000000099';

function setup({ guildId = HOME_GUILD_ID, dmOpen = true, db = {} } = {}) {
  const store = new Map([[getGuildConfigKey(guildId), { prefix: '!', auditChannels: { automode: AUDIT_ROOM } }]]);
  const sent = { room: [], dm: [], audit: [] };
  const client = {
    user: { id: 'bot', bot: true },
    commands: new Map(),
    guilds: { cache: new Map() },
    channels: { cache: new Map(), fetch: async () => null },
    db: {
      get: async (key, fallback) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
      set: async (key, value) => { store.set(key, structuredClone(value)); return true; },
      ...db,
    },
  };
  const audit = { id: AUDIT_ROOM, type: 0, isTextBased: () => true, send: async (payload) => { sent.audit.push(payload); return { id: 'a' }; } };
  const guild = {
    id: guildId, name: 'Home', ownerId: '1', client,
    channels: { cache: new Map([[AUDIT_ROOM, audit]]), fetch: async () => null },
    members: { me: null, fetch: async () => null, cache: new Map() },
    roles: { cache: new Map(), everyone: { id: guildId } },
  };
  client.guilds.cache.set(guildId, guild);
  const channel = {
    id: ROOM, guild,
    send: async (payload) => {
      const msg = { ...payload, deleted: false, delete: async () => { msg.deleted = true; } };
      sent.room.push(msg);
      return msg;
    },
  };
  const user = (id) => ({
    id, tag: `user${id.slice(-3)}`, username: `user${id.slice(-3)}`, bot: false,
    send: async (payload) => {
      if (!dmOpen) throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
      sent.dm.push(payload);
      return { id: `dm${sent.dm.length}` };
    },
  });
  const message = (content, authorId = OWNER) => {
    const msg = {
      id: String(Math.random()), content, guild, channel, channelId: ROOM, client, author: user(authorId),
      member: { id: authorId, roles: { cache: new Map() }, permissions: { has: () => false } },
      reference: null, fetchReference: async () => null, deleted: false,
    };
    msg.delete = async () => { msg.deleted = true; };
    return msg;
  };
  const interaction = (customId, userId = OWNER, { fields = {}, select = {}, fromMessage = true } = {}) => {
    const it = {
      customId, user: user(userId), guild: null, guildId: null, replies: [], updates: [], modals: [], edits: [],
      reply: async (payload) => { it.replies.push(payload); },
      update: async (payload) => { it.updates.push(payload); },
      showModal: async (modal) => { it.modals.push(modal); },
      fields: {
        getTextInputValue: (id) => { if (!(id in fields)) throw new Error('no field'); return fields[id]; },
        getStringSelectValues: (id) => select[id] || [],
      },
      message: fromMessage ? { edit: async (payload) => { it.edits.push(payload); } } : null,
    };
    return it;
  };
  const press = (customId, userId, options) => {
    const it = interaction(customId, userId, options);
    const [name, ...args] = customId.split(':');
    const handler = name === AUTOMOD_BUTTON ? handleAutomodButton : handleAutomodForm;
    return handler(it, client, args).then(() => it);
  };
  return { client, guild, channel, store, sent, message, press };
}

describe('automod store', () => {
  beforeEach(() => resetAutomodStore());

  test('add / remove a word: saved, applied at once, normalized duplicates and bad words refused', async () => {
    const { client, store } = setup();
    assert.deepEqual(await loadAutomodRules(client), { loaded: true, custom: 0, disabled: 0 });
    const added = await addAutomodWord(client, { word: 'كلب', rule: 'insult', by: OWNER, now: 5 });
    assert.equal(added.ok, true);
    assert.equal(added.saved, true);
    assert.deepEqual(store.get(AUTOMOD_KEY).custom, [{ word: 'كلب', rule: 'insult', addedBy: OWNER, at: 5 }]);
    assert.equal(checkText('يا ك.ل.ب'), 'insult');
    assert.equal(checkText('ya kalb'), 'insult');

    const refused = async (word, rule = 'insult') => (await addAutomodWord(client, { word, rule, by: OWNER })).reason;
    assert.equal(await refused('كـلـب'), 'duplicate', 'same word once normalized');
    assert.equal(await refused('K.A.L.B'.toLowerCase()), 'already', 'its franco spelling is already caught');
    assert.equal(await refused('ك'), 'length');
    assert.equal(await refused('ا'.repeat(31)), 'length');
    assert.equal(await refused('https://x.com/a'), 'link');
    assert.equal(await refused('<@200000000000000001>'), 'link');
    assert.equal(await refused('@everyone'), 'link');
    assert.equal(await refused('the'), 'common');
    assert.equal(await refused('في'), 'common');
    assert.equal(await refused('...'), 'empty');
    assert.equal(await refused('شرموط'), 'builtin');
    assert.equal(await refused('fuck'), 'builtin');
    assert.equal(await refused('كسمك'), 'already');
    assert.equal(await refused('حمار', 'nope'), 'rule');
    assert.equal(await refused('جزمة', 'ibnAl'), 'builtin', 'already an ibn al completion');

    const removed = await removeAutomodWord(client, { word: 'كلب' });
    assert.equal(removed.kind, 'custom');
    assert.equal(checkText('يا كلب'), null);
    assert.deepEqual(store.get(AUTOMOD_KEY).custom, []);
    // Once the owner word is gone, the same word names the built-in "ابن الكلب" completion.
    const builtIn = await removeAutomodWord(client, { word: 'كلب' });
    assert.deepEqual([builtIn.kind, builtIn.builtIn.list], ['disabled', 'ibnAl']);
    assert.equal(checkText('ابن الكلب'), null);
    assert.equal((await enableAutomodWord(client, { word: 'كلب' })).ok, true);
    assert.equal(checkText('ابن الكلب'), 'ibnAl');
    assert.equal((await removeAutomodWord(client, { word: 'قطقوطة' })).reason, 'not_found');
  });

  test('built-in list words are switched off and back on; the regex families are read-only', async () => {
    const { client, store } = setup();
    await loadAutomodRules(client);
    const off = await removeAutomodWord(client, { word: 'طيز' });
    assert.equal(off.kind, 'disabled');
    assert.deepEqual(off.builtIn, { list: 'insult', word: 'طيز', words: ['طيز'] });
    assert.ok(off.related.includes('teez'), 'the other spellings that stay on are named');
    assert.equal(checkText('طيز'), null);
    assert.equal(checkText('طيز', { legacy: true }), 'insult', 'other servers keep it');
    assert.deepEqual(store.get(AUTOMOD_KEY).disabled, ['طيز']);
    assert.equal((await removeAutomodWord(client, { word: 'طيز' })).reason, 'already_off');
    assert.equal((await removeAutomodWord(client, { word: 'كسمك' })).reason, 'readonly');
    assert.equal((await removeAutomodWord(client, { word: 'ميتين امك' })).reason, 'readonly');
    assert.equal((await removeAutomodWord(client, { word: 'fvck' })).builtIn.word, 'fuck', 'an English spelling switches its entry off');
    assert.equal(checkText('fuck'), null);
    // A switched-off word can come back as an owner word with another rule.
    const moved = await addAutomodWord(client, { word: 'طيز', rule: 'banned', by: OWNER });
    assert.equal(moved.ok, true);
    assert.equal(checkText('طيز'), 'banned');
    await removeAutomodWord(client, { word: 'طيز' });
    assert.equal((await enableAutomodWord(client, { word: 'طيز' })).ok, true);
    assert.equal(checkText('طيز'), 'insult');
    assert.equal((await enableAutomodWord(client, { word: 'طيز' })).reason, 'not_off');
  });

  test('saved edits come back after a restart; garbage in the database is ignored', async () => {
    const { client, store } = setup();
    await loadAutomodRules(client);
    await addAutomodWord(client, { word: 'حمار', rule: 'family', by: OWNER });
    await removeAutomodWord(client, { word: 'teez' });
    resetAutomodStore();
    assert.equal(checkText('حمار'), null, 'forgotten in memory');
    const saved = store.get(AUTOMOD_KEY);
    assert.deepEqual(saved.disabled, ['teez', 'tez'], '"teez" and "tez" go off together');
    store.set(AUTOMOD_KEY, { custom: [...saved.custom, null, { word: 5 }, { word: 'x y', rule: 'nope' }], disabled: [...saved.disabled, 'not-a-built-in', 5] });
    assert.deepEqual(await loadAutomodRules(client), { loaded: true, custom: 1, disabled: 2 });
    assert.equal(checkText('7mar'), 'family');
    assert.equal(checkText('teez'), null);
    assert.equal(checkText('طيز'), 'insult', 'only the franco spellings were switched off');
    assert.deepEqual(getAutomodState().disabled, ['teez', 'tez']);
  });

  test(`at most ${MAX_CUSTOM_WORDS} owner words`, async () => {
    const { client, store } = setup();
    const letters = 'بتثجحخدذرزسشصضطظعغفقلمن';
    const words = [];
    for (let i = 0; words.length < MAX_CUSTOM_WORDS + 3; i += 1) {
      words.push(`${letters[i % 24]}${letters[Math.floor(i / 24) % 24]}${letters[Math.floor(i / 576) % 24]}ظظ${i}`.replace(/\d/gu, (d) => letters[d]));
    }
    store.set(AUTOMOD_KEY, { custom: words.map((word) => ({ word, rule: 'banned', addedBy: OWNER, at: 1 })), disabled: [] });
    assert.equal((await loadAutomodRules(client)).custom, MAX_CUSTOM_WORDS);
    assert.equal((await addAutomodWord(client, { word: 'حمار', rule: 'insult', by: OWNER })).reason, 'full');
  });

  test('a failed save never breaks the filter; an unread list is never overwritten', async () => {
    const failing = setup({ db: { set: async () => false } });
    await loadAutomodRules(failing.client);
    const added = await addAutomodWord(failing.client, { word: 'حمار', rule: 'insult', by: OWNER });
    assert.equal(added.ok, true);
    assert.equal(added.saved, false);
    assert.equal(checkText('حمار'), 'insult', 'still works from memory');

    resetAutomodStore();
    const throwing = setup({ db: { set: async () => { throw new Error('down'); } } });
    await loadAutomodRules(throwing.client);
    assert.equal((await addAutomodWord(throwing.client, { word: 'حمار', rule: 'insult', by: OWNER })).saved, false);

    resetAutomodStore();
    let broken = true;
    const writes = [];
    const unreadable = setup({ db: {
      getStrict: async () => { if (broken) throw new Error('connection reset'); return { custom: [{ word: 'قرد', rule: 'insult' }], disabled: [] }; },
      isAvailable: () => true, isDegraded: () => false,
      set: async (key, value) => { writes.push(value); return true; },
    } });
    assert.equal((await loadAutomodRules(unreadable.client)).loaded, false);
    assert.equal(checkText('كسمك'), 'family', 'the built-in lists keep working');
    assert.equal((await addAutomodWord(unreadable.client, { word: 'حمار', rule: 'insult', by: OWNER })).reason, 'not_loaded');
    assert.equal(writes.length, 0, 'nothing written over the saved list');
    broken = false;
    const retried = await addAutomodWord(unreadable.client, { word: 'حمار', rule: 'insult', by: OWNER });
    assert.equal(retried.ok, true, 'the next edit reads the list first');
    assert.deepEqual(writes.at(-1).custom.map((entry) => entry.word), ['قرد', 'حمار']);
  });
});

describe('automod punishments follow the chosen rule (our server)', () => {
  beforeEach(() => {
    resetAutomodStore();
    clearRepeats();
  });

  function chat(content, guild, authorId = '200000000000000377') {
    const calls = [];
    const member = { id: authorId };
    const message = {
      content, guild: { ...guild, members: { me: { id: 'bot' }, fetch: async () => member } }, member,
      author: { id: authorId, bot: false }, client: { user: { id: 'bot' } }, channel: { id: ROOM, send: async (p) => { calls.push(['notice', p.content]); return { delete: async () => {} }; } },
      delete: async () => calls.push(['delete']),
    };
    return { calls, message };
  }

  test('family: deleted, a warning on the 3rd hit; insult / ibnAl: a warning every time; banned: deleted only', async () => {
    const { client, guild } = setup();
    await loadAutomodRules(client);
    for (const [word, rule] of [['حمار', 'family'], ['قرد', 'insult'], ['بقرة', 'ibnAl'], ['سبونج', 'banned']]) {
      assert.equal((await addAutomodWord(client, { word, rule, by: OWNER })).ok, true, word);
    }
    const warned = [];
    const warn = async ({ member }) => { warned.push(member.id); return { totalCount: warned.length, timeoutApplied: false }; };
    const send = async (content, now = 1_000_000) => {
      const fixture = chat(content, guild);
      const handled = await handleChatFilter(fixture.message, { warn, now });
      return { handled, ...fixture };
    };
    for (let i = 0; i < 2; i += 1) assert.equal((await send('يا 7mar', 1_000_000 + i)).handled, true);
    assert.equal(warned.length, 0, 'family: quiet until the 3rd');
    await send('حمار', 1_000_010);
    assert.equal(warned.length, 1);
    await send('يا قرد');
    assert.equal(warned.length, 2);
    await send('ebn el ba2ara');
    assert.equal(warned.length, 3);
    assert.equal((await send('بقرة')).handled, false, 'ibnAl words alone are fine');
    const banned = await send('س.ب.و.ن.ج');
    assert.deepEqual(banned.calls[0], ['delete']);
    assert.equal(warned.length, 3, 'banned: no warning');

    // Another server keeps the old filter: no owner words, no English.
    const other = setup({ guildId: OTHER_GUILD });
    assert.equal(await handleChatFilter(chat('يا قرد', other.guild).message, { warn }), false);
    assert.equal(await handleChatFilter(chat('fuck you', other.guild).message, { warn }), false);
    assert.equal(await handleChatFilter(chat('fuck you', guild).message, { warn }), true);
    // Owners stay exempt.
    assert.equal(await handleChatFilter(chat('يا قرد', guild, OWNER).message, { warn }), false);
  });
});

describe('the automod command', () => {
  beforeEach(() => resetAutomodStore());

  test('typed forms: automod, !automod, .automod, اوتومود; anything else is not the command', () => {
    assert.deepEqual(parseAutomod('automod'), { sub: 'list', rule: null, text: '' });
    assert.deepEqual(parseAutomod('!automod'), { sub: 'list', rule: null, text: '' });
    assert.deepEqual(parseAutomod('.AutoMod'), { sub: 'list', rule: null, text: '' });
    assert.deepEqual(parseAutomod('اوتومود'), { sub: 'list', rule: null, text: '' });
    assert.deepEqual(parseAutomod('automod add عيلة كس اختك'), { sub: 'add', rule: 'family', text: 'كس اختك' });
    assert.deepEqual(parseAutomod('automod add ابن البقرة'), { sub: 'add', rule: 'ibnAl', text: 'البقرة' });
    assert.deepEqual(parseAutomod('automod add ممنوع سبونج'), { sub: 'add', rule: 'banned', text: 'سبونج' });
    assert.deepEqual(parseAutomod('automod add حمار'), { sub: 'add', rule: 'insult', text: 'حمار' });
    assert.deepEqual(parseAutomod('automod remove kalb'), { sub: 'remove', rule: null, text: 'kalb' });
    assert.deepEqual(parseAutomod('automod test يا كلب يا حمار'), { sub: 'test', rule: null, text: 'يا كلب يا حمار' });
    assert.equal(parseAutomod('automod blabla').sub, 'usage');
    for (const text of ['automodx', 'the automod', 'auto mod', 'hello', '']) assert.equal(parseAutomod(text), null, text);
  });

  test('owners (the trust manager is an owner too) get the list in DM; the typed command leaves the room', async () => {
    assert.ok(isServerOwner(TRUST_MANAGER) && SERVER_OWNER_IDS.includes(TRUST_MANAGER));
    for (const owner of [OWNER, TRUST_MANAGER]) {
      const { message, sent } = setup();
      const typed = message('automod', owner);
      assert.equal(await handleAutomodMessage(typed), true);
      assert.equal(typed.deleted, true);
      assert.equal(sent.room.length, 0);
      assert.equal(sent.dm.length, 1);
      const [list] = sent.dm;
      assert.match(list.embeds[0].title, /أوتومود/u);
      assert.ok(list.embeds.some((embed) => embed.description.includes('شرموط')), 'built-in words listed');
      assert.ok(list.embeds.some((embed) => embed.description.includes('🔒')), 'read-only groups explained');
      const ids = list.components.flatMap((row) => row.toJSON().components.map((c) => c.custom_id));
      assert.deepEqual(ids, [`automod:add:${HOME_GUILD_ID}:0`, `automod:remove:${HOME_GUILD_ID}:0`, `automod:test:${HOME_GUILD_ID}:0`, `automod:page:${HOME_GUILD_ID}:0`]);
    }
  });

  test('anyone else gets nothing at all: the word is just chat (also through the typed-command pipeline)', async () => {
    const { client, message, sent } = setup();
    for (const content of ['automod', '!automod', 'automod add شتيمة حمار', 'اوتومود']) {
      const typed = message(content, MEMBER);
      assert.equal(await handleAutomodMessage(typed), false);
      await handlePrefixCommand(typed, client);
      assert.equal(typed.deleted, false, content);
    }
    assert.deepEqual([sent.room.length, sent.dm.length, sent.audit.length], [0, 0, 0]);
    assert.deepEqual(getAutomodState().custom, []);
    // The owner through the same pipeline.
    const typed = message('!automod', OWNER);
    await handlePrefixCommand(typed, client);
    assert.equal(sent.dm.length, 1);
  });

  test('other servers: the command does nothing, even for an owner', async () => {
    const { message, sent } = setup({ guildId: OTHER_GUILD });
    assert.equal(await handleAutomodMessage(message('automod', OWNER)), false);
    assert.deepEqual([sent.room.length, sent.dm.length], [0, 0]);
  });

  test('DMs closed: the answer goes in the room for 60 seconds', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { message, sent } = setup({ dmOpen: false });
    assert.equal(await handleAutomodMessage(message('automod', OWNER)), true);
    assert.equal(sent.room.length, 1);
    assert.match(sent.room[0].content, new RegExp(`<@${OWNER}>`, 'u'));
    assert.deepEqual(sent.room[0].allowedMentions, { users: [OWNER] });
    t.mock.timers.tick(ROOM_REPLY_DELETE_MS - 1);
    assert.equal(sent.room[0].deleted, false);
    t.mock.timers.tick(1);
    assert.equal(sent.room[0].deleted, true);
  });

  test('add / remove / enable / variants / test from typed commands, every change in the automod log', async () => {
    const { client, message, sent } = setup();
    await loadAutomodRules(client);
    const run = async (content) => {
      await handleAutomodMessage(message(content, OWNER));
      return sent.dm.at(-1).embeds[0].description;
    };
    assert.match(await run('automod add ابن البقرة'), /اتضافت/u);
    assert.equal(checkText('ابن البقره'), 'ibnAl');
    assert.match(await run('automod add حمار'), /اتضافت/u);
    assert.equal(getAutomodState().custom.find((entry) => entry.word === 'حمار').rule, 'insult', 'default rule');
    assert.match(await run('automod add حمار'), /موجودة في كلماتك/u);
    assert.match(await run('automod remove teez'), /اتوقفت/u);
    assert.match(await run('automod enable teez'), /رجعت/u);
    assert.match(await run('automod remove حمار'), /اتشالت/u);
    assert.match(await run('automod remove كسمك'), /نمط ثابت/u);
    const variants = await run('automod variants كلب');
    assert.match(variants, /kalb/u);
    assert.match(variants, /dog/u);
    assert.match(await run('automod test يا ك.ل.ب'), /مفيش حاجة/u);
    assert.match(await run('automod test ابن البقرة'), /ابن ال/u);
    assert.match(await run('automod test fvck'), /fuck/u);
    assert.match(await run('automod oops'), /أوامر الأوتومود/u);

    // Four changes logged (add ×2, switch off, switch on, remove); refusals and tests are not.
    assert.equal(sent.audit.length, 5);
    for (const log of sent.audit) {
      assert.match(log.embeds[0].description, new RegExp(`<@${OWNER}>`, 'u'));
      assert.deepEqual(log.allowedMentions, { parse: [] });
    }
    assert.match(sent.audit[0].embeds[0].description, /البقرة/u);
    assert.match(sent.audit[2].embeds[0].description, /teez/u);
  });

  test('a long list is split in pages under Discord limits, with ◀️ ▶️', () => {
    const custom = Array.from({ length: 300 }, (_, i) => ({ word: `كلمةطويلةجدا${String(i).replace(/\d/gu, (d) => 'ابتثجحخدذر'[d])}`, rule: 'insult' }));
    const state = { custom, disabled: ['طيز'], loaded: true };
    const pages = automodPages(state);
    assert.ok(pages.length > 1);
    for (let page = 0; page < pages.length; page += 1) {
      const payload = automodListPayload(HOME_GUILD_ID, page, state);
      const chars = payload.embeds.reduce((sum, e) => sum + e.title.length + e.description.length + (e.footer?.text.length || 0), 0);
      assert.ok(chars <= 6000 && payload.embeds.length <= 10, `page ${page}: ${chars}`);
      assert.ok(payload.embeds.every((e) => e.description.length <= 4096));
      const nav = payload.components[1].toJSON().components;
      assert.equal(nav[0].custom_id, `automod:page:${HOME_GUILD_ID}:${page - 1}`);
      assert.equal(nav[0].disabled, page === 0);
      assert.equal(nav[1].disabled, page === pages.length - 1);
    }
    const everything = pages.flat().map((e) => e.description).join('\n');
    for (const entry of custom) assert.ok(everything.includes(entry.word), entry.word);
    assert.equal(automodListPayload(HOME_GUILD_ID, 999, state).embeds.at(-1).footer.text.startsWith(`صفحة ${pages.length}/`), true, 'an old page number is clamped');
  });
});

describe('automod buttons and forms (owners only)', () => {
  beforeEach(() => resetAutomodStore());

  test('registered under the repo pattern', () => {
    assert.equal(automodButton.name, AUTOMOD_BUTTON);
    assert.equal(automodForm.name, AUTOMOD_FORM);
    assert.equal(typeof automodButton.execute, 'function');
    assert.equal(typeof automodForm.execute, 'function');
  });

  test('anyone else gets a private "owners only"; nothing opens and nothing changes', async () => {
    const { press, sent } = setup();
    for (const id of [`automod:add:${HOME_GUILD_ID}:0`, `automod:page:${HOME_GUILD_ID}:1`]) {
      const it = await press(id, MEMBER);
      assert.equal(it.modals.length + it.updates.length, 0);
      assert.equal(it.replies[0].flags, 64);
      assert.match(it.replies[0].content, /للأونرز/u);
    }
    const form = await press(`automodform:add:${HOME_GUILD_ID}:0`, MEMBER, { fields: { word: 'حمار' } });
    assert.match(form.replies[0].content, /للأونرز/u);
    assert.deepEqual(getAutomodState().custom, []);
    assert.equal(sent.audit.length, 0);
  });

  test('owners open the forms, turn pages; old or broken buttons answer politely', async () => {
    const { press } = setup();
    const add = await press(`automod:add:${HOME_GUILD_ID}:0`, OWNER);
    assert.equal(add.modals[0].toJSON().custom_id, `automodform:add:${HOME_GUILD_ID}:0`);
    const modal = add.modals[0].toJSON();
    assert.ok(JSON.stringify(modal).includes('"custom_id":"rule"'), 'the rule picker');
    assert.equal((await press(`automod:test:${HOME_GUILD_ID}:0`, TRUST_MANAGER)).modals.length, 1);
    const page = await press(`automod:page:${HOME_GUILD_ID}:0`, OWNER);
    assert.equal(page.updates.length, 1);
    for (const id of [`automod:add:${OTHER_GUILD}:0`, `automod:nope:${HOME_GUILD_ID}:0`, 'automod:add']) {
      const it = await press(id, OWNER);
      assert.match(it.replies[0].content, /قديمة/u, id);
      assert.equal(it.replies[0].flags, 64);
    }
  });

  test('the forms add, remove and test; the list message is refreshed and the change logged', async () => {
    const { client, press, sent } = setup();
    await loadAutomodRules(client);
    const added = await press(`automodform:add:${HOME_GUILD_ID}:0`, OWNER, { fields: { word: 'حمار' }, select: { rule: ['family'] } });
    assert.match(added.replies[0].content, /اتضافت/u);
    assert.equal(added.replies[0].flags, 64);
    assert.equal(added.edits.length, 1, 'the list shows the new word');
    assert.equal(checkText('7mar'), 'family');
    assert.match(sent.audit[0].embeds[0].description, /حمار/u);
    const tested = await press(`automodform:test:${HOME_GUILD_ID}:0`, OWNER, { fields: { text: 'يا 7maaar' } });
    assert.match(tested.replies[0].content, /هتتمسح/u);
    const removed = await press(`automodform:remove:${HOME_GUILD_ID}:0`, OWNER, { fields: { word: 'حمار' } });
    assert.match(removed.replies[0].content, /اتشالت/u);
    assert.equal(checkText('7mar'), null);
    assert.equal(sent.audit.length, 2);
  });
});
