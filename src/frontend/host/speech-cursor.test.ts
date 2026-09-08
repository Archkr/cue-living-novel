import { describe, expect, test } from "bun:test";

import { speechCursorFor } from "./controller.js";
import type { TurnView } from "../../protocol.js";

const turn = (overrides: Partial<TurnView> = {}): TurnView => ({
  chatId: "chat-1",
  messageId: "msg-1",
  swipeId: 0,
  sourceFingerprint: "fp-1",
  revision: 1,
  speaker: "Mira",
  paragraphs: ["Narration.", "“Hi.”"],
  paragraphSpeakers: ["", "Mira"],
  choices: [],
  assets: [],
  status: "ready",
  ...overrides,
});

describe("speechCursorFor", () => {
  test("preserves the tri-state paragraph attribution exactly", () => {
    const view = turn({ paragraphSpeakers: ["", null, "Mira"] as Array<string | null>, paragraphs: ["a", "b", "c"] });
    expect(speechCursorFor(view, 0)?.paragraphSpeaker).toBe("");
    expect(speechCursorFor(view, 1)?.paragraphSpeaker).toBeNull();
    expect(speechCursorFor(view, 2)?.paragraphSpeaker).toBe("Mira");
    const noAttribution = turn();
    delete noAttribution.paragraphSpeakers;
    expect(noAttribution.paragraphSpeakers).toBeUndefined();
    expect(speechCursorFor(noAttribution, 0)?.paragraphSpeaker).toBeUndefined();
  });

  test("carries the turn identity used by the same-turn no-replay guard", () => {
    const cursor = speechCursorFor(turn(), 1)!;
    expect(cursor.chatId).toBe("chat-1");
    expect(cursor.messageId).toBe("msg-1");
    expect(cursor.sourceFingerprint).toBe("fp-1");
    expect(cursor.paragraphIndex).toBe(1);
    expect(cursor.text).toBe("“Hi.”");
    expect(cursor.turnSpeaker).toBe("Mira");
  });

  test("returns null for out-of-range paragraphs (planning/empty turns cannot speak)", () => {
    expect(speechCursorFor(turn(), 5)).toBeNull();
    expect(speechCursorFor(turn({ paragraphs: [] }), 0)).toBeNull();
  });

  test("generates 1-level lookahead next cursor for upcoming paragraph", () => {
    const view = turn({ paragraphs: ["p0", "p1", "p2"] });
    const c0 = speechCursorFor(view, 0)!;
    expect(c0.paragraphIndex).toBe(0);
    expect(c0.next?.paragraphIndex).toBe(1);
    expect(c0.next?.text).toBe("p1");
    // Next cursor itself has next: null (strictly 1-level)
    expect(c0.next?.next).toBeNull();

    const c2 = speechCursorFor(view, 2)!;
    expect(c2.paragraphIndex).toBe(2);
    expect(c2.next).toBeNull();
  });

});
