import { serializePromptWeights } from "../inlay-prompt/utils.js";

export type NovelAiCapabilities = { structured: boolean; numeric: boolean; negativeNumeric: boolean };

/** Unknown models get the older, broadly supported bracket syntax. */
export function novelAiCapabilities(model: string | null | undefined): NovelAiCapabilities {
  const version = /^nai-diffusion-(\d+)(?:-(\d+))?(?:-|$)/.exec(model ?? "");
  const major = Number(version?.[1] ?? 0);
  const minor = Number(version?.[2] ?? 0);
  return { structured: major >= 4, numeric: major >= 4, negativeNumeric: major > 4 || (major === 4 && minor >= 5) };
}

/** Serialize compiler weights without treating escaped literal parentheses as emphasis. */
export function renderNovelAiEmphasis(text: string, model: string | null | undefined): string {
  const caps = novelAiCapabilities(model);
  // Authored native numerical emphasis must not silently become an unsupported prompt.
  if (!caps.negativeNumeric && /(?:^|[\s,])-\d+(?:\.\d+)?::/.test(text)) {
    throw new Error("Negative numerical emphasis requires NovelAI V4.5 or newer.");
  }
  if (!caps.numeric) {
    const legacy = text.replace(/(-?\d+(?:\.\d+)?)::([\s\S]*?)::/g, (_, weight, body) => `(${body}:${weight})`);
    return serializePromptWeights(legacy, "nai");
  }
  const render = (source: string, inherited = 1): string => {
    let out = "";
    let plain = "";
    const flush = () => {
      if (!plain) return;
      out += inherited === 1 ? plain : `${Number(inherited.toFixed(6))}::${plain}::`;
      plain = "";
    };
    for (let i = 0; i < source.length; i++) {
      if (source[i] === "\\" && i + 1 < source.length) { plain += source[i]! + source[++i]!; continue; }
      if (source[i] !== "(") { plain += source[i]; continue; }
      let depth = 1;
      let end = i + 1;
      for (; end < source.length; end++) {
        if (source[end] === "\\") { end++; continue; }
        if (source[end] === "(") depth++;
        if (source[end] === ")" && --depth === 0) break;
      }
      const inner = source.slice(i + 1, end);
      const match = depth === 0 ? /:([0-9]+(?:\.[0-9]+)?)$/.exec(inner) : null;
      if (!match) { plain += source[i]; continue; }
      flush();
      out += render(inner.slice(0, match.index), inherited * Number(match[1]));
      i = end;
    }
    flush();
    return out;
  };
  return render(text);
}

export function novelAiQualityTags(model: string | null | undefined): string {
  if (/^nai-diffusion-5(?:-|$)/.test(model ?? "")) return "very aesthetic, masterpiece, no text";
  if (model === "nai-diffusion-4-5-curated") return "location, masterpiece, no text, -0.8::feet::, rating:general";
  if (/^nai-diffusion-4-5(?:-|$)/.test(model ?? "")) return "location, very aesthetic, masterpiece, no text";
  if (model === "nai-diffusion-4-curated-preview") return "rating:general, amazing quality, very aesthetic, absurdres";
  if (/^nai-diffusion-4(?:-|$)/.test(model ?? "")) return "no text, best quality, very aesthetic, absurdres";
  return "best quality, amazing quality, very aesthetic, absurdres";
}

export const NOVELAI_NEGATIVE_DEFAULT = "lowres, artistic error, worst quality, bad quality, jpeg artifacts, blurry, text, watermark, logo, signature, multiple views";
