import type { DB } from "./db.ts";
import type { ActionRow, BotMessage, CharacterState, ConversationState, Emotion, Example, MessageStatus, Platform, TurnBuffer, UnresolvedItem } from "./types.ts";

type Row = Record<string, any>;

const toConversation = (r: Row): ConversationState => ({
  conversationId: r.id,
  characterId: r.character_id,
  platform: r.platform,
  chatId: r.chat_id,
  version: r.version,
  topic: r.topic,
  topicStartedAt: r.topic_started_at,
  lastUserAt: r.last_user_at,
  lastBotAt: r.last_bot_at,
  attention: r.attention,
  attentionRaisedAt: r.attention_raised_at,
  unresolved: r.unresolved ? (JSON.parse(r.unresolved) as UnresolvedItem[]) : [],
});

const toExample = (r: Row): Example => ({
  id: r.id,
  characterId: r.character_id,
  episode: r.episode,
  emotion: r.emotion,
  secondary: r.secondary ? JSON.parse(r.secondary) : [],
  lines: JSON.parse(r.lines),
});

const toBotMessage = (r: Row): BotMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  generationId: r.generation_id,
  conversationVersion: r.conversation_version,
  text: r.text,
  order: r.ord,
  status: r.status,
  dueAt: r.due_at,
});

const toAction = (r: Row): ActionRow => ({ id: r.id, conversationId: r.conversation_id, kind: r.kind, dueAt: r.due_at });

export class Store {
  constructor(readonly db: DB) {}

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  appendEvent(conversationId: string, at: number, type: string, payload: unknown = {}) {
    this.db
      .prepare("INSERT INTO events (conversation_id, at, type, payload) VALUES (?, ?, ?, ?)")
      .run(conversationId, at, type, JSON.stringify(payload));
  }

  events(conversationId: string): { type: string; payload: any }[] {
    return this.db
      .prepare("SELECT type, payload FROM events WHERE conversation_id = ? ORDER BY seq")
      .all(conversationId)
      .map((r: any) => ({ type: r.type, payload: JSON.parse(r.payload) }));
  }

  getOrCreateConversation(characterId: string, platform: Platform, chatId: string): ConversationState {
    const id = `${characterId}:${platform}:${chatId}`;
    this.db
      .prepare("INSERT OR IGNORE INTO conversations (id, character_id, platform, chat_id) VALUES (?, ?, ?, ?)")
      .run(id, characterId, platform, chatId);
    return this.getConversation(id)!;
  }

  getConversation(id: string): ConversationState | undefined {
    const r = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Row | undefined;
    return r && toConversation(r);
  }

  saveConversation(c: ConversationState) {
    this.db
      .prepare(
        `UPDATE conversations SET version = ?, topic = ?, topic_started_at = ?, last_user_at = ?,
         last_bot_at = ?, attention = ?, attention_raised_at = ?, unresolved = ? WHERE id = ?`,
      )
      .run(
        c.version, c.topic, c.topicStartedAt, c.lastUserAt, c.lastBotAt, c.attention, c.attentionRaisedAt,
        JSON.stringify(c.unresolved ?? []), c.conversationId,
      );
  }

  /** Offline content, written only by the ingest script. Re-running it replaces by id. */
  saveExample(e: Example) {
    this.db
      .prepare("INSERT OR REPLACE INTO examples (id, character_id, episode, emotion, secondary, lines) VALUES (?, ?, ?, ?, ?, ?)")
      .run(e.id, e.characterId, e.episode, e.emotion, JSON.stringify(e.secondary), JSON.stringify(e.lines));
  }

  /**
   * The candidate pool for one emotion, bounded by `limit` — the seeded pick happens over this.
   * Primary matches fill the pool first; a secondary match only fills what is left.
   */
  examplesFor(characterId: string, emotion: Emotion, limit: number): Example[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM examples WHERE character_id = ?
             AND (emotion = ? OR EXISTS (SELECT 1 FROM json_each(examples.secondary) WHERE value = ?))
           ORDER BY emotion != ?, id LIMIT ?`,
        )
        .all(characterId, emotion, emotion, emotion, limit) as Row[]
    ).map(toExample);
  }

  /** Drops a character's examples the current cut no longer produces. Returns how many went. */
  pruneExamples(characterId: string, keep: Set<string>): number {
    const stale = (this.db.prepare("SELECT id FROM examples WHERE character_id = ?").all(characterId) as Row[])
      .map((r) => r.id as string)
      .filter((id) => !keep.has(id));
    const del = this.db.prepare("DELETE FROM examples WHERE id = ?");
    this.tx(() => stale.forEach((id) => del.run(id)));
    return stale.length;
  }

  exampleCount(characterId?: string): number {
    const r = characterId
      ? this.db.prepare("SELECT COUNT(*) AS n FROM examples WHERE character_id = ?").get(characterId)
      : this.db.prepare("SELECT COUNT(*) AS n FROM examples").get();
    return (r as { n: number }).n;
  }

  getCharacterState(characterId: string, now: number): CharacterState {
    this.db
      .prepare("INSERT OR IGNORE INTO character_state (character_id, activity, activity_since) VALUES (?, 'idle', ?)")
      .run(characterId, now);
    const r = this.db.prepare("SELECT * FROM character_state WHERE character_id = ?").get(characterId) as Row;
    return { characterId, activity: r.activity, activitySince: r.activity_since, mood: r.mood ?? null, moodChangedAt: r.mood_changed_at ?? null };
  }

  saveCharacterState(cs: CharacterState) {
    this.db
      .prepare("UPDATE character_state SET activity = ?, activity_since = ?, mood = ?, mood_changed_at = ? WHERE character_id = ?")
      .run(cs.activity, cs.activitySince, cs.mood, cs.moodChangedAt, cs.characterId);
  }

  conversationsForCharacter(characterId: string): ConversationState[] {
    return (this.db.prepare("SELECT * FROM conversations WHERE character_id = ?").all(characterId) as Row[]).map(toConversation);
  }

  /** Returns false when the id already exists (platform redelivery). */
  insertUserMessage(id: string, conversationId: string, text: string, at: number): boolean {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO messages (id, conversation_id, role, text, at) VALUES (?, ?, 'user', ?, ?)")
        .run(id, conversationId, text, at).changes === 1
    );
  }

  /**
   * User messages plus sent bot messages, oldest first, strictly before `before` and at/after
   * `since`. `since` is the topic-scoped window (doc 05 §5); 0 is the whole conversation.
   */
  recentMessages(conversationId: string, limit: number, before = Number.MAX_SAFE_INTEGER, since = 0): { role: "user" | "bot"; text: string; at: number }[] {
    return this.db
      .prepare(
        `SELECT role, text, at FROM (
           SELECT role, text, at, rowid AS rid FROM messages
           WHERE conversation_id = ? AND at < ? AND at >= ? AND (role = 'user' OR status = 'sent')
           ORDER BY at DESC, rid DESC LIMIT ?
         ) ORDER BY at, rid`,
      )
      .all(conversationId, before, since, limit) as { role: "user" | "bot"; text: string; at: number }[];
  }

  /** When they first wrote, and how many messages they have sent in all. */
  userMessageStats(conversationId: string): { firstAt: number | null; count: number } {
    const r = this.db
      .prepare("SELECT MIN(at) AS firstAt, COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'user'")
      .get(conversationId) as Row;
    return { firstAt: r.firstAt ?? null, count: r.n };
  }

  insertBotMessage(m: BotMessage) {
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, text, at, generation_id, conversation_version, ord, status, due_at)
         VALUES (?, ?, 'bot', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.id, m.conversationId, m.text, m.dueAt, m.generationId, m.conversationVersion, m.order, m.status, m.dueAt);
  }

  getBotMessage(id: string): BotMessage | undefined {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ? AND role = 'bot'").get(id) as Row | undefined;
    return r && toBotMessage(r);
  }

  updateBotMessage(m: BotMessage) {
    this.db
      .prepare("UPDATE messages SET conversation_version = ?, status = ?, due_at = ? WHERE id = ?")
      .run(m.conversationVersion, m.status, m.dueAt, m.id);
  }

  markSent(id: string, at: number) {
    this.db.prepare("UPDATE messages SET status = 'sent', at = ? WHERE id = ?").run(at, id);
  }

  pendingBotMessages(conversationId: string): BotMessage[] {
    return (
      this.db
        .prepare("SELECT * FROM messages WHERE conversation_id = ? AND role = 'bot' AND status = 'scheduled' ORDER BY due_at, ord")
        .all(conversationId) as Row[]
    ).map(toBotMessage);
  }

  /** Scheduled sends with no action row: a send that was held for a turn whose handler never finished. */
  scheduledBotMessagesWithoutAction(): BotMessage[] {
    return (
      this.db
        .prepare(
          `SELECT m.* FROM messages m LEFT JOIN actions a ON a.id = m.id
           WHERE m.role = 'bot' AND m.status = 'scheduled' AND a.id IS NULL
           ORDER BY m.due_at, m.ord`,
        )
        .all() as Row[]
    ).map(toBotMessage);
  }

  botMessagesWithStatus(status: MessageStatus): BotMessage[] {
    return (this.db.prepare("SELECT * FROM messages WHERE role = 'bot' AND status = ?").all(status) as Row[]).map(toBotMessage);
  }

  getTurnBuffer(conversationId: string): TurnBuffer | undefined {
    const r = this.db.prepare("SELECT * FROM turn_buffers WHERE conversation_id = ?").get(conversationId) as Row | undefined;
    return (
      r && {
        conversationId: r.conversation_id,
        messageIds: JSON.parse(r.message_ids),
        texts: JSON.parse(r.texts),
        firstAt: r.first_at,
        lastAt: r.last_at,
      }
    );
  }

  saveTurnBuffer(b: TurnBuffer) {
    this.db
      .prepare("INSERT OR REPLACE INTO turn_buffers (conversation_id, message_ids, texts, first_at, last_at) VALUES (?, ?, ?, ?, ?)")
      .run(b.conversationId, JSON.stringify(b.messageIds), JSON.stringify(b.texts), b.firstAt, b.lastAt);
  }

  deleteTurnBuffer(conversationId: string) {
    this.db.prepare("DELETE FROM turn_buffers WHERE conversation_id = ?").run(conversationId);
  }

  putAction(a: ActionRow) {
    this.db
      .prepare("INSERT OR REPLACE INTO actions (id, conversation_id, kind, due_at) VALUES (?, ?, ?, ?)")
      .run(a.id, a.conversationId, a.kind, a.dueAt);
  }

  getAction(id: string): ActionRow | undefined {
    const r = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as Row | undefined;
    return r && toAction(r);
  }

  deleteAction(id: string) {
    this.db.prepare("DELETE FROM actions WHERE id = ?").run(id);
  }

  allActions(): ActionRow[] {
    return (this.db.prepare("SELECT * FROM actions ORDER BY due_at, rowid").all() as Row[]).map(toAction);
  }
}
