# docs/

This directory holds screenshots, GIFs, and other visual assets for the top-level `README.md`.

## Pending assets

Before publishing a screenshot-heavy README, capture:

1. **Hero screenshot (PNG)** — sidepanel in CP2077 theme, fresh install state showing the onboarding status bar. Suggested size: 1280×800 or close to actual sidepanel proportions.
2. **Theme comparison (PNG, optional)** — CP2077 vs Synthwave side by side.
3. **Feature GIF (≤ 5 MB)** — 30–60 seconds: open sidepanel → type a research prompt → watch agent open a tab, read the a11y tree, stream the reply. Use `gifski` or `ffmpeg -filter_complex "fps=15,scale=720:-1:flags=lanczos,palettegen"` for a small palette-optimised GIF.
4. **Demo video (optional)** — 1–3 minute YouTube / Bilibili upload, link from the README.

## Recording tips

- macOS QuickTime Player → File → New Screen Recording → pick a region around the sidepanel
- For GIFs of the agent in action, narrate the steps with on-screen captions or arrows; viewers won't know what `read_page` is on first glance
- Crop tightly — empty Chrome chrome around the sidepanel hurts engagement

Once recorded, drop the files in this directory and update the image links in the top-level README.
