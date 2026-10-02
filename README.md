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

### Voice examples

A persona describes a character; examples are what make them *sound* like one.
`examples` is offline content — a tagged stretch of source dialogue, retrieved at
reply time by `(characterId, emotion)` and labelled in the prompt as speech, so
the model copies the voice and not the screenplay formatting.

```
npm run ingest -- --dry     # what the CSV would produce, nothing written
npm run ingest              # cut, tag with Jev, store
```

Reads `~/Downloads/rickmorty-transcripts/Rick-n-Morty.csv` (override with
`--csv`), takes up to `--limit` exchanges per character from the characters in
`characters/`, and writes into the same SQLite file the bot uses. It is
`INSERT OR REPLACE`, so re-running is safe. Nothing on the reply path ever calls
it: a character with no examples simply gets no example block, and replies
normally.

The ingest is also where those characters get their open threads — a
`conversation.unresolved` list the bot is reminded to ask about. Nothing to set
up; it fills as people mention things that have not happened yet.

`LLM_STRUCTURED_MODE` picks how the reply schema is enforced: `tool` (default, reliable),
`json_schema`, or `json_object`. On OpenCode Go, `json_schema` fails with a bare 400
(`{"model":"..."}`) on roughly half of requests for `deepseek-v4.1-flash` — it is not a
retryable error and the turn is silently dropped, so prefer `tool`.

The OpenCode Go endpoint also requires the model id *without* the `opencode-go/` prefix
(that prefix is for OpenCode config only), and each model is served on a specific route:
`/chat/completions` for DeepSeek, GLM, Kimi, LongCat, Hy4; `/responses` for GPT, Grok, Muse
Spark; `/messages` for MiniMax and Qwen.
