# pi-langfuse-plus

Langfuse observability for Pi coding agent, vendored from `gooyoung/pi-langfuse`
and extended with Superpowers workflow phase metadata.

## Install

From this monorepo:

```bash
pi install ./packages/langfuse
```

This package has runtime Langfuse/OpenTelemetry dependencies. For local tests:

```bash
cd packages/langfuse
npm install
npm test
npm run typecheck
```

## Configure

Run `/langfuse-setup` inside Pi, or set the required credentials in the environment:

- `LANGFUSE_PUBLIC_KEY` — required public key.
- `LANGFUSE_SECRET_KEY` — required secret key.
- `LANGFUSE_BASE_URL` or `LANGFUSE_HOST` — optional host, defaulting to `https://cloud.langfuse.com`.

Optional environment controls include `LANGFUSE_PRIVACY_PRESET`, `LANGFUSE_CAPTURE_INPUTS`, `LANGFUSE_CAPTURE_OUTPUTS`, `LANGFUSE_CAPTURE_TOOL_IO`, `LANGFUSE_CAPTURE_SYSTEM_PROMPT`, and `LANGFUSE_CAPTURE_CWD`. `PI_LANGFUSE_SCORE_SHUTDOWN_TIMEOUT` bounds the final score-delivery attempt during shutdown and defaults to 2 seconds. Use `/langfuse-status` to inspect configuration and `/langfuse-privacy` to view or change the capture preset.

## Superpowers phase metadata

The extension listens for `superpowers:phase` events and retains the latest
non-empty phase in memory. It writes that phase under the `superpowers_phase`
metadata key on the root agent observation at start and finish, and on every
LLM generation observation at request start. Clearing the phase omits the key;
no phase is persisted. The value follows the same capture-policy path as the
extension's git source metadata.

## Upstream provenance

This is a trimmed monorepo vendoring of `gooyoung/pi-langfuse` at commit
`c79c527a7294e1d4b8153525d5218e87354cbcb1` (v1.5.12, 2026-08-10).
To re-sync upstream behavior, compare the package against that commit before
preserving the local phase-tracking changes.
