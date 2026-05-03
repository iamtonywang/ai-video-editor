/**
 * HTTP client for the external identity embedding service (build_identity).
 * Contract: POST {serviceUrl}/embed with JSON body `{ "image": "<base64>" }`.
 */

const DEFAULT_TIMEOUT_MS = 120_000

export type IdentityEmbeddingEmbedResult = {
  embedding: number[]
  model_version: string
  face_count: number
  quality_score: number
}

function assertNonEmptyString(label: string, v: unknown): string {
  if (v == null || typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${label}_MISSING_OR_EMPTY`)
  }
  return v.trim()
}

function assertFiniteNumber(label: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${label}_NOT_FINITE_NUMBER`)
  }
  return v
}

function parseEmbedResponseJson(raw: unknown): IdentityEmbeddingEmbedResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('EMBED_RESPONSE_NOT_OBJECT')
  }
  const o = raw as Record<string, unknown>

  const embeddingRaw = o.embedding
  if (!Array.isArray(embeddingRaw) || embeddingRaw.length === 0) {
    throw new Error('EMBEDDING_INVALID_OR_EMPTY')
  }
  const embedding: number[] = []
  for (let i = 0; i < embeddingRaw.length; i++) {
    const n = embeddingRaw[i]
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new Error(`EMBEDDING_NON_FINITE_AT_INDEX_${i}`)
    }
    embedding.push(n)
  }

  const model_version = assertNonEmptyString('model_version', o.model_version)
  const face_count = assertFiniteNumber('face_count', o.face_count)
  const quality_score = assertFiniteNumber('quality_score', o.quality_score)

  return {
    embedding,
    model_version,
    face_count,
    quality_score,
  }
}

/**
 * Calls POST `${serviceUrl}/embed` with `{ image: imageBase64 }`.
 * @throws Error with explicit messages on misconfiguration, timeout, HTTP, or invalid body.
 */
export async function callIdentityEmbeddingEmbed(params: {
  imageBase64: string
  serviceUrl: string
  timeoutMs?: number
}): Promise<IdentityEmbeddingEmbedResult> {
  const trimmedUrl = params.serviceUrl.trim()
  if (!trimmedUrl) {
    throw new Error('IDENTITY_EMBEDDING_SERVICE_URL_MISSING')
  }

  const image = params.imageBase64.trim()
  if (!image) {
    throw new Error('IDENTITY_EMBEDDING_IMAGE_EMPTY')
  }

  const base = trimmedUrl.replace(/\/+$/, '')
  const url = `${base}/embed`
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image }),
      signal: controller.signal,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'UNKNOWN_FETCH_ERROR'
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`IDENTITY_EMBEDDING_TIMEOUT:${timeoutMs}ms`)
    }
    throw new Error(`IDENTITY_EMBEDDING_FETCH_FAILED:${msg}`)
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()
  if (!res.ok) {
    throw new Error(
      `IDENTITY_EMBEDDING_HTTP_${res.status}:${text.slice(0, 500)}`
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error('IDENTITY_EMBEDDING_JSON_PARSE_FAILED')
  }

  try {
    return parseEmbedResponseJson(parsed)
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'INVALID_EMBED_RESPONSE'
    throw new Error(`IDENTITY_EMBEDDING_INVALID_RESPONSE:${detail}`)
  }
}
