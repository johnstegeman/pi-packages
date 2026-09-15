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
