export type RenderChunkProviderInput = {
  job_id: string
  project_id: string
  sequence_id: string
  scene_id: string
  chunk_id: string
  chunk_index: number | null
  /** `chunk_index === 0`일 때만 true (`readChunkIndexField` 결과가 정확히 0). */
  first_chunk: boolean
  /** 현재 render_chunk 파이프라인 고정값. */
  render_mode: 'render_chunk'
  output_asset_key: string
  instruction: string | null
  identity_profile_id: string | null
  reference_asset_id: string | null
  source_asset_id: string | null
  /** 현재 chunk 생성에 provider가 사용할 입력 state storage key. 첫 청크에서는 null일 수 있음. */
  state_in_key: string | null
  /** 이전 chunk 결과에서 온 원본 state_out key 추적값(동일 문자열이 `state_in_key`와 겹칠 수 있음). */
  prev_state_out_key: string | null
  /** 이전 chunk state-out.json의 `provider_state_out`(화이트리스트 적용본). 첫 청크는 null. */
  prev_provider_state_out: Record<string, unknown> | null
  sequence_meta: Record<string, unknown> | null
  scene_meta: Record<string, unknown> | null
  source_asset_meta: Record<string, unknown> | null
  reference_asset_meta: Record<string, unknown> | null
  prev_chunk_meta: Record<string, unknown> | null
}

export type BuildRenderChunkProviderInputResult =
  | { ok: true; input: RenderChunkProviderInput }
  | { ok: false; reason: string }

/** `state_out_payload` / `provider_state_out` 저장·전달에 허용되는 최소 키만. */
export const WHITELIST_STATE_OUT_PAYLOAD_KEYS = [
  'schema_version',
  'provider',
  'model',
  'model_version',
  'state_key',
  'latent_state_key',
  'temporal_state_key',
  'identity_state_key',
  'scene_state_key',
  'camera_state_key',
  'lighting_state_key',
  'background_state_key',
  'consistency_score',
  'identity_score',
  'style_score',
  'temporal_score',
  'drift_score',
  'created_at',
] as const

function isSafeWhitelistScalar(v: unknown): boolean {
  if (v === null) return true
  if (typeof v === 'string' || typeof v === 'boolean') return true
  if (typeof v === 'number' && Number.isFinite(v)) return true
  return false
}

/** 저장·HTTP 전달용: 허용 키만, 값은 string | number | boolean | null 만 통과. */
export function whitelistProviderStateOutPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of WHITELIST_STATE_OUT_PAYLOAD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    const v = raw[key]
    if (isSafeWhitelistScalar(v)) {
      out[key] = v
    }
  }
  return out
}

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

function readPrevProviderStateOutField(
  o: Record<string, unknown>,
  first_chunk: boolean
): Record<string, unknown> | null {
  if (first_chunk) return null
  const v = o.prev_provider_state_out
  if (v === undefined || v === null) return null
  if (!isPlainObject(v)) return null
  const w = whitelistProviderStateOutPayload(v)
  return Object.keys(w).length > 0 ? w : null
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

  const chunkIndexVal = readChunkIndexField(o.chunk_index)
  const first_chunk = chunkIndexVal === 0

  const input: RenderChunkProviderInput = {
    job_id: jid,
    project_id: projectId,
    sequence_id: sequenceId,
    scene_id: sceneId,
    chunk_id: chunkId,
    chunk_index: chunkIndexVal,
    first_chunk,
    render_mode: 'render_chunk',
    output_asset_key: outKey,
    instruction: readInstructionField(o.instruction),
    identity_profile_id: readNullableIdField(o.identity_profile_id),
    reference_asset_id: readNullableIdField(o.reference_asset_id),
    source_asset_id: readNullableIdField(o.source_asset_id),
    state_in_key: readNullableIdField(o.state_in_key),
    prev_state_out_key: readNullableIdField(o.prev_state_out_key),
    prev_provider_state_out: readPrevProviderStateOutField(o, first_chunk),
    sequence_meta: readMetaField(o, 'sequence_meta'),
    scene_meta: readMetaField(o, 'scene_meta'),
    source_asset_meta: readMetaField(o, 'source_asset_meta'),
    reference_asset_meta: readMetaField(o, 'reference_asset_meta'),
    prev_chunk_meta: readMetaField(o, 'prev_chunk_meta'),
  }

  return { ok: true, input }
}
