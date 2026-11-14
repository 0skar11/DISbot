import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startHeartbeat, STATUS_GUILD_ID, STATUS_CHANNEL_ID, STALE_MS } from '../src/services/heartbeatService.js';

function setup(peerAgeMs) {
  const sent = [];
  const peerMessage = { author: { id: 'peer' }, content: '💓 heartbeat peer • x', createdTimestamp: 0, editedTimestamp: 0 };
  const own = [];
  const channel = {
    isTextBased: () => true,
    messages: { fetch: async () => { const list = [peerMessage, ...own]; list.find = Array.prototype.find; return list; } },
    send: async (payload) => { sent.push(payload); if (payload.content.startsWith('💓')) { const m = { author: { id: 'me' }, content: payload.content, edit: async ({ content }) => { m.content = content; return m; } }; own.push(m); return m; } return {}; },
  };
  const client = { user: { id: 'me' }, guilds: { cache: new Map([[STATUS_GUILD_ID, { channels: { fetch: async (id) => (id === STATUS_CHANNEL_ID ? channel : null) } }]]) } };
  let now = peerAgeMs;
  return { client, sent, setNow: (v) => { now = v; }, now: () => now, peerMessage };
}

describe('heartbeat', () => {
  test('posts its own heartbeat once, alerts once when the other bot goes quiet, then says it is back', async () => {
    const s = setup(STALE_MS + 60_000);
    const stop = startHeartbeat(s.client, { selfName: 'me', peer: { id: 'peer', name: 'Peer' }, log: { warn() {} }, now: s.now, beatEveryMs: 1_000_000, watchEveryMs: 10 });
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    assert.equal(s.sent.filter((p) => p.content.startsWith('💓')).length, 1);
    const alerts = s.sent.filter((p) => p.content.includes('🔴'));
    assert.equal(alerts.length, 1);
    assert.ok(alerts[0].content.startsWith('@everyone'));
    s.peerMessage.editedTimestamp = s.now();
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    assert.equal(s.sent.filter((p) => p.content.includes('🟢')).length, 1);
    assert.equal(s.sent.filter((p) => p.content.includes('🔴')).length, 1);
    stop();
  });
});
