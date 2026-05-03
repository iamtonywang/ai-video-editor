import { supabaseServer } from '@/lib/supabase/server'
import {
  expectedIdentityMemoryManifestKey,
  isCanonicalIdentityMemoryManifestKey,
  IDENTITY_MEMORY_MANIFEST_MAX_BYTES,
} from './identity-memory-manifest-keys'

export type IdentityMemoryManifestV1 = {
  schema_version: 1
  type: 'identity_memory_manifest'
  project_id: string
  identity_profile_id: string
  sequence_id: string
  scene_id: string
  latest_chunk_id: string
  source_job_id: string
  stable_identity_score: number | null
  stable_window_size: number
  drift_summary: {
    excluded_drift_count: number
    skipped_count: number
  }
  updated_at: string
}

export type ReadIdentityMemoryManifestResult =
  | { ok: true; manifest: IdentityMemoryManifestV1 }
  | { ok: false; reason: string }

function isUuidParam(v: string): boolean {
  const t = v.trim()
  return t !== '' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Read-only: downloads and validates `memory-manifest.json` from project-media.
 * Does not throw; never used for gate/rerender/worker decisions.
 */
export async function readIdentityMemoryManifest(params: {
  projectId: string
  identityProfileId: string
}): Promise<ReadIdentityMemoryManifestResult> {
  const { projectId, identityProfileId } = params

  if (
    typeof projectId !== 'string' ||
    typeof identityProfileId !== 'string' ||
    projectId.trim() === '' ||
    identityProfileId.trim() === '' ||
    !isUuidParam(projectId) ||
    !isUuidParam(identityProfileId)
  ) {
    return { ok: false, reason: 'invalid_input' }
  }

  const pid = projectId.trim()
  const iid = identityProfileId.trim()
  const manifestKey = expectedIdentityMemoryManifestKey(pid, iid)
  if (!isCanonicalIdentityMemoryManifestKey(manifestKey, pid, iid)) {
    return { ok: false, reason: 'manifest_key_not_canonical' }
  }

  const dl = await supabaseServer.storage.from('project-media').download(manifestKey)
  if (dl.error || !dl.data) {
    return { ok: false, reason: 'download_failed' }
  }

  let buf: Buffer
  try {
    buf = Buffer.from(await dl.data.arrayBuffer())
  } catch {
    return { ok: false, reason: 'download_failed' }
  }

  if (buf.length > IDENTITY_MEMORY_MANIFEST_MAX_BYTES) {
    return { ok: false, reason: 'too_large' }
  }

  let obj: unknown
  try {
    obj = JSON.parse(buf.toString('utf8')) as unknown
  } catch {
    return { ok: false, reason: 'parse_failed' }
  }

  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, reason: 'schema_invalid' }
  }

  const o = obj as Record<string, unknown>
  if (o.schema_version !== 1 || o.type !== 'identity_memory_manifest') {
    return { ok: false, reason: 'schema_invalid' }
  }
  if (o.project_id !== pid || o.identity_profile_id !== iid) {
    return { ok: false, reason: 'schema_invalid' }
  }

  if (
    !isNonEmptyString(o.sequence_id) ||
    !isNonEmptyString(o.scene_id) ||
    !isNonEmptyString(o.latest_chunk_id) ||
    !isNonEmptyString(o.source_job_id) ||
    !isNonEmptyString(o.updated_at)
  ) {
    return { ok: false, reason: 'field_invalid' }
  }

  const scoreRaw = o.stable_identity_score
  if (scoreRaw !== null && (typeof scoreRaw !== 'number' || !Number.isFinite(scoreRaw))) {
    return { ok: false, reason: 'field_invalid' }
  }

  if (!isFiniteNumber(o.stable_window_size)) {
    return { ok: false, reason: 'field_invalid' }
  }

  const drift = o.drift_summary
  if (drift === null || typeof drift !== 'object' || Array.isArray(drift)) {
    return { ok: false, reason: 'field_invalid' }
  }
  const d = drift as Record<string, unknown>
  if (!isFiniteNumber(d.excluded_drift_count) || !isFiniteNumber(d.skipped_count)) {
    return { ok: false, reason: 'field_invalid' }
  }

  const manifest: IdentityMemoryManifestV1 = {
    schema_version: 1,
    type: 'identity_memory_manifest',
    project_id: String(o.project_id),
    identity_profile_id: String(o.identity_profile_id),
    sequence_id: String(o.sequence_id).trim(),
    scene_id: String(o.scene_id).trim(),
    latest_chunk_id: String(o.latest_chunk_id).trim(),
    source_job_id: String(o.source_job_id).trim(),
    stable_identity_score: scoreRaw === null ? null : (scoreRaw as number),
    stable_window_size: o.stable_window_size as number,
    drift_summary: {
      excluded_drift_count: d.excluded_drift_count as number,
      skipped_count: d.skipped_count as number,
    },
    updated_at: String(o.updated_at).trim(),
  }

  return { ok: true, manifest }
}
