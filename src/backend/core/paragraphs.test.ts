import { describe, expect, test } from "bun:test";
import { extractInlineCardImages, extractInlineCardImagesWithParagraphs, prepareNarrative } from "./paragraphs.js";

describe("narrative preparation", () => {
  test("hides comment-delimited metadata and choices across paragraphs without shifting source indexes", () => {
    const prepared = prepareNarrative("Before.\n\n<!-- GFX_START -->\nGraphics notes.\n\n<Choice>Hidden choice</Choice>\n<!-- GFX_END -->\n\nAfter.");
    expect(prepared.paragraphs).toEqual([
      { index: 0, sourceIndex: 0, text: "Before." },
      { index: 1, sourceIndex: 3, text: "After." },
    ]);
    expect(prepared.choices).toEqual([]);
  });

  test("hides nested, repeated and unfinished comment-delimited blocks", () => {
    const prepared = prepareNarrative("Before.\n\n<!-- gfx_start -->outer<!-- GFX_START -->inner<!-- GFX_END -->outer<!-- gfx_end -->\n\nMiddle.\n\n<!-- GFX_START -->more<!-- GFX_END -->\n\nAfter.\n\n<!-- GFX_START -->unfinished");
    expect(prepared.paragraphs.map((p) => p.text)).toEqual(["Before.", "Middle.", "After."]);
  });

  test("removes standalone and multiline comments while keeping ordinary formatting", () => {
    const prepared = prepareNarrative("Before.<!-- note -->\n\n<!-- hidden\n\ncomment -->\n\nA <em>visible</em> word.\n\n<!-- unfinished");
    expect(prepared.paragraphs).toEqual([
      { index: 0, sourceIndex: 0, text: "Before." },
      { index: 1, sourceIndex: 3, text: "A <em>visible</em> word." },
    ]);
  });

  test("keeps graphics available as panels without reading their wrapper or metadata", () => {
    const prepared = prepareNarrative("Before.\n\n<!-- GFX_START -->\nGraphics notes.\n<div>HP: 10</div>\n<!-- GFX_END -->\n\nAfter.");
    expect(prepared.paragraphs.map((p) => p.text)).toEqual(["Before.", "After."]);
    expect(prepared.panels.map((p) => p.html)).toEqual(["<div>HP: 10</div>"]);
  });

  test("keeps paragraph source indexes after removing metadata", () => {
    const prepared = prepareNarrative("First paragraph.\n\n<Think>hidden</Think>\n\nSecond paragraph.", { ignoredTags: ["Think"] });
    expect(prepared.paragraphs).toEqual([
      { index: 0, sourceIndex: 0, text: "First paragraph." },
      { index: 1, sourceIndex: 2, text: "Second paragraph." }
    ]);
  });

  test("extracts single authored choices with attributes", () => {
    const prepared = prepareNarrative([
      "The door waits.",
      "",
      "<Choice id=\"enter\" value=\"I enter the room.\">Enter</Choice>",
      "<Choice message='I walk away.'>Leave</Choice>"
    ].join("\n"));
    expect(prepared.paragraphs).toEqual([{ index: 0, sourceIndex: 0, text: "The door waits." }]);
    expect(prepared.choices).toEqual([
      { id: "enter", label: "Enter", submission: "I enter the room.", source: "authored", unlocksAfterParagraph: 0 },
      { id: expect.stringMatching(/^choice-/), label: "Leave", submission: "I walk away.", source: "authored", unlocksAfterParagraph: 0 }
    ]);
  });

  test("does not renumber narrative blocks around a choice block", () => {
    const prepared = prepareNarrative("Before.\n\n<Choice>Continue</Choice>\n\nAfter.");
    expect(prepared.paragraphs).toEqual([
      { index: 0, sourceIndex: 0, text: "Before." },
      { index: 1, sourceIndex: 2, text: "After." }
    ]);
  });

  test("extracts a bullet list from one Choice block and creates stable unique IDs", () => {
    const content = "Answer now.\n\n<Choice>\n- Yes\n- No\n- Yes\n</Choice>";
    const first = prepareNarrative(content);
    const second = prepareNarrative(content);
    expect(first.choices.map(({ label }) => label)).toEqual(["Yes", "No", "Yes"]);
    expect(new Set(first.choices.map(({ id }) => id))).toHaveLength(3);
    expect(first.choices.map(({ id }) => id)).toEqual(second.choices.map(({ id }) => id));
  });

  test("extractInlineCardImages extracts asset names and strips tags", () => {
    const raw = 'Look at this: <img="neeko_excited"> and {{img::neeko_smug}} with <img src="neeko_neutral">';
    const extracted = extractInlineCardImages(raw);
    expect(extracted.assetNames).toEqual(["neeko_excited", "neeko_smug", "neeko_neutral"]);
    expect(extracted.text).toBe("Look at this:  and  with ");
  });


  test("extractInlineCardImages treats RisuAI <pimg=\"name\"> like <img=\"name\">", () => {
    const raw = "Seated upon the throne was the Empress.\n\n<pimg=\"aurelia\">\n\nHer golden eyes shone.\n\n<pimg=\"elizabeth_smirking\">";
    const extracted = extractInlineCardImages(raw);
    expect(extracted.assetNames).toEqual(["aurelia", "elizabeth_smirking"]);
    expect(extracted.text).not.toContain("pimg");
    const prepared = prepareNarrative(raw);
    expect(prepared.paragraphs.map((p) => p.text)).toEqual(["Seated upon the throne was the Empress.", "Her golden eyes shone."]);
    const placed = extractInlineCardImagesWithParagraphs(raw, prepared.paragraphs);
    expect(placed).toEqual([{ name: "aurelia", paragraphIndex: 0 }, { name: "elizabeth_smirking", paragraphIndex: 1 }]);
  });

  test("extractInlineCardImages supports unquoted img=expression tags", () => {
    const raw = 'An expression: <img=neeko_curious> and quoted <img="neeko_happy">';
    const extracted = extractInlineCardImages(raw);
    expect(extracted.assetNames).toEqual(["neeko_curious", "neeko_happy"]);
    expect(extracted.text).toBe("An expression:  and quoted ");
  });

  test("extractInlineCardImagesWithParagraphs maps unquoted and pipe-caption markers", () => {
    const content = 'She smiles.\n\n<img=neeko_curious> | <"😏:Hi">\n\nThen she looks away.';
    const prepared = prepareNarrative(content);
    const images = extractInlineCardImagesWithParagraphs(content, prepared.paragraphs);
    expect(images).toEqual([{ name: "neeko_curious", paragraphIndex: 0 }]);
  });

  test("prepareNarrative strips inline card images from paragraphs", () => {
    const content = 'Neeko says hello! <img="neeko_wave">\n\nShe winks. {{img::neeko_wink}}';
    const prepared = prepareNarrative(content);
    expect(prepared.paragraphs).toEqual([
      { index: 0, sourceIndex: 0, text: "Neeko says hello!" },
      { index: 1, sourceIndex: 1, text: "She winks." },
    ]);
  });

  test("prepareNarrative strips custom ignoredTags including bracket syntax", () => {
    const content = [
      "Before status window.",
      "",
      "<status>",
      "HP: 100/100",
      "MP: 50/50",
      "</status>",
      "",
      "[Status]",
      "Level 5 Adventurer",
      "[/Status]",
      "",
      "After status window.",
    ].join("\n");
    const prepared = prepareNarrative(content, { ignoredTags: ["status"] });
    expect(prepared.paragraphs).toEqual([
      { index: 0, sourceIndex: 0, text: "Before status window." },
      { index: 1, sourceIndex: 3, text: "After status window." },
    ]);
  });

  test("extractChoices rejects numeric attributes.value and preserves actual choice text", () => {
    const content = 'Some story text.\n\n<Choice id="2" value="2">Step closer and call her bluff</Choice>';
    const prepared = prepareNarrative(content);
    expect(prepared.choices).toEqual([
      {
        id: "2",
        label: "Step closer and call her bluff",
        submission: "Step closer and call her bluff",
        source: "authored",
        unlocksAfterParagraph: 0,
      },
    ]);
  });
});
