# Running beads against a Dolt server (opt-in)

By default this repo uses beads' **embedded** Dolt backend: `bd` opens the database
in-process, so there is nothing to install and no server to run. This document is the
opt-in escape hatch for one specific problem, and nothing more.

## The symptom

Embedded Dolt holds an **exclusive lock on the data directory for the entire duration of
each `bd` invocation**:

```
embeddeddolt: another process holds the exclusive lock on <dir>;
embedded backend supports only one writer at a time
```

Orca worktrees of this repo share one beads database (each `.beads/` resolves to the main
checkout's `.beads/embeddeddolt`). Two agents working at once therefore serialize every
query, and a slow or killed query makes the other side surface `database is locked by
another dolt process` or `context canceled`.

The molecule widget now backs off instead of retrying into the lock, so this is much less
noisy than it was — but the lock itself is a property of embedded mode.

## When it's worth it

- Multiple worktrees or multiple agents issuing `bd` commands against the same workspace, **and**
- the serialization actually gets in your way.

For a single worktree it is not worth it.

## The cost: you must install `dolt`

Every server mode shells out to a standalone `dolt` binary. It is **not** bundled — the `bd`
binary embeds Dolt only as the in-process engine for embedded mode. Verified on this machine:

```
$ bd init --shared-server
Error: failed to start shared Dolt server: dolt is not installed (not found in PATH)

$ bd init --proxied-server
Error: bd init --proxied-server: resolving dolt binary (source: PATH): dolt binary not found:
  dolt not found on PATH: exec: "dolt": executable file not found in $PATH;
  install from https://docs.dolthub.com/introduction/installation
```

So: the shared-server path adds a dependency for *you*. Other users of this repo get the
embedded default for free and are unaffected.

## Setup

1. Install Dolt (https://docs.dolthub.com/introduction/installation) and confirm it is on
   `PATH`:

   ```bash
   dolt version
   ```

2. Configure the workspace for a shared server. All projects share one server at
   `~/.beads/shared-server/`:

   ```bash
   bd init --shared-server
   ```

   The server starts automatically when needed. For an externally managed server instead,
   use `bd init --server --server-host <host> --server-port <port>`; passwords are supplied
   out of band via `BEADS_DOLT_PASSWORD` or `~/.config/beads/credentials`, never in
   `metadata.json`.

## Verify

```bash
bd dolt status   # should report server mode, not "embedded (in-process, no server)"
bd dolt show     # prints the effective configuration and tests the connection
bd dolt test     # connection test only
```

A quick behavioural check: run a `bd` query in two worktrees at the same time and confirm
neither reports a lock or cancellation error.

## Lifecycle and teardown

```bash
bd dolt start    # start the server for this project (usually unnecessary: it auto-starts)
bd dolt stop     # stop it
bd dolt killall  # kill orphan dolt sql-server processes for this repo's data directory
```

Reverting to the default is a re-init of the workspace against the embedded engine; back up
first (`bd backup`) if the database holds work you care about.

## Trade-offs

| | embedded (default) | shared Dolt server (opt-in) |
|---|---|---|
| Install | none | standalone `dolt` binary |
| Concurrency | one writer, one exclusive lock per `bd` call | multi-writer |
| Background process | none | sql-server (auto-started, per project) |
| Orca multi-worktree contention | serialized; may error under load | gone |
