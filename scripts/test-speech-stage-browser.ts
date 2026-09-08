import { chromium, type Browser, type Page } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

await mkdir(".cache/speech-integration", { recursive: true });

const build = await Bun.build({ entrypoints: ["scripts/speech-stage-integration-fixture.ts"], target: "browser" });
if (!build.success) throw new Error(String(build.logs));
const bundle = await build.outputs[0]!.text();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => new URL(request.url).pathname === "/fixture.js"
    ? new Response(bundle, { headers: { "Content-Type": "application/javascript" } })
    : new Response('<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><script type="module" src="/fixture.js"></script></body></html>', { headers: { "Content-Type": "text/html" } })
});

const browser = await chromium.launch({ headless: true });
try {
  // 1. Desktop layout & hit-testing
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.locator("[data-integration-ready]").waitFor();

  // Inspect elementFromPoint at speech dock position (top center: x=512, y=25)
  const hit = await page.evaluate(() => {
    // Traverse down through shadow roots
    const el = document.elementFromPoint(512, 25);
    const stageHost = el?.hasAttribute("data-vn-stage-host");
    let innerHit: string | undefined;
    if (el?.shadowRoot) {
      const sub = el.shadowRoot.elementFromPoint(512, 25);
      if (sub?.tagName === "DIV" && sub?.classList.contains("vn-speech-dock") && sub.shadowRoot) {
        const dockSub = sub.shadowRoot.elementFromPoint(512, 25);
        innerHit = dockSub?.tagName;
      } else {
        innerHit = sub?.tagName;
      }
    }
    return { outerTag: el?.tagName, stageHost, innerHit };
  });
  console.log("Desktop top-center hit-test:", hit);

  // Click the Play button in the dock via mouse
  // First get the button bounding box
  const playButtonBox = await page.evaluate(() => {
    const stageHost = document.querySelector("[data-vn-stage-host]");
    const dockHost = stageHost?.shadowRoot?.querySelector(".vn-speech-dock");
    const playBtn = dockHost?.shadowRoot?.querySelector("button");
    if (!playBtn) return null;
    const r = playBtn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
  });
  assert.ok(playButtonBox, "Play button must be rendered in DOM");
  console.log("Play button box:", playButtonBox);

  // Click at the exact center of Play button
  await page.mouse.click(playButtonBox.x, playButtonBox.y);
  await page.waitForTimeout(50);

  const logsAfterPlay = await page.evaluate(() => [...(window as any).fixture.logs]);
  console.log("Logs after Play click:", logsAfterPlay);
  assert.ok(logsAfterPlay.includes("dock:play-click"), "Play button click must trigger onPlay callback");
  assert.ok(logsAfterPlay.includes("transport:synthesize"), "Synthesis request must be dispatched");
  assert.ok(logsAfterPlay.includes("audio:play"), "Audio element play() must be called");

  await page.screenshot({ path: ".cache/speech-integration/desktop-stage-dock.png" });

  // 2. Mobile layout & non-overlap with dialogue box
  const mobilePage = await browser.newPage({ viewport: { width: 375, height: 667 } });
  await mobilePage.goto(`http://127.0.0.1:${server.port}/`);
  await mobilePage.locator("[data-integration-ready]").waitFor();

  const mobileBoxes = await mobilePage.evaluate(() => {
    const stageHost = document.querySelector("[data-vn-stage-host]");
    const dockHost = stageHost?.shadowRoot?.querySelector(".vn-speech-dock");
    const dockPill = dockHost?.shadowRoot?.querySelector("[data-dock]");
    const dialogueBox = stageHost?.shadowRoot?.querySelector("[data-vn-theme-host]")?.shadowRoot?.querySelector("[data-vn-dialogue]");
    const exitBtn = stageHost?.shadowRoot?.querySelector("[data-vn-exit]");
    return {
      dock: dockPill?.getBoundingClientRect(),
      dialogue: dialogueBox?.getBoundingClientRect(),
      exit: exitBtn?.getBoundingClientRect(),
    };
  });
  console.log("Mobile bounding boxes:", mobileBoxes);
  assert.ok(mobileBoxes.dock && mobileBoxes.dialogue, "Both dock and dialogue must be laid out on mobile");
  assert.ok(mobileBoxes.dock.y + mobileBoxes.dock.height < mobileBoxes.dialogue.y, "Dock must sit well above bottom dialogue");
  if (mobileBoxes.exit) {
    // Dock is centered, exit is top right: verify they do not overlap
    assert.ok(mobileBoxes.dock.x + mobileBoxes.dock.width < mobileBoxes.exit.x || mobileBoxes.dock.y > mobileBoxes.exit.y + mobileBoxes.exit.height, "Dock must not overlap exit button");
  }

  await mobilePage.screenshot({ path: ".cache/speech-integration/mobile-stage-dock.png" });
  await mobilePage.close();

  // 3. Reader Auto Mode coordination with Speech Playback
  console.log("--- Testing Reader Auto vs Speech Playback ---");
  // Clear logs
  await page.evaluate(() => { (window as any).fixture.logs.length = 0; });

  // Start reader auto-play on stage
  await page.evaluate(() => {
    (window as any).fixture.stage.toggleAutoPlay(true);
  });
  await page.waitForTimeout(50);
  const logsAutoStart = await page.evaluate(() => [...(window as any).fixture.logs]);
  console.log("Logs after toggleAutoPlay(true):", logsAutoStart);

  // Now trigger manual speech play while in auto mode
  await page.evaluate(() => {
    void (window as any).fixture.speech.playCurrent();
  });
  await page.waitForTimeout(50);
  const logsPlaying = await page.evaluate(() => [...(window as any).fixture.logs]);
  console.log("Logs while speech is playing:", logsPlaying);
  assert.ok(logsPlaying.includes("audio:play"), "Speech must be playing");

  // Wait 350ms (longer than autoPlayDelay: 200ms)
  await page.waitForTimeout(350);
  const logsMidPlay = await page.evaluate(() => [...(window as any).fixture.logs]);
  console.log("Logs after waiting 350ms with speech playing:", logsMidPlay);
  // Stage must NOT have advanced because speech is holding auto-advance!
  assert.ok(!logsMidPlay.some(l => l.startsWith("stage:advance")), "Stage must NOT advance while speech is playing");

  // Now emit audio ended
  await page.evaluate(() => {
    (window as any).fixture.audio.emitEnded();
  });
  // After audio ended, speech status returns to idle, autoPlay countdown starts (200ms)
  await page.waitForTimeout(600);
  const logsAfterEnd = await page.evaluate(() => [...(window as any).fixture.logs]);
  console.log("Logs after audio ended and delay elapsed:", logsAfterEnd);
  assert.ok(logsAfterEnd.includes("stage:advance:1"), "Stage must advance after speech finishes and delay elapses");

  // 4. Test Pause then Stop in Auto mode
  console.log("--- Testing Pause and Stop in Auto mode ---");
  // At paragraph 1, start speech
  await page.evaluate(() => {
    (window as any).fixture.logs.length = 0;
    void (window as any).fixture.speech.playCurrent();
  });
  await page.waitForTimeout(50);
  // Pause speech
  await page.evaluate(() => {
    (window as any).fixture.speech.pause();
  });
  await page.waitForTimeout(350);
  const logsPaused = await page.evaluate(() => [...(window as any).fixture.logs]);
  assert.ok(!logsPaused.some(l => l.startsWith("stage:advance")), "Stage must NOT advance while speech is paused");

  // Now Stop speech
  await page.evaluate(() => {
    (window as any).fixture.speech.stop("user-stop");
  });
  await page.waitForTimeout(600);
  const logsStopped = await page.evaluate(() => [...(window as any).fixture.logs]);
  assert.ok(logsStopped.includes("stage:advance:2"), "Stage must resume auto countdown and advance after speech is stopped");

  // Turn off auto mode
  await page.evaluate(() => {
    (window as any).fixture.stage.toggleAutoPlay(false);
  });

  // 5. Settings UI Draft preservation and Enter key
  console.log("--- Testing Settings UI Draft preservation & Enter key ---");
  await page.evaluate(() => {
    const sm = document.querySelector(".vn-speech-settings")?.parentElement;
    if (sm) sm.style.display = "block";
    const details = document.querySelector(".vn-speech-settings")?.shadowRoot?.querySelector("details");
    if (details && !details.open) details.open = true;
  });
  const settingsCard = page.locator(".vn-speech-settings");
  const addInput = settingsCard.locator("input[placeholder*='Character name']");
  
  // Test Enter key to add draft
  await addInput.fill("Yuri");
  await addInput.press("Enter");
  await page.waitForTimeout(50);
  const draftRows = await settingsCard.locator("[data-speech-draft-row]").count();
  console.log("Draft rows after Enter key:", draftRows);
  assert.equal(draftRows, 1, "Pressing Enter must create a draft override row");

  // Test typing uncommitted draft name and receiving config echo
  await addInput.fill("Sayori");
  // Simulate a config echo arriving from host
  await page.evaluate(() => {
    (window as any).fixture.settingsSection.setConfig({
      enabled: true,
      autoplay: false,
      volume: 0.7,
      narrator: { connectionId: "prof-1", voice: "Puck" },
      characterDefault: null,
      characters: {},
      deliveryMode: "none",
      deliveryTag: "",
      deliveryAllProviders: false,
    });
  });
  await page.waitForTimeout(50);
  const textAfterEcho = await addInput.inputValue();
  console.log("Add input value after config echo:", JSON.stringify(textAfterEcho));
  assert.equal(textAfterEcho, "Sayori", "Uncommitted draft name must be preserved across config echo");

  console.log("ALL INTEGRATION CHECKS PASSED!");
} finally {
  await browser.close();
  server.stop();
}
