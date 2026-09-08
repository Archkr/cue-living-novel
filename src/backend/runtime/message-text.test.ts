import { describe, expect, test } from "bun:test";
import type { SpindleAPI } from "lumiverse-spindle-types";
import {
  cleanResolvedText,
  isUnselectedGreeting,
  needsResolution,
  resolveContextMessages,
  resolveMessageText,
  type MessageResolutionCache
} from "./message-text.js";
import {
  RAW_GREETING,
  RESOLVED_GREETING_S0,
  RESOLVED_GREETING_S1,
  S0_PLACEHOLDER_TEXT,
  S1_SCENE_TEXT
} from "./__fixtures__/greeting-macro.js";

function macroSpindle(resolveImpl?: (template: string) => string | Promise<string>): { spindle: SpindleAPI; calls: () => number } {
  let calls = 0;
  const spindle = {
    macros: {
      resolve: async (template: string) => {
        calls += 1;
        if (!resolveImpl) return { text: template, diagnostics: [] };
        return { text: await resolveImpl(template), diagnostics: [] };
      }
    }
  } as unknown as SpindleAPI;
  return { spindle, calls: () => calls };
}

const ORDINARY = "Mira steps forward.\n\nShe smiles at the door.";

describe("needsResolution", () => {
  test("ordinary prose does not need resolution", () => {
    expect(needsResolution(ORDINARY)).toBe(false);
  });
  test("a {{img::...}} token alone does not need resolution", () => {
    expect(needsResolution('Look. {{img::aurelia}}')).toBe(false);
  });
  test("macro syntax and placeholder lines need resolution", () => {
    expect(needsResolution(RAW_GREETING)).toBe(true);
    expect(needsResolution("$messageSelector\n\nStory.")).toBe(true);
    expect(needsResolution("Hello {{user}}.")).toBe(true);
  });
});

describe("cleanResolvedText", () => {
  test("ordinary text passes through unchanged", () => {
    expect(cleanResolvedText(ORDINARY)).toBe(ORDINARY);
  });

  test("drops unresolved when-blocks with their content and the placeholder line", () => {
    const cleaned = cleanResolvedText(RAW_GREETING);
    expect(cleaned).toBe("");
  });

  test("keeps narrative around unresolved blocks", () => {
    const cleaned = cleanResolvedText(`Before.\n\n{{#when::{{equal::{{getvar::x}}::1}}}}\nHidden scene.\n{{/when}}\n\nAfter.`);
    expect(cleaned).toBe("Before.\n\nAfter.");
  });

  test("handles nested when-blocks as one removal", () => {
    const nested = "Intro.\n\n{{#when::a}}outer {{#when::b}}inner{{/when}} tail{{/when}}\n\nOutro.";
    expect(cleanResolvedText(nested)).toBe("Intro.\n\nOutro.");
  });

  test("an unmatched closer or opener loses only the marker, not the narrative", () => {
    expect(cleanResolvedText("Story continues.{{/when}} More text.")).toBe("Story continues. More text.");
    expect(cleanResolvedText("{{#when::{{getvar::x}}}}\nStory continues.")).toBe("Story continues.");
  });

  test("drops placeholder-only lines but keeps $names inside sentences", () => {
    expect(cleanResolvedText("$messageSelector\n\nThe story starts.")).toBe("The story starts.");
    expect(cleanResolvedText("  $faction_picker  \n\nThe story starts.")).toBe("The story starts.");
    expect(cleanResolvedText("She paid $five for it. The $item glowed.")).toBe("She paid $five for it. The $item glowed.");
  });

  test("keeps <pimg>/<img> tags and {{img::...}} tokens intact", () => {
    const text = 'Scene.\n\n<pimg="aurelia">\n\n{{img::mira_smile}}\n\n<img src="a.png">';
    expect(cleanResolvedText(text)).toBe(text);
  });

  test("keeps {{char}}/{{user}} display macros for the planner to substitute", () => {
    expect(cleanResolvedText("{{char}} greets {{user}} warmly.")).toBe("{{char}} greets {{user}} warmly.");
  });

  test("strips other leftover inline macros, including nested ones", () => {
    expect(cleanResolvedText("Value: {{getvar::firstMessage}}!")).toBe("Value: !");
    expect(cleanResolvedText("Deep {{getvar::{{lower::X}}}} end.")).toBe("Deep  end.");
    expect(cleanResolvedText("Mixed {{getvar::{{user}}}} end.")).toBe("Mixed  end.");
    expect(cleanResolvedText("Stray {{ brace stays out.")).toBe("Stray  brace stays out.");
  });

  test("is idempotent on every fixture input", () => {
    for (const input of [ORDINARY, RAW_GREETING, RESOLVED_GREETING_S1, RESOLVED_GREETING_S0, "{{char}} and {{img::a}}"]) {
      const once = cleanResolvedText(input);
      expect(cleanResolvedText(once)).toBe(once);
    }
  });

  test("real resolved s1 scene keeps its narrative and sprite tag", () => {
    const cleaned = cleanResolvedText(RESOLVED_GREETING_S1);
    expect(cleaned).toContain("The cradle of humanity");
    expect(cleaned).toContain('<pimg="aurelia">');
    expect(cleaned).not.toContain("$messageSelector");
    expect(cleaned).not.toContain("{{");
  });
});

describe("resolveMessageText", () => {
  test("H1: ordinary message never reaches the host and returns byte-identical", async () => {
    const { spindle, calls } = macroSpindle();
    const input = "  Mira steps forward.\n\nDone.  ";
    expect(await resolveMessageText(spindle, "chat", input)).toBe(input);
    expect(calls()).toBe(0);
  });

  test("H2: with LumiRealm the selected scene survives, selector and macro syntax do not", async () => {
    const { spindle, calls } = macroSpindle(() => RESOLVED_GREETING_S1);
    const resolved = await resolveMessageText(spindle, "chat", RAW_GREETING);
    expect(calls()).toBe(1);
    expect(resolved).toContain("The cradle of humanity");
    expect(resolved).toContain('<pimg="aurelia">');
    expect(resolved).not.toContain("$messageSelector");
    expect(resolved).not.toContain("{{");
    expect(resolved).toBe(cleanResolvedText(S1_SCENE_TEXT));
  });

  test("H3: a host without the interceptor leaves blocks; the cleaner empties them", async () => {
    const { spindle } = macroSpindle();
    const resolved = await resolveMessageText(spindle, "chat", RAW_GREETING);
    expect(resolved).toBe("");
  });

  test("H5: a throwing resolve falls back to cleaning the raw text", async () => {
    const spindle = {
      macros: { resolve: async () => { throw new Error("host down"); } }
    } as unknown as SpindleAPI;
    const resolved = await resolveMessageText(spindle, "chat", "$messageSelector\n\n{{getvar::x}} The story starts.");
    expect(resolved).toBe("The story starts.");
  });

  test("a missing macros API cleans locally", async () => {
    const spindle = {} as unknown as SpindleAPI;
    const resolved = await resolveMessageText(spindle, "chat", "{{getvar::x}}Hello.");
    expect(resolved).toBe("Hello.");
  });
});

describe("resolveContextMessages", () => {
  test("H6: macro messages resolve once per id+swipe; ordinary ones never reach the host", async () => {
    const { spindle, calls } = macroSpindle((template) => template.replace(/\{\{[^{}]*\}\}/g, "Mira"));
    const cache: MessageResolutionCache = new Map();
    const history = [
      { id: "m1", swipe_id: 0, content: "Plain text." },
      { id: "m2", swipe_id: 0, content: "Hello {{char}}." },
      { id: "m3", swipe_id: 1, content: "Bye {{char}}." }
    ];
    const first = await resolveContextMessages(spindle, "chat", history, cache);
    expect(calls()).toBe(2);
    expect(first[0]!.content).toBe("Plain text.");
    expect(first[1]!.content).toBe("Hello Mira.");
    const again = await resolveContextMessages(spindle, "chat", history, cache);
    expect(calls()).toBe(2);
    expect(again[2]!.content).toBe("Bye Mira.");
  });
});

describe("isUnselectedGreeting", () => {
  test("raw greeting resolved to the s0 placeholder is unselected", () => {
    expect(isUnselectedGreeting(RAW_GREETING, cleanResolvedText(RESOLVED_GREETING_S0))).toBe(true);
    expect(S0_PLACEHOLDER_TEXT.length).toBeLessThan(120);
  });
  test("raw greeting cleaned to nothing is unselected", () => {
    expect(isUnselectedGreeting(RAW_GREETING, "")).toBe(true);
  });
  test("a selected multi-paragraph scene is not unselected", () => {
    expect(isUnselectedGreeting(RAW_GREETING, cleanResolvedText(RESOLVED_GREETING_S1))).toBe(false);
  });
  test("ordinary short messages are never treated as unselected", () => {
    expect(isUnselectedGreeting("Hi.", "Hi.")).toBe(false);
    expect(isUnselectedGreeting("", "")).toBe(false);
  });
  test("a short line that keeps an inline image tag is not unselected", () => {
    expect(isUnselectedGreeting(RAW_GREETING, 'She waits. <pimg="aurelia">')).toBe(false);
  });
});

describe("audit regressions (cleaner and rule)", () => {
  test("audit F2: whitespace inside block delimiters still strips the whole block", () => {
    expect(cleanResolvedText("{{#when::s1}}\nSecret scene 1\n{{/when }}\n\nPublic narrative.")).toBe("Public narrative.");
    expect(cleanResolvedText("{{ #when::s1}}\nSecret scene 2\n{{ /when }}\n\nPublic narrative.")).toBe("Public narrative.");
    expect(cleanResolvedText("{{# when::s1}}\nSecret scene 3\n{{/ when}}\n\nPublic narrative.")).toBe("Public narrative.");
  });

  test("audit F2: inverted {{^when}} blocks are stripped like {{#when}} blocks", () => {
    expect(cleanResolvedText("{{^when::s1}}\nSecret inverted scene\n{{/when}}\n\nPublic narrative.")).toBe("Public narrative.");
  });

  test("audit F3: an unclosed outer block does not leak later matched blocks", () => {
    const text = "{{#when::outer}}\nOuter narrative\n{{#when::inner}}\nInner secret\n{{/when}}\n\nTrailing.";
    const cleaned = cleanResolvedText(text);
    expect(cleaned).not.toContain("Inner secret");
    // Only the unmatched opener marker is dropped; its surrounding text stays.
    expect(cleaned).toContain("Outer narrative");
    expect(cleaned).toContain("Trailing.");
  });

  test("audit F7: a legitimate short scene without placeholder evidence is planned, not blocked", () => {
    const raw = "{{#when::s1}}Darkness surrounds you.{{/when}}{{#when::s2}}Sunlight burns.{{/when}}";
    expect(isUnselectedGreeting(raw, "Darkness surrounds you.")).toBe(false);
  });

  test("audit F7: default-branch evidence still yields the waiting state", () => {
    // Placeholder line + two blocks + cleaned text equal to the first block's
    // single-line body: this is the unset-variable fallback branch.
    const raw = "$picker\n\n{{#when::s0}}Enjoy freely.{{/when}}\n\n{{#when::s1}}A long real scene.\n\nWith paragraphs.{{/when}}";
    expect(isUnselectedGreeting(raw, "Enjoy freely.")).toBe(true);
    // The same single line WITHOUT the placeholder line is planned.
    const noPlaceholder = "{{#when::s0}}Enjoy freely.{{/when}}\n\n{{#when::s1}}A long real scene.\n\nWith paragraphs.{{/when}}";
    expect(isUnselectedGreeting(noPlaceholder, "Enjoy freely.")).toBe(false);
    // A multi-paragraph first-block body is real narrative, never blocked.
    const longDefault = "$picker\n\n{{#when::s0}}Real opening.\n\nSecond paragraph.{{/when}}\n\n{{#when::s1}}Other.{{/when}}";
    expect(isUnselectedGreeting(longDefault, "Real opening.\n\nSecond paragraph.")).toBe(false);
  });
});
