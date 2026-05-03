/**
 * UUID v4-style string check (aligned with `isValidUuid` in `src/workers/index.ts`).
 */
export function isValidUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}
