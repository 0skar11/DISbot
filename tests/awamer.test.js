import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AWAMER_CATEGORIES,
  buildAwamerSelectMenu,
  buildAwamerHomeButton,
  buildAwamerMainPayload,
  buildAwamerCategoryPayload,
} from '../src/services/help/awamerService.js';

describe('اوامر command GUI (Report #306)', () => {
  const mockClient = {
    user: {
      username: 'Aether',
      displayName: 'Aether Bot',
      displayAvatarURL: () => 'https://example.com/avatar.png',
    },
  };

  test('buildAwamerMainPayload builds overview embed with select menu', () => {
    const payload = buildAwamerMainPayload(mockClient);
    assert.ok(payload.embeds?.length === 1);
    const embed = payload.embeds[0].data;
    assert.match(embed.title, /لوحة أوامر البوت/u);
    assert.match(embed.description, /دليل أوامر البوت/u);

    assert.ok(payload.components?.length === 1);
    const selectMenu = payload.components[0].components[0];
    assert.equal(selectMenu.data.custom_id, 'awamer_select');
    assert.equal(selectMenu.options.length, 4);
    assert.deepEqual(
      selectMenu.options.map((o) => o.data.value),
      ['admin', 'general', 'tickets', 'leveling'],
    );
  });

  test('buildAwamerCategoryPayload for admin shows moderation commands and back button', () => {
    const payload = buildAwamerCategoryPayload(mockClient, 'admin');
    assert.ok(payload.embeds?.length === 1);
    const embed = payload.embeds[0].data;
    assert.match(embed.title, /أوامر الإدارة والإشراف/u);
    assert.ok(embed.fields.length >= 4);

    // Verify pull command is documented
    const voiceField = embed.fields.find((f) => f.name.includes('الفويس'));
    assert.ok(voiceField);
    assert.match(voiceField.value, /\.سحب/u);

    // Has select menu and home button
    assert.equal(payload.components.length, 2);
    const selectMenu = payload.components[0].components[0];
    assert.equal(selectMenu.data.custom_id, 'awamer_select');
    const defaultOpt = selectMenu.options.find((o) => o.data.default);
    assert.equal(defaultOpt?.data.value, 'admin');

    const homeBtn = payload.components[1].components[0].data;
    assert.equal(homeBtn.custom_id, 'awamer_home');
  });

  test('buildAwamerCategoryPayload for general shows member tools and caption', () => {
    const payload = buildAwamerCategoryPayload(mockClient, 'general');
    const embed = payload.embeds[0].data;
    assert.match(embed.title, /أوامر الأعضاء والأدوات/u);
    const imgField = embed.fields.find((f) => f.name.includes('الصور'));
    assert.ok(imgField);
    assert.match(imgField.value, /\.caption/u);
    assert.match(imgField.value, /\.removebg/u);
  });

  test('buildAwamerCategoryPayload falls back to main payload for unknown category', () => {
    const payload = buildAwamerCategoryPayload(mockClient, 'non_existent');
    assert.match(payload.embeds[0].data.title, /لوحة أوامر البوت/u);
  });
});
