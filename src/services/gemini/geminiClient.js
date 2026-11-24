// geminiClient.js — one generateContent request to the Gemini REST API, with Node's global fetch (no SDK).
//
// The API key goes in the x-goog-api-key header, never in the URL, and it never appears in an error message
// or a log line: GeminiError only carries the kind of failure and the HTTP status. Nothing here retries.

import { GEMINI_API_BASE } from '../../config/geminiRoom.js';

/** Gemini's own safety filters, on for every request (the default for current models is off). */
export const GEMINI_SAFETY_SETTINGS = Object.freeze([
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => Object.freeze({ category, threshold: 'BLOCK_MEDIUM_AND_ABOVE' })));

const BLOCKED_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);
const MAX_RETRY_AFTER_MS = 5 * 60_000;

export class GeminiError extends Error {
  /** kind: 'timeout' | 'network' | 'http' | 'bad_response'. */
  constructor(kind, { status = null, retryAfterMs = null, detail = '' } = {}) {
    super(`Gemini request failed (${kind}${status ? ` ${status}` : ''})`);
    this.name = 'GeminiError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.detail = detail; // Google's short message, for the log only; never contains the key
  }
}

const isTimeout = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError';

function retryAfterOf(response) {
  const seconds = Number(response?.headers?.get?.('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null;
}

/** POSTs `body` to models/{model}:generateContent and resolves to the parsed JSON. Throws GeminiError. */
export async function generateContent({ apiKey, model, body, timeoutMs, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new GeminiError('network');
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))),
    });
  } catch (error) {
    throw new GeminiError(isTimeout(error) ? 'timeout' : 'network');
  }
  if (!response?.ok) {
    const detail = await errorDetail(response, apiKey);
    try { await response?.body?.cancel?.(); } catch { /* the body is not needed */ }
    throw new GeminiError('http', { status: response?.status ?? null, retryAfterMs: retryAfterOf(response), detail });
  }
  try {
    return await response.json();
  } catch (error) {
    throw new GeminiError(isTimeout(error) ? 'timeout' : 'bad_response');
  }
}

/** Google's short error message (never the key), for the log only. Empty when there is none. */
async function errorDetail(response, apiKey) {
  try {
    if (typeof response?.text !== 'function') return '';
    const raw = String(await response.text()).slice(0, 2000);
    let message = raw;
    try { message = JSON.parse(raw)?.error?.message ?? raw; } catch { /* not JSON */ }
    let clean = String(message).replace(/\s+/gu, ' ');
    if (apiKey) clean = clean.split(apiKey).join('[key]');
    return clean.slice(0, 240);
  } catch {
    return '';
  }
}

const NOT_FOR_CHAT = /(tts|image|embed|live|audio|vision|robotics|computer-use|aqa|imagen|veo|learnlm|gemma|native|exp|latest-?preview-?\d{2}-\d{2})/iu;

/**
 * The chat-capable Gemini models the key can use, best first: stable Flash by version, then other Flash, then Pro.
 * Returns model IDs (no "models/" prefix). Throws GeminiError.
 */
export async function listChatModels({ apiKey, timeoutMs = 8000, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new GeminiError('network');
  let response;
  try {
    response = await fetchImpl(`${GEMINI_API_BASE}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))),
    });
  } catch (error) {
    throw new GeminiError(isTimeout(error) ? 'timeout' : 'network');
  }
  if (!response?.ok) {
    try { await response?.body?.cancel?.(); } catch { /* not needed */ }
    throw new GeminiError('http', { status: response?.status ?? null });
  }
  let json;
  try { json = await response.json(); } catch { throw new GeminiError('bad_response'); }
  const version = (name) => Number(String(name).match(/gemini-(\d+(?:\.\d+)?)/u)?.[1] ?? 0);
  const rank = (name) => (/flash/u.test(name) && !/lite/u.test(name) ? 3 : /flash/u.test(name) ? 2 : /pro/u.test(name) ? 1 : 0);
  return (json?.models || [])
    .filter((model) => (model?.supportedGenerationMethods || []).includes('generateContent'))
    .map((model) => String(model.name || '').replace(/^models\//u, ''))
    .filter((name) => /^gemini-\d/u.test(name) && !NOT_FOR_CHAT.test(name))
    .sort((a, b) => (/preview/u.test(a) - /preview/u.test(b)) || rank(b) - rank(a) || version(b) - version(a) || a.localeCompare(b));
}

/**
 * The useful part of a generateContent response: the answer text (thought parts left out), the function
 * calls, the model's turn as it came (it is sent back unchanged with the tool results, thought signatures
 * included), and whether Gemini blocked the prompt or the answer.
 */
export function readAnswer(json) {
  if (json?.promptFeedback?.blockReason) return { blocked: true, text: '', calls: [], content: null };
  const candidate = Array.isArray(json?.candidates) ? json.candidates[0] : null;
  const content = candidate?.content && typeof candidate.content === 'object' ? candidate.content : null;
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const text = parts.filter((part) => typeof part?.text === 'string' && !part.thought).map((part) => part.text).join('').trim();
  const calls = parts
    .filter((part) => part?.functionCall && typeof part.functionCall.name === 'string')
    .map((part) => part.functionCall);
  return { blocked: BLOCKED_FINISH.has(candidate?.finishReason), text, calls, content };
}
