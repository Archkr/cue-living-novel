import { describe, expect, test } from "bun:test";

import { formatOutboundText, GEMINI_AUDIO_TAG_SUGGESTIONS } from "./delivery.js";

describe("speech delivery formatting", () => {
  test("mode none sends the prose byte-identical", () => {
    const prose = "  “You came back,” she says. [sic]\n";
    expect(formatOutboundText(prose, "none", "whispers")).toBe(prose);
  });

  test("gemini-audio-tags prepends exactly one documented-style inline tag", () => {
    expect(formatOutboundText("Have a wonderful day!", "gemini-audio-tags", "whispers"))
      .toBe("[whispers] Have a wonderful day!");
  });

  test("an empty tag selection never invents a tag", () => {
    expect(formatOutboundText("Hello.", "gemini-audio-tags", "")).toBe("Hello.");
    expect(formatOutboundText("Hello.", "gemini-audio-tags", "   ")).toBe("Hello.");
  });

  test("user-typed brackets are not doubled", () => {
    expect(formatOutboundText("Hello.", "gemini-audio-tags", "[laughs]")).toBe("[laughs] Hello.");
  });

  test("suggestions are the documented commonly-used set, lowercase, no brackets", () => {
    expect(GEMINI_AUDIO_TAG_SUGGESTIONS).toContain("whispers");
    expect(GEMINI_AUDIO_TAG_SUGGESTIONS).toContain("sighs");
    for (const tag of GEMINI_AUDIO_TAG_SUGGESTIONS) {
      expect(tag).not.toMatch(/[\[\]<>=]/);
    }
  });
});

describe("delivery tag route gating", () => {
  test("tags require gemini-audio-tags mode AND a Gemini-family model, or the explicit opt-in", async () => {
    const { deliveryTagAllowedForModel } = await import("./delivery.js");
    expect(deliveryTagAllowedForModel("none", "google/gemini-2.5-flash-tts", true)).toBe(false);
    expect(deliveryTagAllowedForModel("gemini-audio-tags", "google/gemini-2.5-flash-tts", false)).toBe(true);
    expect(deliveryTagAllowedForModel("gemini-audio-tags", "Gemini-2.5-pro-tts", false)).toBe(true);
    expect(deliveryTagAllowedForModel("gemini-audio-tags", "gpt-4o-mini-tts", false)).toBe(false);
    expect(deliveryTagAllowedForModel("gemini-audio-tags", "", false)).toBe(false);
    expect(deliveryTagAllowedForModel("gemini-audio-tags", "gpt-4o-mini-tts", true)).toBe(true);
  });
});

describe("delivery tag sanitizing (audit remediation)", () => {
  test("bracket and markup content in a tag collapses to one safe token", () => {
    expect(formatOutboundText("Good morning.", "gemini-audio-tags", 'whispers] [shouts] <break time="10s"/>'))
      .toBe("[whispers shouts break time10s] Good morning.");
  });

  test("a tag that is only punctuation sends no tag at all", () => {
    expect(formatOutboundText("Hello.", "gemini-audio-tags", "[[[ ]]]")).toBe("Hello.");
    expect(formatOutboundText("Hello.", "gemini-audio-tags", "<>")).toBe("Hello.");
  });

  test("plain tags keep working, including user-typed brackets", () => {
    expect(formatOutboundText("Hello.", "gemini-audio-tags", "very slow")).toBe("[very slow] Hello.");
    expect(formatOutboundText("Hello.", "gemini-audio-tags", "[laughs]")).toBe("[laughs] Hello.");
  });
});
