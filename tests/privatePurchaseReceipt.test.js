import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, ComponentType } from 'discord.js';
import store from '../src/commands/Games/store.js';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import { applyWordAliases } from '../src/config/commands/commandAliases.js';
import { parseTypedCommand } from '../src/utils/prefixParser.js';
import { createMockInteraction } from '../src/utils/messageAdapter.js';
import { getProfile, adjustCC } from '../src/services/cc/ccService.js';
import { PRIVATE_PURCHASE_TTL_MS } from '../src/services/cc/privatePurchaseReceipt.js';

const MEMBER = '200000000000000241';
const OTHER = '200000000000000242';

function fakeCollector(options) {
    const handlers = {};
    return {
        options, ended: false, endWork: Promise.resolve(),
        on(event, callback) { handlers[event] = callback; return this; },
        stop(reason) {
            if (this.ended) return;
            this.ended = true;
            this.endWork = Promise.resolve(handlers.end([], reason));
        },
        collect(button) { return options.filter(button) ? handlers.collect(button) : null; },
    };
}

async function purchasePrefix(t, { text = 'متجر 2 تأكيد', dmsOpen = false, collectorAvailable = true, receiptGuildId = HOME_GUILD_ID, failButtonEdit = false } = {}) {
    t.mock.method(Math, 'random', () => 0.99); // The luck box gives a forecast (also tests closed DMs).
    const records = new Map();
    const client = { db: {
        get: async (key, fallback = null) => records.has(key) ? structuredClone(records.get(key)) : fallback,
        set: async (key, value) => { records.set(key, structuredClone(value)); return true; },
    } };
    await adjustCC(client, HOME_GUILD_ID, MEMBER, 100_000);
    const publicPayloads = [];
    const privateMessages = [];
    const user = { id: MEMBER, bot: false, toString: () => `<@${MEMBER}>`, send: async (payload) => {
        if (!dmsOpen) throw new Error('DMs closed');
        privateMessages.push(payload);
    } };
    const guild = { id: HOME_GUILD_ID, roles: { cache: new Map() } };
    const member = { id: MEMBER, user, guild, roles: { cache: new Map(), add: async () => {} } };
    guild.members = { cache: new Map([[MEMBER, member]]) };
    let collector;
    const receipt = {
        id: '300000000000000241', guildId: receiptGuildId,
        edit: async (payload) => {
            if (failButtonEdit && payload.components?.length) throw new Error('Cannot show components');
            publicPayloads.push(payload);
            return receipt;
        },
        ...(collectorAvailable ? { createMessageComponentCollector: (options) => { collector = fakeCollector(options); return collector; } } : {}),
    };
    const message = {
        id: '300000000000000242', content: text, author: user, member, guild, client,
        channel: { id: '300000000000000243', send: async (payload) => { publicPayloads.push(payload); return receipt; } },
    };
    const parsed = parseTypedCommand(text, '!');
    const aliased = applyWordAliases(parsed.commandName, parsed.args, parsed.prefixed);
    assert.ok(aliased, text);
    const args = store.normalizePrefixArgs(aliased.args);
    const interaction = createMockInteraction(message, store.data, args);
    await store.execute(interaction, {}, client);
    const balance = async () => (await getProfile(client, HOME_GUILD_ID, MEMBER)).cc;
    return {
        publicPayloads, privateMessages, collector, receipt, balance,
        button({ userId = MEMBER, guildId = HOME_GUILD_ID, messageId = receipt.id, reply } = {}) {
            const replies = [];
            const button = {
                customId: publicPayloads.find((payload) => payload.components?.length)?.components[0].toJSON().components[0].custom_id,
                guildId, user: { id: userId }, message: { id: messageId },
                reply: reply || (async (payload) => { replies.push(payload); }),
            };
            return { button, replies };
        },
    };
}

function assertPublicPrivacy(payloads) {
    // The receipt can show the name of the forecast, but never its private future prices.
    const text = JSON.stringify(payloads);
    assert.ok(!text.includes('الأسعار الجاية') && !text.includes('بالظبط'));
}

test('the reported luck-box command completes once and reveals a forecast privately to its owner', async (t) => {
    const purchase = await purchasePrefix(t);
    assert.equal(await purchase.balance(), 98_200);
    assert.match(purchase.publicPayloads[0].embeds[0].title, /تم الشراء/u);
    const ready = purchase.publicPayloads.at(-1);
    assert.match(ready.content, /5 دقايق/u);
    assert.equal(ready.components[0].toJSON().components[0].label, 'عرض النتيجة الخاصة');
    assert.ok(!ready.components[0].toJSON().components[0].custom_id.includes(':'));
    assert.equal(purchase.collector.options.componentType, ComponentType.Button);
    assert.equal(purchase.collector.options.time, PRIVATE_PURCHASE_TTL_MS);
    assert.equal(PRIVATE_PURCHASE_TTL_MS, 300_000);
    const { button, replies } = purchase.button();
    await purchase.collector.collect(button);
    await purchase.collector.endWork;
    assert.equal(replies.length, 1);
    assert.equal(replies[0].flags, MessageFlags.Ephemeral);
    assert.match(replies[0].embeds[0].description, /الأسعار الجاية/u);
    assert.deepEqual(purchase.publicPayloads.at(-1).components, []);
    assert.equal(await purchase.balance(), 98_200);
    assertPublicPrivacy(purchase.publicPayloads);
});

test('direct forecast purchases use the same private receipt without a second purchase', async (t) => {
    const purchase = await purchasePrefix(t, { text: 'متجر 5 تأكيد' });
    assert.equal(await purchase.balance(), 92_200);
    const { button, replies } = purchase.button();
    await purchase.collector.collect(button);
    await purchase.collector.endWork;
    assert.equal(replies[0].flags, MessageFlags.Ephemeral);
    assert.match(replies[0].embeds[0].description, /الأسعار الجاية/u);
    assert.equal(await purchase.balance(), 92_200);
    assertPublicPrivacy(purchase.publicPayloads);
});

test('another member, another guild or another message cannot reveal the purchased result', async (t) => {
    const purchase = await purchasePrefix(t);
    for (const mismatch of [{ userId: OTHER }, { guildId: '100000000000000241' }, { messageId: '300000000000000244' }]) {
        const { button, replies } = purchase.button(mismatch);
        await purchase.collector.collect(button);
        assert.equal(replies[0].flags, MessageFlags.Ephemeral);
        assert.match(replies[0].content, /لصاحب الشراء/u);
        assert.equal(replies[0].embeds, undefined);
        assert.equal(purchase.collector.ended, false);
    }
    assert.equal(await purchase.balance(), 98_200);
    assertPublicPrivacy(purchase.publicPayloads);
    purchase.collector.stop('time');
    await purchase.collector.endWork;
});

test('concurrent and repeated clicks never buy again or disclose the private result twice', async (t) => {
    const purchase = await purchasePrefix(t);
    let release;
    const firstReplies = [];
    const first = purchase.button({ reply: async (payload) => { firstReplies.push(payload); await new Promise((resolve) => { release = resolve; }); } });
    const firstWork = purchase.collector.collect(first.button);
    const second = purchase.button();
    await purchase.collector.collect(second.button);
    assert.match(second.replies[0].content, /بتتعرض/u);
    assert.equal(second.replies[0].embeds, undefined);
    release();
    await firstWork;
    await purchase.collector.endWork;
    const repeated = purchase.button();
    await purchase.collector.collect(repeated.button); // A stale already-queued event is safe as well.
    assert.equal(repeated.replies[0].embeds, undefined);
    assert.equal(firstReplies.length, 1);
    assert.equal(await purchase.balance(), 98_200);
    assertPublicPrivacy(purchase.publicPayloads);
});

test('collector expiry removes the button, clears access, and keeps the existing purchase', async (t) => {
    const purchase = await purchasePrefix(t);
    const stale = purchase.button();
    purchase.collector.stop('time');
    await purchase.collector.endWork;
    assert.deepEqual(purchase.publicPayloads.at(-1).components, []);
    assert.match(purchase.publicPayloads.at(-1).content, /انتهت مهلة/u);
    await purchase.collector.collect(stale.button);
    assert.equal(stale.replies[0].embeds, undefined);
    assert.match(stale.replies[0].content, /انتهت مهلة/u);
    assert.equal(await purchase.balance(), 98_200);
    assertPublicPrivacy(purchase.publicPayloads);
});

test('wall-clock expiry blocks disclosure even if the collector end event is delayed', async (t) => {
    const purchase = await purchasePrefix(t);
    const expired = Date.now() + PRIVATE_PURCHASE_TTL_MS + 1;
    t.mock.method(Date, 'now', () => expired);
    const { button, replies } = purchase.button();
    await purchase.collector.collect(button);
    await purchase.collector.endWork;
    assert.match(replies[0].content, /انتهت مهلة/u);
    assert.equal(replies[0].embeds, undefined);
    assert.equal(purchase.collector.ended, true);
    assertPublicPrivacy(purchase.publicPayloads);
});

test('an unavailable collector or wrong-guild receipt never exposes a private payload publicly', async (t) => {
    for (const options of [{ collectorAvailable: false }, { receiptGuildId: '100000000000000241' }]) {
        const purchase = await purchasePrefix(t, options);
        assert.equal(purchase.collector, undefined);
        assert.match(purchase.publicPayloads.at(-1).content, /مش متاح دلوقتي/u);
        assert.deepEqual(purchase.publicPayloads.at(-1).components, []);
        assert.equal(await purchase.balance(), 98_200);
        assertPublicPrivacy(purchase.publicPayloads);
    }
});

test('a failed private interaction leaves the same purchased result available for retry', async (t) => {
    const purchase = await purchasePrefix(t);
    const failed = purchase.button({ reply: async () => { throw new Error('Interaction expired'); } });
    await purchase.collector.collect(failed.button);
    assert.equal(purchase.collector.ended, false);
    const retry = purchase.button();
    await purchase.collector.collect(retry.button);
    await purchase.collector.endWork;
    assert.match(retry.replies[0].embeds[0].description, /الأسعار الجاية/u);
    assert.equal(retry.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(await purchase.balance(), 98_200);
    assertPublicPrivacy(purchase.publicPayloads);
});

test('failure to expose the receipt button ends the collector without another charge or public disclosure', async (t) => {
    const purchase = await purchasePrefix(t, { failButtonEdit: true });
    await purchase.collector.endWork;
    assert.equal(purchase.collector.ended, true);
    assert.match(purchase.publicPayloads.at(-1).content, /مش متاح دلوقتي/u);
    assert.deepEqual(purchase.publicPayloads.at(-1).components, []);
    assert.equal(await purchase.balance(), 98_200);
    assertPublicPrivacy(purchase.publicPayloads);
});

test('open DMs deliver the purchased result there and need no public reveal button', async (t) => {
    const purchase = await purchasePrefix(t, { dmsOpen: true });
    assert.equal(purchase.collector, undefined);
    assert.equal(purchase.privateMessages.length, 1);
    assert.match(purchase.privateMessages[0].embeds[0].description, /الأسعار الجاية/u);
    assert.deepEqual(purchase.publicPayloads[0].components, []);
    assert.equal(await purchase.balance(), 98_200);
    assertPublicPrivacy(purchase.publicPayloads);
});
