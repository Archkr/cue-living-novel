import { describe, expect, test } from "bun:test";

import {
  createSpeechTransport,
  MAX_SPEECH_TEXT_CHARS,
  SpeechTransportError,
} from "./transport.js";

type Call = { url: string; init: RequestInit };

function fetchMock(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, impl };
}

const audioResponse = (bytes: Uint8Array, type = "audio/mpeg") =>
  new Response(new Blob([bytes as unknown as BlobPart]), { status: 200, headers: { "Content-Type": type } });

describe("speech transport trust boundary", () => {
  test("refuses any non-relative base (no direct provider or foreign-origin calls)", () => {
    for (const base of ["https://api.example.com/api/v1", "//evil.example/api", "http://localhost:3000/api/v1"]) {
      expect(() => createSpeechTransport({ baseUrl: base })).toThrow(SpeechTransportError);
    }
    expect(() => createSpeechTransport({ baseUrl: "/api/v1" })).not.toThrow();
  });

  test("every request targets the relative base and sends session credentials, never a key", async () => {
    const { calls, impl } = fetchMock(() => new Response(JSON.stringify({ data: [], total: 0 }), { status: 200 }));
    const transport = createSpeechTransport({ fetchImpl: impl });
    await transport.listProfiles(new AbortController().signal);
    expect(calls[0]!.url).toBe("/api/v1/tts-connections?limit=100&offset=0");
    expect(calls[0]!.init.credentials).toBe("include");
    expect(JSON.stringify(calls[0]!.init.headers ?? {})).not.toMatch(/authorization|api[-_]?key/i);
  });
});

describe("profile listing", () => {
  test("follows pagination until total and maps only safe fields", async () => {
    const page = (offset: number) => {
      const rows = offset === 0
        ? [{ id: "a", name: "A", provider: "openrouter_tts", model: "m", voice: "v", is_default: true, has_api_key: true }]
        : [{ id: "b", name: "B", provider: "p2", model: "", voice: "", is_default: false }];
      return new Response(JSON.stringify({ data: rows, total: 2 }), { status: 200 });
    };
    const { calls, impl } = fetchMock((url) => page(Number(new URLSearchParams(url.split("?")[1]).get("offset"))));
    const transport = createSpeechTransport({ fetchImpl: impl });
    const profiles = await transport.listProfiles(new AbortController().signal);
    expect(calls.length).toBe(2);
    expect(profiles.map((p) => p.id)).toEqual(["a", "b"]);
    expect(profiles[0]).toEqual({ id: "a", name: "A", provider: "openrouter_tts", model: "m", voice: "v", isDefault: true });
    expect(JSON.stringify(profiles)).not.toContain("api_key");
  });

  test("auth failures surface as auth errors", async () => {
    const { impl } = fetchMock(() => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }));
    const transport = createSpeechTransport({ fetchImpl: impl });
    const error = await transport.listProfiles(new AbortController().signal).catch((e: SpeechTransportError) => e);
    expect(error).toBeInstanceOf(SpeechTransportError);
    expect((error as SpeechTransportError).kind).toBe("auth");
  });
});

describe("voice listing", () => {
  test("a 200 body with an error field is a failure, not an empty catalog", async () => {
    const { impl } = fetchMock(() => new Response(JSON.stringify({ voices: [], provider: "p", error: "provider down" }), { status: 200 }));
    const transport = createSpeechTransport({ fetchImpl: impl });
    const error = await transport.listVoices("conn-1", new AbortController().signal).catch((e: SpeechTransportError) => e);
    expect((error as SpeechTransportError).kind).toBe("provider");
    expect((error as SpeechTransportError).message).toBe("provider down");
  });

  test("voice ids are the returned ids, not display names", async () => {
    const { impl } = fetchMock(() => new Response(JSON.stringify({ voices: [{ id: "Kore", name: "Kore (Firm)" }] }), { status: 200 }));
    const transport = createSpeechTransport({ fetchImpl: impl });
    const voices = await transport.listVoices("conn-1", new AbortController().signal);
    expect(voices).toEqual([{ id: "Kore", name: "Kore (Firm)" }]);
  });
});

describe("synthesis", () => {
  const ref = { connectionId: "conn-1", voice: "Kore" };

  test("posts connectionId/text/outputFormat; empty voice override is omitted (profile default wins)", async () => {
    const { calls, impl } = fetchMock(() => audioResponse(new Uint8Array([1, 2, 3])));
    const transport = createSpeechTransport({ fetchImpl: impl });
    await transport.synthesize({ ref, text: "Hello." }, new AbortController().signal);
    expect(calls[0]!.url).toBe("/api/v1/tts/synthesize");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ connectionId: "conn-1", text: "Hello.", outputFormat: "mp3", voice: "Kore" });

    const { calls: calls2, impl: impl2 } = fetchMock(() => audioResponse(new Uint8Array([1])));
    await createSpeechTransport({ fetchImpl: impl2 })
      .synthesize({ ref: { connectionId: "conn-1", voice: "" }, text: "Hi" }, new AbortController().signal);
    expect(JSON.parse(String(calls2[0]!.init.body)).voice).toBeUndefined();
  });

  test("empty and over-cap text never reach the network", async () => {
    const { calls, impl } = fetchMock(() => audioResponse(new Uint8Array([1])));
    const transport = createSpeechTransport({ fetchImpl: impl });
    await expect(transport.synthesize({ ref, text: "   " }, new AbortController().signal)).rejects.toThrow();
    const long = "a".repeat(MAX_SPEECH_TEXT_CHARS + 1);
    const error = await transport.synthesize({ ref, text: long }, new AbortController().signal).catch((e: SpeechTransportError) => e);
    expect((error as SpeechTransportError).kind).toBe("too-large");
    expect(calls.length).toBe(0);
  });

  test("non-audio content types are rejected", async () => {
    const { impl } = fetchMock(() => new Response("<html>login</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    const transport = createSpeechTransport({ fetchImpl: impl });
    const error = await transport.synthesize({ ref, text: "Hi" }, new AbortController().signal).catch((e: SpeechTransportError) => e);
    expect((error as SpeechTransportError).kind).toBe("not-audio");
  });

  test("JSON error bodies surface with truthful classification", async () => {
    const { impl } = fetchMock(() => new Response(JSON.stringify({ error: "TTS connection not found" }), { status: 400 }));
    const transport = createSpeechTransport({ fetchImpl: impl });
    const error = await transport.synthesize({ ref, text: "Hi" }, new AbortController().signal).catch((e: SpeechTransportError) => e);
    expect((error as SpeechTransportError).kind).toBe("bad-request");
    expect((error as SpeechTransportError).message).toBe("TTS connection not found");

    const { impl: impl502 } = fetchMock(() => new Response(JSON.stringify({ error: "provider exploded" }), { status: 502 }));
    const error502 = await createSpeechTransport({ fetchImpl: impl502 })
      .synthesize({ ref, text: "Hi" }, new AbortController().signal).catch((e: SpeechTransportError) => e);
    expect((error502 as SpeechTransportError).kind).toBe("provider");
  });

  test("the byte cap is enforced WHILE streaming: reading stops mid-stream", async () => {
    let pulls = 0;
    const chunk = new Uint8Array(1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
    });
    const { impl } = fetchMock(() => new Response(stream, { status: 200, headers: { "Content-Type": "audio/mpeg" } }));
    const transport = createSpeechTransport({ fetchImpl: impl, maxResponseBytes: 4096 });
    const error = await transport.synthesize({ ref, text: "Hi" }, new AbortController().signal).catch((e: SpeechTransportError) => e);
    expect((error as SpeechTransportError).kind).toBe("too-large");
    // 4096/1024 = 4 chunks allowed; the reader must stop within a few pulls, not drain forever.
    expect(pulls).toBeLessThanOrEqual(8);
  });

  test("empty audio is a provider failure, never a playable blob", async () => {
    const { impl } = fetchMock(() => audioResponse(new Uint8Array(0)));
    const transport = createSpeechTransport({ fetchImpl: impl });
    const error = await transport.synthesize({ ref, text: "Hi" }, new AbortController().signal).catch((e: SpeechTransportError) => e);
    expect((error as SpeechTransportError).kind).toBe("provider");
  });

  test("an aborted request reports kind aborted", async () => {
    const abort = new AbortController();
    const { impl } = fetchMock(() => {
      abort.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const transport = createSpeechTransport({ fetchImpl: impl });
    const error = await transport.synthesize({ ref, text: "Hi" }, abort.signal).catch((e: SpeechTransportError) => e);
    expect((error as SpeechTransportError).kind).toBe("aborted");
  });

  test("successful audio keeps the response MIME type on the blob", async () => {
    const { impl } = fetchMock(() => audioResponse(new Uint8Array([1, 2, 3]), "audio/mpeg"));
    const transport = createSpeechTransport({ fetchImpl: impl });
    const blob = await transport.synthesize({ ref, text: "Hi" }, new AbortController().signal);
    expect(blob.size).toBe(3);
    expect(blob.type).toContain("audio/mpeg");
  });
});

describe("profile revision snapshot (getProfile)", () => {
  test("maps updated_at/model/voice and fingerprints default parameters deterministically", async () => {
    const row = {
      id: "conn-1", name: "Gem", provider: "openrouter_tts", model: "google/gemini-2.5-flash-tts",
      voice: "Kore", is_default: true, has_api_key: true, updated_at: "2026-01-01T00:00:00Z",
      default_parameters: { speed: 1.1, output_format: "mp3" },
    };
    const { calls, impl } = fetchMock(() => new Response(JSON.stringify(row), { status: 200 }));
    const transport = createSpeechTransport({ fetchImpl: impl });
    const snapshot = await transport.getProfile("conn-1", new AbortController().signal);
    expect(calls[0]!.url).toBe("/api/v1/tts-connections/conn-1");
    expect(calls[0]!.init.credentials).toBe("include");
    expect(snapshot.updatedAt).toBe("2026-01-01T00:00:00Z");
    expect(snapshot.model).toBe("google/gemini-2.5-flash-tts");
    expect(snapshot.voice).toBe("Kore");
    // sorted-key fingerprint: parameter ORDER cannot change the cache key
    const reordered = { ...row, default_parameters: { output_format: "mp3", speed: 1.1 } };
    const { impl: impl2 } = fetchMock(() => new Response(JSON.stringify(reordered), { status: 200 }));
    const snapshot2 = await createSpeechTransport({ fetchImpl: impl2 }).getProfile("conn-1", new AbortController().signal);
    expect(snapshot2.parametersFingerprint).toBe(snapshot.parametersFingerprint);
    expect(JSON.stringify(snapshot)).not.toContain("api_key");
  });

  test("a deleted profile is a truthful bad-request error", async () => {
    const { impl } = fetchMock(() => new Response(JSON.stringify({ error: "Not found" }), { status: 404 }));
    const transport = createSpeechTransport({ fetchImpl: impl });
    const error = await transport.getProfile("gone", new AbortController().signal).catch((e: SpeechTransportError) => e);
    expect((error as SpeechTransportError).kind).toBe("bad-request");
    expect((error as SpeechTransportError).message).toContain("no longer exists");
  });
});

describe("synthesis timeout", () => {
  const ref = { connectionId: "conn-1", voice: "Kore" };

  test("hitting the synthesis timeout reports kind timeout, not a silent abort", async () => {
    const hanging = (_url: string, init: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }));
        });
      });
    const transport = createSpeechTransport({ fetchImpl: hanging, timeoutMs: 20 });
    const error = await transport.synthesize({ ref, text: "Hi" }, new AbortController().signal)
      .catch((e: SpeechTransportError) => e);
    expect(error).toBeInstanceOf(SpeechTransportError);
    expect((error as SpeechTransportError).kind).toBe("timeout");
    expect((error as SpeechTransportError).message).toMatch(/timed out/i);
  });

  test("a user abort before the timeout still reports kind aborted", async () => {
    const userAbort = new AbortController();
    const hanging = (_url: string, init: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    const transport = createSpeechTransport({ fetchImpl: hanging, timeoutMs: 10_000 });
    const pending = transport.synthesize({ ref, text: "Hi" }, userAbort.signal)
      .catch((e: SpeechTransportError) => e);
    userAbort.abort();
    const error = await pending;
    expect((error as SpeechTransportError).kind).toBe("aborted");
  });
});
