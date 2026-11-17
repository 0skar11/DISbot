import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HOME_GUILD_ID, ZENITH_GUILD_ID } from '../src/config/homeGuild.js';
import { SERVER_OWNER_IDS, isServerOwner } from '../src/config/serverOwners.js';
import { getGuildConfigKey } from '../src/utils/database.js';
import {
  BUILT_IN_FAMILIES, IBN_AL_INSULTS, INSULTS, INSULTS_LATIN, checkText,
} from '../src/services/moderation/chatFilterRules.js';
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

function setup({ guildId = HOME_GUILD_ID, dmOpen = true, db = {}, auditRoom = true } = {}) {
  const store = new Map([[getGuildConfigKey(guildId), { prefix: '!', ...(auditRoom ? { auditChannels: { automode: AUDIT_ROOM } } : {}) }]]);
  const sent = { room: [], dm: [], dmMessages: [], audit: [] };
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
      const msg = { id: `dm${sent.dm.length + 1}`, payload, edits: [], edit: async (edit) => { msg.edits.push(edit); return msg; } };
      sent.dm.push(payload);
      sent.dmMessages.push(msg);
      return msg;
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
  const interaction = (customId, userId = OWNER, { fields = {}, select = {}, fromMessage = true, inGuild = null } = {}) => {
    const it = {
      customId, user: user(userId), guild: null, guildId: inGuild, replies: [], updates: [], modals: [], edits: [],
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
    assert.deepEqual([builtIn.kind, builtIn.builtIn.list, builtIn.words], ['disabled', 'ibnAl', ['كلب', 'كلبه', 'كلاب']]);
    assert.equal(checkText('ابن الكلب'), null);
    assert.equal(checkText('ابن الكلاب'), null, 'the whole word goes off');
    assert.equal((await enableAutomodWord(client, { word: 'كلب' })).ok, true);
    assert.equal(checkText('ابن الكلب'), 'ibnAl');
    assert.equal((await removeAutomodWord(client, { word: 'قطقوطة' })).reason, 'not_found');
  });

  test('every built-in list entry belongs to exactly one word', () => {
    const counts = new Map();
    for (const family of BUILT_IN_FAMILIES) for (const word of new Set(family)) counts.set(word, (counts.get(word) || 0) + 1);
    for (const word of new Set([...INSULTS, ...INSULTS_LATIN, ...IBN_AL_INSULTS])) assert.equal(counts.get(word), 1, word);
    for (const word of counts.keys()) assert.ok([...INSULTS, ...INSULTS_LATIN, ...IBN_AL_INSULTS].includes(word), `${word} is not a list entry`);
  });

  test('built-in words are switched off and back on in all their spellings; the regex families are read-only', async () => {
    const { client, store } = setup();
    await loadAutomodRules(client);
    const off = await removeAutomodWord(client, { word: 'طيز' });
    assert.equal(off.kind, 'disabled');
    assert.deepEqual(off.builtIn, { list: 'insult', word: 'طيز', head: 'طيز', words: ['طيز', 'teez', 'tez'] });
    assert.deepEqual(off.words, ['طيز', 'teez', 'tez']);
    assert.equal(checkText('طيز'), null);
    assert.equal(checkText('teez'), null, 'its franco spellings too');
    assert.equal(checkText('طيز', { legacy: true }), 'insult', 'the original list still has it');
    assert.deepEqual(store.get(AUTOMOD_KEY).disabled, ['طيز', 'teez', 'tez']);
    assert.equal((await removeAutomodWord(client, { word: 'طيز' })).reason, 'already_off');
    assert.equal((await removeAutomodWord(client, { word: 'tez' })).reason, 'already_off', 'any spelling names the same word');
    const khawal = await removeAutomodWord(client, { word: 'khawal' });
    assert.deepEqual(khawal.words, ['خول', 'خولات', 'khawal', 'khawl', 'khwal', '5awal', '5wal', 'khawalat', '5awalat']);
    assert.deepEqual(['خول', 'خولات', 'khawal', '5awal', 'ya khwal'].map((text) => checkText(text)), [null, null, null, null, null]);
    assert.equal((await enableAutomodWord(client, { word: 'خولات' })).words.length, 9);
    assert.equal(checkText('5awal'), 'insult');
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
    assert.equal(checkText('teez'), 'insult');
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
    assert.deepEqual(saved.disabled, ['طيز', 'teez', 'tez'], 'the word in all its spellings');
    // An older save that switched off one spelling only ("خول") comes back as the whole word.
    store.set(AUTOMOD_KEY, { custom: [...saved.custom, null, { word: 5 }, { word: 'x y', rule: 'nope' }], disabled: ['teez', 'خول', 'not-a-built-in', 5] });
    assert.deepEqual(await loadAutomodRules(client), { loaded: true, custom: 1, disabled: 12 });
    assert.equal(checkText('7mar'), 'family');
    assert.deepEqual(['teez', 'طيز', 'خول', 'khawal', '5awal'].map((text) => checkText(text)), [null, null, null, null, null]);
    assert.deepEqual(getAutomodState().disabled.slice(0, 3), ['طيز', 'teez', 'tez']);
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

describe('automod punishments follow the chosen rule (every server)', () => {
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

    // Every server uses the same list (owner's rule of 2026-11-17): the owner words and the English insults.
    for (const guildId of [ZENITH_GUILD_ID, OTHER_GUILD]) {
      const other = setup({ guildId });
      assert.equal(await handleChatFilter(chat('يا قرد', other.guild).message, { warn }), true, guildId);
      assert.equal(await handleChatFilter(chat('fuck you', other.guild).message, { warn }), true, guildId);
      assert.equal(await handleChatFilter(chat('كسمك', other.guild).message, { warn }), true, guildId);
      assert.equal(await handleChatFilter(chat('صباح الخير', other.guild).message, { warn }), false, guildId);
    }
    assert.equal(await handleChatFilter(chat('fuck you', guild).message, { warn }), true);
    // Owners stay exempt everywhere.
    assert.equal(await handleChatFilter(chat('يا قرد', guild, OWNER).message, { warn }), false);
    assert.equal(await handleChatFilter(chat('يا قرد', setup({ guildId: OTHER_GUILD }).guild, OWNER).message, { warn }), false);
  });

  test('one shared list: an edit made in any server applies in every server', async () => {
    const zenith = setup({ guildId: ZENITH_GUILD_ID });
    const other = setup({ guildId: OTHER_GUILD });
    const home = setup();
    await loadAutomodRules(home.client);
    const warn = async () => ({ totalCount: 1, timeoutApplied: false });
    const caught = async (fixture, text) => handleChatFilter(chat(text, fixture.guild).message, { warn });

    // Added from Zenith: caught in every server.
    await handleAutomodMessage(zenith.message('automod add شتيمة سبونج', OWNER));
    for (const fixture of [home, zenith, other]) assert.equal(await caught(fixture, 'يا سبونج'), true, fixture.guild.id);
    // Switched off from another server: off in every server, also for its franco spellings.
    await handleAutomodMessage(other.message('automod remove خول', OWNER));
    for (const fixture of [home, zenith, other]) {
      assert.equal(await caught(fixture, 'انت خول'), false, fixture.guild.id);
      assert.equal(await caught(fixture, 'ya khawal'), false, fixture.guild.id);
    }
    // Back on from the home server.
    await handleAutomodMessage(home.message('automod enable خول', OWNER));
    for (const fixture of [home, zenith, other]) assert.equal(await caught(fixture, 'ya khawal'), true, fixture.guild.id);
    assert.deepEqual(getAutomodState().custom.map((entry) => entry.word), ['سبونج']);
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
    assert.equal(parseAutomod('automod موقوفة').sub, 'disabled');
    assert.equal(parseAutomod('automod disabled').sub, 'disabled');
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

  test('every server: the owners can use it, anyone else gets nothing', async () => {
    for (const guildId of [ZENITH_GUILD_ID, OTHER_GUILD]) {
      const { client, message, sent } = setup({ guildId });
      for (const owner of [OWNER, TRUST_MANAGER]) {
        const typed = message('automod', owner);
        assert.equal(await handleAutomodMessage(typed), true, guildId);
        assert.equal(typed.deleted, true);
      }
      assert.equal(sent.dm.length, 2);
      const ids = sent.dm[0].components.flatMap((row) => row.toJSON().components.map((c) => c.custom_id));
      assert.ok(ids.includes(`automod:add:${guildId}:0`), 'the list names the server it was asked from');
      for (const content of ['automod', '!automod', 'automod add شتيمة حمار', 'اوتومود']) {
        const typed = message(content, MEMBER);
        assert.equal(await handleAutomodMessage(typed), false);
        await handlePrefixCommand(typed, client);
        assert.equal(typed.deleted, false, content);
      }
      assert.deepEqual([sent.room.length, sent.dm.length, sent.audit.length], [0, 2, 0], guildId);
      assert.deepEqual(getAutomodState().custom, []);
    }
  });

  test('the change is logged in the server where it was made, and skipped there when it has no log room', async () => {
    const zenith = setup({ guildId: ZENITH_GUILD_ID });
    const bare = setup({ guildId: OTHER_GUILD, auditRoom: false });
    await loadAutomodRules(zenith.client);
    await handleAutomodMessage(zenith.message('automod add شتيمة سبونج', OWNER));
    assert.equal(zenith.sent.audit.length, 1);
    assert.match(zenith.sent.audit[0].embeds[0].description, /سبونج/u);
    await handleAutomodMessage(bare.message('automod remove سبونج', OWNER));
    assert.equal(bare.sent.audit.length, 0, 'no log room: nothing posted');
    assert.match(bare.sent.dm.at(-1).embeds[0].description, /اتشالت/u, 'the edit still works');
    assert.equal(zenith.sent.audit.length, 1, 'not posted in the other server');
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

  test('removed words disappear from the list: owner words, and built-in words in all their spellings', async () => {
    const { client, message, sent, press } = setup();
    await loadAutomodRules(client);
    // The words shown in the rule sections (the header with the commands is left out).
    const wordsOf = (embeds) => new Set(embeds.filter((e) => !e.title.startsWith('🛡️'))
      .flatMap((e) => e.description.replace(/\*/gu, '').split(/[،,:\s()]+/u)).filter(Boolean));
    const listed = () => wordsOf(automodPages().flat());
    const titles = () => automodPages().flat().map((e) => e.title);
    const typed = (content) => handleAutomodMessage(message(content, OWNER));
    const KHAWAL = ['خول', 'خولات', 'khawal', 'khawl', 'khwal', '5awal', '5wal', 'khawalat', '5awalat'];

    assert.ok(!titles().some((title) => title.includes('🔕') || title.includes('⏸️')), 'nothing switched off: no such section');
    assert.ok(KHAWAL.every((w) => listed().has(w)));
    await typed('automod');
    const list = sent.dmMessages.at(-1);

    await typed('automod add قرد');
    assert.ok(listed().has('قرد'));
    await typed('automod remove قرد');
    assert.ok(!listed().has('قرد'), 'a removed owner word is gone');

    await typed('automod remove خول');
    for (const w of KHAWAL) assert.ok(!listed().has(w), `${w} is gone from the Arabic and franco lines`);
    assert.ok(listed().has('شرموط') && listed().has('sharmota') && listed().has('عرص'), 'the other words stay');
    await typed('automod remove fuck');
    assert.ok(!listed().has('fuck') && listed().has('motherfucker'), 'the English line too');
    await typed('automod remove كلب');
    for (const w of ['كلب', 'كلبه', 'كلاب']) assert.ok(!listed().has(w), `${w} is gone from the ابن ال... line`);

    // The list the owner was sent is refreshed, and the buttons show the same list.
    assert.ok(list.edits.length >= 5);
    const refreshed = wordsOf(list.edits.at(-1).embeds);
    assert.ok(!refreshed.has('خول') && !refreshed.has('khawal') && !refreshed.has('fuck') && refreshed.has('شرموط'));
    const page = await press(`automod:page:${HOME_GUILD_ID}:0`, OWNER);
    assert.ok(!wordsOf(page.updates[0].embeds).has('khawal'));

    // One short last section says how to see and bring back the switched-off words; it lists none of them.
    const off = automodPages().flat().find((e) => e.title === '🔕 موقوفة');
    assert.match(off.description, /^3 /u);
    assert.ok(!/خول|khawal|fuck|كلب/u.test(off.description));
    assert.ok(!titles().includes('⏸️ كلمات أساسية موقفة'));
    await typed('automod موقوفة');
    const offList = sent.dm.at(-1).embeds[0].description;
    for (const w of ['خول', 'khawal', 'fuck', 'كلب', 'كلاب']) assert.ok(offList.includes(w), w);

    for (const w of ['خول', 'fuck', 'كلب']) await typed(`automod enable ${w}`);
    assert.ok(KHAWAL.every((w) => listed().has(w)) && listed().has('fuck') && listed().has('كلاب'));
    assert.ok(!titles().some((title) => title.includes('🔕')), 'the section goes away when nothing is off');
    await typed('automod موقوفة');
    assert.match(sent.dm.at(-1).embeds[0].description, /مفيش/u);
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
    // Any server's list works (in a DM or inside that server).
    assert.equal((await press(`automod:add:${OTHER_GUILD}:0`, OWNER)).modals.length, 1);
    assert.equal((await press(`automod:add:${ZENITH_GUILD_ID}:0`, OWNER, { inGuild: ZENITH_GUILD_ID })).modals.length, 1);
    const stale = [
      [`automod:nope:${HOME_GUILD_ID}:0`, {}], ['automod:add', {}], ['automod:add:abc:0', {}],
      [`automod:add:${HOME_GUILD_ID}:0`, { inGuild: OTHER_GUILD }], [`automodform:add:${HOME_GUILD_ID}:0`, { inGuild: OTHER_GUILD, fields: { word: 'حمار' } }],
    ];
    for (const [id, options] of stale) {
      const it = await press(id, OWNER, options);
      assert.match(it.replies[0].content, /قديمة/u, id);
      assert.equal(it.replies[0].flags, 64);
      assert.equal(it.modals.length, 0);
    }
    assert.deepEqual(getAutomodState().custom, []);
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
