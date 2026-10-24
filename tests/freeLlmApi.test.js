import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import { getFreeLlmApiConfig, chatWithFreeLlmApi } from '../src/services/llm/freeLlmApi.js';

const NON_HOME_GUILD_ID = '100000000000000001';

describe('freeLlmApi config', () => {
  test('parses defaults and normalizes values', () => {
    const defaults = getFreeLlmApiConfig({});
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.baseUrl, 'http://localhost:3001/v1');
    assert.equal(defaults.apiKey, '');
    assert.equal(defaults.model, 'auto');
    assert.equal(defaults.timeoutMs, 15_000);

    const parsed = getFreeLlmApiConfig({
      FREELLMAPI_ENABLED: ' true ',
      FREELLMAPI_BASE_URL: ' http://127.0.0.1:3001/v1/ ',
      FREELLMAPI_API_KEY: '  unified-key  ',
      FREELLMAPI_MODEL: ' llama-3.3-70b ',
      FREELLMAPI_TIMEOUT_MS: '32000',
    });

    assert.equal(parsed.enabled, true);
    assert.equal(parsed.baseUrl, 'http://127.0.0.1:3001/v1');
    assert.equal(parsed.apiKey, 'unified-key');
    assert.equal(parsed.model, 'llama-3.3-70b');
    assert.equal(parsed.timeoutMs, 32_000);
  });
});

describe('chatWithFreeLlmApi', () => {
  const messages = [{ role: 'user', content: 'hello' }];

  test('skips non-home guilds and never calls fetch', async () => {
    let called = false;
    const result = await chatWithFreeLlmApi({
      guildId: NON_HOME_GUILD_ID,
      messages,
      fetchImpl: async () => {
        called = true;
        return { ok: true, json: async () => ({}) };
      },
      config: {
        enabled: true,
        apiKey: 'key',
        baseUrl: 'http://localhost:3001/v1',
        model: 'auto',
        timeoutMs: 50,
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_home');
    assert.equal(called, false);
  });

  test('returns disabled and missing_api_key states safely', async () => {
    const disabled = await chatWithFreeLlmApi({
      guildId: HOME_GUILD_ID,
      messages,
      config: {
        enabled: false,
        apiKey: 'key',
        baseUrl: 'http://localhost:3001/v1',
        model: 'auto',
        timeoutMs: 50,
      },
    });
    assert.deepEqual(disabled, { ok: false, reason: 'disabled' });

    const missingKey = await chatWithFreeLlmApi({
      guildId: HOME_GUILD_ID,
      messages,
      config: {
        enabled: true,
        apiKey: '',
        baseUrl: 'http://localhost:3001/v1',
        model: 'auto',
        timeoutMs: 50,
      },
    });

    assert.deepEqual(missingKey, { ok: false, reason: 'missing_api_key' });
  });

  test('handles timeout and network failures', async () => {
    const timeoutResult = await chatWithFreeLlmApi({
      guildId: HOME_GUILD_ID,
      messages,
      fetchImpl: async (_url, { signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      }),
      config: {
        enabled: true,
        apiKey: 'key',
        baseUrl: 'http://localhost:3001/v1',
        model: 'auto',
        timeoutMs: 5,
      },
    });

    assert.deepEqual(timeoutResult, { ok: false, reason: 'timeout' });

    const failureResult = await chatWithFreeLlmApi({
      guildId: HOME_GUILD_ID,
      messages,
      fetchImpl: async () => {
        throw new Error('network down');
      },
      config: {
        enabled: true,
        apiKey: 'key',
        baseUrl: 'http://localhost:3001/v1',
        model: 'auto',
        timeoutMs: 100,
      },
    });

    assert.deepEqual(failureResult, { ok: false, reason: 'request_failed' });
  });

  test('parses successful OpenAI-compatible responses', async () => {
    const calls = [];
    const result = await chatWithFreeLlmApi({
      guildId: HOME_GUILD_ID,
      messages,
      model: 'my-model',
      temperature: 0.1,
      maxTokens: 50,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          json: async () => ({
            model: 'my-model',
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            choices: [{ message: { content: 'Hi from FreeLLMAPI' } }],
          }),
        };
      },
      config: {
        enabled: true,
        apiKey: 'unified-key',
        baseUrl: 'http://localhost:3001/v1',
        model: 'auto',
        timeoutMs: 100,
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://localhost:3001/v1/chat/completions');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(typeof calls[0].init.headers.Authorization, 'string');
    assert.ok(calls[0].init.headers.Authorization.length > 7);
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      model: 'my-model',
      messages,
      temperature: 0.1,
      max_tokens: 50,
    });
    assert.equal(result.ok, true);
    assert.equal(result.content, 'Hi from FreeLLMAPI');
    assert.equal(result.model, 'my-model');
    assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });
});
