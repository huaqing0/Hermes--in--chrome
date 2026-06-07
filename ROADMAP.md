# Roadmap

Hermes in Chrome is an **early-preview, local-first Chrome workspace for Hermes Agent**. It lets Hermes understand the current browser scene, automate browser actions, and keep each task isolated in its own tab group. This document outlines the direction and priorities.

## Current focus

- Stabilize the core loop: WebSocket connection, tool execution, streaming replies
- Polish the onboarding flow so users can get from zero to working agent in minutes
- Collect early feedback from real-world use

## Near-term improvements

- Improve backend troubleshooting UX — better error messages, health-check visibility, one-click diagnostics
- Refine Native Messaging host setup — clarify the install/status/uninstall flow, reduce manual steps
- Windows validation — verify the full install + run path on real Windows + Chrome
- Provider setup wizard — guide users through API key configuration, OAuth login, and connection tests
- Docs: troubleshooting guide, release checklist, issue/PR templates

## Medium-term improvements

- Safety controls — per-session tool approval defaults, permission profiles, read-only research sessions
- Automated tests — unit tests for filewriter safety, integration tests for the WS protocol, smoke tests for the extension build
- Release notes — structured changelog per release, known limitations documented upfront
- Provider health monitoring — detect degraded providers and surface status in the UI
- Console hook hardening — make the MAIN world console hook opt-in instead of default injection

## Long-term direction

- Signed releases and Chrome Web Store submission readiness
- Linux support (after Windows is validated)
- Shared-token local gateway authentication — defend against local process impersonation
- Session export and import — share and restore agent research sessions
- Accessibility improvements — keyboard navigation, screen reader support, high-contrast theme
