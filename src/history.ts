// Feature 6: History Management

import { openOnUserTurn } from "./history-validator.js";
import type { KiroHistoryEntry, KiroToolSpec } from "./transform.js";

export const HISTORY_LIMIT = 850000;
/** The context window size (in tokens) that HISTORY_LIMIT was calibrated for. */
export const HISTORY_LIMIT_CONTEXT_WINDOW = 200000;
/** Maximum combined base64 characters retained for one historical image-bearing turn. */
export const HISTORY_IMAGE_BASE64_LIMIT = 512 * 1024;

/**
 * Keep at most the newest bounded image-bearing history entry.
 *
 * Older images are removed to bound request growth. If the newest image set is
 * itself too large, remove it as well rather than substituting an older image
 * that no longer matches a follow-up such as "look at that image again".
 */
export function stripHistoryImages(history: KiroHistoryEntry[], keepNewestBounded = true): KiroHistoryEntry[] {
  let newestImageIndex = -1;
  for (let index = history.length - 1; index >= 0; index--) {
    if ((history[index]?.userInputMessage?.images?.length ?? 0) > 0) {
      newestImageIndex = index;
      break;
    }
  }

  const newestImages = newestImageIndex >= 0 ? history[newestImageIndex]?.userInputMessage?.images : undefined;
  const keepNewest =
    keepNewestBounded &&
    newestImages !== undefined &&
    newestImages.reduce((size, image) => size + image.source.bytes.length, 0) <= HISTORY_IMAGE_BASE64_LIMIT;

  return history.map((entry, index) => {
    if (!entry.userInputMessage?.images || (index === newestImageIndex && keepNewest)) return entry;
    const { images: _images, ...rest } = entry.userInputMessage;
    return { ...entry, userInputMessage: { ...rest } };
  });
}

export function sanitizeHistory(history: KiroHistoryEntry[]): KiroHistoryEntry[] {
  // Open on a user turn by salvaging, not dropping, a mid-turn prefix — see
  // `openOnUserTurn` for why dropping cascades into a context wipe.
  const modelId = history.find((entry) => entry.userInputMessage?.modelId)?.userInputMessage?.modelId ?? "";
  history = openOnUserTurn(history, modelId, { keepLast: false });
  const result: KiroHistoryEntry[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (!m) continue;
    // Skip assistant messages with no content and no tool uses (e.g. from API errors)
    if (m.assistantResponseMessage && !m.assistantResponseMessage.toolUses && !m.assistantResponseMessage.content)
      continue;
    if (m.assistantResponseMessage?.toolUses) {
      const next = history[i + 1];
      if (next?.userInputMessage?.userInputMessageContext?.toolResults) result.push(m);
    } else if (m.userInputMessage?.userInputMessageContext?.toolResults) {
      const prev = result[result.length - 1];
      if (prev?.assistantResponseMessage?.toolUses) result.push(m);
      else if (m.userInputMessage.content.trim() !== "") {
        // The results answer nothing, but the text is a user utterance merged
        // into this carrier; keep it and drop only the orphaned results.
        const { userInputMessageContext, ...rest } = m.userInputMessage;
        const tools = userInputMessageContext.tools;
        result.push({ userInputMessage: { ...rest, ...(tools ? { userInputMessageContext: { tools } } : {}) } });
      }
    } else {
      result.push(m);
    }
  }
  return result;
}

export function injectSyntheticToolCalls(history: KiroHistoryEntry[]): KiroHistoryEntry[] {
  const validIds = new Set<string>();
  for (const entry of history) {
    for (const tu of entry.assistantResponseMessage?.toolUses ?? []) {
      if (tu.toolUseId) validIds.add(tu.toolUseId);
    }
  }
  const result: KiroHistoryEntry[] = [];
  for (const entry of history) {
    const toolResults = entry.userInputMessage?.userInputMessageContext?.toolResults;
    if (toolResults) {
      const orphaned = toolResults.filter((tr) => !validIds.has(tr.toolUseId));
      if (orphaned.length > 0) {
        result.push({
          assistantResponseMessage: {
            content: "Tool calls were made.",
            toolUses: orphaned.map((tr) => ({ name: "unknown_tool", toolUseId: tr.toolUseId, input: {} })),
          },
        });
        for (const tr of orphaned) validIds.add(tr.toolUseId);
      }
    }
    result.push(entry);
  }
  return result;
}

export function prepareHistory(history: KiroHistoryEntry[], keepNewestBoundedImage = true): KiroHistoryEntry[] {
  return injectSyntheticToolCalls(sanitizeHistory(stripHistoryImages(history, keepNewestBoundedImage)));
}

/** Fail before sending rather than silently discarding conversation context. */
export function assertHistoryWithinLimit(history: KiroHistoryEntry[], limit: number): void {
  const size = JSON.stringify(history).length;
  if (size > limit) {
    throw new Error(
      `Kiro API error: context_length_exceeded (local history ${size} chars / ${history.length} entries exceeds ${limit}-char limit)`,
    );
  }
}

export function extractToolNamesFromHistory(history: KiroHistoryEntry[]): Set<string> {
  const names = new Set<string>();
  for (const entry of history) {
    for (const tu of entry.assistantResponseMessage?.toolUses ?? []) {
      if (tu.name) names.add(tu.name);
    }
  }
  return names;
}

export function addPlaceholderTools(tools: KiroToolSpec[], history: KiroHistoryEntry[]): KiroToolSpec[] {
  const historyNames = extractToolNamesFromHistory(history);
  if (historyNames.size === 0) return tools;
  const existing = new Set(tools.map((t) => t.toolSpecification?.name).filter(Boolean));
  const missing = Array.from(historyNames).filter((n) => !existing.has(n));
  if (missing.length === 0) return tools;
  return [
    ...tools,
    ...missing.map((name) => ({
      toolSpecification: {
        name,
        description: "Tool",
        inputSchema: { json: { type: "object" as const, properties: {} } },
      },
    })),
  ];
}
