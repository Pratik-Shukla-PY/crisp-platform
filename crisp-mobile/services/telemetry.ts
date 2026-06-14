/**
 * CRISP - lightweight telemetry logger (P3.4).
 *
 * Replaces the many silent `catch { }` blocks scattered across the RN app.
 * Each caller passes a short context string so we know *where* the swallowed
 * error came from, and the error itself so we capture message + stack.
 *
 * Behaviour:
 *   - Always console.warn with a consistent `[silent:<context>]` prefix so
 *     Metro / ADB logs surface the error during dev without spamming red
 *     screens at the user.
 *   - Retains the last 100 events in a ring buffer so a debug screen (or
 *     later Sentry hook, P3.8) can fetch them.
 *   - Never throws.
 */

export type TelemetryEvent = {
  context: string;
  message: string;
  stack?: string;
  timestamp: number;
};

const RING_SIZE = 100;
const _events: TelemetryEvent[] = [];

function _push(ev: TelemetryEvent): void {
  _events.push(ev);
  if (_events.length > RING_SIZE) _events.shift();
}

/** Log + retain a silently-caught error. Never throws. */
export function swallow(context: string, err: unknown): void {
  try {
    const e = err as any;
    const msg = e?.message || String(err);
    const stack = typeof e?.stack === 'string' ? e.stack : undefined;
    console.warn(`[silent:${context}]`, msg, stack ? `\n${stack}` : '');
    _push({ context, message: msg, stack, timestamp: Date.now() });
    // Hook for P3.8: Sentry or similar can read the ring buffer and forward.
    // Intentionally not wired here to keep this module dependency-free.
  } catch {
    // Telemetry itself must never throw.
  }
}

/** Read (and optionally clear) the ring buffer. Used by a future diagnostics UI. */
export function drain(clear = false): TelemetryEvent[] {
  const copy = _events.slice();
  if (clear) _events.length = 0;
  return copy;
}
