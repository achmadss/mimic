# mimic

Human-like chat engine. Design: `docs/README.md`. Plans: `docs/superpowers/plans/`.

## Run

```bash
npm install
cp .env.example .env   # fill TYPESAFE_API_KEY, LLM_API_KEY, LLM_MODEL (list: GET $LLM_BASE_URL/models)
npm run cli -- rick    # or morty; chat in the terminal
npm start              # Telegram/Discord for every character with a token set
npm test
```

## Characters

One JSON file per character in `characters/`, loaded at startup — adding a
persona is a file, never a code change. See **`characters/README.md`** for the
fields, the token env vars, and how to bind one character to Telegram, Discord,
or both. `characters/_template.json` is a complete character to copy.

Each character has their own identity, traits, quirks, speech style and daily
routine, in their own timezone: activity, reply speed, attention and (on
Discord) online status all follow that routine through the day.

`LLM_STRUCTURED_MODE` picks how the reply schema is enforced: `tool` (default, reliable),
`json_schema`, or `json_object`. On OpenCode Go, `json_schema` fails with a bare 400
(`{"model":"..."}`) on roughly half of requests for `deepseek-v4.1-flash` — it is not a
retryable error and the turn is silently dropped, so prefer `tool`.

The OpenCode Go endpoint also requires the model id *without* the `opencode-go/` prefix
(that prefix is for OpenCode config only), and each model is served on a specific route:
`/chat/completions` for DeepSeek, GLM, Kimi, LongCat, Hy4; `/responses` for GPT, Grok, Muse
Spark; `/messages` for MiniMax and Qwen.
