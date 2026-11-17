import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildGuideEmbeds, buildGuideSections, buildGuidePayload } from '../src/services/cc/guideUi.js';
import guide from '../src/commands/Games/guide.js';
import guideMenu from '../src/interactions/selectMenus/guide/guideSection.js';
import { commandAliases, standaloneOnlyAliases } from '../src/config/commands/commandAliases.js';
import { bourseSettings } from '../src/config/store/bourse.js';
import { CC } from '../src/config/cc.js';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import { isMovedCCCommand, isSilentCommand } from '../src/config/commands/commandAvailability.js';
import { registerCommands } from '../src/handlers/loaders/commandLoader.js';
import removebg from '../src/commands/Tools/removebg.js';
import interactionCreate from '../src/events/interactionCreate.js';

describe('شرح: the CC / store / bourse guide in DM', () => {
  test('covers CC, earning, the store, the bourse and transfers with the real numbers', () => {
    const embeds = buildGuideEmbeds({ boostLine: '' });
    const text = JSON.stringify(embeds);
    for (const word of ['رصيد', 'متجر', 'مخزني', 'اسعار', 'شراء عربية', 'استثمار عربية', 'بيع عربية', 'ممتلكاتي', 'تحويل']) {
      assert.ok(text.includes(word), word);
    }
    assert.ok(text.includes(`${bourseSettings.maxMovePercent}%`));
    assert.ok(text.includes(`${bourseSettings.demand.guaranteedRiseUnits} قطعة`));
    assert.ok(text.includes(`**${CC.gamesBot.win}**`));
    // Our server's guide shows its own game rewards (report #181).
    assert.ok(JSON.stringify(buildGuideEmbeds({ boostLine: '', guildId: HOME_GUILD_ID })).includes(`**${CC.gamesBot.home.win}**`));
    assert.ok(embeds.length <= 10 && text.length < 6000);
  });

  test('opens on a short contents page; the menu shows each short section and goes back (report #283)', async () => {
    for (const guildId of [HOME_GUILD_ID, '100000000000000250']) {
      const sections = buildGuideSections({ boostLine: '', guildId });
      const contents = buildGuidePayload({ guildId, boostLine: '' });
      assert.equal(contents.embeds.length, 1);
      for (const section of sections) assert.ok(contents.embeds[0].description.includes(section.label), section.id);
      const menu = contents.components[0].components[0];
      assert.equal(menu.custom_id, `guide:${guildId}`);
      assert.deepEqual(menu.options.map((option) => option.value), ['contents', ...sections.map((section) => section.id)]);
      assert.ok(menu.options.length <= 25);
      for (const section of sections) {
        assert.ok(section.embed.description.split('\n').length <= 6, `${section.id} stays short`);
        assert.ok(section.embed.description.length < 700, `${section.id} stays short`);
      }

      // A section page (what the menu showed before the guide moved), with the server from its id.
      const bourse = buildGuidePayload({ guildId, boostLine: '', section: 'bourse' });
      assert.equal(bourse.embeds[0].title, '📈 البورصة (الاستثمار)');
      assert.equal(bourse.components[0].components[0].options.find((option) => option.default).value, 'bourse');
      assert.equal(bourse.embeds[0].description.includes('القصر'), guildId === HOME_GUILD_ID, 'the server still shapes the section');

      // The guide moved to the CC bot (report #287): a menu left in an old DM is acknowledged, nothing changes.
      let deferred = 0;
      await guideMenu.execute({ values: ['bourse'], deferUpdate: async () => { deferred += 1; }, update: () => assert.fail('updated') }, {}, [guildId]);
      assert.equal(deferred, 1);
    }
    assert.equal(guideMenu.name, 'guide');
    assert.equal(buildGuidePayload({ guildId: 'x' }).components[0].components[0].custom_id, 'guide:0');
  });

  test('`شرح` maps to the guide only as the whole message', () => {
    assert.equal(commandAliases['شرح'], 'guide');
    assert.ok(standaloneOnlyAliases.has('شرح'));
  });

  test('the guide moved to the CC bot (report #287): `/guide` is not registered and `شرح` gets no answer', async () => {
    assert.equal(isMovedCCCommand('guide'), true);
    assert.equal(isSilentCommand('guide'), true, 'typed `شرح` and stale `/guide` return silently');
    const requests = [];
    await registerCommands({
      commands: new Map([[guide.data.name, guide], [removebg.data.name, removebg]]),
      rest: { put: async (route, payload) => requests.push(payload) },
    }, { clientId: '100000000000000001' });
    assert.deepEqual(requests[0].body.map((command) => command.name), ['removebg']);

    let touched = 0;
    await interactionCreate.execute({ commandName: 'guide', isChatInputCommand: () => true, reply: () => { touched += 1; } }, { commands: { get: () => { touched += 1; } } });
    assert.equal(touched, 0);
  });

  test('sends the guide in DM and says so; tells the member when their DMs are closed', async () => {
    const replies = [];
    const dms = [];
    const interaction = (send) => ({
      user: { id: 'u', send },
      deferred: false,
      replied: false,
      reply: async (payload) => { replies.push(payload); },
      isRepliable: () => true,
    });
    await guide.execute(interaction(async (payload) => { dms.push(payload); }));
    assert.equal(dms.length, 1);
    assert.equal(dms[0].embeds.length, 1, 'one short page at a time');
    assert.match(dms[0].embeds[0].title, /المحتويات/u);
    assert.equal(dms[0].components[0].components[0].type, 3);

    const notes = [];
    const source = { channel: { send: async (payload) => { notes.push(payload); return { delete: async () => {} }; } }, delete: async () => {} };
    await guide.execute({ ...interaction(async () => { throw new Error('Cannot send messages to this user'); }), _sourceMessage: source, user: { id: 'u', toString: () => '<@u>', send: async () => { throw new Error('closed'); } } });
    assert.match(notes[0].content, /مقدرتش أبعتلك في الخاص/u);
  });
});
