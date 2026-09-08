import { describe, expect, test } from "bun:test";
import type { SpindleAPI } from "lumiverse-spindle-types";
import { DEFAULT_CONFIG, type VisualNovelConfig } from "../../config.js";
import { TurnPlanSchema, type SceneState, type TurnPlan, type VisualCue } from "../../shared/contracts.js";
import {
  cardPortraitKey,
  compatiblePortrait,
  createAssetJobs,
  generateAssets,
  referenceParametersFor,
  sceneImageIdentityFor
} from "./images.js";
import { handleReferenceImageResponse } from "./reference-source.js";
import { loadPortraits, savePortrait, type StoredPortrait } from "./storage.js";
import scenarioCard from "./__fixtures__/scenario-card.json";

const now = new Date().toISOString();
const key = {
  chatId: "chat",
  assistantMessageId: "message",
  swipeId: 0,
  sourceFingerprint: "12345678abcdef",
  revision: 0
};

function scene(cast: string[]): SceneState {
  return {
    sceneId: "scene",
    revision: 0,
    startParagraph: 0,
    environment: {
      location: "Great Hall",
      timeOfDay: "day",
      weather: null,
      lighting: "daylight",
      description: "A vaulted hall.",
      persistentElements: []
    },
    cast,
    continuity: { revision: 0, characters: {}, facts: {} },
    basePrompt: "vaulted hall",
    identityPrompt: "silver hair, green eyes",
    cameraLock: {
      framing: "medium wide",
      angle: "eye level",
      perspective: "fixed",
      lens: "50mm",
      subjectAnchor: "center",
      horizon: "upper third",
      safeDialogueRegion: "lower third",
      aspectRatio: "16:9"
    },
    compositionLock: "centered",
    activeAssetId: null,
    priorSceneId: null
  };
}

function cue(id: string, paragraphIndex: number, character?: string, poseExpressionId = "smile", resolvedIdentity?: string): VisualCue {
  return {
    cueId: `cue-${id}`,
    paragraphIndex,
    sceneId: "scene",
    sceneRevision: 0,
    kind: "flattened_scene",
    action: null,
    expression: null,
    poseExpressionId,
    promptDelta: "",
    ...(character ? { character } : {}),
    ...(resolvedIdentity !== undefined ? { resolvedIdentity } : {}),
    assetJobId: `job-${id}`
  };
}

function plan(cues: VisualCue[], cast: string[] = ["Aurelia"]): TurnPlan {
  const maxP = Math.max(1, ...cues.map((c) => c.paragraphIndex));
  const paragraphs = Array.from({ length: maxP + 1 }, (_, index) => ({
    index,
    sourceIndex: index,
    text: `Paragraph ${index}.`
  }));
  return TurnPlanSchema.parse({
    schemaVersion: 1,
    key,
    paragraphs,
    scenes: [scene(cast)],
    visualCues: cues,
    choices: [],
    initialContinuity: { revision: 0, characters: {}, facts: {} },
    continuityDeltas: [],
    terminalContinuity: { revision: 0, characters: {}, facts: {} },
    planningStatus: "planned",
    createdAt: now
  });
}

type GenerateCall = {
  prompt: string;
  parameters: Record<string, unknown>;
  includeDataUrl?: boolean;
};

function spriteData(imageId: string): string {
  return Buffer.from(`sprite:${imageId}`).toString("base64");
}

type RelayMode =
  | { kind: "reply" }
  | { kind: "silent" }
  | { kind: "error" }
  | { kind: "bad-data-url" }
  | { kind: "oversize" };

/**
 * Full runtime mock: storage map, an image provider, the chat's card, and a
 * frontend relay auto-responder driven by `mode`. Card host lookups
 * (`chats.get`, `characters.get`, `chat.getMessages`) count their calls so
 * the default path can prove it never touches them.
 */
function cardRuntime(provider: string, mode: RelayMode = { kind: "reply" }, content = ""): {
  spindle: SpindleAPI;
  calls: GenerateCall[];
  data: Map<string, unknown>;
  fetches: Array<{ requestId: string; imageId: string; characterKey: string }>;
  cardLookups: { count: number };
} {
  const data = new Map<string, unknown>();
  const calls: GenerateCall[] = [];
  const fetches: Array<{ requestId: string; imageId: string; characterKey: string }> = [];
  const cardLookups = { count: 0 };
  // Oversize: decoded size one unit above REFERENCE_IMAGE_MAX_BYTES (8 MiB),
  // still below the relay's raw string bound, so the backend size check trips.
  const oversize = "A".repeat(Math.ceil(8 * 1024 * 1024 * 4 / 3 / 4) * 4 + 4);
  const spindle = {
    userStorage: {
      getJson: async (path: string, readOptions: { fallback: unknown }) => data.get(path) ?? readOptions.fallback,
      setJson: async (path: string, value: unknown) => { data.set(path, value); }
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    imageGen: {
      getConnection: async (id: string) => id.includes("::") ? null : ({ provider }),
      listConnections: async () => [{ provider, is_default: true }],
      generate: async (input: GenerateCall & { includeDataUrl?: boolean }) => {
        calls.push({ prompt: input.prompt, parameters: input.parameters, includeDataUrl: input.includeDataUrl ?? false });
        const index = calls.length;
        return {
          imageId: `gen-${index}`,
          imageUrl: `/images/gen-${index}`,
          ...(input.includeDataUrl ? { imageDataUrl: "data:image/png;base64,UE9SVFJBSVQ=" } : {}),
          model: "m",
          provider
        };
      }
    },
    chats: {
      get: async () => { cardLookups.count += 1; return { id: "chat", character_id: "char-1" }; }
    },
    characters: {
      get: async () => { cardLookups.count += 1; return scenarioCard; },
      list: async () => { cardLookups.count += 1; return [scenarioCard]; }
    },
    chat: {
      getMessages: async () => { cardLookups.count += 1; return [{ id: "message", content, is_user: false }]; }
    },
    sendToFrontend: (message: Record<string, unknown>) => {
      if (message.type !== "vn_reference_fetch") return;
      const requestId = String(message.requestId);
      fetches.push({ requestId, imageId: String(message.imageId), characterKey: String(message.characterKey) });
      if (mode.kind === "silent") return;
      setTimeout(() => {
        if (mode.kind === "error") handleReferenceImageResponse({ requestId, error: "fetch failed" });
        else if (mode.kind === "bad-data-url") handleReferenceImageResponse({ requestId, dataUrl: "not a data url" });
        else if (mode.kind === "oversize") handleReferenceImageResponse({ requestId, dataUrl: `data:image/png;base64,${oversize}` });
        else handleReferenceImageResponse({ requestId, dataUrl: `data:image/png;base64,${spriteData(String(message.imageId))}` });
      }, 0);
    }
  } as unknown as SpindleAPI;
  return { spindle, calls, data, fetches, cardLookups };
}

const capturedConfig = {
  ...DEFAULT_CONFIG,
  imageConnectionId: "conn",
  imageConcurrency: 1
};
const cardConfig = { ...capturedConfig, referenceSource: "card" as const };
// The relay minimum timeout is 250ms; failure tests pay it once per character.
const fastCardConfig = { ...cardConfig, imageParameters: { referenceFetchTimeoutMs: 250 } };

async function run(runtime: ReturnType<typeof cardRuntime>, turnPlan: TurnPlan, config: VisualNovelConfig = cardConfig) {
  const jobs = createAssetJobs(turnPlan, config);
  return generateAssets(runtime.spindle, turnPlan, jobs, config, new AbortController().signal, () => {});
}

describe("default captured source (regression)", () => {
  test("never sends vn_reference_fetch and never looks the card up", async () => {
    const runtime = cardRuntime("comfyui");
    const turnPlan = plan([cue("one", 0), cue("two", 1, undefined, "sad")]);
    const finalJobs = await run(runtime, turnPlan, capturedConfig);
    expect(finalJobs.every((job) => job.status === "generated")).toBe(true);
    expect(runtime.fetches.length).toBe(0);
    expect(runtime.cardLookups.count).toBe(0);
    // The captured pipeline is untouched: first render captures, second anchors.
    expect(runtime.calls[0]?.includeDataUrl).toBe(true);
    expect(runtime.calls[1]?.parameters.resolvedSourceImages).toEqual([
      { data: "UE9SVFJBSVQ=", mimeType: "image/png" }
    ]);
  });
});

describe("card sprite reference source", () => {
  test("each known character anchors to its own sprite; the unknown one is captured", async () => {
    const runtime = cardRuntime("comfyui");
    // Guard carries his own resolved identity, so he is capture-eligible and
    // his prompt fingerprint stays unique (identical fingerprints share a
    // render in the scheduler, which is pre-existing behaviour).
    const turnPlan = plan([cue("a", 0, "Aurelia"), cue("b", 1, "Elizabeth"), cue("c", 2, "Guard", "sad", "tall man, guard armor")]);
    const finalJobs = await run(runtime, turnPlan);
    expect(finalJobs.every((job) => job.status === "generated")).toBe(true);

    // Aurelia resolves the bare "Aurelia" asset (id-000), Elizabeth "elizabeth" (id-009).
    expect(runtime.calls[0]?.parameters.resolvedSourceImages).toEqual([
      { data: spriteData("id-000"), mimeType: "image/png" }
    ]);
    expect(runtime.calls[0]?.includeDataUrl).toBe(false);
    expect(runtime.calls[1]?.parameters.resolvedSourceImages).toEqual([
      { data: spriteData("id-009"), mimeType: "image/png" }
    ]);
    // The card does not know "Guard": captured path, exactly as today.
    expect(runtime.calls[2]?.includeDataUrl).toBe(true);
    expect(runtime.calls[2]?.parameters.resolvedSourceImages).toBeUndefined();

    const portraits = await loadPortraits(runtime.spindle, "chat");
    expect(portraits[cardPortraitKey("aurelia")]).toMatchObject({
      name: "Aurelia", imageId: "id-000", source: "card", assetName: "Aurelia"
    });
    expect(portraits[cardPortraitKey("elizabeth")]).toMatchObject({ imageId: "id-009", source: "card" });
    expect(portraits.guard?.source).toBeUndefined();
    expect(portraits.guard?.imageId).toBe("gen-3");
  });

  test("one relay fetch per character per chat; the next turn reuses the stored portrait", async () => {
    const runtime = cardRuntime("comfyui");
    await run(runtime, plan([cue("a", 0, "Aurelia"), cue("b", 1, "Aurelia", "sad")]));
    expect(runtime.fetches.length).toBe(1);

    await run(runtime, plan([cue("c", 0, "Aurelia")]));
    expect(runtime.fetches.length).toBe(1);
    expect(runtime.calls[2]?.parameters.resolvedSourceImages).toEqual([
      { data: spriteData("id-000"), mimeType: "image/png" }
    ]);
  });

  test("an inline tag picks the sprite for the tagged paragraph's character", async () => {
    const runtime = cardRuntime("comfyui", { kind: "reply" }, 'Paragraph 0.\n<pimg="aurelia_smirking">\n\nParagraph 1.');
    const p = plan([cue("a", 0, "Aurelia")]);
    await generateAssets(runtime.spindle, p, createAssetJobs(p, cardConfig), cardConfig,
      new AbortController().signal, () => {}, undefined,
      { resolvedSourceText: 'Paragraph 0.\n<pimg="aurelia_smirking">\n\nParagraph 1.' });
    const portraits = await loadPortraits(runtime.spindle, "chat");
    expect(portraits[cardPortraitKey("aurelia")]?.assetName).toBe("aurelia_smirking");
  });

  test("NovelAI gets director reference images from the card portrait", async () => {
    const runtime = cardRuntime("novelai");
    await run(runtime, plan([cue("a", 0, "Aurelia")]));
    expect(runtime.calls[0]?.parameters.resolvedReferenceImages).toEqual([
      { data: spriteData("id-000"), strength: 0.6, infoExtracted: 1, refType: "character" }
    ]);
    expect(runtime.calls[0]?.includeDataUrl).toBe(false);
  });

  test("a silent relay times out into the captured path without blocking the batch", async () => {
    const runtime = cardRuntime("comfyui", { kind: "silent" });
    const finalJobs = await run(runtime, plan([cue("a", 0, "Aurelia"), cue("b", 1, "Aurelia", "sad")]), fastCardConfig);
    expect(finalJobs.every((job) => job.status === "generated")).toBe(true);
    // Exactly one fetch was attempted; the character was captured instead.
    expect(runtime.fetches.length).toBe(1);
    expect(runtime.calls[0]?.includeDataUrl).toBe(true);
    expect(runtime.calls[1]?.parameters.resolvedSourceImages).toEqual([
      { data: "UE9SVFJBSVQ=", mimeType: "image/png" }
    ]);
    const portraits = await loadPortraits(runtime.spindle, "chat");
    expect(portraits[cardPortraitKey("aurelia")]).toBeUndefined();
    expect(portraits.aurelia?.imageId).toBe("gen-1");
  });

  test("an error reply, a bad data URL, and an oversize payload each fall back to capture", async () => {
    for (const kind of ["error", "bad-data-url", "oversize"] as const) {
      const runtime = cardRuntime("comfyui", { kind });
      const finalJobs = await run(runtime, plan([cue("a", 0, "Aurelia")]), fastCardConfig);
      expect(finalJobs.every((job) => job.status === "generated")).toBe(true);
      expect(runtime.calls[0]?.includeDataUrl).toBe(true);
      expect(runtime.calls[0]?.parameters.resolvedSourceImages).toBeUndefined();
      const portraits = await loadPortraits(runtime.spindle, "chat");
      expect(portraits[cardPortraitKey("aurelia")]).toBeUndefined();
    }
  });

  test("switching the source ignores the other source's portraits without deleting them", async () => {
    const runtime = cardRuntime("comfyui");
    // Turn 1 in card mode locks the sprite.
    await run(runtime, plan([cue("a", 0, "Aurelia")]));

    // Turn 2 in captured mode ignores the card portrait, captures its own.
    await run(runtime, plan([cue("b", 0, "Aurelia")]), capturedConfig);
    expect(runtime.calls[1]?.includeDataUrl).toBe(true);
    expect(runtime.calls[1]?.parameters.resolvedSourceImages).toBeUndefined();

    // Turn 3 in captured mode anchors to the captured render, not the sprite.
    await run(runtime, plan([cue("c", 0, "Aurelia")]), capturedConfig);
    expect(runtime.calls[2]?.parameters.resolvedSourceImages).toEqual([
      { data: "UE9SVFJBSVQ=", mimeType: "image/png" }
    ]);

    // Turn 4 back in card mode restores the sprite anchor with no new fetch.
    await run(runtime, plan([cue("d", 0, "Aurelia")]));
    expect(runtime.fetches.length).toBe(1);
    expect(runtime.calls[3]?.parameters.resolvedSourceImages).toEqual([
      { data: spriteData("id-000"), mimeType: "image/png" }
    ]);

    // Both portraits still exist side by side.
    const portraits = await loadPortraits(runtime.spindle, "chat");
    expect(portraits.aurelia?.imageId).toBe("gen-2");
    expect(portraits[cardPortraitKey("aurelia")]?.imageId).toBe("id-000");
  });

  test("a hand-stored card portrait under the plain key never satisfies the captured lookup", () => {
    const portrait: StoredPortrait = {
      name: "Aurelia",
      imageId: "id-000",
      data: "QUJD",
      mimeType: "image/png",
      createdAt: now,
      source: "card",
      identityFingerprint: "fp"
    };
    expect(compatiblePortrait(portrait, "fp")).toBeUndefined();
  });

  test("card portraits feed referenceParametersFor exactly like captured ones", () => {
    const portrait = { data: "QUJD", mimeType: "image/webp" };
    expect(referenceParametersFor("comfyui", portrait, DEFAULT_CONFIG)).toEqual({
      resolvedSourceImages: [{ data: "QUJD", mimeType: "image/webp" }]
    });
    expect(referenceParametersFor("novelai", portrait, DEFAULT_CONFIG)).toEqual({
      resolvedReferenceImages: [{ data: "QUJD", strength: 0.6, infoExtracted: 1, refType: "character" }]
    });
  });
});

describe("scene-image cache identity", () => {
  test("card mode adds referenceSource to the request identity; the default stays byte-identical", () => {
    const turnPlan = plan([cue("a", 0, "Aurelia")]);
    const sceneState = turnPlan.scenes[0]!;
    const visualCue = turnPlan.visualCues[0]!;
    const captured = sceneImageIdentityFor(capturedConfig, sceneState, visualCue, undefined, "comfyui");
    const card = sceneImageIdentityFor(cardConfig, sceneState, visualCue, undefined, "comfyui");
    expect("referenceSource" in captured.request).toBe(false);
    expect(card.request.referenceSource).toBe("card");
    expect(JSON.stringify(captured)).not.toBe(JSON.stringify(card));

    // With anchoring off, card mode adds nothing (nothing is anchored).
    const off = sceneImageIdentityFor({ ...cardConfig, referenceAnchoring: false }, sceneState, visualCue, undefined, "comfyui");
    expect("referenceSource" in off.request).toBe(false);
  });
});

describe("card portrait storage keys", () => {
  test("savePortrait with a card key does not collide with the captured key", async () => {
    const data = new Map<string, unknown>();
    const spindle = {
      userStorage: {
        getJson: async (path: string, readOptions: { fallback: unknown }) => data.get(path) ?? readOptions.fallback,
        setJson: async (path: string, value: unknown) => { data.set(path, value); }
      }
    } as unknown as SpindleAPI;
    const captured: StoredPortrait = { name: "Mira", imageId: "img-1", data: "QUJD", mimeType: "image/png", createdAt: now };
    const card: StoredPortrait = { ...captured, imageId: "id-1", data: "WFla", source: "card", assetName: "mira" };
    expect(await savePortrait(spindle, "chat-1", captured)).toBe(true);
    expect(await savePortrait(spindle, "chat-1", card, undefined, { key: cardPortraitKey("mira") })).toBe(true);
    const portraits = await loadPortraits(spindle, "chat-1");
    expect(portraits.mira?.imageId).toBe("img-1");
    expect(portraits[cardPortraitKey("mira")]?.imageId).toBe("id-1");
  });
});


describe("review regressions: exact text and cancellation", () => {
  test("card reference uses the exact resolved source, never a discarded branch or current swipe", async () => {
    const runtime = cardRuntime("comfyui", { kind: "reply" }, 'Discarded branch.\n<pimg="aurelia_evil smile">');
    const p = plan([cue("a", 0, "Aurelia")]);
    await generateAssets(runtime.spindle, p, createAssetJobs(p, cardConfig), cardConfig,
      new AbortController().signal, () => {}, undefined,
      { resolvedSourceText: 'Paragraph 0.\n<pimg="aurelia_smirking">' });
    expect(runtime.fetches[0]?.imageId).toBe("id-003");
  });

  test("legacy plan without exact source skips raw inline tags", async () => {
    const runtime = cardRuntime("comfyui", { kind: "reply" }, 'Discarded branch.\n<pimg="aurelia_evil smile">');
    await run(runtime, plan([cue("a", 0, "Aurelia")]));
    expect(runtime.fetches[0]?.imageId).toBe("id-000");
  });

  test("closing during the reference relay never invokes the provider", async () => {
    const runtime = cardRuntime("comfyui", { kind: "silent" });
    const controller = new AbortController();
    runtime.spindle.sendToFrontend = () => { controller.abort("closed during relay"); };
    const p = plan([cue("a", 0, "Aurelia")]);
    const result = await generateAssets(runtime.spindle, p, createAssetJobs(p, cardConfig), cardConfig,
      controller.signal, () => {});
    expect(result[0]?.status).toBe("cancelled");
    expect(runtime.calls).toHaveLength(0);
  });
});


test("capture dependents do not invoke the provider after cancellation", async () => {
  const runtime = cardRuntime("comfyui");
  const controller = new AbortController();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  runtime.spindle.imageGen.generate = async () => {
    calls++;
    entered();
    await gate;
    return { imageId: "captured", provider: "comfyui", model: "m", imageDataUrl: "data:image/png;base64,QUJD" };
  };
  const config = { ...capturedConfig, imageConcurrency: 2 };
  const p = plan([cue("one", 0, "Aurelia"), cue("two", 1, "Aurelia", "sad")]);
  const pending = generateAssets(runtime.spindle, p, createAssetJobs(p, config), config, controller.signal, () => {});
  await started;
  controller.abort("closed while waiting for capture");
  release();
  await pending;
  expect(calls).toBe(1);
});
