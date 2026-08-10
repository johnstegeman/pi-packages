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

Run `/langfuse-setup` inside Pi, or set the following environment variables. Both
`LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are required to enable tracing.

### Credentials and transport

- `LANGFUSE_PUBLIC_KEY` — required public key.
- `LANGFUSE_SECRET_KEY` — required secret key.
- `LANGFUSE_BASE_URL` or `LANGFUSE_HOST` — optional host, defaulting to
  `https://cloud.langfuse.com`. `LANGFUSE_BASE_URL` takes precedence when both are set.
- `LANGFUSE_TRACING_ENVIRONMENT` — optional Langfuse tracing environment name.
- `LANGFUSE_TIMEOUT` — positive request timeout in seconds; defaults to 5.
- `LANGFUSE_FLUSH_AT` — positive number of queued scores that triggers a flush;
  defaults to 10.
- `LANGFUSE_FLUSH_INTERVAL` — positive score-flush interval in seconds; defaults
  to 1.

### Privacy and capture

`LANGFUSE_PRIVACY_PRESET` accepts exactly these values:

| Preset | Captures | Omits |
| --- | --- | --- |
| `metadata-only` | Redacted metadata (except `cwd`) | Inputs, outputs, tool input/output, system prompt, and `cwd` |
| `prompts-only` | Redacted inputs and metadata (except `cwd`) | Outputs, tool input/output, system prompt, and `cwd` |
| `conversations` | Redacted inputs, outputs, and metadata (except `cwd`) | Tool input/output, system prompt, and `cwd` |
| `full-debug` | Redacted inputs, outputs, tool input/output, system prompt, and metadata including `cwd` | Nothing from these capture categories |

The default, and the fallback for an unrecognized preset, is `full-debug`. The
individual boolean controls `LANGFUSE_CAPTURE_INPUTS`,
`LANGFUSE_CAPTURE_OUTPUTS`, `LANGFUSE_CAPTURE_TOOL_IO`,
`LANGFUSE_CAPTURE_SYSTEM_PROMPT`, and `LANGFUSE_CAPTURE_CWD` override the preset
when set to `1`, `true`, `yes`, or `on` (or disable it with `0`, `false`, `no`,
or `off`). Captured values are redacted and shaped according to the payload
limits below; disabled fields are omitted. Use `/langfuse-status` to inspect
configuration and `/langfuse-privacy` to view or change the capture preset.

### Payload limits and diagnostics

The `PI_LANGFUSE_*` variables are package-specific safeguards. Each accepts a
positive number (rounded down); `0`, `off`, `none`, `false`, `no`, `unlimited`,
`inf`, or `infinity` removes that limit. Unset, blank, or invalid values retain
the built-in default.

- `PI_LANGFUSE_MAX_STRING_LENGTH` — maximum characters per captured string.
- `PI_LANGFUSE_MAX_TOOL_PAYLOAD_LENGTH` — maximum characters for tool inputs/outputs.
- `PI_LANGFUSE_MAX_DEPTH` — maximum structured-payload nesting depth.
- `PI_LANGFUSE_MAX_ARRAY_ITEMS` — maximum array elements retained per array.
- `PI_LANGFUSE_MAX_OBJECT_KEYS` — maximum own keys retained per object.
- `PI_LANGFUSE_MAX_PAYLOAD_NODES` — maximum nodes visited per payload.
- `PI_LANGFUSE_DEBUG` — set to `1` or `true` to enable diagnostic logging.
- `PI_LANGFUSE_SCORE_SHUTDOWN_TIMEOUT` — positive shutdown score-delivery timeout
  in seconds; defaults to 2 seconds.

## Superpowers phase metadata

The extension listens for `superpowers:phase` events and retains the latest
non-empty phase in memory. It writes that phase under the `superpowers_phase`
metadata key on the root agent observation at start and finish, and on every
LLM generation observation at request start. Clearing the phase omits the key;
no phase is persisted. The value follows the same capture-policy path as the
extension's git source metadata. In addition to the metadata, the extension
maintains a single trace-level tag named `phase:<latest-phase>` reflecting
the current phase. Traces can begin untagged (before any phase event is
received). When the phase changes, the previous `phase:*` tag is replaced
with the new one, and clearing the phase removes the tag entirely.

## Upstream provenance

This is a trimmed monorepo vendoring of `gooyoung/pi-langfuse` at commit
`c79c527a7294e1d4b8153525d5218e87354cbcb1` (v1.5.12, 2026-08-10).
To re-sync upstream behavior, compare the package against that commit before
preserving the local phase-tracking changes.
