import type { SpindleAPI } from "lumiverse-spindle-types";

/**
 * Message intake for RisuAI/LumiRealm cards: resolve host macros, then clean
 * whatever the host could not resolve, so the planner, the stored turn, and
 * the frontend only ever see readable narrative text.
 *
 * Pipeline: `resolveMessageText` = fast path -> `spindle.macros.resolve`
 * (dry, `commit: false`) -> `cleanResolvedText`. Ordinary messages take the
 * fast path and are returned byte-identical without a host call.
 */

/** A line that is only a display-regex placeholder such as `$messageSelector`. */
const PLACEHOLDER_LINE = /^[ \t]*\$[A-Za-z_][\w-]*[ \t]*$/;

/**
 * Tokens `cleanResolvedText` keeps even though they look like macros:
 * `{{img::...}}` is an inline card image reference consumed later by
 * `paragraphs.ts`, and `{{char}}`/`{{user}}` style display macros are
 * substituted with real names by the planner's `resolveDisplayMacros`.
 * Stripping the latter here would lose the name substitution on hosts
 * without a macros API.
 */
const KEEP_IMG = /^\{\{\s*img\s*::/i;
const KEEP_DISPLAY = /^\{\{\s*(?:char|character|user|persona)\s*\}\}$/i;

function keepToken(token: string): boolean {
  return KEEP_IMG.test(token) || KEEP_DISPLAY.test(token);
}

/**
 * Host macros whose output changes between calls with identical input
 * (`volatile: true` in the Lumiverse registry: time, randomness, idle
 * duration, counters, shuffles). The host does not report volatility to
 * extensions, so the selection fingerprint masks these tokens before the
 * dry resolve; the planning text still resolves them for real.
 */
export const VOLATILE_MACROS: ReadonlySet<string> = new Set([
  "randomtag", "random_tag", "randomchartag",
  "time", "date", "weekday", "isotime", "isodate", "datetimeformat",
  "idleduration", "idle_duration", "timediff", "time_diff",
  "random", "pick", "roll", "randomlumia", "chatage", "chat_age",
  "counter", "toggle", "rcounter", "shuffle",
  "foreachvar", "for_each_var", "foreachchatvar", "for_each_chat_var",
  "foreachglobalvar", "foreachgvar", "for_each_global_var"
].map((name) => name.toLowerCase()));

/**
 * Mask delimiter: U+2062 INVISIBLE TIMES (format char, not whitespace, never
 * produced by macros). Any literal occurrence in the stored text is dropped
 * first so a placeholder can never collide with user content.
 */
const MASK = "\u2062";
const MASK_PATTERN = /\u2062(\d+)\u2062/g;

/** Macro name of a `{{...}}` token: the first segment before `::`, `:`, whitespace or `}}`. */
function macroName(token: string): string {
  const inner = token.slice(2, -2).trim();
  const match = /^([A-Za-z_][\w-]*)/.exec(inner);
  return match ? match[1]!.toLowerCase() : "";
}

export type MaskedTemplate = { template: string; tokens: string[] };

/**
 * Replace every depth-0 volatile token with an indexed placeholder
 * (`\u2062N\u2062`) and return the tokens in order. Tokens nested inside
 * another token (a `{{#when::{{random::..}}}}` header) are left alone: they
 * drive the selection itself and must reach the host in the ONE call that
 * chooses the branch. `tokens` is empty when nothing was masked.
 */
export function maskVolatileMacros(text: string): MaskedTemplate {
  const source = text.includes(MASK) ? text.split(MASK).join("") : text;
  if (!source.includes("{{")) return { template: source, tokens: [] };
  const tokens: string[] = [];
  let output = "";
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("{{", cursor);
    if (start < 0) break;
    const end = tokenEnd(source, start);
    if (end < 0) break;
    const token = source.slice(start, end);
    output += source.slice(cursor, start);
    if (VOLATILE_MACROS.has(macroName(token))) {
      output += `${MASK}${tokens.length}${MASK}`;
      tokens.push(token);
    } else {
      output += token;
    }
    cursor = end;
  }
  if (tokens.length === 0) return { template: source, tokens: [] };
  return { template: output + source.slice(cursor), tokens };
}

/** Selection form of a masked resolution: every placeholder collapses to one stable mark. */
function collapseMasks(text: string): string {
  return text.replace(MASK_PATTERN, MASK);
}

/** Planning form: each surviving placeholder is replaced by its resolved token value. */
function fillMasks(text: string, values: readonly string[]): string {
  return text.replace(MASK_PATTERN, (_match, index: string) => values[Number(index)] ?? "");
}

/** True when the text contains macro syntax the host may be able to resolve. */
function hasMacroSyntax(text: string): boolean {
  return text.replace(/\{\{\s*img\s*::[^{}]*\}\}/gi, "").includes("{{");
}

/** True when the text contains CBS block syntax like `{{#when::...}}` (whitespace and `{{^...}}` inverted forms included). */
function hasMacroBlocks(text: string): boolean {
  return /\{\{\s*[#^/]/.test(text);
}

function hasPlaceholderLine(text: string): boolean {
  return text.split("\n").some((line) => PLACEHOLDER_LINE.test(line));
}

/**
 * Fast-path guard: ordinary messages (no macro syntax, no placeholder-only
 * line) are never sent to the host and are returned unchanged.
 */
export function needsResolution(text: string): boolean {
  return hasMacroSyntax(text) || hasPlaceholderLine(text);
}

/**
 * Find the end offset (exclusive) of a `{{...}}` token starting at `start`,
 * counting nested `{{`/`}}` pairs. Returns -1 when unbalanced.
 */
function tokenEnd(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length - 1; index += 1) {
    if (text.startsWith("{{", index)) {
      depth += 1;
      index += 1;
    } else if (text.startsWith("}}", index)) {
      depth -= 1;
      index += 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

// Tolerate whitespace inside the delimiters and the inverted `{{^name}}` form.
const BLOCK_OPEN = /\{\{\s*[#^]\s*[A-Za-z_]/g;
const BLOCK_CLOSE = /\{\{\s*\/\s*[A-Za-z_]\w*\s*\}\}/g;

type BlockMarker = { kind: "open"; start: number; end: number } | { kind: "close"; start: number; end: number };

function blockMarkers(text: string): BlockMarker[] {
  const markers: BlockMarker[] = [];
  BLOCK_OPEN.lastIndex = 0;
  for (let match = BLOCK_OPEN.exec(text); match; match = BLOCK_OPEN.exec(text)) {
    const end = tokenEnd(text, match.index);
    markers.push({ kind: "open", start: match.index, end: end > 0 ? end : match.index + 3 });
    BLOCK_OPEN.lastIndex = end > 0 ? end : match.index + 3;
  }
  BLOCK_CLOSE.lastIndex = 0;
  for (let match = BLOCK_CLOSE.exec(text); match; match = BLOCK_CLOSE.exec(text)) {
    markers.push({ kind: "close", start: match.index, end: match.index + match[0].length });
  }
  return markers.sort((left, right) => left.start - right.start);
}

/**
 * Remove complete `{{#when::...}} ... {{/when}}` blocks together with their
 * content. When the host resolved the selection, the chosen block is already
 * collapsed to plain text; a block that still exists after resolve belongs to
 * a scene that is not selected (or cannot be selected on this host), so its
 * content must not leak into the story. Unmatched openers or closers lose
 * only the marker itself; the surrounding narrative is kept.
 */
function stripMacroBlocks(text: string): string {
  const markers = blockMarkers(text);
  if (markers.length === 0) return text;
  const removals: Array<{ start: number; end: number }> = [];
  const stack: Array<{ start: number; end: number }> = [];
  for (const marker of markers) {
    if (marker.kind === "open") {
      stack.push({ start: marker.start, end: marker.end });
    } else if (stack.length > 0) {
      // Record EVERY matched pair. An unmatched outer opener must not stop
      // properly closed inner blocks from being removed; outer pairs come
      // first after sorting and swallow the inner ranges.
      const opener = stack.pop()!;
      removals.push({ start: opener.start, end: marker.end });
    } else {
      removals.push({ start: marker.start, end: marker.end });
    }
  }
  // Openers left on the stack are unmatched: drop only the marker token.
  for (const opener of stack) removals.push({ start: opener.start, end: opener.end });
  removals.sort((left, right) => left.start - right.start);
  let output = "";
  let cursor = 0;
  for (const removal of removals) {
    if (removal.start < cursor) continue;
    output += text.slice(cursor, removal.start);
    cursor = removal.end;
  }
  return output + text.slice(cursor);
}

/**
 * Last-resort pass for tokens the innermost-first loop cannot reach, such as
 * `{{getvar::{{user}}}}` where a kept token is nested inside an unresolved
 * one: drop the whole outer token. A lone unbalanced `{{` is dropped as well
 * so no paragraph ever carries macro syntax.
 */
function stripResidualTokens(text: string): string {
  if (!hasMacroSyntax(text)) return text;
  let output = "";
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("{{", cursor);
    if (start < 0) {
      output += text.slice(cursor);
      break;
    }
    output += text.slice(cursor, start);
    const end = tokenEnd(text, start);
    if (end < 0) {
      cursor = start + 2;
      continue;
    }
    const token = text.slice(start, end);
    if (keepToken(token)) output += token;
    cursor = end;
  }
  return output;
}

/** Remove remaining inline `{{...}}` tokens, innermost first, keeping the whitelist. */
function stripInlineTokens(text: string): string {
  let output = text;
  for (let pass = 0; pass < 16; pass += 1) {
    let changed = false;
    output = output.replace(/\{\{[^{}]*\}\}/g, (token) => {
      if (keepToken(token)) return token;
      changed = true;
      return "";
    });
    if (!changed) return output;
  }
  return output;
}

/**
 * Pure, idempotent cleanup of host-resolved text: drop unresolved macro
 * blocks, unresolved inline `{{...}}` tokens, and placeholder-only lines
 * (`$messageSelector`), then normalize the blank lines the removals leave
 * behind. `<pimg>`/`<img>` tags and the kept `{{img::...}}`/display tokens
 * pass through untouched.
 */
export function cleanResolvedText(text: string): string {
  let output = stripMacroBlocks(text);
  output = stripInlineTokens(output);
  output = stripResidualTokens(output);
  output = output
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !PLACEHOLDER_LINE.test(line))
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return output;
}

/**
 * Resolve one message's text through the host macro engine (dry resolve,
 * nothing committed), then clean the leftovers. Falls back to cleaning the
 * raw text when the API is missing or fails. Ordinary messages return
 * unchanged without a host call.
 */
export async function resolveMessageText(
  spindle: SpindleAPI,
  chatId: string,
  content: string,
  userId?: string
): Promise<string> {
  return (await resolveMessageIntake(spindle, chatId, content, userId)).text;
}

/**
 * Result of one message intake resolution.
 *
 * - `text`: the exact narrative the planner, the stored turn and the frontend
 *   use (host-resolved, then cleaned).
 * - `selectionText`: the same resolution with depth-0 volatile macros masked
 *   before the host saw them. Fingerprint THIS, never `text`: `{{random}}`
 *   or `{{time}}` output changes on every dry resolve, while a scene
 *   selection change still changes `selectionText`.
 * - `resolved`: false when the host could not resolve the message (no macros
 *   API, the call threw, or `{{#...}}` blocks survived the resolve, e.g. the
 *   card's interceptor extension is not loaded). A stored turn for the same
 *   message must then be kept instead of replanned or replaced by a waiting
 *   state.
 */
export type MessageIntake = { text: string; selectionText: string; resolved: boolean };

async function hostResolve(spindle: SpindleAPI, chatId: string, template: string, userId?: string): Promise<string | null> {
  if (typeof spindle.macros?.resolve !== "function") return null;
  try {
    const result = await spindle.macros.resolve(template, { chatId, ...(userId ? { userId } : {}), commit: false });
    return typeof result?.text === "string" ? result.text : null;
  } catch {
    return null;
  }
}

export async function resolveMessageIntake(
  spindle: SpindleAPI,
  chatId: string,
  content: string,
  userId?: string
): Promise<MessageIntake> {
  if (!needsResolution(content)) return { text: content, selectionText: content, resolved: true };
  if (!hasMacroSyntax(content)) {
    // Placeholder line only: nothing for the host to do.
    const cleaned = cleanResolvedText(content);
    return { text: cleaned, selectionText: cleaned, resolved: true };
  }
  // Volatile tokens are masked BEFORE the host sees the template, so the
  // branch selection happens in exactly one host call and the planning text
  // and the selection text always describe the same scene. The masked
  // tokens are then resolved on their own to fill the planning text in.
  const masked = maskVolatileMacros(content);
  const hostText = await hostResolve(spindle, chatId, masked.template, userId);
  // A resolve that leaves block syntax behind did not evaluate the card's
  // selection (no interceptor); treat it like an unavailable host.
  const resolved = hostText !== null && !hasMacroBlocks(hostText);
  const base = hostText ?? masked.template;
  if (masked.tokens.length === 0) {
    const text = cleanResolvedText(base);
    return { text, selectionText: text, resolved };
  }
  const values = await Promise.all(masked.tokens.map(async (token, index) => {
    // Only tokens that survived (sit in the selected branch) need a value.
    if (!base.includes(`${MASK}${index}${MASK}`)) return "";
    const value = resolved ? await hostResolve(spindle, chatId, token, userId) : null;
    // An unresolvable volatile token is dropped like any other leftover macro.
    return value !== null && !value.includes("{{") ? value : "";
  }));
  return {
    text: cleanResolvedText(fillMasks(base, values)),
    selectionText: cleanResolvedText(collapseMasks(base)),
    resolved
  };
}

/** Per-planning-run resolution cache, keyed by message id + swipe. */
export type MessageResolutionCache = Map<string, string>;

export function resolutionCacheKey(message: { id: string; swipe_id?: number | null }): string {
  return `${message.id}:${message.swipe_id ?? 0}`;
}

/**
 * Resolve a bounded batch of history messages for planner context. Only
 * messages that actually need resolution reach the host, at most once per
 * message id + swipe within one planning run (the shared `cache`).
 */
export async function resolveContextMessages<T extends { id: string; swipe_id?: number | null; content: string }>(
  spindle: SpindleAPI,
  chatId: string,
  messages: readonly T[],
  cache: MessageResolutionCache,
  userId?: string
): Promise<T[]> {
  return Promise.all(messages.map(async (message) => {
    if (!needsResolution(message.content)) return message;
    const key = resolutionCacheKey(message);
    let resolved = cache.get(key);
    if (resolved === undefined) {
      resolved = await resolveMessageText(spindle, chatId, message.content, userId);
      cache.set(key, resolved);
    }
    return { ...message, content: resolved };
  }));
}

const INLINE_IMAGE_TAG = /<p?img\b/i;

type MatchedBlock = { start: number; end: number; bodyStart: number; bodyEnd: number };

/** Top-level matched `{{#...}}...{{/...}}` blocks with their body offsets. */
function topLevelBlocks(text: string): MatchedBlock[] {
  const blocks: MatchedBlock[] = [];
  const stack: Array<{ start: number; end: number }> = [];
  for (const marker of blockMarkers(text)) {
    if (marker.kind === "open") {
      stack.push({ start: marker.start, end: marker.end });
    } else if (stack.length > 0) {
      const opener = stack.pop()!;
      if (stack.length === 0) blocks.push({ start: opener.start, end: marker.end, bodyStart: opener.end, bodyEnd: marker.start });
    }
  }
  return blocks;
}

/**
 * Unselected-greeting rule (documented in ARCHITECTURE.md). Evidence-based,
 * never a bare length heuristic:
 *
 * 1. The RAW text must contain macro block syntax or a placeholder-only line
 *    (scene selection is in play at all); otherwise never unselected.
 * 2. Cleaned text that is empty is unselected: every scene sat in a block
 *    that was not chosen.
 * 3. Non-empty cleaned text is unselected only with explicit default-branch
 *    evidence: the raw greeting carries a display-regex placeholder line AND
 *    at least two selectable top-level blocks AND the cleaned text equals the
 *    FIRST block's cleaned body (the branch such cards fall into while the
 *    selection variable is unset) AND that body is a single line without a
 *    paragraph break or inline image tag.
 *
 * A legitimate short opening scene is never blocked just for being short:
 * without the placeholder line and the first-block match it is planned as
 * narrative. The placeholder's wording is never matched, so the rule works
 * for any card and language.
 */
export function isUnselectedGreeting(raw: string, cleaned: string): boolean {
  if (!hasMacroBlocks(raw) && !hasPlaceholderLine(raw)) return false;
  if (!cleaned.trim()) return true;
  if (!hasPlaceholderLine(raw)) return false;
  const blocks = topLevelBlocks(raw);
  if (blocks.length < 2) return false;
  const firstBody = cleanResolvedText(raw.slice(blocks[0]!.bodyStart, blocks[0]!.bodyEnd));
  if (!firstBody || cleaned.trim() !== firstBody) return false;
  return !firstBody.includes("\n") && !INLINE_IMAGE_TAG.test(firstBody);
}
