# Release Checklist

Steps to follow when cutting a new release of Hermes in Chrome.

## 1. Versioning

- [ ] `version` in `package.json` is bumped (semver)
- [ ] `version` in `src/manifest.json` matches `package.json`
- [ ] Commit the version bumps on a release branch (e.g. `release/v0.2.0`)

## 2. Build

```bash
npm ci
npm run typecheck
npm run build
npm audit --omit=dev --audit-level=moderate
```

- [ ] `npm ci` runs cleanly (no lockfile changes should appear)
- [ ] `npm run typecheck` passes with no errors
- [ ] `npm run build` produces a complete `dist/` directory
- [ ] `npm audit --omit=dev --audit-level=moderate` reports no moderate or higher vulnerabilities

## 3. Manual smoke test

Load `dist/` in Chrome (`chrome://extensions` → Developer mode → Load unpacked) and verify:

- [ ] Sidepanel opens and renders without errors
- [ ] Status bar shows backend health check (green or actionable prompt)
- [ ] Provider settings panel opens, provider dropdown works, model list populates
- [ ] Can send a simple message and receive a response
- [ ] `read_page` returns content from a simple test page
- [ ] Approval mode blocks tools and shows the approval card
- [ ] Native Messaging status shows the correct state
- [ ] (Windows) `reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hermes.filewriter` returns the expected value

## 4. Release notes

Write release notes in the following format:

```markdown
## Added
- Feature or capability added in this release

## Changed
- Existing behavior that was modified

## Fixed
- Bugs resolved in this release

## Security
- Security-related fixes or improvements

## Known limitations
- Issues that are not yet resolved and users should be aware of
```

- [ ] Release notes are written and reviewed
- [ ] Known limitations are documented upfront

## 5. Publish

- [ ] Create a GitHub Release with the version tag (e.g. `v0.2.0`)
- [ ] Attach `hermes-in-chrome.zip` (zip the `dist/` directory)
- [ ] Verify the zip downloads and contains all expected files
- [ ] Check that the GitHub Actions release workflow succeeds (if CI is configured)

## 6. Post-release

- [ ] Update README badges if any are version-dependent
- [ ] Close related milestones or issues
- [ ] Announce on relevant channels if applicable
