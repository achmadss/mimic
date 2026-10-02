import { availability, formatLocalTime } from "../character/derived.ts";
import { moodNow } from "../character/mood.ts";
import { openThreads } from "../context/context.ts";
import type { Deps } from "./respond.ts";

/**
 * Out-of-character controls for the person in the chat. Each acts on that one conversation only,
 * which is the whole access model: anyone can manage their own chat and nobody else's.
 *
 * Replies go straight to the platform and are never stored as messages, so the character never
 * sees them and never answers one.
 */
export const COMMANDS = {
  help: "What these commands do",
  status: "What the character is doing, and what is queued in this chat",
  memory: "What the character remembers about you",
  forget: "Forget what the character remembers, but keep the chat",
  reset: "Start this chat over: history, memory and queued messages",
  debug: "Why the last reply came out the way it did",
} as const;
export type CommandName = keyof typeof COMMANDS;

/** `/Status@rick_bot now` → `status`. Null for anything that is not a known command. */
export function parseCommand(text: string): CommandName | null {
  const m = text.trim().match(/^\/([a-z]+)(?:@\S+)?(?:\s|$)/i);
  const name = m?.[1].toLowerCase();
  return name && name in COMMANDS ? (name as CommandName) : null;
}

const ago = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)}d`;

/** Runs inside the conversation's serial queue, so a reset cannot interleave with a reply. */
export function runCommand(d: Deps, conversationId: string, name: CommandName): string {
  const { store, clock, config } = d;
  const now = clock.now();
  const conv = store.getConversation(conversationId)!;
  const profile = d.profiles.get(conv.characterId)!;

  switch (name) {
    case "help":
      return Object.entries(COMMANDS).map(([k, v]) => `/${k} - ${v}`).join("\n");

    case "status": {
      const cs = store.getCharacterState(conv.characterId, now);
      const mood = moodNow(cs, now);
      const pending = store.pendingBotMessages(conversationId);
      const followUp = store.getAction(`followup:${conversationId}`);
      const open = openThreads(conv.unresolved, now, config);
      return [
        `${profile.name}: ${cs.activity} for ${ago(now - cs.activitySince)} (${availability(cs.activity)}), ${formatLocalTime(now, profile.timezone)} their time.`,
        mood === "neutral" ? "" : `Mood: ${mood}.`,
        `Topic: ${conv.topic ?? "none"}.`,
        pending.length ? `${pending.length} message(s) queued, next in ${ago(Math.max(0, pending[0].dueAt - now))}.` : "Nothing queued.",
        followUp ? `Follow-up in ${ago(Math.max(0, followUp.dueAt - now))}.` : "",
        open.length ? `Open threads: ${open.map((t) => t.summary).join("; ")}.` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "memory": {
      const facts = store.memories(conversationId, "fact", 50);
      const notes = store.memories(conversationId, "summary", 3);
      const open = openThreads(conv.unresolved, now, config);
      if (!facts.length && !notes.length && !open.length) return `${profile.name} doesn't remember anything about you yet.`;
      return [
        facts.length ? `Facts:\n${facts.map((f) => `- ${f.text}`).join("\n")}` : "",
        notes.length ? `Recent notes:\n${notes.map((n) => `- ${n.text}`).join("\n")}` : "",
        open.length ? `Meaning to ask about:\n${open.map((t) => `- ${t.summary}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    }

    case "forget": {
      store.tx(() => {
        const n = store.forgetMemories(conversationId);
        store.saveConversation({ ...store.getConversation(conversationId)!, unresolved: [] });
        store.appendEvent(conversationId, now, "MEMORY_FORGOTTEN", { memories: n });
      });
      return `${profile.name} has forgotten what they knew about you. The chat history is still there.`;
    }

    case "reset": {
      store.tx(() => {
        for (const m of store.pendingBotMessages(conversationId)) d.scheduler.cancel(m.id);
        d.scheduler.cancel(`followup:${conversationId}`);
        d.scheduler.cancel(`turn:${conversationId}`);
        store.deleteTurnBuffer(conversationId);
        store.resetConversation(conversationId);
        // the version bump is the stale guard: anything already built for this chat is now dead
        const c = store.getConversation(conversationId)!;
        store.saveConversation({ ...c, version: c.version + 1, topic: null, topicStartedAt: null, attention: null, attentionRaisedAt: null, unresolved: [] });
        store.appendEvent(conversationId, now, "CONVERSATION_RESET", {});
      });
      return `Chat reset. ${profile.name} won't remember any of it.`;
    }

    case "debug": {
      const decision = store.lastEvent(conversationId, "BEHAVIOR_DECISION_CREATED");
      if (!decision) return "No reply has been decided in this chat yet.";
      const ctx = store.lastEvent(conversationId, "CONTEXT_RETRIEVED");
      const p = decision.payload;
      return [
        `Last decision, ${ago(now - decision.at)} ago:`,
        `respond ${p.respondMode}, topic ${p.topicAction}, pace ${p.pace}, ${p.messageCount} x ${p.messageLength}`,
        `emotion ${p.emotion ?? "-"}, mood ${p.mood ?? "unchanged"}, opens thread ${p.openThread ? "yes" : "no"}${p.followUp ? `, follow-up in ${ago(p.followUp.afterMs)}` : ""}`,
        p.answers ? "" : "Jev was unavailable; defaults were used.",
        ctx && ctx.at >= decision.at
          ? `Context: ${ctx.payload.window} window of ${ctx.payload.messages} messages, ${ctx.payload.examples.length} examples, ${ctx.payload.memories?.length ?? 0} memories, asking about ${ctx.payload.asking.length} thread(s).`
          : "No reply was generated for it.",
      ]
        .filter(Boolean)
        .join("\n");
    }
  }
}
