import type { SpeechVoiceRef } from "../../speech-config.js";

/**
 * Minimal authenticated REST adapter for the Lumiverse TTS endpoints.
 *
 * Truthful scope (verified against host source, not invented Spindle API):
 * - `/api/v1/*` is session-cookie authenticated (`requireAuth`, src/app.ts:472);
 *   Cue's frontend runs inside the host page (blob-module import), so a
 *   same-origin relative fetch with `credentials: "include"` reuses the user's
 *   session. No API key, provider URL, or token is ever read or sent by Cue.
 * - The base is ALWAYS a same-origin relative path. Deployments that serve the
 *   UI from a different origin than the API are unsupported for Cue speech and
 *   fail with a normal auth/network error rather than a credential workaround.
 * - There is no versioned `spindle.tts` consumer API in spindle-types 0.6.23;
 *   this adapter can break if the host routes change and says so in SPEECH.md.
 */

export type SafeTtsProfile = {
  id: string;
  name: string;
  provider: string;
  model: string;
  voice: string;
  isDefault: boolean;
};

export type VoiceOption = { id: string; name: string };

/**
 * Metadata snapshot of one profile, fetched from the host's local database
 * (GET /tts-connections/:id — no provider contact, no synthesis). Used to key
 * the audio cache on the ACTUAL profile revision so a host-side profile edit
 * (voice/model/parameter change bumps `updated_at`) can never silently reuse
 * audio synthesized under the old revision.
 */
export type TtsProfileSnapshot = SafeTtsProfile & {
  updatedAt: string;
  /** Stable fingerprint of default_parameters (sorted-key JSON); never logged raw. */
  parametersFingerprint: string;
};

export type SpeechSynthesisInput = {
  ref: SpeechVoiceRef;
  /** Exact outbound text (already delivery-formatted). */
  text: string;
};

export interface TtsTransport {
  /** Lists saved TTS connection profiles (paginated; metadata only, no synthesis). */
  listProfiles(signal: AbortSignal): Promise<SafeTtsProfile[]>;
  /** Fetches one profile's current revision metadata (host DB read, no provider call). */
  getProfile(connectionId: string, signal: AbortSignal): Promise<TtsProfileSnapshot>;
  /**
   * Lists a profile's voices. This host endpoint may contact the provider for
   * metadata (never synthesis); call it only on an explicit user action.
   */
  listVoices(connectionId: string, signal: AbortSignal): Promise<VoiceOption[]>;
  /** Buffered synthesis. Returns an audio Blob; rejects on anything non-audio. */
  synthesize(input: SpeechSynthesisInput, signal: AbortSignal): Promise<Blob>;
}

/** Practical v1 caps (Cue-side, not provider limits). */
export const MAX_SPEECH_TEXT_CHARS = 2000;
export const MAX_AUDIO_RESPONSE_BYTES = 8 * 1024 * 1024;
export const SYNTHESIS_TIMEOUT_MS = 60_000;

export class SpeechTransportError extends Error {
  constructor(message: string, readonly kind:
    | "auth" | "bad-request" | "provider" | "not-audio" | "too-large" | "network" | "aborted" | "timeout") {
    super(message);
    this.name = "SpeechTransportError";
  }
}

/** Synthesis timed out (the caller's AbortSignal did NOT fire): surfaced as an error, never a silent cancel. */
export function timeoutError(timeoutMs: number): SpeechTransportError {
  return new SpeechTransportError(
    `Speech synthesis timed out after ${Math.round(timeoutMs / 1000)} seconds. Nothing was played; press Play to try again.`,
    "timeout",
  );
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type SpeechTransportOptions = {
  fetchImpl?: FetchLike;
  /** Must be a same-origin relative path. Anything else is rejected at construction. */
  baseUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

function assertRelativeBase(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  if (!/^\/[A-Za-z0-9/_.-]*$/.test(trimmed) || trimmed.startsWith("//")) {
    throw new SpeechTransportError(
      `Cue speech only talks to the same-origin API base; refusing "${base}".`,
      "bad-request",
    );
  }
  return trimmed;
}

async function errorMessageFrom(response: Response): Promise<string> {
  let detail = "";
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body?.error === "string") detail = body.error;
  } catch { /* non-JSON error body */ }
  return detail || `Request failed (${response.status}).`;
}

function classifyStatus(status: number): SpeechTransportError["kind"] {
  if (status === 401 || status === 403) return "auth";
  if (status >= 500 || status === 429 || status === 502) return "provider";
  return "bad-request";
}

const AUDIO_MIME = /^audio\/|^application\/ogg\b/i;

export function createSpeechTransport(options: SpeechTransportOptions = {}): TtsTransport {
  const base = assertRelativeBase(options.baseUrl ?? "/api/v1");
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? SYNTHESIS_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? MAX_AUDIO_RESPONSE_BYTES;

  async function request(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, { ...init, credentials: "include", signal });
    } catch (error) {
      if (signal.aborted) throw new SpeechTransportError("Cancelled.", "aborted");
      throw new SpeechTransportError(error instanceof Error ? error.message : String(error), "network");
    }
    return response;
  }

  return {
    async listProfiles(signal) {
      const profiles: SafeTtsProfile[] = [];
      const limit = 100;
      let offset = 0;
      for (let page = 0; page < 20; page += 1) {
        const response = await request(`/tts-connections?limit=${limit}&offset=${offset}`, { method: "GET" }, signal);
        if (!response.ok) throw new SpeechTransportError(await errorMessageFrom(response), classifyStatus(response.status));
        const body = await response.json() as { data?: unknown; total?: unknown };
        const rows = Array.isArray(body.data) ? body.data : [];
        for (const raw of rows) {
          if (raw === null || typeof raw !== "object") continue;
          const row = raw as Record<string, unknown>;
          if (typeof row.id !== "string" || !row.id) continue;
          profiles.push({
            id: row.id,
            name: typeof row.name === "string" ? row.name : row.id,
            provider: typeof row.provider === "string" ? row.provider : "",
            model: typeof row.model === "string" ? row.model : "",
            voice: typeof row.voice === "string" ? row.voice : "",
            isDefault: row.is_default === true,
          });
        }
        offset += rows.length;
        const total = typeof body.total === "number" ? body.total : profiles.length;
        if (rows.length === 0 || profiles.length >= total) break;
      }
      return profiles;
    },

    async getProfile(connectionId, signal) {
      const response = await request(`/tts-connections/${encodeURIComponent(connectionId)}`, { method: "GET" }, signal);
      if (response.status === 404) {
        throw new SpeechTransportError("This saved TTS profile no longer exists. Pick another in Settings.", "bad-request");
      }
      if (!response.ok) throw new SpeechTransportError(await errorMessageFrom(response), classifyStatus(response.status));
      const row = await response.json() as Record<string, unknown>;
      if (typeof row.id !== "string" || !row.id) {
        throw new SpeechTransportError("The host returned an unreadable TTS profile.", "provider");
      }
      const defaults = row.default_parameters;
      const fingerprint = defaults !== null && typeof defaults === "object" && !Array.isArray(defaults)
        ? JSON.stringify(Object.entries(defaults as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
        : "";
      return {
        id: row.id,
        name: typeof row.name === "string" ? row.name : row.id,
        provider: typeof row.provider === "string" ? row.provider : "",
        model: typeof row.model === "string" ? row.model : "",
        voice: typeof row.voice === "string" ? row.voice : "",
        isDefault: row.is_default === true,
        updatedAt: typeof row.updated_at === "string" || typeof row.updated_at === "number" ? String(row.updated_at) : "",
        parametersFingerprint: fingerprint,
      };
    },

    async listVoices(connectionId, signal) {
      const response = await request(`/tts-connections/${encodeURIComponent(connectionId)}/voices`, { method: "GET" }, signal);
      if (!response.ok) throw new SpeechTransportError(await errorMessageFrom(response), classifyStatus(response.status));
      const body = await response.json() as { voices?: unknown; error?: unknown };
      // The host returns 200 with an `error` field when the provider lookup failed.
      if (typeof body.error === "string" && body.error) throw new SpeechTransportError(body.error, "provider");
      const voices = Array.isArray(body.voices) ? body.voices : [];
      return voices.flatMap((raw) => {
        if (raw === null || typeof raw !== "object") return [];
        const row = raw as Record<string, unknown>;
        if (typeof row.id !== "string" || !row.id) return [];
        return [{ id: row.id, name: typeof row.name === "string" && row.name ? row.name : row.id }];
      });
    },

    async synthesize(input, signal) {
      const text = input.text;
      if (!text.trim()) throw new SpeechTransportError("Nothing to speak.", "bad-request");
      if (text.length > MAX_SPEECH_TEXT_CHARS) {
        throw new SpeechTransportError(
          `This paragraph is longer than the ${MAX_SPEECH_TEXT_CHARS}-character speech limit.`,
          "too-large",
        );
      }
      const timeout = timeoutMs > 0 && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(timeoutMs)
        : null;
      const combined = timeout && typeof AbortSignal.any === "function"
        ? AbortSignal.any([signal, timeout])
        : signal;
      const payload: Record<string, unknown> = {
        connectionId: input.ref.connectionId,
        text,
        outputFormat: "mp3",
      };
      // Empty voice means "use the profile's own default voice" (host semantics).
      if (input.ref.voice) payload.voice = input.ref.voice;
      if (input.ref.parameters?.speed) payload.parameters = { speed: input.ref.parameters.speed };
      // A fired timeout signal means OUR cap hit, not a user cancel: report it
      // as "timeout" so the UI shows an error instead of silently resetting.
      const timedOut = (): boolean => (timeout?.aborted ?? false) && !signal.aborted;
      let response: Response;
      try {
        response = await request("/tts/synthesize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }, combined);
      } catch (error) {
        if (timedOut()) throw timeoutError(timeoutMs);
        throw error;
      }
      if (!response.ok) throw new SpeechTransportError(await errorMessageFrom(response), classifyStatus(response.status));
      const contentType = response.headers.get("content-type") ?? "";
      if (!AUDIO_MIME.test(contentType)) {
        throw new SpeechTransportError(
          `The TTS endpoint returned "${contentType || "no content type"}" instead of audio.`,
          "not-audio",
        );
      }
      // Enforce the size cap WHILE reading, not after allocation.
      const reader = response.body?.getReader();
      if (!reader) {
        const blob = await response.blob();
        if (blob.size > maxBytes) throw new SpeechTransportError("Audio response exceeded the size limit.", "too-large");
        if (blob.size === 0) throw new SpeechTransportError("The TTS endpoint returned empty audio.", "provider");
        return blob.type ? blob : new Blob([blob], { type: contentType });
      }
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          received += value.byteLength;
          if (received > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new SpeechTransportError("Audio response exceeded the size limit.", "too-large");
          }
          chunks.push(value);
        }
      } catch (error) {
        if (error instanceof SpeechTransportError) throw error;
        if ((timeout?.aborted ?? false) && !signal.aborted) throw timeoutError(timeoutMs);
        if (combined.aborted) throw new SpeechTransportError("Cancelled.", "aborted");
        throw new SpeechTransportError(error instanceof Error ? error.message : String(error), "network");
      }
      if (received === 0) throw new SpeechTransportError("The TTS endpoint returned empty audio.", "provider");
      return new Blob(chunks as BlobPart[], { type: contentType });
    },
  };
}
