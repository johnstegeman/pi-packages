/**
 * Session-boundary clearing for the superpowers:phase event.
 * Clears on BOTH session_start and session_shutdown so no session inherits a
 * prior session's phase. `emit`/`on` are injected for testability.
 */
export const PHASE_CLEAR = "";

export function createPhaseLifecycle({ emit, on }) {
  const clear = () => emit("superpowers:phase", { phase: PHASE_CLEAR });
  on("session_start", clear);
  on("session_shutdown", clear);
}
