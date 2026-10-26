# Assets

Served from the app origin's root (copied into `dist/` by `build.mjs`).

| File | Used for |
|---|---|
| `favicon.svg`, `favicon-32.png`, `apple-touch-icon.svg`, `apple-touch-icon.png` (180×180) | Browser tab and home-screen icons: the bento blocks of the link-preview card (a wide amber block over a teal one and a dark, outlined one). The tab icon has no background so it sits on a light or dark tab; the touch icon is a full square on the dark ground, since iOS fills transparency with black and rounds the corners itself. This is Bynk's mark: the VS Code extension icon and the docs site's favicon are the same blocks. |
| `og.png` (1200×630) | The link-preview card (`og:image`). Unfurlers do not run scripts, so every playground link, `?s=` and `#…` alike, shows this one card. |

The PNGs are screenshots of the SVGs (`favicon-32.png` from `favicon.svg`, `apple-touch-icon.png` from `apple-touch-icon.svg`) and of an HTML card (the `Bynk.` wordmark in JetBrainsMono Nerd Font, the brand amber and teal blocks, a ligature arrow), taken with headless Chrome at the sizes above. Regenerate them when the mark changes.
