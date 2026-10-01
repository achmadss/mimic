# mimic-telethon

A small containerized [Telethon](https://codeberg.org/Lonami/Telethon) service that exposes the
Telegram MTProto user API over a plain HTTP JSON API. It lets an **AI agent send and read
Telegram messages on behalf of a human user account**.

The service runs the persistent Telegram session in Docker and only exposes a local HTTP port,
so an agent (or any script) can call it with `curl` / `httpx` without dealing with Telegram
protocol details or interactive logins.

```
AI agent / script ──HTTP──▶ mimic-telethon ──MTProto──▶ Telegram
                                   │
                                   └── ./data/agent.session (persistent login)
```

## Requirements

- Docker + Docker Compose v2
- Telegram API credentials (`api_id` / `api_hash`) from <https://my.telegram.org> →
  **API development tools**
- A Telegram user account (phone number) that the agent will act as

> **This acts as *you*.** The session file grants full access to the account. Anyone with the
> session string or the `./data` volume can read and send as that user. Keep it private.

## Quick start

### 1. Configure

```bash
cp .env.example .env
```

Edit `.env`:

| Variable            | Required | Description                                                        |
| ------------------- | -------- | ------------------------------------------------------------------ |
| `TELEGRAM_API_ID`   | yes      | From my.telegram.org                                               |
| `TELEGRAM_API_HASH` | yes      | From my.telegram.org                                               |
| `SESSION_DIR`       | no       | Where the session file lives (default `/data`, mounted to `./data`) |
| `SESSION_NAME`      | no       | Session filename without extension (default `agent`)               |
| `API_TOKEN`         | no       | If set, every request must send `Authorization: Bearer <API_TOKEN>` |

### 2. Start the service

```bash
docker compose up -d --build
```

### 3. Log in (one time, human step)

The session persists in `./data/agent.session`, so this only needs to happen once. A human has
to supply the login code from their Telegram app:

```bash
# Sends a login code to the account
curl -s -X POST localhost:8000/login/start \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+15551234567"}'

# Complete login with the code from the Telegram app
curl -s -X POST localhost:8000/login/verify \
  -H 'Content-Type: application/json' \
  -d '{"code":"12345"}'
```

If the account has 2FA enabled, `/login/verify` returns `428` with
`{"detail":"2FA password required"}`. Retry including the password:

```bash
curl -s -X POST localhost:8000/login/verify \
  -H 'Content-Type: application/json' \
  -d '{"code":"12345","password":"your-2fa-password"}'
```

Confirm you're authorized:

```bash
curl -s localhost:8000/health
# {"connected":true,"authorized":true}
```

## API reference

Base URL: `http://127.0.0.1:8000`

If `API_TOKEN` is set, include `Authorization: Bearer <token>` on **every** request except none —
all endpoints are protected.

### `GET /health`

```json
{ "connected": true, "authorized": true }
```

### `POST /send`

Send a message as the logged-in user.

Request body:

```json
{ "to": "@my_bot", "message": "hello from the agent" }
```

`to` accepts a username (`@my_bot` or `my_bot`), a phone number, or a numeric user/chat id.

Response:

```json
{ "status": "sent", "message_id": 12345, "to": "@my_bot" }
```

### `GET /messages/{peer}?limit=20`

Read recent messages from a chat. `peer` is a username, phone, or id; `limit` defaults to 20.

```json
{
  "peer": "@my_bot",
  "messages": [
    { "id": 42, "out": false, "date": "2026-10-01T12:00:00+00:00", "sender_id": 777, "text": "pong" }
  ]
}
```

`out` is `true` for messages sent by this account, `false` for incoming ones. `date` may be
`null`.

### `POST /login/start`

```json
{ "phone": "+15551234567" }
```

Returns `{"status":"code_sent","phone":"+15551234567"}` or
`{"status":"already_authorized"}`.

### `POST /login/verify`

```json
{ "code": "12345", "password": "optional-2fa-password" }
```

Returns `{"status":"authorized","id":...,"username":...}` on success.

### `POST /logout`

Logs out and invalidates the session. Returns `{"status":"logged_out"}`.

## Error handling

| Status | Meaning                                                         |
| ------ | --------------------------------------------------------------- |
| `400`  | Bad peer, invalid login code, or invalid 2FA password           |
| `401`  | Not logged in, or missing/incorrect `API_TOKEN`                 |
| `428`  | 2FA password required — retry `/login/verify` with `password`   |

Errors use the standard FastAPI shape: `{"detail": "..."}`.

## Orchestrator CLI

For simple agent/tool calls, a bundled CLI wraps the API:

```bash
docker compose exec telethon python scripts/cli.py health
docker compose exec telethon python scripts/cli.py send --to @my_bot --message "hello"
docker compose exec telethon python scripts/cli.py read --peer @my_bot --limit 5
```

It reads `MIMIC_BASE_URL` (default `http://127.0.0.1:8000`) and `MIMIC_API_TOKEN` from the
environment, or accepts `--base-url` / `--token`.

## Typical agent workflow

1. `GET /health` → confirm `authorized` is `true`.
2. `POST /send` to the target bot with the outgoing message.
3. Poll `GET /messages/{peer}?limit=N` to read the bot's reply.
4. Repeat as needed.

## Operations

- Rebuild after code changes: `docker compose up -d --build`
- Logs: `docker compose logs -f telethon`
- Reset the login: `docker compose down` then delete `./data/agent.session` and re-run the login flow.
- The port is bound to `127.0.0.1` only. To let a remote agent reach it, either change the
  mapping in `docker-compose.yml` or put it behind a reverse proxy with `API_TOKEN` enabled.

## Security notes

- Never commit `.env` or `./data/` — both are git-ignored by default.
- `./data/agent.session` is a full-access credential for the Telegram account; treat it like an
  SSH private key.
- Always set `API_TOKEN` if anything other than localhost can reach the port.
- This library drives the account through Telegram's user API; misuse can get the account
  limited or banned. Keep volumes and endpoints private and test against your own bot.
