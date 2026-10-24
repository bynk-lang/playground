// The examples gallery: a searchable dialog of cards, replacing the plain <select>.
// Each card shows what the example teaches and a peek at the code; picking one hands
// it back to the app, which loads and runs it.

import { EXAMPLES } from "./examples";
import type { Example } from "./examples";

// The first few lines from the first `type` / `service`: the part worth a glance.
function peek(source: string): string {
  const lines = source.split("\n");
  const start = Math.max(0, lines.findIndex((l) => /^(type|service)\b/.test(l)));
  return lines.slice(start, start + 4).join("\n");
}

export function mountGallery(opts: { onPick: (ex: Example) => void; currentId: () => string | null }): void {
  const dialog = document.getElementById("gallery") as HTMLDialogElement;
  const search = document.getElementById("gallery-search") as HTMLInputElement;
  const grid = document.getElementById("gallery-grid")!;
  const empty = document.getElementById("gallery-empty")!;
  const opener = document.getElementById("examples")!;

  const render = (): void => {
    const q = search.value.trim().toLowerCase();
    const current = opts.currentId();
    grid.textContent = "";
    const matches = EXAMPLES.filter((e) => !q || `${e.title} ${e.blurb}`.toLowerCase().includes(q));
    for (const ex of matches) {
      const card = document.createElement("button");
      card.className = "card";
      card.type = "button";
      card.dataset.id = ex.id;
      if (ex.id === current) card.setAttribute("aria-current", "true");
      const title = document.createElement("div");
      title.className = "card-title";
      title.textContent = ex.title;
      const blurb = document.createElement("div");
      blurb.className = "card-blurb";
      blurb.textContent = ex.blurb;
      const code = document.createElement("pre");
      code.className = "card-peek";
      code.textContent = peek(ex.source);
      card.append(title, blurb, code);
      if (ex.id === current) {
        const tag = document.createElement("div");
        tag.className = "card-current";
        tag.textContent = "✓ Current";
        card.append(tag);
      }
      card.addEventListener("click", () => {
        dialog.close();
        opts.onPick(ex);
      });
      grid.append(card);
    }
    empty.hidden = matches.length > 0;
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
