// heartbeatService.js — the two main bots watch each other in Zenith's #bot-status room.
// Each bot edits one "heartbeat" message of its own every minute. Every two minutes it also looks at the
// other bot's heartbeat: when it is older than STALE_MS the bot posts one alert with @everyone, and one
// message when the other bot is back. No secrets and no webhook are needed, only the room.

export const STATUS_GUILD_ID = '1569932761471524874';
export const STATUS_CHANNEL_ID = '1571078435927887952';
export const HEARTBEAT_EVERY_MS = 60_000;
export const WATCH_EVERY_MS = 120_000;
export const STALE_MS = 5 * 60_000;

const marker = (botId) => `💓 heartbeat ${botId}`;

/** Starts the heartbeat and the watcher. `peer` is `{ id, name }` of the other bot. Returns a stop function. */
export function startHeartbeat(client, { selfName, peer, log = console, now = () => Date.now(), beatEveryMs = HEARTBEAT_EVERY_MS, watchEveryMs = WATCH_EVERY_MS } = {}) {
  let message = null;
  let peerDown = false;
  const timers = [];

  async function room() {
    const guild = client.guilds.cache.get(STATUS_GUILD_ID);
    if (!guild) return null;
    const channel = await guild.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
    return channel?.isTextBased?.() ? channel : null;
  }

  async function beat() {
    try {
      const channel = await room();
      if (!channel) return;
      const content = `${marker(client.user.id)} • ${selfName} • <t:${Math.floor(now() / 1000)}:R>`;
      if (!message) {
        const recent = await channel.messages.fetch({ limit: 30 }).catch(() => null);
        message = recent?.find((m) => m.author.id === client.user.id && m.content.startsWith(marker(client.user.id))) || null;
      }
      message = message ? await message.edit({ content }).catch(() => null) : null;
      if (!message) message = await channel.send({ content, allowedMentions: { parse: [] } });
    } catch (error) {
      log.warn?.(`Heartbeat failed: ${error.message}`);
      message = null;
    }
  }

  async function watch() {
    try {
      const channel = await room();
      if (!channel) return;
      const recent = await channel.messages.fetch({ limit: 30 });
      const theirs = recent.find((m) => m.author.id === peer.id && m.content.startsWith(marker(peer.id)));
      if (!theirs) return; // the other bot never reported yet: nothing to compare
      const last = theirs.editedTimestamp || theirs.createdTimestamp;
      const stale = now() - last > STALE_MS;
      if (stale && !peerDown) {
        peerDown = true;
        const minutes = Math.round((now() - last) / 60_000);
        await channel.send({ content: `@everyone 🔴 **${peer.name}** مش بيرد من ${minutes} دقيقة تقريبًا. شوف Railway.`, allowedMentions: { parse: ['everyone'] } });
      } else if (!stale && peerDown) {
        peerDown = false;
        await channel.send({ content: `🟢 **${peer.name}** رجع يشتغل.`, allowedMentions: { parse: [] } });
      }
    } catch (error) {
      log.warn?.(`Heartbeat watch failed: ${error.message}`);
    }
  }

  void beat();
  timers.push(setInterval(beat, beatEveryMs), setInterval(watch, watchEveryMs));
  // Give the other bot time to report after a joint restart before the first comparison.
  timers.push(setTimeout(watch, watchEveryMs));
  for (const timer of timers) timer.unref?.();
  return () => timers.forEach((timer) => { clearInterval(timer); clearTimeout(timer); });
}
