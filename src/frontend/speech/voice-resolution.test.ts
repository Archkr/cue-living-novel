import { describe, expect, test } from "bun:test";

import { characterOverrideKey, resolveVoiceForParagraph, speakerNameKey } from "./voice-resolution.js";
import type { SpeechVoiceRef } from "../../speech-config.js";

const narrator: SpeechVoiceRef = { connectionId: "conn-n", voice: "Kore" };
const fallback: SpeechVoiceRef = { connectionId: "conn-d", voice: "Puck" };
const mira: SpeechVoiceRef = { connectionId: "conn-m", voice: "Aoede" };

const settings = {
  narrator,
  characterDefault: fallback,
  characters: { [characterOverrideKey("chat-1", "Mira")]: mira },
};

describe("voice resolution mirrors nameplate semantics", () => {
  test("empty string speaker is the intentional narrator", () => {
    const resolved = resolveVoiceForParagraph(settings, { chatId: "chat-1", paragraphSpeaker: "", turnSpeaker: "Mira" });
    expect(resolved.role).toBe("narrator");
    expect(resolved.ref).toBe(narrator);
    expect(resolved.source).toBe("narrator");
  });

  test("null/undefined speaker falls back to the TURN speaker, not the narrator", () => {
    for (const unknown of [null, undefined]) {
      const resolved = resolveVoiceForParagraph(settings, { chatId: "chat-1", paragraphSpeaker: unknown, turnSpeaker: "Mira" });
      expect(resolved.role).toBe("character");
      expect(resolved.speakerName).toBe("Mira");
      expect(resolved.ref).toBe(mira);
    }
  });

  test("named speaker resolves override -> characterDefault -> narrator", () => {
    expect(resolveVoiceForParagraph(settings, { chatId: "chat-1", paragraphSpeaker: "Mira", turnSpeaker: "X" }).ref).toBe(mira);
    expect(resolveVoiceForParagraph(settings, { chatId: "chat-1", paragraphSpeaker: "Stranger", turnSpeaker: "X" }).ref).toBe(fallback);
    const noDefault = { ...settings, characterDefault: null };
    const resolved = resolveVoiceForParagraph(noDefault, { chatId: "chat-1", paragraphSpeaker: "Stranger", turnSpeaker: "X" });
    expect(resolved.ref).toBe(narrator);
    expect(resolved.source).toBe("narrator");
  });

  test("name matching is case/whitespace-insensitive but never fuzzy", () => {
    expect(resolveVoiceForParagraph(settings, { chatId: "chat-1", paragraphSpeaker: "  MIRA ", turnSpeaker: "X" }).ref).toBe(mira);
    expect(resolveVoiceForParagraph(settings, { chatId: "chat-1", paragraphSpeaker: "Mirabelle", turnSpeaker: "X" }).ref).toBe(fallback);
  });

  test("a same-named character in ANOTHER chat never steals the override", () => {
    const resolved = resolveVoiceForParagraph(settings, { chatId: "chat-2", paragraphSpeaker: "Mira", turnSpeaker: "Mira" });
    expect(resolved.ref).toBe(fallback);
    expect(resolved.source).toBe("character-default");
  });

  test("nothing configured => truthful none, never a silent first-profile fallback", () => {
    const empty = { narrator: null, characterDefault: null, characters: {} };
    const narration = resolveVoiceForParagraph(empty, { chatId: "c", paragraphSpeaker: "", turnSpeaker: "X" });
    expect(narration.ref).toBeNull();
    expect(narration.source).toBe("none");
    const named = resolveVoiceForParagraph(empty, { chatId: "c", paragraphSpeaker: "Mira", turnSpeaker: "X" });
    expect(named.ref).toBeNull();
    expect(named.source).toBe("none");
  });

  test("narration falls back to the character default when no narrator is set", () => {
    const noNarrator = { ...settings, narrator: null };
    const resolved = resolveVoiceForParagraph(noNarrator, { chatId: "chat-1", paragraphSpeaker: "", turnSpeaker: "X" });
    expect(resolved.ref).toBe(fallback);
    expect(resolved.source).toBe("character-default");
  });

  test("override keys are chat-scoped and normalized", () => {
    expect(characterOverrideKey("chat-1", "  Mira  Song ")).toBe("chat::chat-1::mira song");
    expect(speakerNameKey("MIRA")).toBe("mira");
  });
});
