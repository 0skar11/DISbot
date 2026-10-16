# Optional FreeLLMAPI backend (OpenAI-compatible)

DISbot can optionally call a self-hosted [FreeLLMAPI router](https://github.com/tashfeenahmed/freellmapi) through its OpenAI-compatible endpoint. This is optional and OFF by default.

## What this does (and does not do)

- It adds a small integration layer (`src/services/llm/freeLlmApi.js`) for `/v1/chat/completions`.
- It does **not** enable any end-user AI command by itself.
- It does **not** bypass Claude/Copilot usage limits or credits.

## Setup

1. Run FreeLLMAPI separately (Docker/Desktop or your preferred method from its repository).
2. Open FreeLLMAPI dashboard.
3. Add your upstream provider keys there (for example Groq/Gemini/OpenRouter, etc.).
4. Copy the unified API key from FreeLLMAPI.
5. In DISbot `.env`, set:

```env
FREELLMAPI_ENABLED=true
FREELLMAPI_BASE_URL=http://localhost:3001/v1
FREELLMAPI_API_KEY=your_unified_key_here
FREELLMAPI_MODEL=auto
FREELLMAPI_TIMEOUT_MS=15000
```

Default base URL is exactly `http://localhost:3001/v1`.

If you keep `FREELLMAPI_ENABLED=false`, DISbot behavior stays unchanged.
