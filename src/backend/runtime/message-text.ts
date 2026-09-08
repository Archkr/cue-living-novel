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
  if (!needsResolution(content)) return content;
  let text = content;
  if (hasMacroSyntax(content) && typeof spindle.macros?.resolve === "function") {
    try {
      const result = await spindle.macros.resolve(content, { chatId, ...(userId ? { userId } : {}), commit: false });
      if (typeof result?.text === "string") text = result.text;
    } catch {
      text = content;
    }
  }
  return cleanResolvedText(text);
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
