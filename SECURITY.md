# Security Policy

## Secrets

Do not commit API keys, OAuth tokens, `.env` files, logs, or local credential stores.

Use `.env.example` as a template only. Real credentials should live in your local Hermes backend environment, for example `~/.hermes/.env`, or in the extension's local settings when you intentionally choose the advanced local override path.

## Data Flow

Hermes in Chrome can read page content and send user prompts plus selected page context to the configured local Hermes backend at `127.0.0.1:8642`.

If you configure an external model provider, the backend may send relevant prompt/page context to that provider. Review your provider's data policy before use.

For the concrete trust boundaries, risky permissions, and mitigations, see [docs/threat-model.md](./docs/threat-model.md).

## Reporting Issues

Please report security issues privately before opening a public GitHub issue.

For now, contact the maintainer through the GitHub profile:

https://github.com/huaqing0
