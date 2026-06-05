# Local Gateway Authentication

## Problem

Hermes in Chrome connects to the Hermes Agent gateway at `ws://127.0.0.1:8642/api/ws/extension`. While this is loopback-only, a malicious local process could:

- Bind to port 8642 before the real Hermes gateway starts
- Impersonate the gateway and intercept conversations, tool calls, screenshots, and page content
- Relay traffic to a malicious LLM provider or log it locally

The loopback address prevents remote attacks but does not prevent local process impersonation.

## Planned solution: shared-token handshake

A simple shared token can validate that both the extension and the gateway are under the same user's control.

### Setup flow

1. On first `npm run backend:ensure`, the backend setup script generates a random token and writes it to `~/.hermes/.gateway-token` (permissions `0600`)
2. The token is passed to the gateway as an environment variable or CLI argument
3. The extension retrieves the token on startup via the Native Messaging host (the `ping` op already returns metadata from `~/.hermes/hermes-in-chrome.json`; the token file can be read through the same channel). The Service Worker holds the token in memory for the session lifetime and re-reads it on reconnect

### Runtime flow

1. The extension's Service Worker opens a WebSocket to `127.0.0.1:8642`
2. The extension sends a `hello` message containing the token
3. The gateway validates the token against the stored value
4. If the token matches, the connection proceeds normally
5. If the token does not match, the gateway closes the connection and logs the rejection

### Design constraints

- The token is never sent to any LLM provider — it stays within the WebSocket handshake
- The extension holds the token in memory only (not persisted in `chrome.storage`); it does not appear in conversation logs or tool results
- Token rotation is supported: generate a new token, restart the gateway with it, and the extension picks it up on next connect
- Fail-closed by default: if the token file is missing or the token does not match, the gateway rejects the connection. During migration, unauthenticated mode may be allowed only behind an explicit `--legacy-no-auth` flag

### What this does NOT protect

- A process that can read `~/.hermes/.gateway-token` (already has user-level filesystem access) can impersonate the gateway
- This layer does not add encryption (already handled by the loopback interface)
- It does not authenticate the extension to the gateway in the opposite direction (the gateway trusts any local connection)

### Alternatives considered

- **Unix domain sockets**: more secure than TCP loopback, but Chrome extensions cannot connect to Unix sockets through the WebSocket API
- **mTLS**: would require certificate management, key distribution, and more complex setup
- **Random port**: port scanners defeat this; not meaningful security
- **HMAC challenge-response**: more complex than needed for a single-user machine; the shared token is sufficient

## Implementation plan

This is a planned enhancement. It requires changes in:

1. `scripts/hermes-backend.mjs` — token generation and env variable passthrough
2. The Hermes Agent gateway — token validation on WebSocket connect
3. The extension's Service Worker — retrieve the token and include it in the `hello` message

## Related

- [Threat model](./threat-model.md)
- [Security policy](../SECURITY.md)
