# Fonts

`JetBrainsMonoNerdFont-{Regular,Bold,Italic}.woff2` are the editor's code font:
[JetBrainsMono Nerd Font](https://github.com/ryanoasis/nerd-fonts) v3.5.1 (JetBrains Mono patched
with Nerd Font glyphs), licensed under the SIL Open Font License 1.1 (`OFL.txt`).

They are trimmed with `pyftsubset` to keep the files small (~50 KB each): Basic Latin, Latin-1,
general punctuation, arrows, math operators, box drawing, geometric shapes, a few check/cross
marks and the Powerline symbols (U+E0A0–E0D7). **All OpenType layout features are kept**, notably
`calt`, which draws Bynk's `<-`, `->`, `=>`, `::` and `++` as ligatures. The full Nerd Font icon
set is not included; to restore it, re-subset from the release archive with a wider `--unicodes`.

To regenerate (needs `pip install fonttools brotli`), from the extracted release archive:

```sh
pyftsubset JetBrainsMonoNerdFont-Regular.ttf \
  --unicodes="U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-203A,U+2190-21FF,U+2200-22FF,U+2500-257F,U+25A0-25FF,U+2713-2717,U+E0A0-E0D7,U+FB00-FB06" \
  --layout-features='*' --flavor=woff2 --output-file=JetBrainsMonoNerdFont-Regular.woff2
```
