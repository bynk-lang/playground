# Assets

Served from the app origin's root (copied into `dist/` by `build.mjs`).

| File | Used for |
|---|---|
| `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` (180×180) | Browser tab and home-screen icons. A **placeholder**: a bold B on the brand amber, until the official Bynk mark is supplied. |
| `og.png` (1200×630) | The link-preview card (`og:image`). Unfurlers do not run scripts, so every playground link, `?s=` and `#…` alike, shows this one card. |

The PNGs are screenshots of the SVG and of an HTML card (the `Bynk.` wordmark in JetBrainsMono Nerd Font, the brand amber and teal blocks, a ligature arrow), taken with headless Chrome at the sizes above. Regenerate them when the mark changes.
