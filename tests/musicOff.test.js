import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOffCommand, isSilentCommand } from '../src/config/commands/commandAvailability.js';
import { MUSIC_COMMAND_NAMES, musicEnabled } from '../src/config/music/musicFeature.js';
import { resolveCommandAlias } from '../src/config/commands/commandAliases.js';
import { botConfig, isCommandCategoryEnabled } from '../src/config/bot.js';
import { registerCommands } from '../src/handlers/loaders/commandLoader.js';
import play from '../src/commands/Music/play.js';
import ping from '../src/commands/Core/ping.js';
import interactionCreate from '../src/events/interactionCreate.js';

test('music is off by default and MUSIC_ENABLED=true turns it back on', () => {
    assert.equal(musicEnabled({}), false);
    assert.equal(musicEnabled({ MUSIC_ENABLED: 'true' }), true);
    assert.equal(musicEnabled({ MUSIC_ENABLED: 'false' }), false);
    assert.equal(botConfig.features.music, false, 'no Lavalink connection at startup, no music voice handler');
    assert.equal(isCommandCategoryEnabled('Music'), false);
});

test('every music command and its typed words get no answer', () => {
    for (const name of ['join', 'music', 'nowplaying', 'play', 'queue']) {
        assert.ok(MUSIC_COMMAND_NAMES.has(name));
        assert.equal(isOffCommand(name), true, name);
        assert.equal(isSilentCommand(name), true, name);
    }
    for (const word of ['شغل', 'play', 'np', 'now', 'queue', 'join', 'nowplaying']) {
        assert.equal(isSilentCommand(resolveCommandAlias(word)), true, word);
    }
    assert.equal(isSilentCommand('ping'), false);
});

test('the music slash commands are not registered and stale ones return silently', async () => {
    const requests = [];
    await registerCommands({
        commands: new Map([[play.data.name, play], [ping.data.name, ping]]),
        rest: { put: async (route, payload) => requests.push(payload) },
    }, { clientId: '100000000000000001' });
    assert.deepEqual(requests[0].body.map((command) => command.name), ['ping']);
    let touched = 0;
    await interactionCreate.execute({ commandName: 'play', isChatInputCommand: () => true, reply: () => { touched += 1; } }, { commands: { get: () => { touched += 1; } } });
    assert.equal(touched, 0);
});
