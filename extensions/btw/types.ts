// ── Shared BTW types ─────────────────────────────────────────────────
//
// Canonical type definitions shared between the registry, spawner,
// and other BTW modules.  Single source of truth for tool trace and
// usage shapes.

export interface BtwToolTraceEntry {
  toolName: string;
  args: Record<string, unknown>;
}

export interface BtwUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: number;
}
