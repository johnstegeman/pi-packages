// Shared `bd`-fixture shell fragments used by both pi-beads test suites.
//
// conc_guard: when FAKE_BD_CONC=1, detect two bd ops in flight at once. A correct
// serialized show->update / create loop never overlaps; a racy one writes
// CONCURRENT to the marker and exits non-zero. Embed into a /bin/sh fixture.
export const CONC_GUARD_SH = `conc_guard() {
  [ "\${FAKE_BD_CONC:-0}" = "1" ] || return 0
  mkdir -p "$FAKE_BD_CONC_DIR"
  CLAIM="$FAKE_BD_CONC_DIR/$$"
  mkdir "$CLAIM" 2>/dev/null || { echo "cannot claim" >&2; exit 1; }
  N="$(ls -A "$FAKE_BD_CONC_DIR" | wc -l | tr -d ' ')"
  if [ "$N" -gt 1 ]; then
    mkdir -p "$(dirname "$FAKE_BD_CONC_MARKER")"
    printf 'CONCURRENT\\n' >> "$FAKE_BD_CONC_MARKER"
    rmdir "$CLAIM" 2>/dev/null
    echo "concurrent bd op detected" >&2
    exit 1
  fi
  sleep 0.05
  rmdir "$CLAIM" 2>/dev/null
}`;

// Enable concurrency instrumentation for this process; returns a cleanup fn.
export function concEnv(dir, marker) {
  process.env.FAKE_BD_CONC = "1";
  process.env.FAKE_BD_CONC_DIR = dir;
  process.env.FAKE_BD_CONC_MARKER = marker;
  return () => {
    delete process.env.FAKE_BD_CONC;
    delete process.env.FAKE_BD_CONC_DIR;
    delete process.env.FAKE_BD_CONC_MARKER;
  };
}


// lock_guard: when FAKE_BD_LOCK_UNTIL=<n> is set, the first n invocations of this
// fixture fail with the embedded-dolt lock text on stderr and a non-zero exit;
// invocation n+1 onward proceed normally. FAKE_BD_LOCK_COUNTER names the counter
// file (one line appended per invocation), so each test can point at its own file
// and no lock mode bleeds across tests. Embed into a /bin/sh fixture and call it
// once at the top of the script, before any command dispatch.
export const LOCK_GUARD_SH = `lock_guard() {
  [ -n "\${FAKE_BD_LOCK_UNTIL:-}" ] || return 0
  C="\${FAKE_BD_LOCK_COUNTER:-}"
  [ -n "$C" ] || return 0
  N=0
  [ -f "$C" ] && N="$(wc -l < "$C" | tr -d ' ')"
  N=$((N + 1))
  printf 'x\\n' >> "$C"
  if [ "$N" -le "$FAKE_BD_LOCK_UNTIL" ]; then
    echo "embeddeddolt: open db: failed to load database: the database is locked by another dolt process" >&2
    exit 1
  fi
}`;