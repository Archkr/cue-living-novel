import { expect, test } from "bun:test";
import { installFakeDocument } from "./stage-test-dom.js";
import { VnStage } from "./vn-stage.js";

for (const themePreset of ["literature-club", "yamaku-classic"] as const) {
  test(`${themePreset} preserves authored quotes without wrapping character narration`, () => {
    const restore = installFakeDocument();
    let stage: VnStage | undefined;
    try {
      const mount = document.createElement("div");
      stage = new VnStage({ mount, themePreset, textSpeed: 0 });
      const examples = [
        ["*She glances toward the window.*", "She glances toward the window."],
        ["She glances toward the window.", "She glances toward the window."],
        ['"Come here," she says.', '"Come here," she says.'],
        ["“Come here.”", "“Come here.”"],
      ] as const;
      for (const [index, [text, expected]] of examples.entries()) {
        stage.loadTurn({
          mode: "standard",
          paragraphs: [{ id: `p-${index}`, speaker: "Mira", text }],
          choices: [],
        });
        expect(mount.querySelector("[data-vn-dialogue-text]")!.textContent).toBe(expected);
      }
    } finally {
      stage?.destroy();
      restore();
    }
  });
}
