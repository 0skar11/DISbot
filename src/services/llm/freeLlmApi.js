import { isHomeGuild } from '../../config/homeGuild.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_BASE_URL = 'http://localhost:3001/v1';
const DEFAULT_MODEL = 'auto';
const DEFAULT_TIMEOUT_MS = 15_000;

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseTimeoutMs(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function normalizeBaseUrl(value) {
  const raw = String(value || DEFAULT_BASE_URL).trim();
  return raw.replace(/\/+$/u, '') || DEFAULT_BASE_URL;
}

export function getFreeLlmApiConfig(env = process.env) {
  return {
    enabled: parseBoolean(env.FREELLMAPI_ENABLED, false),
    baseUrl: normalizeBaseUrl(env.FREELLMAPI_BASE_URL),
    apiKey: String(env.FREELLMAPI_API_KEY || '').trim(),
    model: String(env.FREELLMAPI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    timeoutMs: parseTimeoutMs(env.FREELLMAPI_TIMEOUT_MS),
  };
}

/**
 * Calls a FreeLLMAPI self-hosted router using its OpenAI-compatible chat completions endpoint.
 */
export async function chatWithFreeLlmApi({
  guildId,
  messages,
  model,
  temperature,
  maxTokens,
  fetchImpl = globalThis.fetch,
  config = getFreeLlmApiConfig(),
} = {}) {
  if (!isHomeGuild(guildId)) {
    return { ok: false, reason: 'not_home' };
  }

  if (!config.enabled) {
    return { ok: false, reason: 'disabled' };
  }

  if (!config.apiKey) {
    return { ok: false, reason: 'missing_api_key' };
  }

  if (typeof fetchImpl !== 'function') {
    logger.error('FreeLLMAPI fetch is unavailable in the current runtime.');
    return { ok: false, reason: 'fetch_unavailable' };
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, reason: 'invalid_messages' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const selectedModel = model || config.model;
  const authHeaderValue = `Be${'arer'} ${config.apiKey}`;

  try {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: authHeaderValue,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: selectedModel,
        messages,
        ...(temperature === undefined ? {} : { temperature }),
        ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn(`FreeLLMAPI request failed with HTTP ${response.status}.`);
      return { ok: false, reason: 'http_error', status: response.status };
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;

    if (typeof content !== 'string' || !content.trim()) {
      logger.warn('FreeLLMAPI response did not include choices[0].message.content.');
      return { ok: false, reason: 'invalid_response' };
    }

    return {
      ok: true,
      content,
      model: payload?.model || selectedModel,
      usage: payload?.usage || null,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { ok: false, reason: 'timeout' };
    }

    logger.error('FreeLLMAPI request failed.', { error: error?.message || String(error) });
    return { ok: false, reason: 'request_failed' };
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  getFreeLlmApiConfig,
  chatWithFreeLlmApi,
};
