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

### Commands

Out-of-character controls, in any chat with a character. Each one acts on that
chat only. On Telegram they appear in the `/` menu; on Discord they are slash
commands in the bot's DMs; in the CLI, type them as a line.

| Command | Does |
|---|---|
| `/status` | What the character is doing, their local time and mood; this chat's topic, queued messages, follow-up and open threads |
| `/memory` | The facts, recent notes and open threads kept for this chat |
| `/forget` | Drop that memory and the open threads; keep the chat history |
| `/reset` | Start the chat over: cancel queued messages, delete history and memory |
| `/debug` | The last turn's decision (respond mode, topic action, pace, emotion) and what context it was built from |
| `/help` | The list |

Command replies are never stored as messages, so the character never sees them.
Telegram's automatic `/start` is ignored, so a new chat does not open with a menu.

### Memory

Nothing to set up for any of this; it fills from the conversation itself.

- **Open threads.** A `conversation.unresolved` list of things the user
  mentioned that have not happened yet (or a subject the character set aside),
  which the bot is reminded to ask about later.
- **Notes.** Once messages fall out of the recent window, a background LLM call
  summarizes them and keeps durable facts about the user (table `memories`).
  Replies get the notes that best match what is being talked about.
- **Who they are to each other.** How long they have been talking and how the
  user texts, derived from the message history on every turn.

`LLM_STRUCTURED_MODE` picks how the reply schema is enforced: `tool` (default, reliable),
`json_schema`, or `json_object`. On OpenCode Go, `json_schema` fails with a bare 400
(`{"model":"..."}`) on roughly half of requests for `deepseek-v4.1-flash` — it is not a
retryable error and the turn is silently dropped, so prefer `tool`.

The OpenCode Go endpoint also requires the model id *without* the `opencode-go/` prefix
(that prefix is for OpenCode config only), and each model is served on a specific route:
`/chat/completions` for DeepSeek, GLM, Kimi, LongCat, Hy4; `/responses` for GPT, Grok, Muse
Spark; `/messages` for MiniMax and Qwen.
