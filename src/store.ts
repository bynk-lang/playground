// Per-browser memory: the draft being edited and the last few snippets that were run.
// Everything here is a convenience, never state that must survive: storage can be
// missing or throw (private windows, blocked site data), so every access is wrapped
// and the app behaves identically, just without memory, when it fails.

export interface RecentSnippet {
  src: string;
  /// Epoch milliseconds when it was run.
  at: number;
}

const DRAFT_KEY = "bynk-draft";
const RECENT_KEY = "bynk-recent";
export const RECENT_MAX = 10;

/// `list` with `src` moved to the front (any older copy removed), capped at `max`.
/// Pure, so it is unit-tested without a browser.
export function pushRecent(list: RecentSnippet[], src: string, at: number, max = RECENT_MAX): RecentSnippet[] {
  return [{ src, at }, ...list.filter((r) => r.src !== src)].slice(0, max);
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable or full: carry on without memory
  }
}

export const loadDraft = (): string | null => read(DRAFT_KEY);
export const saveDraft = (src: string): void => write(DRAFT_KEY, src);
export const clearDraft = (): void => write(DRAFT_KEY, null);

export function loadRecent(): RecentSnippet[] {
  try {
    const parsed: unknown = JSON.parse(read(RECENT_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is RecentSnippet => typeof r?.src === "string" && typeof r?.at === "number")
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

const TOUR_KEY = "bynk-tour-done";

/// Ids of the tour steps the learner has passed.
export function loadTourDone(): string[] {
  try {
    const parsed: unknown = JSON.parse(read(TOUR_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function markTourDone(id: string): void {
  const done = loadTourDone();
  if (!done.includes(id)) write(TOUR_KEY, JSON.stringify([...done, id]));
}

export const resetTourDone = (): void => write(TOUR_KEY, null);

export function rememberRun(src: string): void {
  write(RECENT_KEY, JSON.stringify(pushRecent(loadRecent(), src, Date.now())));
}
