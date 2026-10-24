// The examples gallery: a searchable dialog of cards, replacing the plain <select>.
// Each card shows what the example teaches and a peek at the code; picking one hands
// it back to the app, which loads and runs it.

import { EXAMPLES } from "./examples";
import type { Example } from "./examples";
import type { RecentSnippet } from "./store";

// The first few lines from the first `type` / `service`: the part worth a glance.
function peek(source: string): string {
  const lines = source.split("\n");
  const start = Math.max(0, lines.findIndex((l) => /^(type|service)\b/.test(l)));
  return lines.slice(start, start + 4).join("\n");
}

function contextName(src: string): string {
  return /^context\s+(\S+)/m.exec(src)?.[1] ?? "Untitled snippet";
}

function ago(at: number): string {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

export function mountGallery(opts: {
  onPick: (ex: Example) => void;
  currentId: () => string | null;
  recent: () => RecentSnippet[];
  onPickRecent: (r: RecentSnippet) => void;
}): void {
  const dialog = document.getElementById("gallery") as HTMLDialogElement;
  const search = document.getElementById("gallery-search") as HTMLInputElement;
  const grid = document.getElementById("gallery-grid")!;
  const recentGrid = document.getElementById("recent-grid")!;
  const recentSection = document.getElementById("recent-section")!;
  const empty = document.getElementById("gallery-empty")!;
  const opener = document.getElementById("examples")!;

  const makeCard = (titleText: string, blurbText: string, source: string, onClick: () => void): HTMLElement => {
    const card = document.createElement("button");
    card.className = "card";
    card.type = "button";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = titleText;
    const blurb = document.createElement("div");
    blurb.className = "card-blurb";
    blurb.textContent = blurbText;
    const code = document.createElement("pre");
    code.className = "card-peek";
    code.textContent = peek(source);
    card.append(title, blurb, code);
    card.addEventListener("click", onClick);
    return card;
  };

  const render = (): void => {
    const q = search.value.trim().toLowerCase();
    const current = opts.currentId();
    grid.textContent = "";
    const matches = EXAMPLES.filter((e) => !q || `${e.title} ${e.blurb}`.toLowerCase().includes(q));
    for (const ex of matches) {
      const card = makeCard(ex.title, ex.blurb, ex.source, () => {
        dialog.close();
        opts.onPick(ex);
      });
      if (ex.id === current) {
        card.setAttribute("aria-current", "true");
        const tag = document.createElement("div");
        tag.className = "card-current";
        tag.textContent = "✓ Current";
        card.append(tag);
      }
      grid.append(card);
    }
    const recents = opts.recent().filter((r) => !q || contextName(r.src).toLowerCase().includes(q));
    recentGrid.textContent = "";
    for (const r of recents) {
      recentGrid.append(
        makeCard(contextName(r.src), ago(r.at), r.src, () => {
          dialog.close();
          opts.onPickRecent(r);
        }),
      );
    }
    recentSection.hidden = recents.length === 0;
    empty.hidden = matches.length > 0 || recents.length > 0;
  };

  opener.addEventListener("click", () => {
    search.value = "";
    render();
    dialog.showModal();
    search.focus();
  });
  search.addEventListener("input", render);
  // Enter in the search box opens the first match.
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") grid.querySelector<HTMLElement>(".card")?.click();
  });
  // A click on the backdrop (outside the dialog box) closes it.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => opener.focus());
}
