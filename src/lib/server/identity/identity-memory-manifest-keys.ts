/**
 * Shared identity memory manifest Storage key helpers.
 * Must stay aligned with `persistIdentityMemoryManifest` in `src/workers/index.ts`.
 */

/** Same byte cap as `MAX_RENDER_CHUNK_STATE_JSON_BYTES` in workers (32 KiB). */
export const IDENTITY_MEMORY_MANIFEST_MAX_BYTES = 32 * 1024

export const IDENTITY_MEMORY_MANIFEST_KEY_RE =
  /^projects\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/identity\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/memory-manifest\.json$/

export function expectedIdentityMemoryManifestKey(projectId: string, identityProfileId: string): string {
  const pid = String(projectId).trim()
  const iid = String(identityProfileId).trim()
  return `projects/${pid}/identity/${iid}/memory-manifest.json`
}

export function isCanonicalIdentityMemoryManifestKey(
  key: string,
  projectId: string,
  identityProfileId: string
): boolean {
  return (
    key === expectedIdentityMemoryManifestKey(projectId, identityProfileId) &&
    IDENTITY_MEMORY_MANIFEST_KEY_RE.test(key)
  )
}
