import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildGuideEmbeds, buildGuideSections, buildGuidePayload } from '../src/services/cc/guideUi.js';
import guide from '../src/commands/Games/guide.js';
import guideMenu from '../src/interactions/selectMenus/guide/guideSection.js';
import { commandAliases, standaloneOnlyAliases } from '../src/config/commands/commandAliases.js';
import { bourseSettings } from '../src/config/store/bourse.js';
import { CC } from '../src/config/cc.js';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';

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

      // The menu (in DM, no server there) edits the message in place, with the server from its id.
      const updates = [];
      await guideMenu.execute({ values: ['bourse'], update: async (payload) => updates.push(payload) }, {}, [guildId]);
      assert.equal(updates[0].embeds[0].title, '📈 البورصة (الاستثمار)');
      assert.equal(updates[0].components[0].components[0].options.find((option) => option.default).value, 'bourse');
      assert.equal(updates[0].embeds[0].description.includes('القصر'), guildId === HOME_GUILD_ID, 'the server still shapes the section');
      await guideMenu.execute({ values: ['contents'], update: async (payload) => updates.push(payload) }, {}, [guildId]);
      assert.match(updates[1].embeds[0].title, /المحتويات/u);
    }
    assert.equal(guideMenu.name, 'guide');
    assert.equal(buildGuidePayload({ guildId: 'x' }).components[0].components[0].custom_id, 'guide:0');
  });

  test('`شرح` runs the guide only as the whole message', () => {
    assert.equal(commandAliases['شرح'], 'guide');
    assert.ok(standaloneOnlyAliases.has('شرح'));
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
