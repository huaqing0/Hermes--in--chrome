# Contributing to Hermes in Chrome

Thanks for the interest! This is a small project — contributions and issues are welcome.

## Quick start

```bash
git clone https://github.com/huaqing0/hermes-in-chrome.git
cd hermes-in-chrome
npm install
npm run dev    # vite dev with hot reload
# or
npm run build  # production build into dist/
```

Load the extension in Chrome:

1. `chrome://extensions` → enable Developer mode
2. "Load unpacked" → select the `dist/` folder
3. Open the sidepanel (toolbar icon or `Cmd+H` / `Ctrl+H`)

You'll also need the **Hermes Agent** backend running on `127.0.0.1:8642`. See the [main README](./README.md#dependencies) for setup.

## Code style

- TypeScript strict mode — no `any` unless unavoidable
- Functional components + hooks (no class components)
- Keep CSS in `src/sidepanel/styles.css` (single sheet, theme-scoped via `[data-theme]`)
- Don't reformat unrelated files — keep changes surgical

## Pull requests

- One feature / fix per PR
- Include a one-line summary in the PR title (e.g. `feat: add minimax oauth flow`, `fix: composer placeholder regression`)
- Test in both `dystopia` and `synthwave` themes if your change touches UI
- Run `npm run build` and `npm run typecheck` before pushing

## Filing issues

Useful info to include:

- Chrome version (`chrome://version`)
- Hermes Agent version
- Steps to reproduce
- Screenshot or screen recording if it's a UI issue

## License

By contributing, you agree that your contributions will be licensed under the [PolyForm Noncommercial License 1.0.0](./LICENSE) of this project.

If you want to make a contribution that should be available under a more permissive license, mention it in your PR and we'll discuss.
