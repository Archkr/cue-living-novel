import type { SpeechDeliveryMode } from "../../speech-config.js";

/**
 * Outbound speech-text decoration.
 *
 * Bumped whenever formatting changes so cache keys never serve audio produced
 * by an older formatter for the same prose.
 */
export const DELIVERY_ADAPTER_VERSION = 3;

/**
 * The "commonly used" inline audio tags from the official Gemini
 * speech-generation guide (https://ai.google.dev/gemini-api/docs/speech-generation,
 * #audio-tags). The docs state there is NO exhaustive supported-tag list; these
 * are suggestions for the picker, and free text is allowed. They are
 * probabilistic performance guidance for Gemini-family TTS models only — other
 * providers may read the bracket text aloud.
 */
export const GEMINI_AUDIO_TAG_SUGGESTIONS: readonly string[] = [
  "amazed", "crying", "curious", "excited", "sighs", "gasp", "giggles", "laughs",
  "mischievously", "panicked", "sarcastic", "serious", "shouting", "tired",
  "trembling", "whispers",
];

/**
 * Build the exact text sent to the synthesis endpoint. The visible paragraph
 * prose is NEVER modified; this only decorates the outbound copy.
 *
 * - mode "none": byte-identical prose.
 * - mode "gemini-audio-tags" with a nonempty tag: `[tag] ` + prose, matching the
 *   documented inline-modifier syntax (no closing tag exists in the docs).
 * - mode "gemini-audio-tags" with an empty tag: prose unchanged (no invented tag).
 */
/**
 * Whether the selected profile's route supports the documented Gemini audio
 * tags. Only a Gemini-family model id qualifies; any other provider/model gets
 * the tag ONLY through the clearly-labeled `deliveryAllProviders` compatibility
 * opt-in (default off), because it may read the bracket text aloud.
 */
export function deliveryTagAllowedForModel(
  mode: SpeechDeliveryMode,
  profileModel: string,
  applyToAllProviders: boolean,
): boolean {
  if (mode !== "gemini-audio-tags") return false;
  if (applyToAllProviders) return true;
  return /gemini/i.test(profileModel);
}

export function formatOutboundText(text: string, mode: SpeechDeliveryMode, tag: string): string {
  if (mode !== "gemini-audio-tags") return text;
  // The tag is free text typed by the user. Reduce it to one safe token so
  // bracket/angle markup cannot smuggle extra tags or prompt content into the
  // outbound request: strip outer brackets, drop anything outside letters,
  // digits, space, hyphen and underscore, collapse whitespace, cap length.
  const stripped = tag.trim().replace(/^\[+|\]+$/g, "").trim();
  const safe = stripped.replace(/[^A-Za-z0-9 _-]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!safe) return text;
  return `[${safe}] ${text}`;
}
