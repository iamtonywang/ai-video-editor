import type { RenderChunkProviderInput } from './render-chunk-provider-input'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

export type RenderChunkWithProviderFailureReason =
  | 'provider_disabled'
  | 'provider_failed'
  | 'provider_timeout'
  | 'provider_invalid_response'

export type RenderChunkWithProviderResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; reason: RenderChunkWithProviderFailureReason }

function isProviderExplicitlyEnabled(): boolean {
  const v = (process.env.RENDER_CHUNK_PROVIDER_ENABLED ?? '').trim().toLowerCase()
  return v === 'true' || v === '1'
}

function isLikelyWebPBuffer(buf: Buffer): boolean {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false
  return buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP'
}

/** HTTP 요청 본문. provider 서버로만 전송; 로그/이벤트에 넣지 않는다. */
function buildProviderRequestBody(input: RenderChunkProviderInput): string {
  return JSON.stringify({
    job_id: input.job_id,
    project_id: input.project_id,
    sequence_id: input.sequence_id,
    scene_id: input.scene_id,
    chunk_id: input.chunk_id,
    chunk_index: input.chunk_index,
    output_asset_key: input.output_asset_key,
    instruction: input.instruction,
    identity_profile_id: input.identity_profile_id,
    reference_asset_id: input.reference_asset_id,
    source_asset_id: input.source_asset_id,
    state_in_key: input.state_in_key,
    prev_state_out_key: input.prev_state_out_key,
    sequence_meta: input.sequence_meta,
    scene_meta: input.scene_meta,
    source_asset_meta: input.source_asset_meta,
    reference_asset_meta: input.reference_asset_meta,
    prev_chunk_meta: input.prev_chunk_meta,
  })
}

async function executeRenderChunkProviderHttp(params: {
  input: RenderChunkProviderInput
  url: string
  apiKey: string | null
  timeoutMs: number
}): Promise<RenderChunkWithProviderResult> {
  const { input, url, apiKey, timeoutMs } = params
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey != null && apiKey.trim() !== '') {
      headers.Authorization = `Bearer ${apiKey.trim()}`
    }
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: buildProviderRequestBody(input),
      signal: controller.signal,
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { ok: false, reason: 'provider_timeout' }
    }
    return { ok: false, reason: 'provider_failed' }
  } finally {
    clearTimeout(timer)
  }

  const ct = (res.headers.get('content-type') ?? '').toLowerCase()

  if (res.ok && ct.includes('image/webp')) {
    const ab = await res.arrayBuffer()
    const buf = Buffer.from(ab)
    if (isLikelyWebPBuffer(buf)) {
      return { ok: true, buffer: buf }
    }
    return { ok: false, reason: 'provider_invalid_response' }
  }

  if (res.ok && ct.includes('application/json')) {
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      return { ok: false, reason: 'provider_invalid_response' }
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>
      const b64Raw = o.webp_base64 ?? o.image_base64 ?? o.output_base64
      if (typeof b64Raw === 'string' && b64Raw.trim() !== '') {
        try {
          const buf = Buffer.from(b64Raw.trim(), 'base64')
          if (isLikelyWebPBuffer(buf)) {
            return { ok: true, buffer: buf }
          }
        } catch {
          return { ok: false, reason: 'provider_invalid_response' }
        }
      }
    }
    return { ok: false, reason: 'provider_invalid_response' }
  }

  return { ok: false, reason: 'provider_failed' }
}

/**
 * Render chunk HTTP provider boundary. 기본은 비활성(네트워크 없음).
 * `RENDER_CHUNK_PROVIDER_ENABLED` 가 true/1 일 때만 `RENDER_CHUNK_PROVIDER_URL` 로 POST.
 */
export async function renderChunkWithProvider(
  input: RenderChunkProviderInput
): Promise<RenderChunkWithProviderResult> {
  if (!isProviderExplicitlyEnabled()) {
    return { ok: false, reason: 'provider_disabled' }
  }

  const url = (process.env.RENDER_CHUNK_PROVIDER_URL ?? '').trim()
  if (url === '') {
    return { ok: false, reason: 'provider_failed' }
  }

  const apiKeyRaw = process.env.RENDER_CHUNK_PROVIDER_API_KEY
  const apiKey = typeof apiKeyRaw === 'string' && apiKeyRaw.trim() !== '' ? apiKeyRaw.trim() : null

  let timeoutMs = DEFAULT_TIMEOUT_MS
  const rawTimeout = process.env.RENDER_CHUNK_PROVIDER_TIMEOUT_MS
  if (typeof rawTimeout === 'string' && rawTimeout.trim() !== '') {
    const n = Number(rawTimeout.trim())
    if (Number.isFinite(n) && n > 0 && n <= MAX_TIMEOUT_MS) {
      timeoutMs = n
    }
  }

  return executeRenderChunkProviderHttp({ input, url, apiKey, timeoutMs })
}
