import type { SpeechSettings, SpeechVoiceRef } from "../../speech-config.js";

/**
 * Pure voice resolution for one paragraph, mirroring the stage nameplate
 * semantics in `host/controller.ts#nameplateForParagraph`:
 * - `''`  -> intentional narrator;
 * - named -> that character/persona name;
 * - null/undefined -> unknown, falls back to the turn speaker (NOT the narrator).
 */

/** Case-insensitive, whitespace-collapsed name key (never a card id — Cue only has names). */
export function speakerNameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Chat-scoped override key. Scoping to the chat id prevents a same-named
 * character in another chat from stealing this chat's voice.
 */
export function characterOverrideKey(chatId: string, name: string): string {
  return `chat::${chatId}::${speakerNameKey(name)}`;
}

export type ResolvedVoice = {
  ref: SpeechVoiceRef | null;
  /** Which configured slot supplied the ref; "none" = unconfigured (stay silent, hint at settings). */
  source: "character-override" | "character-default" | "narrator" | "none";
  role: "narrator" | "character";
  /** Display name the resolution was performed for ("" for narrator). */
  speakerName: string;
};

export function resolveVoiceForParagraph(
  settings: Pick<SpeechSettings, "narrator" | "characterDefault" | "characters">,
  input: { chatId: string; paragraphSpeaker: string | null | undefined; turnSpeaker: string },
): ResolvedVoice {
  const attributed = input.paragraphSpeaker;
  // null/undefined = unknown attribution: fall back to the turn speaker, exactly
  // like the nameplate. Empty string is the intentional narrator.
  const name = attributed === undefined || attributed === null ? input.turnSpeaker : attributed;
  if (name.trim() === "") {
    if (settings.narrator) return { ref: settings.narrator, source: "narrator", role: "narrator", speakerName: "" };
    if (settings.characterDefault) {
      return { ref: settings.characterDefault, source: "character-default", role: "narrator", speakerName: "" };
    }
    return { ref: null, source: "none", role: "narrator", speakerName: "" };
  }
  const override = settings.characters[characterOverrideKey(input.chatId, name)];
  if (override) return { ref: override, source: "character-override", role: "character", speakerName: name };
  if (settings.characterDefault) {
    return { ref: settings.characterDefault, source: "character-default", role: "character", speakerName: name };
  }
  if (settings.narrator) return { ref: settings.narrator, source: "narrator", role: "character", speakerName: name };
  return { ref: null, source: "none", role: "character", speakerName: name };
}
