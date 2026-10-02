# Characters

One JSON file per character. `main.ts` loads every `*.json` in this directory at
startup and brings up a bot for each platform that has a token, so **adding a
character is a file, never a code change**. Files starting with `_` are skipped
(that is what `_template.json` is for).

## Adding one

```bash
cp characters/_template.json characters/nadia.json
# edit it, then set characterId to match the filename
```

Paste its bot tokens on its page in the dashboard, and it is live (no restart).

`cp` alone will not work until you change `characterId` — the loader keys
characters by that field, not by the filename. A duplicate `characterId` in two
files means one silently wins.

## Platforms

`platforms` picks where a character lives. Any combination, including none:

```json
"platforms": {
  "telegram": { "botTokenEnv": "NADIA_TELEGRAM_TOKEN" },
  "discord":  { "botTokenEnv": "NADIA_DISCORD_TOKEN" }
}
```

- **Both** — the same character replies on both, with separate conversations
  and separate memory. They do not know about each other.
- **One** — omit the other key. The env var being unset is also fine; that
  platform is just skipped with no error.
- **Neither** — run `npm run cli -- nadia` to talk to them locally. Useful for
  writing a character before you make a bot account.

Two characters cannot share a token: the conversation id is
`${characterId}:${platform}:${chatId}`, so they would overwrite each other.

## Fields

| Field | What it does |
|---|---|
| `characterId` | Key, and the first segment of the conversation id. `[a-z0-9_]+`. |
| `name` | Display name. |
| `timezone` | IANA. Everything about their day is in this timezone, not yours. |
| `persona` | Prose summary. Goes to Jev as the character's brief — keep it to the essentials. |
| `identity` | Age, occupation, background, and who *you* are to them. |
| `traits` | Personality, as adjectives. |
| `likes` / `dislikes` | What they bring up and what they push back on. |
| `quirks` | Mannerisms the model should reach for. These are what make two characters sound different, more than `traits` does. |
| `stats` | Optional. A description, not a rule — nothing in the system computes on it. Write `10` as max unless you have a reason not to. |
| `speechStyle` | How they type: `lowercase` (0–1, share of messages that go lowercase), `typoRate`, `correctionRate` (of those typos, the share they fix), `maxCharsPerMessage`. |
| `basePace` | Their default speed: `instant`, `fast`, `normal`, `slow`, `very_slow`. |
| `activityBaselines` | Per activity: `attention` (0–1, how much you cut through) and `speedMultiplier` (how much slower they are). All nine activities are required. |
| `routine` | Their day. See below. |

## The routine

```json
"routine": [
  { "start": "07:00", "activity": "idle",     "jitterMin": 45 },
  { "start": "19:30", "activity": "working",  "jitterMin": 30 }
]
```

Slots run until the next one starts, and the last one wraps past midnight — so
the list above means *idle* from 07:00 to 19:30 and *working* from 19:30 all the
way to 07:00 the next morning, which is what a night shift actually looks like.

`start` is wall-clock in the character's `timezone`, so it stays right across
daylight saving. `jitterMin` moves the boundary by up to that many minutes,
picked once per day, so they do not wake up at the same instant every morning.
Keep it under an hour unless you want the day to look unstable.

Slots can repeat an activity — a character who is `working` in the morning and
again at night gets two slots, and the event trail will show the gap.

Activity drives reply speed, attention, whether a reply is deferred, and (on
Discord) their online status. A character with no routine sits at `idle`
forever, which is why the field is required.

## Notes

- `language` is `"en"` only for now.
- DMs only. Group chats are ignored.
- **Reaching a Discord bot.** Discord only lets someone DM a bot they share a
  server with. On boot the bot logs an invite link (`scope=bot`, no
  permissions); add it to any server your users are in, and they can open its
  profile and message it. It never posts in the server, and it needs no
  privileged intents: DM content reaches bots without Message Content.
- `persona` is required to be at least 20 characters and `background` at least
  10, so a stub cannot load by accident. They are not a substitute for the
  structured fields — a `persona` alone gives you a description, and it is
  `quirks` and `speechStyle` that give you a person.
