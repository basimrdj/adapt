/**
 * Shared pause-list helpers — pure functions imported by the background
 * (PauseManager), the popup, and the content runtime. No chrome.* references:
 * this module must stay loadable from every world.
 */

/** Storage-shape guard: a poisoned list degrades to empty (fail closed to protection). */
export function sanitizePausedHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const clean = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const host = entry.toLowerCase().trim();
    if (host.length === 0 || host.length > 253 || !HOST_PATTERN.test(host)) continue;
    clean.add(host);
  }
  return [...clean];
}

/** Dot-boundary suffix match: pausing example.com covers sub.example.com. */
export function hostIsPaused(host: string, pausedHosts: readonly string[]): boolean {
  const lower = host.toLowerCase();
  for (const paused of pausedHosts) {
    if (lower === paused || lower.endsWith(`.${paused}`)) return true;
  }
  return false;
}

const HOST_PATTERN = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
