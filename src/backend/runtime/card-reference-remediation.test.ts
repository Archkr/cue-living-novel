import { describe, expect, test } from "bun:test";
import type { CharacterDTO, SpindleAPI } from "lumiverse-spindle-types";
import { DEFAULT_CONFIG } from "../../config.js";
import { TurnPlanSchema, type SceneState, type TurnPlan, type VisualCue } from "../../shared/contracts.js";
import type { CharacterRegistry } from "../../shared/identity.js";
import {
  fetchReferenceImageViaFrontend,
  handleReferenceImageResponse,
  loadCardReferenceContext,
  resolveCardAssetsForPlan
} from "./reference-source.js";
import { cardReferenceForCache, sceneImageIdentityFor } from "./images.js";
import { sceneImageCacheKey } from "../core/scene-image-cache.js";

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

function cue(id: string, paragraphIndex: number, character?: string): VisualCue {
  return {
    cueId: `cue-${id}`,
    paragraphIndex,
    sceneId: "scene",
    sceneRevision: 0,
    kind: "flattened_scene",
    action: null,
    expression: null,
    poseExpressionId: "smile",
    promptDelta: "",
    ...(character ? { character } : {}),
    assetJobId: `job-${id}`
  };
}

function turnPlan(cues: VisualCue[], cast: string[]): TurnPlan {
  const maxP = Math.max(0, ...cues.map((c) => c.paragraphIndex));
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

const emptyRegistry = {} as CharacterRegistry;

describe("R5: chats without character_id get no card portrait", () => {
  test("group chat without character_id returns null and never lists characters", async () => {
    let listCalled = false;
    const spindle = {
      chats: {
        get: async () => ({ id: "group-chat-1", title: "Group Adventure", character_id: undefined })
      },
      characters: {
        get: async () => null,
        list: async () => {
          listCalled = true;
          return { data: [{ id: "alice-id", name: "Alice", image_id: "alice-avatar-img", extensions: {} }], total: 1 };
        }
      },
      chat: {
        getMessages: async () => [{ id: "message", content: "Alice speaks." }]
      },
      userStorage: {
        getJson: async () => null
      }
    } as unknown as SpindleAPI;
    const plan = turnPlan([cue("a", 0, "Alice")], ["Alice"]);
    expect(await loadCardReferenceContext(spindle, plan)).toBeNull();
    expect(listCalled).toBe(false);
  });
});

describe("R6: inline tags anchor only character-like assets", () => {
  const card = {
    id: "card-1",
    name: "Karin Card",
    avatar_url: "",
    extensions: {
      risu_asset_map: {
        "karin_neutral": "img-karin-sprite",
        "dungeon_gate": "img-dungeon-bg",
        "alice_neutral": "img-alice",
        "bob_angry": "img-bob"
      }
    }
  } as unknown as CharacterDTO;

  test("a lone background/item tag never anchors the character", () => {
    const plan = turnPlan([cue("a", 0, "Karin")], ["Karin"]);
    const resolutions = resolveCardAssetsForPlan({
      plan,
      character: card,
      content: 'Karin arrives at the dark dungeon. <pimg="dungeon_gate">',
      registry: emptyRegistry
    });
    // The prefix step still finds Karin's own sprite; the item tag is ignored.
    expect(resolutions.get("karin")?.assetName).toBe("karin_neutral");
    expect(resolutions.get("karin")?.via).toBe("prefix");
  });

  test("a lone item tag with no prefix match anchors nothing at all", () => {
    const plan = turnPlan([cue("a", 0, "Guard")], ["Guard"]);
    const resolutions = resolveCardAssetsForPlan({
      plan,
      character: card,
      content: 'The guard opens the gate. <pimg="dungeon_gate">',
      registry: emptyRegistry
    });
    expect(resolutions.has("guard")).toBe(false);
  });

  test("an unrendered conditional branch tag never hijacks another character", () => {
    const rawContent = `Alice says hello!\n\n{{#when branch == 2}}\nBob draws his sword angrily! <pimg="bob_angry">\n{{/when}}`;
    const plan = turnPlan([cue("a", 0, "Alice")], ["Alice"]);
    const resolutions = resolveCardAssetsForPlan({
      plan,
      character: card,
      content: rawContent,
      registry: emptyRegistry
    });
    // Alice keeps her own sprite (or nothing), never Bob's.
    expect(resolutions.get("alice")?.assetName).not.toBe("bob_angry");
    expect(resolutions.get("alice")?.assetName).toBe("alice_neutral");
  });
});

describe("R7: partial matches are unique across known characters", () => {
  const card = {
    id: "card-1",
    name: "Scenario",
    avatar_url: "",
    extensions: {
      risu_asset_map: {
        "lady": "img-lady",
        "karin_neutral": "img-karin"
      }
    }
  } as unknown as CharacterDTO;

  test("two characters sharing only a title share no sprite", () => {
    const plan = turnPlan(
      [cue("a", 0, "Lady Catherine"), cue("b", 1, "Lady Maria")],
      ["Lady Catherine", "Lady Maria"]
    );
    const resolutions = resolveCardAssetsForPlan({
      plan,
      character: card,
      content: "",
      registry: emptyRegistry
    });
    expect(resolutions.has("lady catherine")).toBe(false);
    expect(resolutions.has("lady maria")).toBe(false);
  });

  test("a full-name match keeps its sprite while the single-word claimant falls back", () => {
    const plan = turnPlan(
      [cue("a", 0, "Karin"), cue("b", 1, "Karin's Mother")],
      ["Karin", "Karin's Mother"]
    );
    const resolutions = resolveCardAssetsForPlan({
      plan,
      character: card,
      content: "",
      registry: emptyRegistry
    });
    expect(resolutions.get("karin")?.imageId).toBe("img-karin");
    expect(resolutions.has("karin's mother")).toBe(false);
  });

  test("a single-word match ambiguous against the registry falls back", () => {
    const registry: CharacterRegistry = {
      "lady-maria": { id: "lady-maria", name: "Lady Maria", aliases: [], tags: "", subjectCategory: "female" }
    };
    const plan = turnPlan([cue("a", 0, "Lady Catherine")], ["Lady Catherine"]);
    const resolutions = resolveCardAssetsForPlan({
      plan,
      character: card,
      content: "",
      registry
    });
    expect(resolutions.has("lady catherine")).toBe(false);
  });
});

describe("R8: the relay fetch honours AbortSignal", () => {
  test("an already-aborted signal never sends and resolves null", async () => {
    let sent = 0;
    const spindle = {
      sendToFrontend: () => { sent += 1; }
    } as unknown as SpindleAPI;
    const controller = new AbortController();
    controller.abort("User cancelled");
    expect(
      await fetchReferenceImageViaFrontend(spindle, {
        chatId: "c1",
        imageId: "img1",
        characterKey: "alice",
        signal: controller.signal
      })
    ).toBeNull();
    expect(sent).toBe(0);
  });

  test("aborting mid-wait resolves promptly and drops the late reply", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const spindle = {
      sendToFrontend: (message: Record<string, unknown>) => { sent.push(message); }
    } as unknown as SpindleAPI;
    const controller = new AbortController();
    const started = performance.now();
    const pending = fetchReferenceImageViaFrontend(spindle, {
      chatId: "c1",
      imageId: "img1",
      characterKey: "alice",
      timeoutMs: 5000,
      signal: controller.signal
    });
    expect(sent.length).toBe(1);
    controller.abort("User cancelled");
    expect(await pending).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
    // The late frontend reply finds no pending fetch and is ignored.
    expect(
      handleReferenceImageResponse({ requestId: String(sent[0]!.requestId), dataUrl: "data:image/png;base64,QUJD" })
    ).toBe(false);
  });
});

describe("R9: card-mode cache keys carry the chosen reference", () => {
  const cardConfig = { ...DEFAULT_CONFIG, referenceSource: "card" as const };
  const capturedConfig = { ...DEFAULT_CONFIG };

  test("different sprites, fallback, and empty renders never share keys; captured stays byte-identical", () => {
    const plan = turnPlan([cue("a", 0, "Aurelia")], ["Aurelia"]);
    const sceneState = plan.scenes[0]!;
    const visualCue = plan.visualCues[0]!;

    const spriteA = sceneImageIdentityFor(cardConfig, sceneState, visualCue, undefined, "comfyui", {
      source: "card",
      imageId: "img-a",
      assetName: "aurelia_smile"
    });
    const spriteB = sceneImageIdentityFor(cardConfig, sceneState, visualCue, undefined, "comfyui", {
      source: "card",
      imageId: "img-b",
      assetName: "aurelia_neutral"
    });
    const fallback = sceneImageIdentityFor(cardConfig, sceneState, visualCue, undefined, "comfyui", {
      source: "captured",
      imageId: "gen-1"
    });
    const none = sceneImageIdentityFor(cardConfig, sceneState, visualCue, undefined, "comfyui", {
      source: "none"
    });
    const keys = new Set([spriteA, spriteB, fallback, none].map(sceneImageCacheKey));
    expect(keys.size).toBe(4);

    const captured = sceneImageIdentityFor(capturedConfig, sceneState, visualCue, undefined, "comfyui");
    expect("referenceSource" in captured.request).toBe(false);
    expect("reference" in captured.request).toBe(false);
    expect(spriteA.request.referenceSource).toBe("card");
    expect(cardReferenceForCache(
      { name: "A", imageId: "img-a", data: "", mimeType: "image/png", createdAt: now, source: "card", assetName: "a" },
      undefined
    )).toEqual({ source: "card", imageId: "img-a", assetName: "a" });
    expect(cardReferenceForCache(undefined, undefined)).toEqual({ source: "none" });
  });
});
