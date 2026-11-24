// geminiRoom.js — the Gemini chat room (owner's request of 2026-11-24, docs/gemini-room.md).
//
// In a server's Gemini room the bot answers a normal message with Google Gemini only when it is mentioned or replied to. GEMINI_API_KEY turns it
// on (no key = off, with one warning in the log); GEMINI_MODEL picks the model. The rooms below are the
// defaults; an owner can set or turn off the room of any server with `/gemini-room` (saved in the database
// under GEMINI_ROOMS_DB_KEY, which wins over these defaults). Works in every server (all-servers rule).

/** Server ID -> its Gemini room (channel ID). */
export const GEMINI_DEFAULT_ROOMS = Object.freeze({
  // Zenith
  '1569932761471524874': '1570728122259611779',
});

export const GEMINI_ROOMS_DB_KEY = 'gemini:rooms';

// The newest stable Flash model on 2026-11-24 (gemini-2.5-pro and gemini-2.5-flash are deprecated and get
// rerouted on 2026-12-01). Flash keeps the short answers well inside the 20 second limit.
export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const GEMINI_LIMITS = Object.freeze({
  timeoutMs: 20_000, // one answer, every request to Gemini for it included
  maxInputChars: 1_500, // a longer message gets a short "make it shorter" answer and no request
  perUserPerMinute: 5,
  globalPerMinute: 30, // every server together
  maxConcurrent: 4,
  windowMs: 60_000,
  contextMessages: 6, // earlier messages of the same room sent with the question
  contextMaxAgeMs: 30 * 60_000,
  contextCharsEach: 300,
  maxOutputTokens: 2_048,
  maxReplyMessages: 3, // an answer is at most 3 Discord messages of 2000 characters
  maxToolCalls: 2, // tool calls run for one owner message
  confirmMs: 2 * 60_000, // how long the owner's confirm button works
  roomsCacheMs: 5 * 60_000,
});

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{1,79}$/u;

/** The Gemini API key, or '' when it is not set (the room is off then). */
export function geminiApiKey(env = process.env) {
  return String(env?.GEMINI_API_KEY ?? '').trim();
}

/**
 * Optional: tried first when the main model answers 500/502/503/504 (overloaded) or 404. Empty = none; the bot then
 * uses the chat models the API key can list.
 */
export function geminiFallbackModel(env = process.env) {
  const model = String(env?.GEMINI_FALLBACK_MODEL ?? '').trim().toLowerCase().replace(/^models\//u, '');
  return MODEL_ID.test(model) ? model : '';
}

/** GEMINI_MODEL when it looks like a model ID (it goes into the request URL), otherwise the default. */
export function geminiModel(env = process.env) {
  const model = String(env?.GEMINI_MODEL ?? '').trim().toLowerCase().replace(/^models\//u, '');
  return MODEL_ID.test(model) ? model : GEMINI_DEFAULT_MODEL;
}
