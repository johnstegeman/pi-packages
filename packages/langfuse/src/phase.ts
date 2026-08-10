/**
 * Reduce a Superpowers phase update using the same semantics as bifrost.
 * Whitespace is checked only for emptiness; a non-empty value is retained
 * verbatim.
 */
export function applyPhaseUpdate(
  _current: string | null,
  incoming: string | null | undefined,
): string | null {
  return incoming && incoming.trim() !== "" ? incoming : null;
}

let retainedPhase: string | null = null;

export function setPhase(incoming: string | null | undefined): string | null {
  retainedPhase = applyPhaseUpdate(retainedPhase, incoming);
  return retainedPhase;
}

/** Return the metadata fragment to spread into Langfuse observations. */
export function buildPhaseMetadata(): Record<string, string> {
  return retainedPhase ? { superpowers_phase: retainedPhase } : {};
}

/** Return the namespaced phase tag to attach to Langfuse traces. */
export function buildPhaseTags(): string[] {
  return retainedPhase ? [`phase:${retainedPhase}`] : [];
}
