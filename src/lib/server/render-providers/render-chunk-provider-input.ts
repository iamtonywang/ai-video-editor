export type RenderChunkProviderInput = {
  job_id: string
  project_id: string
  sequence_id: string
  scene_id: string
  chunk_id: string
  chunk_index: number | null
  output_asset_key: string
  instruction: string | null
  identity_profile_id: string | null
  reference_asset_id: string | null
  source_asset_id: string | null
  state_in_key: string | null
  prev_state_out_key: string | null
  sequence_meta: Record<string, unknown> | null
  scene_meta: Record<string, unknown> | null
  source_asset_meta: Record<string, unknown> | null
  reference_asset_meta: Record<string, unknown> | null
  prev_chunk_meta: Record<string, unknown> | null
}

export type BuildRenderChunkProviderInputResult =
  | { ok: true; input: RenderChunkProviderInput }
  | { ok: false; reason: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readNonEmptyTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t === '' ? null : t
}

function readNullableIdField(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t === '' ? null : t
}

function readInstructionField(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t === '' ? null : t
}

function readChunkIndexField(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

function readMetaField(obj: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const v = obj[key]
  if (isPlainObject(v)) return v
  return null
}

export function buildRenderChunkProviderInput(params: {
  jobId: string
  outputAssetKey: string
  renderInput: unknown
}): BuildRenderChunkProviderInputResult {
  const { jobId, outputAssetKey, renderInput } = params

  if (!isPlainObject(renderInput)) {
    return { ok: false, reason: 'INVALID_RENDER_INPUT' }
  }

  const o = renderInput

  const jid = typeof jobId === 'string' ? jobId.trim() : ''
  if (jid === '') {
    return { ok: false, reason: 'INVALID_JOB_ID' }
  }

  const outKey = typeof outputAssetKey === 'string' ? outputAssetKey.trim() : ''
  if (outKey === '') {
    return { ok: false, reason: 'INVALID_OUTPUT_ASSET_KEY' }
  }

  const projectId = readNonEmptyTrimmedString(o.project_id)
  if (projectId == null) {
    return { ok: false, reason: 'MISSING_PROJECT_ID' }
  }

  const sequenceId = readNonEmptyTrimmedString(o.sequence_id)
  if (sequenceId == null) {
    return { ok: false, reason: 'MISSING_SEQUENCE_ID' }
  }

  const sceneId = readNonEmptyTrimmedString(o.scene_id)
  if (sceneId == null) {
    return { ok: false, reason: 'MISSING_SCENE_ID' }
  }

  const chunkId = readNonEmptyTrimmedString(o.chunk_id)
  if (chunkId == null) {
    return { ok: false, reason: 'MISSING_CHUNK_ID' }
  }

  const input: RenderChunkProviderInput = {
    job_id: jid,
    project_id: projectId,
    sequence_id: sequenceId,
    scene_id: sceneId,
    chunk_id: chunkId,
    chunk_index: readChunkIndexField(o.chunk_index),
    output_asset_key: outKey,
    instruction: readInstructionField(o.instruction),
    identity_profile_id: readNullableIdField(o.identity_profile_id),
    reference_asset_id: readNullableIdField(o.reference_asset_id),
    source_asset_id: readNullableIdField(o.source_asset_id),
    state_in_key: readNullableIdField(o.state_in_key),
    prev_state_out_key: readNullableIdField(o.prev_state_out_key),
    sequence_meta: readMetaField(o, 'sequence_meta'),
    scene_meta: readMetaField(o, 'scene_meta'),
    source_asset_meta: readMetaField(o, 'source_asset_meta'),
    reference_asset_meta: readMetaField(o, 'reference_asset_meta'),
    prev_chunk_meta: readMetaField(o, 'prev_chunk_meta'),
  }

  return { ok: true, input }
}
