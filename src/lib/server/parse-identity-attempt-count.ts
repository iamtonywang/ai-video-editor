/**
 * sequence_chunks.identity_attempt_count — single parse policy for worker and
 * enqueue-render-chunk-rerender (do not diverge):
 * - typeof value === 'number' && Number.isFinite(value) && value >= 0 → Math.floor(value)
 * - null / undefined / NaN / ±Infinity / negative / non-number (incl. strings) → 0
 */
export function parseIdentityAttemptCount(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw)
  }
  return 0
}
