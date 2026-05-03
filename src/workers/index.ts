import { randomUUID } from 'crypto'
import { Worker } from 'bullmq'
import sharp from 'sharp'
import { jobQueue, QUEUE_NAMES } from '@/lib/queue'
import { redisConnection } from '@/lib/queue/redis'
import { enqueueRenderChunkRerenderJob } from '@/lib/server/enqueue-render-chunk-rerender'
import { parseIdentityAttemptCount } from '@/lib/server/parse-identity-attempt-count'
import { callIdentityEmbeddingEmbed } from '@/lib/server/identity-embedding-client'
import { supabaseServer } from '@/lib/supabase/server'

console.log(`REDIS_URL loaded: ${process.env.REDIS_URL ? 'yes' : 'no'}`)

type AnalyzePayload = {
  job_id: string
  project_id: string
  force_fail?: boolean
}

type BuildIdentityPayload = {
  job_id: string
  project_id: string
  reference_asset_id: string
  embedding_key: string
  latent_base_key: string
  anchor_manifest_key: string
  identity_status: string
  build_score?: number
  force_fail?: boolean
}

type PreviewPayload = {
  job_id: string
  project_id: string
  /** Present for jobs enqueued after API passes instruction through the queue. */
  instruction?: string
  input_mode?: 'prompt_image' | 'image_remix'
  reference_asset_id?: string | null
}

type RenderChunkPayload = {
  job_id: string
  project_id: string
  chunk_id: string
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'UNKNOWN_ERROR'
}

function isValidUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

type AnalyzeJobStatus = 'running' | 'success' | 'failed'

function assertDbResult<T extends { error: { message: string } | null }>(
  label: string,
  result: T
) {
  if (result.error) {
    throw new Error(`${label}: ${result.error.message}`)
  }
}

async function addJobEvent(params: {
  job_id: string
  level: string
  step: string
  message: string
  payload?: Record<string, unknown>
}) {
  const result = await supabaseServer.from('job_events').insert({
    job_id: params.job_id,
    level: params.level,
    step: params.step,
    message: params.message,
    payload: params.payload ?? null,
  })
  assertDbResult('job_events_insert_failed', result)
}

async function safeBuildIdentityJobEvent(params: {
  job_id: string
  level: string
  step: string
  message: string
  payload?: Record<string, unknown>
}): Promise<void> {
  try {
    await addJobEvent(params)
  } catch (e) {
    console.warn(`build_identity job_events ${params.step} failed`, getErrorMessage(e))
  }
}

async function tryRemoveProjectMediaPaths(
  paths: string[]
): Promise<{ ok: boolean; error?: string }> {
  if (paths.length === 0) return { ok: true }
  try {
    const { error } = await supabaseServer.storage.from('project-media').remove(paths)
    if (error) {
      return { ok: false, error: error.message }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: getErrorMessage(e) }
  }
}

async function updateAnalyzeJobStatus(params: {
  job_id: string
  status: AnalyzeJobStatus
  progress: number
  started_at?: string
  finished_at?: string
  error_code?: string | null
  error_message?: string | null
  output_asset_key?: string | null
}) {
  const now = new Date().toISOString()
  const row: {
    status: AnalyzeJobStatus
    progress: number
    started_at?: string
    finished_at?: string
    updated_at: string
    error_code: string | null
    error_message: string | null
    output_asset_key?: string | null
  } = {
    status: params.status,
    progress: params.progress,
    started_at: params.started_at,
    finished_at: params.finished_at,
    updated_at: now,
    error_code: params.error_code ?? null,
    error_message: params.error_message ?? null,
  }
  if (params.output_asset_key !== undefined) {
    row.output_asset_key = params.output_asset_key
  }
  const result = await supabaseServer.from('jobs').update(row).eq('id', params.job_id)
  assertDbResult(`jobs_${params.status}_update_failed`, result)
}

type JobCostSnapshot = {
  id: string
  status: string | null
  cost_estimate: number
  cost_accumulated: number
  cost_actual: number
  soft_cost_limit: number
  hard_cost_limit: number
  kill_signal: unknown
}

function parseJobNumericField(jobId: string, field: string, value: unknown): number {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) {
    console.warn('[COST_NUMERIC_INVALID]', { jobId, field, value })
    return 0
  }
  return n
}

async function shouldSkipTerminalJob(jobId: string, jobType: string): Promise<boolean> {
  const result = await supabaseServer.from('jobs').select('status').eq('id', jobId).maybeSingle()

  if (result.error) {
    console.error('[WORKER_STATUS_READ_FAILED]', {
      job_id: jobId,
      error: result.error.message,
    })
    return true
  }

  const status = result.data?.status
  if (status === 'success' || status === 'failed' || status === 'canceled') {
    console.log('[WORKER_SKIP_TERMINAL_JOB]', { job_id: jobId, status, job_type: jobType })
    return true
  }

  return false
}

async function readJobCostSnapshot(jobId: string): Promise<JobCostSnapshot | null> {
  const result = await supabaseServer
    .from('jobs')
    .select(
      'id, status, cost_estimate, cost_accumulated, cost_actual, soft_cost_limit, hard_cost_limit, kill_signal'
    )
    .eq('id', jobId)
    .maybeSingle()

  if (result.error) {
    console.error('[COST_JOB_SNAPSHOT_READ_FAILED]', {
      job_id: jobId,
      error: result.error.message,
    })
    return null
  }
  const row = result.data
  if (!row?.id) {
    console.error('[COST_JOB_NOT_FOUND]', { job_id: jobId })
    return null
  }

  const cost_estimate = parseJobNumericField(jobId, 'cost_estimate', row.cost_estimate)
  if (cost_estimate <= 0) {
    console.warn('[COST_INVALID_ESTIMATE]', { jobId, cost_estimate, raw: row.cost_estimate })
  }

  return {
    id: row.id,
    status: row.status ?? null,
    cost_estimate,
    cost_accumulated: parseJobNumericField(jobId, 'cost_accumulated', row.cost_accumulated),
    cost_actual: parseJobNumericField(jobId, 'cost_actual', row.cost_actual),
    soft_cost_limit: parseJobNumericField(jobId, 'soft_cost_limit', row.soft_cost_limit),
    hard_cost_limit: parseJobNumericField(jobId, 'hard_cost_limit', row.hard_cost_limit),
    kill_signal: row.kill_signal,
  }
}

function logCostLimitWarnings(
  jobId: string,
  phase: string,
  amount: number,
  softLimit: number,
  hardLimit: number
): void {
  if (softLimit > 0 && amount > softLimit) {
    console.warn('[COST_SOFT_LIMIT_EXCEEDED]', {
      jobId,
      phase,
      amount,
      soft_cost_limit: softLimit,
    })
  }
  if (hardLimit > 0 && amount > hardLimit) {
    console.warn('[COST_HARD_LIMIT_EXCEEDED]', {
      jobId,
      phase,
      amount,
      hard_cost_limit: hardLimit,
    })
  }
}

async function markHardLimitKillSignal(
  jobId: string,
  phase: string,
  amount: number,
  hardLimit: number
): Promise<void> {
  try {
    if (hardLimit <= 0) {
      return
    }
    if (amount <= hardLimit) {
      return
    }

    const killUpdate = await supabaseServer
      .from('jobs')
      .update({ kill_signal: true })
      .eq('id', jobId)
      .or('kill_signal.eq.false,kill_signal.is.null')
      .select('id')
      .maybeSingle()

    if (killUpdate.error) {
      console.error('[KILL_SIGNAL_UPDATE_FAILED]', {
        jobId,
        phase,
        error: killUpdate.error.message,
      })
    } else if (!killUpdate.data) {
      const recheck = await supabaseServer
        .from('jobs')
        .select('status, kill_signal')
        .eq('id', jobId)
        .maybeSingle()
      if (recheck.error || !recheck.data) {
        console.warn('[KILL_SIGNAL_RECHECK_FAILED]', { jobId, phase })
      } else {
        console.warn('[KILL_SIGNAL_UPDATE_ZERO_ROWS]', {
          jobId,
          phase,
          current_status: recheck.data.status,
          current_kill_signal: recheck.data.kill_signal,
        })
      }
    }

    const { data: existingEvent, error: dedupError } = await supabaseServer
      .from('job_events')
      .select('id')
      .eq('job_id', jobId)
      .eq('step', 'cost_hard_limit_exceeded')
      .limit(1)
      .maybeSingle()

    if (dedupError) {
      console.warn('[COST_HARD_LIMIT_EVENT_DEDUP_FAILED]', {
        jobId,
        phase,
        error: dedupError.message,
      })
      return
    }
    if (existingEvent?.id != null) {
      console.log('[COST_HARD_LIMIT_EVENT_SKIP_DEDUP]', {
        jobId,
        phase,
        step: 'cost_hard_limit_exceeded',
      })
      return
    }

    try {
      await addJobEvent({
        job_id: jobId,
        level: 'warn',
        step: 'cost_hard_limit_exceeded',
        message: 'Hard cost limit exceeded',
        payload: {
          phase,
          amount,
          hard_cost_limit: hardLimit,
        },
      })
    } catch (err) {
      console.warn('[COST_HARD_LIMIT_EVENT_INSERT_FAILED]', {
        jobId,
        phase,
        error: getErrorMessage(err),
      })
    }
  } catch (err) {
    console.warn('[MARK_HARD_LIMIT_KILL_SIGNAL_FAILED]', {
      jobId,
      phase,
      error: getErrorMessage(err),
    })
  }
}

async function markCostRunning(jobId: string): Promise<void> {
  try {
    const snap = await readJobCostSnapshot(jobId)
    if (snap === null) {
      return
    }
    const st = snap.status

    if (st === 'success' || st === 'failed' || st === 'canceled') {
      console.log('[COST_RUNNING]', 'skip_terminal_status', { jobId, status: st })
      return
    }

    if (st !== 'running') {
      console.warn('[COST_RUNNING]', 'skip_not_running', { jobId, status: st })
      return
    }

    const runningAccumulated = snap.cost_estimate * 0.5

    const update = await supabaseServer
      .from('jobs')
      .update({ cost_accumulated: runningAccumulated })
      .eq('id', jobId)
      .eq('status', 'running')
      .select('id')
      .maybeSingle()

    if (update.error) {
      console.error('[COST_UPDATE_FAILED]', 'markCostRunning', jobId, update.error.message)
      return
    }
    if (!update.data) {
      console.log('[COST_RUNNING]', 'no_matching_row', { jobId })
      return
    }
    logCostLimitWarnings(jobId, 'running', runningAccumulated, snap.soft_cost_limit, snap.hard_cost_limit)
    await markHardLimitKillSignal(jobId, 'running', runningAccumulated, snap.hard_cost_limit)
    console.log('[COST_RUNNING]', 'ok', { jobId, cost_accumulated: runningAccumulated })
  } catch (err) {
    console.error('[COST_RUNNING_FAILED]', { jobId, error: getErrorMessage(err) })
  }
}

async function markCostSuccess(jobId: string): Promise<void> {
  try {
    const snap = await readJobCostSnapshot(jobId)
    if (snap === null) {
      return
    }
    if (snap.status !== 'success') {
      console.warn('[COST_SUCCESS]', 'skip_wrong_status', { jobId, status: snap.status })
      return
    }

    const rawActual = await supabaseServer
      .from('jobs')
      .select('cost_actual')
      .eq('id', jobId)
      .maybeSingle()

    if (!rawActual.error && rawActual.data != null && rawActual.data.cost_actual != null) {
      console.log('[COST_SUCCESS]', 'skip_already_finalized', { job_id: jobId })
      return
    }

    const est = snap.cost_estimate
    const update = await supabaseServer
      .from('jobs')
      .update({ cost_accumulated: est, cost_actual: est })
      .eq('id', jobId)
      .eq('status', 'success')
      .is('cost_actual', null)
      .select('id')
      .maybeSingle()

    if (update.error) {
      console.error('[COST_UPDATE_FAILED]', 'markCostSuccess', jobId, update.error.message)
      return
    }
    if (!update.data) {
      const recheck = await supabaseServer
        .from('jobs')
        .select('status, cost_actual')
        .eq('id', jobId)
        .maybeSingle()
      if (recheck.error || !recheck.data) {
        console.warn('[COST_RECHECK_FAILED]', { job_id: jobId })
        return
      }
      console.log('[COST_SUCCESS]', 'skip_no_matching_row', {
        job_id: jobId,
        current_status: recheck.data.status,
        current_cost_actual: recheck.data.cost_actual,
      })
      return
    }
    logCostLimitWarnings(jobId, 'success', est, snap.soft_cost_limit, snap.hard_cost_limit)
    await markHardLimitKillSignal(jobId, 'success', est, snap.hard_cost_limit)
    console.log('[COST_SUCCESS]', 'ok', { jobId, cost_accumulated: est, cost_actual: est })
  } catch (err) {
    console.error('[COST_SUCCESS_FAILED]', { job_id: jobId, error: getErrorMessage(err) })
  }
}

async function markCostFailed(jobId: string): Promise<void> {
  try {
    const snap = await readJobCostSnapshot(jobId)
    if (snap === null) {
      return
    }
    if (snap.status !== 'failed') {
      console.warn('[COST_FAILED]', 'skip_wrong_status', { jobId, status: snap.status })
      return
    }

    const rawActual = await supabaseServer
      .from('jobs')
      .select('cost_actual')
      .eq('id', jobId)
      .maybeSingle()

    if (!rawActual.error && rawActual.data != null && rawActual.data.cost_actual != null) {
      console.log('[COST_FAILED]', 'skip_already_finalized', { job_id: jobId })
      return
    }

    let acc = snap.cost_accumulated
    if (acc == null || !Number.isFinite(acc)) {
      acc = 0
    }

    const update = await supabaseServer
      .from('jobs')
      .update({ cost_actual: acc })
      .eq('id', jobId)
      .eq('status', 'failed')
      .is('cost_actual', null)
      .select('id')
      .maybeSingle()

    if (update.error) {
      console.error('[COST_UPDATE_FAILED]', 'markCostFailed', jobId, update.error.message)
      return
    }
    if (!update.data) {
      const recheck = await supabaseServer
        .from('jobs')
        .select('status, cost_actual')
        .eq('id', jobId)
        .maybeSingle()
      if (recheck.error || !recheck.data) {
        console.warn('[COST_RECHECK_FAILED]', { job_id: jobId })
        return
      }
      console.log('[COST_FAILED]', 'skip_no_matching_row', {
        job_id: jobId,
        current_status: recheck.data.status,
        current_cost_actual: recheck.data.cost_actual,
      })
      return
    }
    console.log('[COST_FAILED]', 'ok', { jobId, cost_actual: acc })
  } catch (err) {
    console.error('[COST_FAILED_FAILED]', { job_id: jobId, error: getErrorMessage(err) })
  }
}

async function handleAnalyzeJob(payload: AnalyzePayload) {
  const now = new Date().toISOString()

  if (await shouldSkipTerminalJob(payload.job_id, 'analyze')) return

  try {
    // Locked analyze sync pattern:
    // jobs: queued -> running -> success/failed
    // job_events: worker_received -> analyze_completed/analyze_failed
    await updateAnalyzeJobStatus({
      job_id: payload.job_id,
      status: 'running',
      progress: 10,
      started_at: now,
      error_code: null,
      error_message: null,
    })

    await markCostRunning(payload.job_id)

    await addJobEvent({
      job_id: payload.job_id,
      level: 'info',
      step: 'worker_received',
      message: 'Analyze worker received job',
    })

    // Mock analyze phase for this step.
    await new Promise((resolve) => setTimeout(resolve, 300))

    if (payload.force_fail) {
      throw new Error('ANALYZE_FORCED_FAILURE')
    }

    await updateAnalyzeJobStatus({
      job_id: payload.job_id,
      status: 'success',
      progress: 100,
      started_at: now,
      finished_at: now,
      error_code: null,
      error_message: null,
    })

    await markCostSuccess(payload.job_id)

    await addJobEvent({
      job_id: payload.job_id,
      level: 'info',
      step: 'analyze_completed',
      message: 'Analyze job completed',
    })
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    const errorCode = 'ANALYZE_WORKER_ERROR'

    try {
      await updateAnalyzeJobStatus({
        job_id: payload.job_id,
        status: 'failed',
        progress: 10,
        started_at: now,
        finished_at: now,
        error_code: errorCode,
        error_message: errorMessage,
      })
      await markCostFailed(payload.job_id)
    } catch (statusUpdateError) {
      console.error('jobs_failed_update_failed:', getErrorMessage(statusUpdateError))
    }

    await addJobEvent({
      job_id: payload.job_id,
      level: 'error',
      step: 'analyze_failed',
      message: errorMessage,
      payload: {
        job_id: payload.job_id,
        project_id: payload.project_id,
        job_type: 'analyze',
        error_code: errorCode,
        error_message: errorMessage,
      },
    })

    // TODO: Insert recovery_events only for real recovery actions with an allowed event_type mapping.
    throw error
  }
}

async function handleBuildIdentityJob(payload: BuildIdentityPayload) {
  const now = new Date().toISOString()

  if (await shouldSkipTerminalJob(payload.job_id, 'build_identity')) return

  try {
    await updateAnalyzeJobStatus({
      job_id: payload.job_id,
      status: 'running',
      progress: 10,
      started_at: now,
      error_code: null,
      error_message: null,
    })

    await markCostRunning(payload.job_id)

    await addJobEvent({
      job_id: payload.job_id,
      level: 'info',
      step: 'worker_received',
      message: 'Build identity worker received job',
    })

    if (payload.force_fail) {
      throw new Error('BUILD_IDENTITY_FORCED_FAILURE')
    }

    const serviceUrlRaw = process.env.IDENTITY_EMBEDDING_SERVICE_URL ?? ''
    const serviceUrl = typeof serviceUrlRaw === 'string' ? serviceUrlRaw.trim() : ''
    if (!serviceUrl) {
      await safeBuildIdentityJobEvent({
        job_id: payload.job_id,
        level: 'error',
        step: 'build_identity_embedding_service_unconfigured',
        message: 'IDENTITY_EMBEDDING_SERVICE_URL is not set',
        payload: { error_code: 'IDENTITY_EMBEDDING_SERVICE_URL_MISSING' },
      })
      throw new Error('IDENTITY_EMBEDDING_SERVICE_URL_MISSING')
    }

    const refId = String(payload.reference_asset_id ?? '').trim()
    if (!refId || !isValidUuid(refId)) {
      await safeBuildIdentityJobEvent({
        job_id: payload.job_id,
        level: 'error',
        step: 'build_identity_reference_invalid',
        message: 'reference_asset_id is missing or not a valid UUID',
        payload: { error_code: 'BUILD_IDENTITY_REFERENCE_ID_INVALID', reference_asset_id: refId },
      })
      throw new Error('BUILD_IDENTITY_REFERENCE_ID_INVALID')
    }

    const refRes = await supabaseServer
      .from('source_assets')
      .select('id, project_id, asset_type, asset_key, asset_status, validation_status')
      .eq('id', refId)
      .maybeSingle()

    if (refRes.error || !refRes.data) {
      await safeBuildIdentityJobEvent({
        job_id: payload.job_id,
        level: 'error',
        step: 'build_identity_reference_asset_missing',
        message: refRes.error?.message ?? 'source_assets row not found',
        payload: {
          error_code: 'BUILD_IDENTITY_REFERENCE_ASSET_MISSING',
          reference_asset_id: refId,
        },
      })
      throw new Error('BUILD_IDENTITY_REFERENCE_ASSET_MISSING')
    }

    const ra = refRes.data as Record<string, unknown>
    const rowProjectId = String(ra.project_id ?? '').trim()
    if (rowProjectId !== String(payload.project_id).trim()) {
      await safeBuildIdentityJobEvent({
        job_id: payload.job_id,
        level: 'error',
        step: 'build_identity_reference_project_mismatch',
        message: 'reference asset project_id does not match job project_id',
        payload: {
          error_code: 'BUILD_IDENTITY_REFERENCE_PROJECT_MISMATCH',
          reference_asset_id: refId,
          expected_project_id: payload.project_id,
          row_project_id: rowProjectId,
        },
      })
      throw new Error('BUILD_IDENTITY_REFERENCE_PROJECT_MISMATCH')
    }

    if (String(ra.asset_type ?? '').trim() !== 'reference') {
      await safeBuildIdentityJobEvent({
        job_id: payload.job_id,
        level: 'error',
        step: 'build_identity_reference_type_invalid',
        message: 'source_assets.asset_type must be reference',
        payload: {
          error_code: 'BUILD_IDENTITY_REFERENCE_TYPE_INVALID',
          reference_asset_id: refId,
          asset_type: ra.asset_type ?? null,
        },
      })
      throw new Error('BUILD_IDENTITY_REFERENCE_TYPE_INVALID')
    }

    const assetKey = ra.asset_key == null ? '' : String(ra.asset_key).trim()
    if (!assetKey) {
      await safeBuildIdentityJobEvent({
        job_id: payload.job_id,
        level: 'error',
        step: 'build_identity_reference_key_missing',
        message: 'source_assets.asset_key is empty',
        payload: { error_code: 'BUILD_IDENTITY_REFERENCE_KEY_MISSING', reference_asset_id: refId },
      })
      throw new Error('BUILD_IDENTITY_REFERENCE_KEY_MISSING')
    }

    const vs = ra.validation_status == null ? '' : String(ra.validation_status).trim()
    const ast = ra.asset_status == null ? '' : String(ra.asset_status).trim()
    const statusOk = vs === 'validated' || ast === 'validated' || ast === 'active'
    if (!statusOk) {
      await safeBuildIdentityJobEvent({
        job_id: payload.job_id,
        level: 'error',
        step: 'build_identity_reference_status_invalid',
        message: 'reference asset is not validated or active',
        payload: {
          error_code: 'BUILD_IDENTITY_REFERENCE_STATUS_INVALID',
          reference_asset_id: refId,
          validation_status: vs || null,
          asset_status: ast || null,
        },
      })
      throw new Error('BUILD_IDENTITY_REFERENCE_STATUS_INVALID')
    }

    const dl = await supabaseServer.storage.from('project-media').download(assetKey)
    if (dl.error || !dl.data) {
      await safeBuildIdentityJobEvent({
        job_id: payload.job_id,
        level: 'error',
        step: 'build_identity_reference_download_failed',
        message: dl.error?.message ?? 'NO_FILE_DATA',
        payload: {
          error_code: 'BUILD_IDENTITY_REFERENCE_STORAGE_DOWNLOAD_FAILED',
          asset_key: assetKey,
        },
      })
      throw new Error('BUILD_IDENTITY_REFERENCE_STORAGE_DOWNLOAD_FAILED')
    }

    const referenceBuffer = Buffer.from(await dl.data.arrayBuffer())
    const imageBase64 = referenceBuffer.toString('base64')

    let embedResult: Awaited<ReturnType<typeof callIdentityEmbeddingEmbed>>
    try {
      embedResult = await callIdentityEmbeddingEmbed({
        imageBase64,
        serviceUrl,
      })
    } catch (e) {
      const em = getErrorMessage(e)
      await safeBuildIdentityJobEvent({
        job_id: payload.job_id,
        level: 'error',
        step: 'build_identity_embedding_service_failed',
        message: em,
        payload: { error_code: 'BUILD_IDENTITY_EMBEDDING_SERVICE_FAILED', detail: em },
      })
      throw e
    }

    if (embedResult.face_count === 0) {
      await safeBuildIdentityJobEvent({
        job_id: payload.job_id,
        level: 'error',
        step: 'build_identity_embedding_no_face',
        message: 'face_count is zero',
        payload: { error_code: 'BUILD_IDENTITY_EMBEDDING_FACE_COUNT_ZERO', face_count: 0 },
      })
      throw new Error('BUILD_IDENTITY_EMBEDDING_FACE_COUNT_ZERO')
    }

    const identityProfileId = randomUUID()
    const baseDir = `projects/${payload.project_id}/identity/${identityProfileId}`
    const embeddingKeyPath = `${baseDir}/embedding.json`
    const anchorManifestKeyPath = `${baseDir}/anchor-manifest.json`
    const latentPlaceholderKeyPath = `${baseDir}/latent-placeholder.json`

    const createdAt = new Date().toISOString()

    const embeddingDoc = {
      type: 'identity_embedding',
      reference_asset_id: refId,
      model_version: embedResult.model_version,
      embedding: embedResult.embedding,
      face_count: embedResult.face_count,
      quality_score: embedResult.quality_score,
      created_at: createdAt,
    }
    const anchorDoc = {
      type: 'identity_anchor_manifest',
      reference_asset_id: refId,
      model_version: embedResult.model_version,
      face_count: embedResult.face_count,
      quality_score: embedResult.quality_score,
      note: 'anchor manifest metadata only; full anchor extraction not implemented in this step',
      created_at: createdAt,
    }
    const latentDoc = {
      type: 'latent_placeholder_meta',
      implemented: false,
      reason: 'latent base generation is not implemented in this step',
      reference_asset_id: refId,
      model_version: embedResult.model_version,
      created_at: createdAt,
    }

    const jsonBuf = (obj: unknown) => Buffer.from(JSON.stringify(obj), 'utf8')

    const uploadedPaths: string[] = []
    const uploadOne = async (path: string, body: Buffer) => {
      const up = await supabaseServer.storage.from('project-media').upload(path, body, {
        contentType: 'application/json',
        upsert: false,
      })
      if (up.error) {
        throw new Error(`BUILD_IDENTITY_STORAGE_UPLOAD_FAILED:${path}:${up.error.message}`)
      }
      uploadedPaths.push(path)
    }

    try {
      await uploadOne(embeddingKeyPath, jsonBuf(embeddingDoc))
      await uploadOne(anchorManifestKeyPath, jsonBuf(anchorDoc))
      await uploadOne(latentPlaceholderKeyPath, jsonBuf(latentDoc))
    } catch (uploadErr) {
      const uem = getErrorMessage(uploadErr)
      const rm = await tryRemoveProjectMediaPaths([...uploadedPaths])
      if (!rm.ok) {
        await safeBuildIdentityJobEvent({
          job_id: payload.job_id,
          level: 'warn',
          step: 'build_identity_orphan_artifacts',
          message: 'Partial identity artifacts upload failed and cleanup remove failed or incomplete',
          payload: {
            error_code: 'BUILD_IDENTITY_ORPHAN_ARTIFACTS',
            uploaded_paths: uploadedPaths,
            removal_error: rm.error ?? null,
            upload_error: uem,
          },
        })
      }
      await safeBuildIdentityJobEvent({
        job_id: payload.job_id,
        level: 'error',
        step: 'build_identity_storage_upload_failed',
        message: uem,
        payload: {
          error_code: 'BUILD_IDENTITY_STORAGE_UPLOAD_FAILED',
          paths_attempted: [embeddingKeyPath, anchorManifestKeyPath, latentPlaceholderKeyPath],
          paths_uploaded_before_fail: uploadedPaths,
        },
      })
      throw uploadErr
    }

    const createIdentity = await supabaseServer
      .from('identity_profiles')
      .insert({
        id: identityProfileId,
        project_id: payload.project_id,
        reference_asset_id: refId,
        embedding_key: embeddingKeyPath,
        latent_base_key: latentPlaceholderKeyPath,
        anchor_manifest_key: anchorManifestKeyPath,
        identity_status: 'ready',
        build_score: embedResult.quality_score,
      })
      .select('id')
      .single()

    if (createIdentity.error) {
      const artifactPaths = [
        embeddingKeyPath,
        anchorManifestKeyPath,
        latentPlaceholderKeyPath,
      ]
      const rm = await tryRemoveProjectMediaPaths(artifactPaths)
      if (!rm.ok) {
        await safeBuildIdentityJobEvent({
          job_id: payload.job_id,
          level: 'warn',
          step: 'build_identity_orphan_artifacts',
          message: 'identity_profiles insert failed; storage cleanup remove failed or incomplete',
          payload: {
            error_code: 'BUILD_IDENTITY_ORPHAN_ARTIFACTS',
            uploaded_paths: artifactPaths,
            removal_error: rm.error ?? null,
            insert_error: createIdentity.error.message,
          },
        })
      }
      await safeBuildIdentityJobEvent({
        job_id: payload.job_id,
        level: 'error',
        step: 'build_identity_identity_profiles_insert_failed',
        message: createIdentity.error.message,
        payload: { error_code: 'BUILD_IDENTITY_IDENTITY_PROFILES_INSERT_FAILED' },
      })
      throw new Error(`identity_profiles_insert_failed: ${createIdentity.error.message}`)
    }

    const updateProjectActiveIdentity = await supabaseServer
      .from('projects')
      .update({
        active_identity_profile_id: createIdentity.data.id,
      })
      .eq('id', payload.project_id)
      .select('id')
      .single()
    if (updateProjectActiveIdentity.error) {
      await safeBuildIdentityJobEvent({
        job_id: payload.job_id,
        level: 'error',
        step: 'build_identity_active_project_update_failed',
        message: updateProjectActiveIdentity.error.message,
        payload: {
          error_code: 'BUILD_IDENTITY_ACTIVE_PROJECT_UPDATE_FAILED',
          identity_profile_id: createIdentity.data.id,
        },
      })
      throw new Error(
        `projects_active_identity_update_failed: ${updateProjectActiveIdentity.error.message}`
      )
    }

    await updateAnalyzeJobStatus({
      job_id: payload.job_id,
      status: 'success',
      progress: 100,
      started_at: now,
      finished_at: now,
      error_code: null,
      error_message: null,
    })

    await markCostSuccess(payload.job_id)

    const gateConfigResult = await supabaseServer
      .from('quality_gates')
      .select('threshold')
      .eq('project_id', payload.project_id)
      .eq('gate_type', 'identity')
      .eq('scope_type', 'project')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (gateConfigResult.error) {
      try {
        await addJobEvent({
          job_id: payload.job_id,
          level: 'error',
          step: 'build_identity_gate_config_read_failed',
          message: `quality_gates_read_failed: ${gateConfigResult.error.message}`,
        })
      } catch (eventInsertError) {
        console.error(
          'job_events_gate_config_read_failed_insert_error:',
          getErrorMessage(eventInsertError)
        )
      }
    } else if (!gateConfigResult.data) {
      try {
        await addJobEvent({
          job_id: payload.job_id,
          level: 'error',
          step: 'build_identity_gate_config_missing',
          message: 'quality_gates_identity_project_missing',
        })
      } catch (eventInsertError) {
        console.error(
          'job_events_gate_config_missing_insert_error:',
          getErrorMessage(eventInsertError)
        )
      }
    } else {
      const measuredValue = payload.build_score ?? null
      const thresholdValue = gateConfigResult.data.threshold
      const decision =
        measuredValue != null && measuredValue >= thresholdValue ? 'passed' : 'blocked'
      const reasonCode =
        decision === 'blocked' ? 'IDENTITY_SCORE_BELOW_THRESHOLD' : null

      const gateEvaluationInsert = await supabaseServer.from('gate_evaluations').insert({
        project_id: payload.project_id,
        scope_type: 'job',
        gate_type: 'identity',
        job_id: payload.job_id,
        measured_value: measuredValue,
        threshold: thresholdValue,
        decision,
        reason_code: reasonCode,
      })
      if (gateEvaluationInsert.error) {
        try {
          await addJobEvent({
            job_id: payload.job_id,
            level: 'error',
            step: 'build_identity_gate_record_failed',
            message: `gate_evaluations_insert_failed: ${gateEvaluationInsert.error.message}`,
          })
        } catch (eventInsertError) {
          console.error(
            'job_events_gate_record_failed_insert_error:',
            getErrorMessage(eventInsertError)
          )
        }
      }
    }

    await addJobEvent({
      job_id: payload.job_id,
      level: 'info',
      step: 'build_identity_completed',
      message: 'Build identity job completed',
      payload: { identity_profile_id: createIdentity.data.id },
    })
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    const errorCode = 'BUILD_IDENTITY_WORKER_ERROR'

    try {
      await updateAnalyzeJobStatus({
        job_id: payload.job_id,
        status: 'failed',
        progress: 10,
        started_at: now,
        finished_at: now,
        error_code: errorCode,
        error_message: errorMessage,
      })
      await markCostFailed(payload.job_id)
    } catch (statusUpdateError) {
      console.error('jobs_failed_update_failed:', getErrorMessage(statusUpdateError))
    }

    await addJobEvent({
      job_id: payload.job_id,
      level: 'error',
      step: 'build_identity_failed',
      message: errorMessage,
      payload: {
        job_id: payload.job_id,
        project_id: payload.project_id,
        job_type: 'build_identity',
        error_code: errorCode,
        error_message: errorMessage,
      },
    })

    throw error
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const PREVIEW_TEXT_MAX = 800
const PREVIEW_LINE_CHARS = 58
const PREVIEW_MAX_LINES = 14
const PREVIEW_LINE_HEIGHT = 28

async function renderPreviewWebp(instruction: string): Promise<Buffer> {
  const raw = instruction.trim() || '(no instruction)'
  const body = raw.slice(0, PREVIEW_TEXT_MAX)
  const lines: string[] = []
  for (let i = 0; i < body.length && lines.length < PREVIEW_MAX_LINES; i += PREVIEW_LINE_CHARS) {
    lines.push(body.slice(i, i + PREVIEW_LINE_CHARS))
  }

  const tspans = lines
    .map((line, idx) => {
      const dy = idx === 0 ? '0' : String(PREVIEW_LINE_HEIGHT)
      return `<tspan x="48" dy="${dy}">${escapeXml(line)}</tspan>`
    })
    .join('')

  const startY = 140
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="960" height="540" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#111827"/>
  <text x="48" y="72" font-family="system-ui, Segoe UI, sans-serif" font-size="26" font-weight="600" fill="#f9fafb">Non-AI preview</text>
  <text x="48" y="${startY}" font-family="system-ui, Segoe UI, sans-serif" font-size="17" fill="#e5e7eb">${tspans}</text>
</svg>`

  return sharp(Buffer.from(svg, 'utf8')).webp({ quality: 82 }).toBuffer()
}

const IMAGE_REMIX_OVERLAY_MAX = 140

async function remixReferenceImageToWebp(input: {
  referenceBuffer: Buffer
  instruction: string
  projectId: string
  jobId: string
}): Promise<{ webpBuffer: Buffer; usedFallback: boolean }> {
  const { referenceBuffer, instruction } = input

  // Provider hook boundary (not implemented in this stage).
  const provider = (process.env.IMAGE_REMIX_PROVIDER ?? '').trim()
  const apiKey = (process.env.IMAGE_REMIX_API_KEY ?? '').trim()
  void provider
  void apiKey

  // Deterministic fallback renderer: preserve original image, only add a small overlay label.
  const overlayTextRaw = instruction.trim()
  const overlayText = overlayTextRaw
    ? overlayTextRaw.slice(0, IMAGE_REMIX_OVERLAY_MAX)
    : 'image_remix (fallback)'

  const overlaySvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="960" height="540" xmlns="http://www.w3.org/2000/svg">
  <rect x="24" y="492" width="912" height="36" rx="10" fill="rgba(0,0,0,0.55)"/>
  <text x="44" y="516" font-family="system-ui, Segoe UI, sans-serif" font-size="16" fill="#ffffff">
    ${escapeXml(overlayText)}
  </text>
  <text x="760" y="516" font-family="system-ui, Segoe UI, sans-serif" font-size="14" fill="rgba(255,255,255,0.85)">
    fallback
  </text>
</svg>`

  const base = sharp(referenceBuffer, { failOn: 'none' })
    .rotate()
    .resize(960, 540, { fit: 'cover' })

  const overlayPng = await sharp(Buffer.from(overlaySvg, 'utf8')).png().toBuffer()

  const webpBuffer = await base
    .composite([{ input: overlayPng, top: 0, left: 0 }])
    .webp({ quality: 82 })
    .toBuffer()

  return { webpBuffer, usedFallback: true }
}

async function handlePreviewJob(payload: PreviewPayload) {
  const now = new Date().toISOString()
  const jobId = payload.job_id
  const projectId = payload.project_id

  if (await shouldSkipTerminalJob(jobId, 'preview')) return

  const inputMode = payload.input_mode ?? 'prompt_image'
  const instructionLength = (payload.instruction ?? '').length
  const referenceAssetId =
    payload.reference_asset_id == null ? null : String(payload.reference_asset_id).trim()

  if (inputMode !== 'prompt_image' && inputMode !== 'image_remix') {
    const msg = `Unsupported preview input_mode: ${String(payload.input_mode ?? '')}`
    const finished = new Date().toISOString()
    await updateAnalyzeJobStatus({
      job_id: jobId,
      status: 'failed',
      progress: 5,
      started_at: now,
      finished_at: finished,
      error_code: 'UNSUPPORTED_PREVIEW_INPUT_MODE',
      error_message: msg,
      output_asset_key: null,
    })
    await markCostFailed(jobId)
    await addJobEvent({
      job_id: jobId,
      level: 'error',
      step: 'unsupported_preview_input_mode',
      message: msg,
      payload: {
        job_id: jobId,
        project_id: projectId,
        job_type: 'preview',
        input_mode: payload.input_mode ?? null,
      },
    })
    return
  }

  await updateAnalyzeJobStatus({
    job_id: jobId,
    status: 'running',
    progress: 5,
    started_at: now,
    error_code: null,
    error_message: null,
    output_asset_key: null,
  })

  await markCostRunning(jobId)

  await addJobEvent({
    job_id: jobId,
    level: 'info',
    step: 'preview_received',
    message: 'Preview job received',
    payload: {
      project_id: projectId,
      job_type: 'preview',
      input_mode: inputMode,
      reference_asset_id: referenceAssetId,
      instruction_present: instructionLength > 0,
      instruction_length: instructionLength,
    },
  })

  if (inputMode === 'image_remix') {
    if (!referenceAssetId) {
      const msg = 'reference_asset_id is required for image_remix'
      const finished = new Date().toISOString()
      await updateAnalyzeJobStatus({
        job_id: jobId,
        status: 'failed',
        progress: 5,
        started_at: now,
        finished_at: finished,
        error_code: 'PREVIEW_INPUT_INVALID',
        error_message: msg,
        output_asset_key: null,
      })
      await markCostFailed(jobId)
      await addJobEvent({
        job_id: jobId,
        level: 'error',
        step: 'preview_input_invalid',
        message: msg,
        payload: {
          job_id: jobId,
          project_id: projectId,
          job_type: 'preview',
          input_mode: inputMode,
        },
      })
      return
    }

    await addJobEvent({
      job_id: jobId,
      level: 'info',
      step: 'image_remix_preview_started',
      message: 'Image remix preview started',
      payload: {
        job_id: jobId,
        project_id: projectId,
        job_type: 'preview',
        input_mode: inputMode,
        reference_asset_id: referenceAssetId,
        instruction_length: instructionLength,
      },
    })
  }

  let webpBuffer: Buffer
  try {
    if (inputMode === 'image_remix') {
      const refLookup = await supabaseServer
        .from('source_assets')
        .select('id, asset_key, asset_type, asset_status, validation_status')
        .eq('id', referenceAssetId)
        .eq('project_id', projectId)
        .eq('asset_type', 'reference')
        .or('validation_status.eq.validated,asset_status.eq.validated,asset_status.eq.active')
        .maybeSingle()

      if (refLookup.error) {
        const msg = `source_assets_read_failed: ${refLookup.error.message}`
        const finished = new Date().toISOString()
        await updateAnalyzeJobStatus({
          job_id: jobId,
          status: 'failed',
          progress: 5,
          started_at: now,
          finished_at: finished,
          error_code: 'REFERENCE_ASSET_NOT_AVAILABLE',
          error_message: msg,
          output_asset_key: null,
        })
        await markCostFailed(jobId)
        await addJobEvent({
          job_id: jobId,
          level: 'error',
          step: 'image_remix_reference_not_available',
          message: msg,
          payload: {
            input_mode: inputMode,
            reference_asset_id: referenceAssetId,
          },
        })
        return
      }

      if (!refLookup.data?.id) {
        const msg = 'Reference asset is not available for remix'
        const finished = new Date().toISOString()
        await updateAnalyzeJobStatus({
          job_id: jobId,
          status: 'failed',
          progress: 5,
          started_at: now,
          finished_at: finished,
          error_code: 'REFERENCE_ASSET_NOT_AVAILABLE',
          error_message: msg,
          output_asset_key: null,
        })
        await markCostFailed(jobId)
        await addJobEvent({
          job_id: jobId,
          level: 'error',
          step: 'image_remix_reference_not_available',
          message: msg,
          payload: {
            input_mode: inputMode,
            reference_asset_id: referenceAssetId,
          },
        })
        return
      }

      const assetKey =
        refLookup.data.asset_key == null ? '' : String(refLookup.data.asset_key).trim()
      const expectedPrefix = `projects/${projectId}/references/`
      if (!assetKey || !assetKey.startsWith(expectedPrefix)) {
        const msg = 'Reference asset key is not a supported project-media reference path'
        const finished = new Date().toISOString()
        await updateAnalyzeJobStatus({
          job_id: jobId,
          status: 'failed',
          progress: 5,
          started_at: now,
          finished_at: finished,
          error_code: 'REFERENCE_ASSET_KEY_UNSUPPORTED',
          error_message: msg,
          output_asset_key: null,
        })
        await markCostFailed(jobId)
        await addJobEvent({
          job_id: jobId,
          level: 'error',
          step: 'image_remix_reference_key_unsupported',
          message: msg,
          payload: {
            input_mode: inputMode,
            reference_asset_id: referenceAssetId,
            asset_key: assetKey,
          },
        })
        return
      }

      const dl = await supabaseServer.storage.from('project-media').download(assetKey)
      if (dl.error || !dl.data) {
        const msg = `storage_download_failed: ${dl.error?.message ?? 'NO_FILE_DATA'}`
        const finished = new Date().toISOString()
        await updateAnalyzeJobStatus({
          job_id: jobId,
          status: 'failed',
          progress: 5,
          started_at: now,
          finished_at: finished,
          error_code: 'REFERENCE_ASSET_DOWNLOAD_FAILED',
          error_message: msg,
          output_asset_key: null,
        })
        await markCostFailed(jobId)
        await addJobEvent({
          job_id: jobId,
          level: 'error',
          step: 'image_remix_reference_download_failed',
          message: msg,
          payload: {
            input_mode: inputMode,
            reference_asset_id: referenceAssetId,
            asset_key: assetKey,
          },
        })
        return
      }

      const arrayBuffer = await dl.data.arrayBuffer()
      const referenceBuffer = Buffer.from(arrayBuffer)
      await addJobEvent({
        job_id: jobId,
        level: 'info',
        step: 'image_remix_reference_downloaded',
        message: 'Reference image downloaded',
        payload: {
          input_mode: inputMode,
          reference_asset_id: referenceAssetId,
          asset_key: assetKey,
          byte_length: referenceBuffer.length,
          instruction_length: instructionLength,
        },
      })

      const remix = await remixReferenceImageToWebp({
        referenceBuffer,
        instruction: payload.instruction ?? '',
        projectId,
        jobId,
      })

      if (remix.usedFallback) {
        await addJobEvent({
          job_id: jobId,
          level: 'info',
          step: 'image_remix_provider_fallback_used',
          message: 'External provider not configured or not implemented. Fallback renderer used.',
          payload: {
            input_mode: inputMode,
            reference_asset_id: referenceAssetId,
            asset_key: assetKey,
            instruction_length: instructionLength,
          },
        })
      }

      webpBuffer = remix.webpBuffer

      await addJobEvent({
        job_id: jobId,
        level: 'info',
        step: 'image_remix_render_completed',
        message: 'Image remix render completed',
        payload: {
          input_mode: inputMode,
          reference_asset_id: referenceAssetId,
          asset_key: assetKey,
          byte_length: webpBuffer.length,
          instruction_length: instructionLength,
        },
      })
    } else {
      webpBuffer = await renderPreviewWebp(payload.instruction ?? '')
    }
  } catch (renderErr) {
    const msg = getErrorMessage(renderErr)
    const finished = new Date().toISOString()
    const code = inputMode === 'image_remix' ? 'IMAGE_REMIX_RENDER_FAILED' : 'PREVIEW_RENDER_FAILED'
    await updateAnalyzeJobStatus({
      job_id: jobId,
      status: 'failed',
      progress: 5,
      started_at: now,
      finished_at: finished,
      error_code: code,
      error_message: msg,
      output_asset_key: null,
    })
    await markCostFailed(jobId)
    await addJobEvent({
      job_id: jobId,
      level: 'error',
      step: inputMode === 'image_remix' ? 'image_remix_render_failed' : 'preview_render_failed',
      message: msg,
      payload: {
        job_id: jobId,
        project_id: projectId,
        job_type: 'preview',
        error_code: code,
        input_mode: inputMode,
        reference_asset_id: referenceAssetId,
      },
    })
    throw renderErr
  }

  await addJobEvent({
    job_id: jobId,
    level: 'info',
    step: 'preview_image_generated',
    message: 'Preview WebP generated',
    payload: {
      instruction_length: instructionLength,
      bytes: webpBuffer.length,
    },
  })

  const objectPath = `projects/${projectId}/previews/${jobId}/preview.webp`
  const uploadResult = await supabaseServer.storage
    .from('project-media')
    .upload(objectPath, webpBuffer, {
      contentType: 'image/webp',
      upsert: false,
    })

  if (uploadResult.error) {
    const msg = uploadResult.error.message
    const finished = new Date().toISOString()
    await updateAnalyzeJobStatus({
      job_id: jobId,
      status: 'failed',
      progress: 5,
      started_at: now,
      finished_at: finished,
      error_code: 'PREVIEW_UPLOAD_FAILED',
      error_message: msg,
      output_asset_key: null,
    })
    await markCostFailed(jobId)
    await addJobEvent({
      job_id: jobId,
      level: 'error',
      step: 'preview_upload_failed',
      message: msg,
      payload: {
        job_id: jobId,
        project_id: projectId,
        path: objectPath,
        error_code: 'PREVIEW_UPLOAD_FAILED',
      },
    })
    throw new Error(msg)
  }

  await addJobEvent({
    job_id: jobId,
    level: 'info',
    step: 'preview_uploaded',
    message: 'Preview uploaded to storage',
    payload: {
      path: objectPath,
      bucket: 'project-media',
    },
  })

  const finishedOk = new Date().toISOString()
  await updateAnalyzeJobStatus({
    job_id: jobId,
    status: 'success',
    progress: 100,
    started_at: now,
    finished_at: finishedOk,
    error_code: null,
    error_message: null,
    output_asset_key: objectPath,
  })

  await markCostSuccess(jobId)

  await addJobEvent({
    job_id: jobId,
    level: 'info',
    step: 'preview_completed',
    message: 'Preview job completed',
    payload: {
      path: objectPath,
      instruction_length: instructionLength,
    },
  })
}

async function renderChunkDummyWebp(params: {
  projectId: string
  chunkId: string
}): Promise<Buffer> {
  const { projectId, chunkId } = params
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="960" height="540" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#0b1220"/>
  <text x="48" y="76" font-family="system-ui, Segoe UI, sans-serif" font-size="28" font-weight="700" fill="#f9fafb">Dummy render_chunk</text>
  <text x="48" y="128" font-family="system-ui, Segoe UI, sans-serif" font-size="16" fill="#e5e7eb">project: ${escapeXml(projectId)}</text>
  <text x="48" y="160" font-family="system-ui, Segoe UI, sans-serif" font-size="16" fill="#e5e7eb">chunk: ${escapeXml(chunkId)}</text>
  <text x="48" y="510" font-family="system-ui, Segoe UI, sans-serif" font-size="14" fill="rgba(255,255,255,0.75)">GPU not connected • deterministic placeholder</text>
</svg>`
  return sharp(Buffer.from(svg, 'utf8')).webp({ quality: 82 }).toBuffer()
}

function storageKeyBasename(key: string | null | undefined): string | null {
  if (key == null || typeof key !== 'string') return null
  const t = key.trim()
  if (!t) return null
  const i = t.lastIndexOf('/')
  return i >= 0 ? t.slice(i + 1) : t
}

function secretKeyPresent(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.trim().length > 0
}

type SourceAssetMetaRow = {
  id: string
  asset_key: string
  asset_type: string
  asset_status: string
  validation_status: string | null
  mime_type: string | null
}

function emptyAssetMetaForRenderInput(): Record<string, unknown> {
  return {
    asset_key_present: false,
    asset_key_basename: null,
    asset_type: null,
    asset_status: null,
    validation_status: null,
    mime_type: null,
  }
}

function emptyPrevChunkMetaForRenderInput(): Record<string, unknown> {
  return {
    render_status: null,
    output_asset_key_present: false,
    output_asset_key_basename: null,
    identity_score: null,
    style_score: null,
  }
}

const MAX_RENDER_CHUNK_STATE_JSON_BYTES = 32 * 1024

const RENDER_CHUNK_STATE_OUT_KEY_RE =
  /^projects\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/chunks\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/state-out\.json$/

function expectedRenderChunkStateOutKey(projectId: string, chunkId: string): string {
  const pid = String(projectId).trim()
  const cid = String(chunkId).trim()
  return `projects/${pid}/chunks/${cid}/state-out.json`
}

async function safeAddRenderChunkStateKeyJobEvent(params: {
  job_id: string
  level: string
  step: string
  message: string
  payload?: Record<string, unknown>
}): Promise<void> {
  try {
    await addJobEvent({
      job_id: params.job_id,
      level: params.level,
      step: params.step,
      message: params.message,
      payload: params.payload,
    })
  } catch (e) {
    console.warn(`${params.step} job_events insert failed`, getErrorMessage(e))
  }
}

async function persistRenderChunkStateOut(params: {
  jobId: string
  projectId: string
  chunkId: string
  sceneId: string
  sequenceId: string
  outputPath: string
  normalizedScore: number | null
}): Promise<void> {
  const { jobId, projectId, chunkId, sceneId, outputPath, normalizedScore } = params
  const sequenceIdNorm = String(params.sequenceId ?? '').trim()
  if (!sequenceIdNorm || !isValidUuid(sequenceIdNorm)) {
    await safeAddRenderChunkStateKeyJobEvent({
      job_id: jobId,
      level: 'warn',
      step: 'render_chunk_state_out_sequence_id_missing',
      message: 'sequence_id missing or invalid; state-out JSON not persisted',
      payload: {
        project_id: projectId,
        chunk_id: chunkId,
      },
    })
    return
  }

  const stateOutKey = expectedRenderChunkStateOutKey(projectId, chunkId)
  if (!RENDER_CHUNK_STATE_OUT_KEY_RE.test(stateOutKey)) {
    await safeAddRenderChunkStateKeyJobEvent({
      job_id: jobId,
      level: 'warn',
      step: 'render_chunk_state_out_invalid_key',
      message: 'Computed state_out_key does not match required projects/.../chunks/.../state-out.json pattern',
      payload: {
        project_id: projectId,
        chunk_id: chunkId,
        computed_key: stateOutKey,
      },
    })
    return
  }

  const createdAt = new Date().toISOString()
  const statePayload = {
    schema_version: 1,
    type: 'render_chunk_state_out',
    project_id: projectId,
    chunk_id: chunkId,
    scene_id: sceneId,
    sequence_id: sequenceIdNorm,
    job_id: jobId,
    output_asset_key: outputPath,
    identity_score: normalizedScore,
    render_status: 'rendered',
    state_source: 'render_chunk_success',
    created_at: createdAt,
  }
  const jsonBody = JSON.stringify(statePayload)
  const byteSize = Buffer.byteLength(jsonBody, 'utf8')
  if (byteSize > MAX_RENDER_CHUNK_STATE_JSON_BYTES) {
    await safeAddRenderChunkStateKeyJobEvent({
      job_id: jobId,
      level: 'warn',
      step: 'render_chunk_state_out_too_large',
      message: `state-out JSON exceeds ${MAX_RENDER_CHUNK_STATE_JSON_BYTES} bytes`,
      payload: {
        project_id: projectId,
        chunk_id: chunkId,
        byte_size: byteSize,
        max_bytes: MAX_RENDER_CHUNK_STATE_JSON_BYTES,
      },
    })
    return
  }

  const upload = await supabaseServer.storage
    .from('project-media')
    .upload(stateOutKey, Buffer.from(jsonBody, 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (upload.error) {
    await safeAddRenderChunkStateKeyJobEvent({
      job_id: jobId,
      level: 'warn',
      step: 'render_chunk_state_out_upload_failed',
      message: upload.error.message,
      payload: {
        project_id: projectId,
        chunk_id: chunkId,
        state_out_key: stateOutKey,
        error: upload.error.message,
      },
    })
    return
  }

  const keyUpd = await supabaseServer
    .from('sequence_chunks')
    .update({ state_out_key: stateOutKey } as Record<string, unknown>)
    .eq('id', chunkId)
  if (keyUpd.error) {
    await safeAddRenderChunkStateKeyJobEvent({
      job_id: jobId,
      level: 'warn',
      step: 'render_chunk_state_out_key_update_failed',
      message: keyUpd.error.message,
      payload: {
        project_id: projectId,
        chunk_id: chunkId,
        state_out_key: stateOutKey,
        error: keyUpd.error.message,
      },
    })
    return
  }

  await safeAddRenderChunkStateKeyJobEvent({
    job_id: jobId,
    level: 'info',
    step: 'render_chunk_state_out_recorded',
    message: 'render_chunk state-out JSON stored and sequence_chunks.state_out_key updated',
    payload: {
      project_id: projectId,
      chunk_id: chunkId,
      state_out_key: stateOutKey,
    },
  })
}

type PrevStateOutConsistencyFailReason =
  | 'schema_invalid'
  | 'project_mismatch'
  | 'chunk_mismatch'
  | 'scene_mismatch'
  | 'sequence_mismatch'
  | 'parse_failed'
  | 'download_failed'
  | 'too_large'
  | 'missing_sequence_id'

function normStateOutCompareId(v: unknown): string {
  return String(v ?? '').trim()
}

async function verifyPrevChunkStateOutForSequenceConsistency(params: {
  storageKey: string
  projectId: string
  prevChunkId: string
  sceneId: string
  sequenceId: string
}): Promise<{ ok: true } | { ok: false; reason: PrevStateOutConsistencyFailReason }> {
  const { storageKey, projectId, prevChunkId, sceneId, sequenceId } = params
  const dl = await supabaseServer.storage.from('project-media').download(storageKey)
  if (dl.error || !dl.data) {
    return { ok: false, reason: 'download_failed' }
  }
  let buf: Buffer
  try {
    buf = Buffer.from(await dl.data.arrayBuffer())
  } catch {
    return { ok: false, reason: 'download_failed' }
  }
  if (buf.length > MAX_RENDER_CHUNK_STATE_JSON_BYTES) {
    return { ok: false, reason: 'too_large' }
  }
  let obj: unknown
  try {
    obj = JSON.parse(buf.toString('utf8')) as unknown
  } catch {
    return { ok: false, reason: 'parse_failed' }
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, reason: 'schema_invalid' }
  }
  const o = obj as Record<string, unknown>
  if (o.schema_version !== 1) {
    return { ok: false, reason: 'schema_invalid' }
  }
  if (normStateOutCompareId(o.type) !== 'render_chunk_state_out') {
    return { ok: false, reason: 'schema_invalid' }
  }
  if (normStateOutCompareId(o.project_id) !== normStateOutCompareId(projectId)) {
    return { ok: false, reason: 'project_mismatch' }
  }
  if (normStateOutCompareId(o.chunk_id) !== normStateOutCompareId(prevChunkId)) {
    return { ok: false, reason: 'chunk_mismatch' }
  }
  if (normStateOutCompareId(o.scene_id) !== normStateOutCompareId(sceneId)) {
    return { ok: false, reason: 'scene_mismatch' }
  }
  const seqRaw = o.sequence_id
  if (seqRaw == null || normStateOutCompareId(seqRaw) === '') {
    return { ok: false, reason: 'missing_sequence_id' }
  }
  if (normStateOutCompareId(seqRaw) !== normStateOutCompareId(sequenceId)) {
    return { ok: false, reason: 'sequence_mismatch' }
  }
  const oak = o.output_asset_key
  if (oak == null || normStateOutCompareId(oak) === '') {
    return { ok: false, reason: 'schema_invalid' }
  }
  return { ok: true }
}

async function fetchSourceAssetMetaRow(assetId: string): Promise<{
  row: SourceAssetMetaRow | null
  error: string | null
}> {
  const full = await supabaseServer
    .from('source_assets')
    .select('id, asset_key, asset_type, asset_status, validation_status, mime_type')
    .eq('id', assetId)
    .maybeSingle()
  if (!full.error && full.data) {
    const d = full.data as Record<string, unknown>
    return {
      row: {
        id: String(d.id),
        asset_key: String(d.asset_key ?? ''),
        asset_type: String(d.asset_type ?? ''),
        asset_status: String(d.asset_status ?? ''),
        validation_status: d.validation_status != null ? String(d.validation_status) : null,
        mime_type: d.mime_type != null ? String(d.mime_type) : null,
      },
      error: null,
    }
  }
  const errMsg = full.error?.message ?? ''
  if (errMsg && /mime_type/i.test(errMsg)) {
    const noMime = await supabaseServer
      .from('source_assets')
      .select('id, asset_key, asset_type, asset_status, validation_status')
      .eq('id', assetId)
      .maybeSingle()
    if (noMime.error) return { row: null, error: noMime.error.message }
    if (!noMime.data) return { row: null, error: 'SOURCE_ASSET_NOT_FOUND' }
    const d = noMime.data as Record<string, unknown>
    return {
      row: {
        id: String(d.id),
        asset_key: String(d.asset_key ?? ''),
        asset_type: String(d.asset_type ?? ''),
        asset_status: String(d.asset_status ?? ''),
        validation_status: d.validation_status != null ? String(d.validation_status) : null,
        mime_type: null,
      },
      error: null,
    }
  }
  return { row: null, error: full.error?.message ?? 'SOURCE_ASSET_NOT_FOUND' }
}

function buildAssetMetaForRenderInput(
  row: SourceAssetMetaRow | null,
  fetchError: string | null
): { meta: Record<string, unknown>; err: string | null } {
  if (fetchError && !row) {
    return { meta: emptyAssetMetaForRenderInput(), err: fetchError }
  }
  if (!row) {
    return { meta: emptyAssetMetaForRenderInput(), err: null }
  }
  return {
    meta: {
      asset_key_present: secretKeyPresent(row.asset_key),
      asset_key_basename: storageKeyBasename(row.asset_key),
      asset_type: row.asset_type || null,
      asset_status: row.asset_status || null,
      validation_status: row.validation_status,
      mime_type: row.mime_type,
    },
    err: null,
  }
}

async function safeAddJobEventRenderInputResolved(
  jobId: string,
  renderInput: Record<string, unknown>
): Promise<void> {
  try {
    const sik = renderInput.state_in_key
    const pok = renderInput.prev_state_out_key
    const pcrs = renderInput.prev_chunk_render_status
    const pChecked = renderInput.prev_state_out_consistency_checked
    const pPassed = renderInput.prev_state_out_consistency_passed
    const pFailReason = renderInput.prev_state_out_consistency_failure_reason
    await addJobEvent({
      job_id: jobId,
      level: 'info',
      step: 'render_input_resolved',
      message: 'Render input contract resolved',
      payload: {
        render_input: renderInput,
        state_in_key_present: typeof sik === 'string' && sik.trim() !== '',
        prev_state_out_key_present: typeof pok === 'string' && pok.trim() !== '',
        prev_chunk_render_status:
          pcrs == null || (typeof pcrs === 'string' && pcrs.trim() === '')
            ? null
            : String(pcrs),
        prev_state_out_consistency_checked: pChecked === true,
        prev_state_out_consistency_passed: pPassed === true,
        ...(typeof pFailReason === 'string' && pFailReason.trim() !== ''
          ? { prev_state_out_consistency_failure_reason: String(pFailReason).trim() }
          : {}),
      },
    })
  } catch (e) {
    console.warn('render_input_resolved job_events insert failed', getErrorMessage(e))
  }
}

async function safeAddRenderChunkGateJobEvent(params: {
  job_id: string
  level: string
  step: string
  message: string
  payload?: Record<string, unknown>
}): Promise<void> {
  try {
    await addJobEvent({
      job_id: params.job_id,
      level: params.level,
      step: params.step,
      message: params.message,
      payload: params.payload,
    })
  } catch (e) {
    console.warn(`${params.step} job_events insert failed`, getErrorMessage(e))
  }
}

function parseMeasuredIdentityScoreForGate(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

function parseQualityGateThresholdForGate(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

const AUTO_RERENDER_MAX_ATTEMPT = 3

async function safeAddAutoRerenderJobEvent(params: {
  job_id: string
  level: string
  step: string
  message: string
  payload?: Record<string, unknown>
}): Promise<void> {
  try {
    await addJobEvent({
      job_id: params.job_id,
      level: params.level,
      step: params.step,
      message: params.message,
      payload: params.payload,
    })
  } catch (e) {
    console.warn(`${params.step} job_events insert failed`, getErrorMessage(e))
  }
}

function resolveMeasuredIdentityScoreForGate(params: {
  measuredIdentityScoreOverride: number | null | undefined
  identityScoreRaw: unknown
}): number | null {
  const { measuredIdentityScoreOverride, identityScoreRaw } = params
  if (measuredIdentityScoreOverride !== undefined) {
    if (measuredIdentityScoreOverride === null) return null
    if (
      typeof measuredIdentityScoreOverride === 'number' &&
      Number.isFinite(measuredIdentityScoreOverride)
    ) {
      return measuredIdentityScoreOverride
    }
    return null
  }
  return parseMeasuredIdentityScoreForGate(identityScoreRaw)
}

type BasicRenderChunkIdentityScoreResult = {
  score: number | null
  referenceAssetId: string | null
  referenceSource: 'identity_profile' | 'fallback' | null
  reasonCode?: string
  errorMessage?: string
}

/** Single persist shape: finite only, [0,1] clamp, 2 decimals (matches typical DB numeric scale). */
function normalizeRenderChunkIdentityScoreForPersist(score: number): number | null {
  if (!Number.isFinite(score)) return null
  const clamped = Math.max(0, Math.min(1, score))
  return Math.round(clamped * 100) / 100
}

/** Aligned with `src/app/api/source/upload/route.ts` `MAX_BYTES` (10 MiB). */
const MAX_IDENTITY_SCORE_IMAGE_BYTES = 10 * 1024 * 1024

const MAX_IDENTITY_EMBEDDING_DIMENSIONS = 4096

const MAX_IDENTITY_OUTPUT_PIXELS = 16_000_000

/**
 * Maps cosine similarity in [-1, 1] to [0, 1] for gate thresholds that assume a 0~1-style score.
 * No separate product doc defines identity_score bounds; this policy matches pixel scores (0~1).
 */
const IDENTITY_COSINE_NORMALIZATION_POLICY =
  'cosine_similarity in [-1,1] mapped via (cosine + 1) / 2 into [0,1], clamped to [0,1], then normalizeRenderChunkIdentityScoreForPersist (same rounding as pixel path)'

function vectorL2Squared(values: number[]): number {
  let s = 0
  for (const v of values) {
    s += v * v
  }
  return s
}

function cosineSimilarityOrThrow(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    throw new Error('COSINE_VECTOR_LENGTH_MISMATCH')
  }
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  if (denom === 0 || !Number.isFinite(denom)) {
    throw new Error('COSINE_ZERO_NORM')
  }
  const c = dot / denom
  if (!Number.isFinite(c)) {
    throw new Error('COSINE_NON_FINITE')
  }
  return c
}

type EmbeddingRenderChunkIdentityScoreOk = {
  ok: true
  /** Pre-persist [0,1] score from cosine normalization. */
  score01: number
  rawCosine: number
  referenceModelVersion: string
  outputModelVersion: string
  identityProfileId: string
  embeddingDimensions: number
  referenceAssetId: string | null
  referenceSource: 'identity_profile' | 'fallback' | null
}

type EmbeddingRenderChunkIdentityScoreFail = {
  ok: false
  errorCode: string
  reason: string
}

type EmbeddingRenderChunkIdentityScoreResult =
  | EmbeddingRenderChunkIdentityScoreOk
  | EmbeddingRenderChunkIdentityScoreFail

function parseReferenceEmbeddingVectorFromJsonDoc(
  doc: Record<string, unknown>
): { embedding: number[]; modelVersion: string } | null {
  const mvRaw = doc.model_version
  if (mvRaw == null || typeof mvRaw !== 'string' || mvRaw.trim() === '') {
    return null
  }
  const modelVersion = mvRaw.trim()
  const embRaw = doc.embedding
  if (!Array.isArray(embRaw) || embRaw.length === 0 || embRaw.length > MAX_IDENTITY_EMBEDDING_DIMENSIONS) {
    return null
  }
  const embedding: number[] = []
  for (let i = 0; i < embRaw.length; i++) {
    const n = embRaw[i]
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      return null
    }
    embedding.push(n)
  }
  if (vectorL2Squared(embedding) < 1e-12) {
    return null
  }
  return { embedding, modelVersion: modelVersion }
}

async function resolveIdentityProfileIdForRenderChunk(
  projectId: string,
  renderInput: Record<string, unknown>
): Promise<string | null> {
  const ipRaw = renderInput.identity_profile_id
  const ipStr = ipRaw != null && String(ipRaw).trim() !== '' ? String(ipRaw).trim() : ''
  if (ipStr && isValidUuid(ipStr)) {
    return ipStr
  }
  const pr = await supabaseServer
    .from('projects')
    .select('active_identity_profile_id')
    .eq('id', projectId)
    .maybeSingle()
  if (pr.error || !pr.data) {
    return null
  }
  const aid = pr.data.active_identity_profile_id
  const aidStr = aid != null && String(aid).trim() !== '' ? String(aid).trim() : ''
  if (aidStr && isValidUuid(aidStr)) {
    return aidStr
  }
  return null
}

/**
 * Embedding-based identity score vs reference embedding from identity_profiles.embedding_key JSON.
 * On any failure returns `{ ok: false }` so callers can fall back to pixel comparison.
 */
async function calculateEmbeddingRenderChunkIdentityScore(params: {
  jobId: string
  projectId: string
  chunkId: string
  renderInput: Record<string, unknown>
  outputAssetKey: string
}): Promise<EmbeddingRenderChunkIdentityScoreResult> {
  const { jobId, projectId, chunkId, renderInput, outputAssetKey } = params

  const fail = (errorCode: string, reason: string): EmbeddingRenderChunkIdentityScoreFail => ({
    ok: false,
    errorCode,
    reason,
  })

  const serviceUrlRaw = process.env.IDENTITY_EMBEDDING_SERVICE_URL ?? ''
  const serviceUrl = typeof serviceUrlRaw === 'string' ? serviceUrlRaw.trim() : ''
  if (!serviceUrl) {
    return fail('IDENTITY_EMBEDDING_SERVICE_URL_MISSING', 'IDENTITY_EMBEDDING_SERVICE_URL is not set')
  }

  const profileId = await resolveIdentityProfileIdForRenderChunk(projectId, renderInput)
  if (!profileId) {
    return fail('IDENTITY_EMBEDDING_PROFILE_ID_MISSING', 'No identity_profile_id from render input or project')
  }

  const ipRow = await supabaseServer
    .from('identity_profiles')
    .select('id, embedding_key, reference_asset_id, identity_status')
    .eq('id', profileId)
    .maybeSingle()

  if (ipRow.error || !ipRow.data) {
    return fail('IDENTITY_EMBEDDING_PROFILE_ROW_MISSING', ipRow.error?.message ?? 'identity_profiles not found')
  }

  const row = ipRow.data as Record<string, unknown>
  const identityStatus = String(row.identity_status ?? '').trim()
  if (identityStatus !== 'ready') {
    return fail(
      'IDENTITY_EMBEDDING_PROFILE_NOT_READY',
      `identity_status is not ready: ${identityStatus || 'empty'}`
    )
  }

  const embeddingKey = row.embedding_key == null ? '' : String(row.embedding_key).trim()
  if (!embeddingKey) {
    return fail('IDENTITY_EMBEDDING_KEY_MISSING', 'identity_profiles.embedding_key is empty')
  }

  const refAssetId =
    row.reference_asset_id == null || String(row.reference_asset_id).trim() === ''
      ? null
      : String(row.reference_asset_id).trim()

  const embDl = await supabaseServer.storage.from('project-media').download(embeddingKey)
  if (embDl.error || !embDl.data) {
    return fail(
      'IDENTITY_EMBEDDING_JSON_DOWNLOAD_FAILED',
      embDl.error?.message ?? 'NO_FILE_DATA'
    )
  }

  let embDoc: Record<string, unknown>
  try {
    const txt = Buffer.from(await embDl.data.arrayBuffer()).toString('utf8')
    embDoc = JSON.parse(txt) as Record<string, unknown>
  } catch (e) {
    return fail('IDENTITY_EMBEDDING_JSON_PARSE_FAILED', getErrorMessage(e))
  }

  const parsedRef = parseReferenceEmbeddingVectorFromJsonDoc(embDoc)
  if (!parsedRef) {
    return fail('IDENTITY_REFERENCE_EMBEDDING_VECTOR_INVALID', 'embedding.json embedding or model_version invalid')
  }
  const referenceEmbedding = parsedRef.embedding
  const referenceModelVersion = parsedRef.modelVersion

  const outTrim = typeof outputAssetKey === 'string' ? outputAssetKey.trim() : ''
  const expectedOutPrefix = `projects/${projectId}/chunks/${chunkId}/`
  if (!outTrim || !outTrim.startsWith(expectedOutPrefix) || !outTrim.endsWith('render.webp')) {
    return fail('IDENTITY_OUTPUT_KEY_UNSUPPORTED', 'output asset key is not supported for identity score')
  }

  const outDl = await supabaseServer.storage.from('project-media').download(outTrim)
  if (outDl.error || !outDl.data) {
    return fail(
      'IDENTITY_OUTPUT_IMAGE_DOWNLOAD_FAILED',
      outDl.error?.message ?? 'NO_FILE_DATA'
    )
  }

  const outBuf = Buffer.from(await outDl.data.arrayBuffer())
  if (outBuf.length > MAX_IDENTITY_SCORE_IMAGE_BYTES) {
    return fail(
      'IDENTITY_OUTPUT_IMAGE_TOO_LARGE',
      `output image exceeds MAX_IDENTITY_SCORE_IMAGE_BYTES (${MAX_IDENTITY_SCORE_IMAGE_BYTES})`
    )
  }

  let meta: { width?: number; height?: number }
  try {
    meta = await sharp(outBuf).metadata()
  } catch (e) {
    return fail('IDENTITY_OUTPUT_IMAGE_METADATA_FAILED', getErrorMessage(e))
  }
  const w = meta.width
  const h = meta.height
  if (
    w == null ||
    h == null ||
    !Number.isFinite(w) ||
    !Number.isFinite(h) ||
    w <= 0 ||
    h <= 0
  ) {
    return fail('IDENTITY_OUTPUT_IMAGE_METADATA_INVALID', 'width/height missing or invalid')
  }
  if (w * h > MAX_IDENTITY_OUTPUT_PIXELS) {
    return fail(
      'IDENTITY_OUTPUT_IMAGE_RESOLUTION_TOO_LARGE',
      `width*height ${w * h} exceeds ${MAX_IDENTITY_OUTPUT_PIXELS}`
    )
  }

  const imageBase64 = outBuf.toString('base64')

  let outEmbed: Awaited<ReturnType<typeof callIdentityEmbeddingEmbed>>
  try {
    outEmbed = await callIdentityEmbeddingEmbed({
      imageBase64,
      serviceUrl,
    })
  } catch (e) {
    return fail('IDENTITY_OUTPUT_EMBEDDING_SERVICE_FAILED', getErrorMessage(e))
  }

  if (outEmbed.face_count === 0) {
    return fail('IDENTITY_OUTPUT_EMBEDDING_FACE_COUNT_ZERO', 'output embedding face_count is zero')
  }

  const outVec = outEmbed.embedding
  if (
    !Array.isArray(outVec) ||
    outVec.length === 0 ||
    outVec.length > MAX_IDENTITY_EMBEDDING_DIMENSIONS
  ) {
    return fail('IDENTITY_OUTPUT_EMBEDDING_VECTOR_INVALID', 'output embedding length invalid')
  }
  for (let i = 0; i < outVec.length; i++) {
    const n = outVec[i]
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      return fail('IDENTITY_OUTPUT_EMBEDDING_VECTOR_INVALID', `non-finite at index ${i}`)
    }
  }
  if (vectorL2Squared(outVec) < 1e-12) {
    return fail('IDENTITY_OUTPUT_EMBEDDING_ZERO_VECTOR', 'output embedding is a zero vector')
  }

  if (outVec.length !== referenceEmbedding.length) {
    return fail(
      'IDENTITY_EMBEDDING_DIMENSION_MISMATCH',
      `reference dim ${referenceEmbedding.length} vs output dim ${outVec.length}`
    )
  }

  const outputModelVersion = outEmbed.model_version.trim()
  if (referenceModelVersion !== outputModelVersion) {
    /**
     * No repo contract or docs require matching model_version for cosine; we warn and continue.
     * If a future service contract adds a hard requirement, gate that here before cosine.
     */
    await safeAddRenderChunkIdentityScoreJobEvent({
      job_id: jobId,
      level: 'warn',
      step: 'identity_embedding_model_version_warning',
      message: 'Reference and output embedding model_version differ; proceeding with cosine per current policy',
      payload: {
        reference_model_version: referenceModelVersion,
        output_model_version: outputModelVersion,
        action: 'proceed_cosine',
        reason: 'no_contract_requiring_model_version_match_in_repo',
      },
    })
  }

  let rawCosine: number
  try {
    rawCosine = cosineSimilarityOrThrow(referenceEmbedding, outVec)
  } catch (e) {
    return fail('IDENTITY_COSINE_SIMILARITY_FAILED', getErrorMessage(e))
  }

  let score01 = (rawCosine + 1) / 2
  score01 = Math.max(0, Math.min(1, score01))
  if (!Number.isFinite(score01)) {
    return fail('IDENTITY_COSINE_NORMALIZED_NON_FINITE', 'normalized cosine score is not finite')
  }

  return {
    ok: true,
    score01,
    rawCosine,
    referenceModelVersion,
    outputModelVersion,
    identityProfileId: profileId,
    embeddingDimensions: referenceEmbedding.length,
    referenceAssetId: refAssetId,
    referenceSource: 'identity_profile',
  }
}

async function calculateBasicRenderChunkIdentityScore(params: {
  jobId: string
  projectId: string
  chunkId: string
  outputPath: string
  renderInput: Record<string, unknown>
}): Promise<BasicRenderChunkIdentityScoreResult> {
  const { jobId, projectId, chunkId, outputPath, renderInput } = params
  void jobId
  let referenceAssetId: string | null = null
  let referenceSource: 'identity_profile' | 'fallback' | null = null

  try {
    const expectedRefPrefix = `projects/${projectId}/references/`
    const expectedOutPrefix = `projects/${projectId}/chunks/${chunkId}/`

    const ipRaw = renderInput.identity_profile_id
    const refRaw = renderInput.reference_asset_id
    const ipStr = ipRaw != null && String(ipRaw).trim() !== '' ? String(ipRaw).trim() : ''
    const refStr = refRaw != null && String(refRaw).trim() !== '' ? String(refRaw).trim() : ''
    if (ipStr && isValidUuid(ipStr) && refStr && isValidUuid(refStr)) {
      referenceAssetId = refStr
      referenceSource = 'identity_profile'
    } else {
      const fb = await supabaseServer
        .from('source_assets')
        .select('id')
        .eq('project_id', projectId)
        .eq('asset_type', 'reference')
        .or('validation_status.eq.validated,asset_status.eq.validated,asset_status.eq.active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (fb.error) {
        return {
          score: null,
          referenceAssetId: null,
          referenceSource: null,
          reasonCode: 'REFERENCE_ASSET_NOT_AVAILABLE',
          errorMessage: fb.error.message,
        }
      }
      if (!fb.data?.id) {
        return {
          score: null,
          referenceAssetId: null,
          referenceSource: null,
          reasonCode: 'REFERENCE_ASSET_NOT_AVAILABLE',
        }
      }
      referenceAssetId = String(fb.data.id)
      referenceSource = 'fallback'
    }

    const { row: refRow, error: refErr } = await fetchSourceAssetMetaRow(referenceAssetId)
    if (refErr || !refRow) {
      return {
        score: null,
        referenceAssetId,
        referenceSource,
        reasonCode: 'REFERENCE_ASSET_NOT_AVAILABLE',
        errorMessage: refErr ?? undefined,
      }
    }

    const assetKey = refRow.asset_key == null ? '' : String(refRow.asset_key).trim()
    if (!assetKey || !assetKey.startsWith(expectedRefPrefix)) {
      return {
        score: null,
        referenceAssetId,
        referenceSource,
        reasonCode: 'REFERENCE_ASSET_KEY_UNSUPPORTED',
      }
    }

    const outTrim = typeof outputPath === 'string' ? outputPath.trim() : ''
    if (
      !outTrim ||
      !outTrim.startsWith(expectedOutPrefix) ||
      !outTrim.endsWith('render.webp')
    ) {
      return {
        score: null,
        referenceAssetId,
        referenceSource,
        reasonCode: 'RENDER_OUTPUT_KEY_UNSUPPORTED',
      }
    }

    const refDl = await supabaseServer.storage.from('project-media').download(assetKey)
    if (refDl.error || !refDl.data) {
      return {
        score: null,
        referenceAssetId,
        referenceSource,
        reasonCode: 'IDENTITY_SCORE_ASSET_DOWNLOAD_FAILED',
        errorMessage: refDl.error?.message ?? 'NO_FILE_DATA',
      }
    }

    const outDl = await supabaseServer.storage.from('project-media').download(outTrim)
    if (outDl.error || !outDl.data) {
      return {
        score: null,
        referenceAssetId,
        referenceSource,
        reasonCode: 'IDENTITY_SCORE_ASSET_DOWNLOAD_FAILED',
        errorMessage: outDl.error?.message ?? 'NO_FILE_DATA',
      }
    }

    const refBuf = Buffer.from(await refDl.data.arrayBuffer())
    const outBuf = Buffer.from(await outDl.data.arrayBuffer())

    const toRgb128 = async (buf: Buffer): Promise<Buffer> => {
      const { data, info } = await sharp(buf)
        .resize(128, 128, { fit: 'cover' })
        .flatten({ background: { r: 0, g: 0, b: 0 } })
        .raw()
        .toBuffer({ resolveWithObject: true })
      const w = info.width ?? 128
      const h = info.height ?? 128
      const ch = info.channels ?? 0
      if (ch === 3) return data
      if (ch === 4) {
        const px = w * h
        const out = Buffer.alloc(px * 3)
        for (let p = 0; p < px; p++) {
          const j = p * 4
          const i = p * 3
          out[i] = data[j] ?? 0
          out[i + 1] = data[j + 1] ?? 0
          out[i + 2] = data[j + 2] ?? 0
        }
        return out
      }
      throw new Error(`unexpected_channel_count:${ch}`)
    }

    const refP = await toRgb128(refBuf)
    const outP = await toRgb128(outBuf)
    if (refP.length !== outP.length || refP.length === 0) {
      return {
        score: null,
        referenceAssetId,
        referenceSource,
        reasonCode: 'IDENTITY_SCORE_CALCULATION_FAILED',
        errorMessage: 'pixel_buffer_length_mismatch',
      }
    }

    let sumAbs = 0
    for (let i = 0; i < refP.length; i++) {
      sumAbs += Math.abs((refP[i] ?? 0) - (outP[i] ?? 0))
    }
    const meanAbs = sumAbs / refP.length
    const diff = meanAbs / 255
    let score = 1 - diff
    score = Math.max(0, Math.min(1, score))
    if (!Number.isFinite(score)) {
      return {
        score: null,
        referenceAssetId,
        referenceSource,
        reasonCode: 'IDENTITY_SCORE_CALCULATION_FAILED',
        errorMessage: 'non_finite_score',
      }
    }

    return {
      score,
      referenceAssetId,
      referenceSource,
    }
  } catch (err) {
    return {
      score: null,
      referenceAssetId,
      referenceSource,
      reasonCode: 'IDENTITY_SCORE_CALCULATION_FAILED',
      errorMessage: String((err as { message?: unknown })?.message ?? err),
    }
  }
}

async function safeAddRenderChunkIdentityScoreJobEvent(params: {
  job_id: string
  level: string
  step: string
  message: string
  payload?: Record<string, unknown>
}): Promise<void> {
  try {
    await addJobEvent({
      job_id: params.job_id,
      level: params.level,
      step: params.step,
      message: params.message,
      payload: params.payload,
    })
  } catch (e) {
    console.warn(`${params.step} job_events insert failed`, getErrorMessage(e))
  }
}

type ChunkIdentityGateDecision = 'passed' | 'rerender_required' | 'blocked'

/** Observability-only summary for auto rerender job_events; does not drive decisions. */
type RenderChunkGateRecordSummary = {
  persisted: boolean
  decision: ChunkIdentityGateDecision | null
  reason_code: string | null
  fallback_used: boolean
  fallback_from: string | null
  fallback_to: string | null
}

const EMPTY_RENDER_CHUNK_GATE_RECORD_SUMMARY: RenderChunkGateRecordSummary = {
  persisted: false,
  decision: null,
  reason_code: null,
  fallback_used: false,
  fallback_from: null,
  fallback_to: null,
}

function isStrictFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function looksLikeDecisionCheckConstraintError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('check') ||
    m.includes('violates check') ||
    m.includes('invalid input value for enum') ||
    (m.includes('gate_evaluations') && m.includes('decision'))
  )
}

async function recordRenderChunkQualityGateEvaluation(params: {
  jobId: string
  projectId: string
  chunkId: string
  identityScoreRaw: unknown
  measuredIdentityScoreOverride?: number | null
  /** When set, included on render_chunk_identity_gate_decision job_events payload. */
  scoreSource?: 'embedding' | 'pixel_fallback' | 'unavailable' | null
}): Promise<RenderChunkGateRecordSummary> {
  const { jobId, projectId, chunkId, identityScoreRaw, measuredIdentityScoreOverride, scoreSource } =
    params
  const basePayload = {
    project_id: projectId,
    chunk_id: chunkId,
    gate_type: 'identity' as const,
    scope_type: 'chunk' as const,
  }
  try {
    const dupDecision = await supabaseServer
      .from('job_events')
      .select('id')
      .eq('job_id', jobId)
      .eq('step', 'render_chunk_identity_gate_decision')
      .limit(1)
      .maybeSingle()

    if (!dupDecision.error && dupDecision.data?.id != null && String(dupDecision.data.id).trim() !== '') {
      await safeAddRenderChunkGateJobEvent({
        job_id: jobId,
        level: 'info',
        step: 'render_chunk_identity_gate_duplicate_skipped',
        message: 'Chunk identity gate decision already recorded for this job',
        payload: {
          ...basePayload,
          job_id: jobId,
          chunk_id: chunkId,
        },
      })
      return { ...EMPTY_RENDER_CHUNK_GATE_RECORD_SUMMARY }
    }

    const jobRowRes = await supabaseServer
      .from('jobs')
      .select('started_at, created_at, updated_at')
      .eq('id', jobId)
      .maybeSingle()

    const latestGate = await supabaseServer
      .from('gate_evaluations')
      .select('id, created_at')
      .eq('project_id', projectId)
      .eq('chunk_id', chunkId)
      .eq('gate_type', 'identity')
      .eq('scope_type', 'chunk')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (latestGate.error) {
      console.warn('recordRenderChunkQualityGateEvaluation latest gate read failed', latestGate.error.message)
      await safeAddRenderChunkGateJobEvent({
        job_id: jobId,
        level: 'warn',
        step: 'render_chunk_quality_gate_record_failed',
        message: 'Latest gate_evaluations row read failed',
        payload: {
          ...basePayload,
          error_message: latestGate.error.message,
        },
      })
      return { ...EMPTY_RENDER_CHUNK_GATE_RECORD_SUMMARY }
    }

    const jobStartedIso =
      jobRowRes.data?.started_at != null && String(jobRowRes.data.started_at).trim() !== ''
        ? String(jobRowRes.data.started_at)
        : jobRowRes.data?.created_at != null && String(jobRowRes.data.created_at).trim() !== ''
          ? String(jobRowRes.data.created_at)
          : null

    const latestCreated =
      latestGate.data?.created_at != null ? String(latestGate.data.created_at) : null
    const latestId =
      latestGate.data?.id != null && String(latestGate.data.id).trim() !== ''
        ? String(latestGate.data.id)
        : null

    if (
      jobStartedIso &&
      latestCreated &&
      latestId &&
      Date.parse(latestCreated) > Date.parse(jobStartedIso)
    ) {
      await safeAddRenderChunkGateJobEvent({
        job_id: jobId,
        level: 'info',
        step: 'render_chunk_identity_gate_stale_update_skipped',
        message: 'Skipping gate_evaluations insert: newer evaluation exists relative to job start',
        payload: {
          ...basePayload,
          existing_gate_evaluation_id: latestId,
          job_id: jobId,
          reason: 'stale_job_result',
          job_started_at: jobStartedIso,
          existing_gate_created_at: latestCreated,
        },
      })
      return { ...EMPTY_RENDER_CHUNK_GATE_RECORD_SUMMARY }
    }

    const measuredRaw = resolveMeasuredIdentityScoreForGate({
      measuredIdentityScoreOverride,
      identityScoreRaw,
    })
    const measuredFinite = isStrictFiniteNumber(measuredRaw) ? measuredRaw : null

    const gateCfg = await supabaseServer
      .from('quality_gates')
      .select('threshold')
      .eq('project_id', projectId)
      .eq('gate_type', 'identity')
      .eq('scope_type', 'chunk')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (gateCfg.error || !gateCfg.data) {
      await safeAddRenderChunkGateJobEvent({
        job_id: jobId,
        level: 'info',
        step: 'render_chunk_quality_gate_skipped',
        message: gateCfg.error
          ? 'Chunk identity quality gate config read failed'
          : 'Chunk identity quality gate not configured',
        payload: {
          ...basePayload,
          reason_code: 'RENDER_CHUNK_IDENTITY_GATE_NOT_CONFIGURED',
          ...(gateCfg.error ? { error_message: gateCfg.error.message } : {}),
        },
      })
      return { ...EMPTY_RENDER_CHUNK_GATE_RECORD_SUMMARY }
    }

    const rawThreshold = gateCfg.data.threshold
    const thresholdParsed = parseQualityGateThresholdForGate(rawThreshold)
    const thresholdFinite = isStrictFiniteNumber(thresholdParsed) ? thresholdParsed : null

    let decision: ChunkIdentityGateDecision
    let reasonCode: string
    let measuredForRow: number | null = measuredFinite
    let thresholdForRow: number | null = thresholdFinite

    if (measuredFinite === null) {
      decision = 'blocked'
      reasonCode = 'IDENTITY_SCORE_UNAVAILABLE'
      measuredForRow = null
      await safeAddRenderChunkGateJobEvent({
        job_id: jobId,
        level: 'info',
        step: 'render_chunk_identity_gate_measured_invalid',
        message: 'Measured identity score is not a finite number',
        payload: {
          ...basePayload,
          measured_raw: measuredRaw,
        },
      })
    } else if (thresholdFinite === null) {
      decision = 'blocked'
      reasonCode = 'IDENTITY_GATE_THRESHOLD_INVALID'
      thresholdForRow = null
      await safeAddRenderChunkGateJobEvent({
        job_id: jobId,
        level: 'info',
        step: 'render_chunk_identity_gate_threshold_invalid',
        message: 'quality_gates.threshold is not a finite number',
        payload: {
          ...basePayload,
          raw_threshold: rawThreshold,
        },
      })
    } else if (measuredFinite >= thresholdFinite) {
      decision = 'passed'
      reasonCode = 'IDENTITY_GATE_PASSED'
    } else {
      decision = 'rerender_required'
      reasonCode = 'IDENTITY_SCORE_BELOW_THRESHOLD'
    }

    const insertGate = async (
      d: ChunkIdentityGateDecision,
      rc: string
    ): Promise<{ error: { message: string } | null }> => {
      const ins = await supabaseServer.from('gate_evaluations').insert({
        project_id: projectId,
        scope_type: 'chunk' as const,
        chunk_id: chunkId,
        gate_type: 'identity' as const,
        measured_value: measuredForRow,
        threshold: thresholdForRow,
        decision: d,
        reason_code: rc,
      })
      return { error: ins.error }
    }

    const tryPersistWithFallback = async (
      primary: ChunkIdentityGateDecision,
      rc: string
    ): Promise<{ ok: true; finalDecision: ChunkIdentityGateDecision; finalReason: string } | { ok: false; message: string }> => {
      let res = await insertGate(primary, rc)
      if (!res.error) {
        return { ok: true, finalDecision: primary, finalReason: rc }
      }
      const errMsg = res.error.message
      if (
        primary === 'rerender_required' &&
        looksLikeDecisionCheckConstraintError(errMsg)
      ) {
        await safeAddRenderChunkGateJobEvent({
          job_id: jobId,
          level: 'warn',
          step: 'render_chunk_identity_gate_decision_fallback',
          message: errMsg,
          payload: {
            ...basePayload,
            original_decision: 'rerender_required',
            fallback_decision: 'blocked',
            original_reason_code: 'IDENTITY_SCORE_BELOW_THRESHOLD',
            fallback_reason_code: 'IDENTITY_GATE_DECISION_FALLBACK_BLOCKED',
            error_message: errMsg,
            persisted_gate_decision_may_differ: true,
            gate_decision_source: 'score_threshold_runtime',
            rerender_execution_basis: 'runtime_score_threshold',
            gate_fallback_used: true,
            gate_fallback_from: 'rerender_required',
            gate_fallback_to: 'blocked',
          },
        })
        res = await insertGate('blocked', 'IDENTITY_GATE_DECISION_FALLBACK_BLOCKED')
        if (!res.error) {
          return { ok: true, finalDecision: 'blocked', finalReason: 'IDENTITY_GATE_DECISION_FALLBACK_BLOCKED' }
        }
        return { ok: false, message: res.error.message }
      }

      if (primary === 'passed') {
        await safeAddRenderChunkGateJobEvent({
          job_id: jobId,
          level: 'warn',
          step: 'render_chunk_identity_gate_passed_persist_failed',
          message: errMsg,
          payload: {
            ...basePayload,
            decision: 'passed',
            reason_code: 'IDENTITY_GATE_PASSED',
            error_message: errMsg,
          },
        })
        return { ok: false, message: errMsg }
      }

      return { ok: false, message: errMsg }
    }

    const persisted = await tryPersistWithFallback(decision, reasonCode)
    if (!persisted.ok) {
      console.warn('recordRenderChunkQualityGateEvaluation insert failed', persisted.message)
      if (decision !== 'passed') {
        await safeAddRenderChunkGateJobEvent({
          job_id: jobId,
          level: 'warn',
          step: 'render_chunk_quality_gate_record_failed',
          message: persisted.message,
          payload: {
            ...basePayload,
            measured_value: measuredForRow,
            threshold: thresholdForRow,
            attempted_decision: decision,
            error_message: persisted.message,
          },
        })
      }
      return { ...EMPTY_RENDER_CHUNK_GATE_RECORD_SUMMARY }
    }

    const decisionPayload: Record<string, unknown> = {
      ...basePayload,
      measured_value: measuredForRow,
      threshold: thresholdForRow,
      decision: persisted.finalDecision,
      reason_code: persisted.finalReason,
    }
    if (scoreSource != null && scoreSource !== undefined) {
      decisionPayload.score_source = scoreSource
    }

    await safeAddRenderChunkGateJobEvent({
      job_id: jobId,
      level: 'info',
      step: 'render_chunk_identity_gate_decision',
      message: 'Chunk identity gate decision computed',
      payload: decisionPayload,
    })

    await safeAddRenderChunkGateJobEvent({
      job_id: jobId,
      level: 'info',
      step: 'render_chunk_identity_gate_latest_recorded',
      message: 'gate_evaluations row inserted (no repo-local unique DDL; duplicate rows possible over time)',
      payload: {
        ...basePayload,
        duplicate_possible: true,
        decision: persisted.finalDecision,
        reason_code: persisted.finalReason,
      },
    })

    await safeAddRenderChunkGateJobEvent({
      job_id: jobId,
      level: 'info',
      step: 'render_chunk_quality_gate_recorded',
      message: 'Chunk identity quality gate evaluation recorded',
      payload: {
        ...basePayload,
        measured_value: measuredForRow,
        threshold: thresholdForRow,
        decision: persisted.finalDecision,
        reason_code: persisted.finalReason,
      },
    })

    const fallbackUsed =
      decision === 'rerender_required' && persisted.finalDecision === 'blocked'

    return {
      persisted: true,
      decision: persisted.finalDecision,
      reason_code: persisted.finalReason,
      fallback_used: fallbackUsed,
      fallback_from: fallbackUsed ? 'rerender_required' : null,
      fallback_to: fallbackUsed ? 'blocked' : null,
    }
  } catch (e) {
    console.warn('recordRenderChunkQualityGateEvaluation unexpected', getErrorMessage(e))
    return { ...EMPTY_RENDER_CHUNK_GATE_RECORD_SUMMARY }
  }
}

function buildAutoRerenderGateObservabilityPayload(params: {
  gateRecordSummary: RenderChunkGateRecordSummary | null | undefined
  normalizedScore: number | null
  threshold: number | null
  scoreSource?: 'embedding' | 'pixel_fallback' | 'unavailable' | null
}): Record<string, unknown> {
  const s = params.gateRecordSummary
  const gate_evaluation_persisted = Boolean(s?.persisted)
  const persisted_gate_decision: ChunkIdentityGateDecision | null =
    s != null && s.persisted && s.decision != null ? s.decision : null
  const gate_fallback_used = Boolean(s?.fallback_used)
  const gate_fallback_from = s?.fallback_from ?? null
  const gate_fallback_to = s?.fallback_to ?? null
  const persisted_gate_decision_may_differ =
    !gate_evaluation_persisted || gate_fallback_used

  const out: Record<string, unknown> = {
    normalized_score: params.normalizedScore,
    threshold: params.threshold,
    gate_decision_source: 'score_threshold_runtime',
    rerender_execution_basis: 'runtime_score_threshold',
    persisted_gate_decision,
    gate_evaluation_persisted,
    persisted_gate_decision_may_differ,
    gate_fallback_used,
    gate_fallback_from,
    gate_fallback_to,
  }
  if (params.scoreSource != null && params.scoreSource !== undefined) {
    out.score_source = params.scoreSource
  }
  return out
}

async function evaluateAutoRerenderAfterRenderChunk(params: {
  jobId: string
  projectId: string
  sequenceId: string
  chunkId: string
  normalizedScore: number | null
  identityAttemptCountRaw: unknown
  gateRecordSummary?: RenderChunkGateRecordSummary | null
  scoreSource?: 'embedding' | 'pixel_fallback' | 'unavailable' | null
}): Promise<void> {
  const {
    jobId,
    projectId,
    sequenceId,
    chunkId,
    normalizedScore,
    identityAttemptCountRaw,
    gateRecordSummary,
    scoreSource,
  } = params
  const base = { project_id: projectId, chunk_id: chunkId }

  const gateObs = (threshold: number | null) =>
    buildAutoRerenderGateObservabilityPayload({
      gateRecordSummary,
      normalizedScore,
      threshold,
      scoreSource,
    })

  const currentAttempt = parseIdentityAttemptCount(identityAttemptCountRaw)

  const identityScore =
    normalizedScore !== null && Number.isFinite(normalizedScore) ? normalizedScore : null

  if (identityScore === null) {
    await safeAddAutoRerenderJobEvent({
      job_id: jobId,
      level: 'info',
      step: 'auto_rerender_skipped',
      message: 'Auto rerender skipped: identity score not available',
      payload: {
        ...base,
        ...gateObs(null),
        reason_code: 'AUTO_RERENDER_IDENTITY_SCORE_NOT_AVAILABLE',
      },
    })
    return
  }

  const gateCfg = await supabaseServer
    .from('quality_gates')
    .select('threshold')
    .eq('project_id', projectId)
    .eq('gate_type', 'identity')
    .eq('scope_type', 'chunk')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const rawThreshold = gateCfg.data?.threshold
  if (gateCfg.error || !gateCfg.data) {
    await safeAddAutoRerenderJobEvent({
      job_id: jobId,
      level: 'info',
      step: 'auto_rerender_skipped',
      message: 'Auto rerender skipped: quality gate threshold not available',
      payload: {
        ...base,
        ...gateObs(null),
        identity_score: identityScore,
        raw_threshold: rawThreshold ?? null,
        reason_code: 'AUTO_RERENDER_THRESHOLD_NOT_AVAILABLE',
      },
    })
    return
  }

  const thresholdNum = parseQualityGateThresholdForGate(rawThreshold)
  if (thresholdNum === null || Number.isNaN(thresholdNum)) {
    await safeAddAutoRerenderJobEvent({
      job_id: jobId,
      level: 'info',
      step: 'auto_rerender_skipped',
      message: 'Auto rerender skipped: quality gate threshold invalid',
      payload: {
        ...base,
        ...gateObs(null),
        identity_score: identityScore,
        raw_threshold: rawThreshold ?? null,
        reason_code: 'AUTO_RERENDER_THRESHOLD_NOT_AVAILABLE',
      },
    })
    return
  }

  if (identityScore >= thresholdNum) {
    await safeAddAutoRerenderJobEvent({
      job_id: jobId,
      level: 'info',
      step: 'auto_rerender_not_required',
      message: 'Auto rerender not required: identity score meets threshold',
      payload: {
        ...base,
        ...gateObs(thresholdNum),
        identity_score: identityScore,
        threshold: thresholdNum,
        currentAttempt,
        maxAttempt: AUTO_RERENDER_MAX_ATTEMPT,
        reason_code: 'IDENTITY_SCORE_MEETS_THRESHOLD',
      },
    })
    return
  }

  const dupJobs = await supabaseServer
    .from('jobs')
    .select('id')
    .eq('chunk_id', chunkId)
    .eq('job_type', 'render_chunk')
    .in('status', ['queued', 'running'])
    .limit(1)
    .maybeSingle()

  if (dupJobs.error) {
    console.warn('evaluateAutoRerenderAfterRenderChunk dup jobs query failed', dupJobs.error.message)
  } else if (dupJobs.data?.id != null && String(dupJobs.data.id).trim() !== '') {
    await safeAddAutoRerenderJobEvent({
      job_id: jobId,
      level: 'info',
      step: 'auto_rerender_already_running',
      message: 'Auto rerender candidate skipped: render_chunk job already queued or running',
      payload: {
        ...base,
        ...gateObs(thresholdNum),
        existing_job_id: String(dupJobs.data.id),
        identity_score: identityScore,
        threshold: thresholdNum,
        current_attempt: currentAttempt,
        max_attempt: AUTO_RERENDER_MAX_ATTEMPT,
      },
    })
    return
  }

  if (currentAttempt >= AUTO_RERENDER_MAX_ATTEMPT) {
    const failUpd = await supabaseServer
      .from('sequence_chunks')
      .update({ render_status: 'failed' })
      .eq('id', chunkId)
      .eq('render_status', 'rendered')
      .select('id')

    if (failUpd.error) {
      console.warn('evaluateAutoRerenderAfterRenderChunk failed status update error', failUpd.error.message)
    }
    const rows = failUpd.data
    if (!failUpd.error && Array.isArray(rows) && rows.length > 0) {
      await safeAddAutoRerenderJobEvent({
        job_id: jobId,
        level: 'info',
        step: 'auto_rerender_max_attempt_reached',
        message: 'Auto rerender max attempt reached; chunk marked failed',
        payload: {
          ...base,
          ...gateObs(thresholdNum),
          currentAttempt,
          maxAttempt: AUTO_RERENDER_MAX_ATTEMPT,
          identity_score: identityScore,
          threshold: thresholdNum,
          reason_code: 'AUTO_RERENDER_MAX_ATTEMPT_REACHED',
        },
      })
    } else {
      await safeAddAutoRerenderJobEvent({
        job_id: jobId,
        level: 'info',
        step: 'auto_rerender_state_update_skipped',
        message: 'Auto rerender failed status update skipped: chunk state changed',
        payload: {
          ...base,
          ...gateObs(thresholdNum),
          currentAttempt,
          maxAttempt: AUTO_RERENDER_MAX_ATTEMPT,
          identity_score: identityScore,
          threshold: thresholdNum,
          reason_code: 'AUTO_RERENDER_STATE_CHANGED',
        },
      })
    }
    return
  }

  const pendUpd = await supabaseServer
    .from('sequence_chunks')
    .update({ render_status: 'rerender_pending' })
    .eq('id', chunkId)
    .eq('render_status', 'rendered')
    .select('id')

  if (pendUpd.error) {
    console.warn(
      'evaluateAutoRerenderAfterRenderChunk rerender_pending update error',
      pendUpd.error.message
    )
  }
  const pendRows = pendUpd.data
  if (!pendUpd.error && Array.isArray(pendRows) && pendRows.length > 0) {
    await safeAddAutoRerenderJobEvent({
      job_id: jobId,
      level: 'info',
      step: 'auto_rerender_required',
      message: 'Auto rerender required: chunk marked rerender_pending',
      payload: {
        ...base,
        ...gateObs(thresholdNum),
        currentAttempt,
        maxAttempt: AUTO_RERENDER_MAX_ATTEMPT,
        identity_score: identityScore,
        threshold: thresholdNum,
        reason_code: 'IDENTITY_SCORE_BELOW_THRESHOLD',
      },
    })

    const enqueueResult = await enqueueRenderChunkRerenderJob({
      supabase: supabaseServer,
      jobQueue,
      projectId,
      chunkId,
      sequenceId,
      reason: 'auto_rerender',
    })

    if (!enqueueResult.ok) {
      const enqueueErrMsg = enqueueResult.message
      await safeAddAutoRerenderJobEvent({
        job_id: jobId,
        level: 'warn',
        step: 'auto_rerender_enqueue_failed',
        message: `Auto rerender enqueue failed: ${enqueueErrMsg}`,
        payload: {
          ...base,
          ...gateObs(thresholdNum),
          code: enqueueResult.code,
          identity_score: identityScore,
          threshold: thresholdNum,
          sequence_id: sequenceId,
        },
      })

      const recoveryUpd = await supabaseServer
        .from('sequence_chunks')
        .update({ render_status: 'rendered' })
        .eq('id', chunkId)
        .eq('render_status', 'rerender_pending')
        .select('id')

      if (recoveryUpd.error) {
        await safeAddAutoRerenderJobEvent({
          job_id: jobId,
          level: 'warn',
          step: 'auto_rerender_enqueue_recovery_failed',
          message: recoveryUpd.error.message,
          payload: {
            ...base,
            ...gateObs(thresholdNum),
            enqueue_error: enqueueErrMsg,
            recovery_error: recoveryUpd.error.message,
          },
        })
      } else if (!Array.isArray(recoveryUpd.data) || recoveryUpd.data.length === 0) {
        await safeAddAutoRerenderJobEvent({
          job_id: jobId,
          level: 'info',
          step: 'auto_rerender_enqueue_recovery_skipped',
          message: 'Enqueue recovery skipped: chunk is not rerender_pending',
          payload: {
            ...base,
            ...gateObs(thresholdNum),
            reason: 'chunk_not_rerender_pending',
            enqueue_error: enqueueErrMsg,
          },
        })
      } else {
        await safeAddAutoRerenderJobEvent({
          job_id: jobId,
          level: 'info',
          step: 'auto_rerender_enqueue_recovered',
          message: 'Rerender enqueue failed; chunk render_status restored to rendered',
          payload: {
            ...base,
            ...gateObs(thresholdNum),
            from_status: 'rerender_pending',
            to_status: 'rendered',
            reason: 'enqueue_failed',
            enqueue_error: enqueueErrMsg,
          },
        })
      }
    } else {
      await safeAddAutoRerenderJobEvent({
        job_id: jobId,
        level: 'info',
        step: 'auto_rerender_enqueued',
        message: 'Auto rerender: render_chunk job enqueued',
        payload: {
          ...base,
          ...gateObs(thresholdNum),
          new_job_id: enqueueResult.jobId,
          identity_score: identityScore,
          threshold: thresholdNum,
          sequence_id: sequenceId,
        },
      })
    }
  } else {
    await safeAddAutoRerenderJobEvent({
      job_id: jobId,
      level: 'info',
      step: 'auto_rerender_state_update_skipped',
      message: 'Auto rerender rerender_pending update skipped: chunk state changed',
      payload: {
        ...base,
        ...gateObs(thresholdNum),
        currentAttempt,
        maxAttempt: AUTO_RERENDER_MAX_ATTEMPT,
        identity_score: identityScore,
        threshold: thresholdNum,
        reason_code: 'AUTO_RERENDER_STATE_CHANGED',
      },
    })
  }
}

async function resolveRenderInputContract(params: {
  jobId: string
  projectId: string
  chunkId: string
  chunk: {
    id: string
    scene_id: string
    chunk_index: number | string | null
    identity_score?: number | string | null
    style_score?: number | string | null
  }
  scene: {
    id: string
    sequence_id: string
    scene_index: number | string | null
    difficulty_level?: string | null
  }
  sequence: {
    id: string
    project_id: string
    source_asset_id?: string | null
    duration_sec?: number | string | null
    fps?: number | string | null
    width?: number | string | null
    height?: number | string | null
  }
}): Promise<Record<string, unknown>> {
  const { jobId, projectId, chunkId, chunk, scene, sequence } = params
  const sceneId = String(chunk.scene_id)
  const sequenceId = String(sequence.id)
  const rawIdx = chunk.chunk_index
  const chunkIndexNum =
    typeof rawIdx === 'number'
      ? rawIdx
      : typeof rawIdx === 'string'
        ? Number(rawIdx)
        : NaN
  const chunkIndexSafe = Number.isFinite(chunkIndexNum) ? chunkIndexNum : 0

  const parseNum = (v: unknown): number | null => {
    if (v == null) return null
    if (typeof v === 'number' && Number.isFinite(v)) return v
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  let identity_profile_id: string | null = null
  let identity_error: string | null = null
  let identity_meta: Record<string, unknown> = {
    identity_status: null,
    build_score: null,
    embedding_key_present: false,
    latent_base_key_present: false,
    anchor_manifest_key_present: false,
  }

  let reference_asset_id: string | null = null
  let reference_asset_error: string | null = null
  let reference_asset_meta: Record<string, unknown> = emptyAssetMetaForRenderInput()

  let source_asset_error: string | null = null
  let source_asset_meta: Record<string, unknown> = emptyAssetMetaForRenderInput()

  let prev_chunk_id: string | null = null
  let prev_chunk_error: string | null = null
  let prev_chunk_meta: Record<string, unknown> = emptyPrevChunkMetaForRenderInput()
  let stateInKey: string | null = null
  let prevStateOutKey: string | null = null
  let prevChunkRenderStatus: string | null = null
  let stateInKeyUpdateError: string | null = null
  let prevStateOutConsistencyChecked = false
  let prevStateOutConsistencyPassed = false
  let prevStateOutConsistencyFailureReason: string | null = null

  const projRow = await supabaseServer
    .from('projects')
    .select('active_identity_profile_id')
    .eq('id', projectId)
    .maybeSingle()

  let profileRefId: string | null = null

  if (projRow.error) {
    identity_error = projRow.error.message
  } else {
    const aidRaw = projRow.data?.active_identity_profile_id
    const aidStr = aidRaw != null && aidRaw !== '' ? String(aidRaw).trim() : ''
    if (aidStr && isValidUuid(aidStr)) {
      identity_profile_id = aidStr
      const ip = await supabaseServer
        .from('identity_profiles')
        .select(
          'id, reference_asset_id, embedding_key, latent_base_key, anchor_manifest_key, identity_status, build_score'
        )
        .eq('id', aidStr)
        .maybeSingle()
      if (ip.error) {
        identity_error = ip.error.message
      } else if (!ip.data) {
        identity_error = 'IDENTITY_PROFILE_NOT_FOUND'
      } else {
        const d = ip.data as Record<string, unknown>
        const bs = parseNum(d.build_score)
        identity_meta = {
          identity_status:
            d.identity_status != null && String(d.identity_status).trim() !== ''
              ? String(d.identity_status)
              : null,
          build_score: bs,
          embedding_key_present: secretKeyPresent(
            d.embedding_key != null ? String(d.embedding_key) : undefined
          ),
          latent_base_key_present: secretKeyPresent(
            d.latent_base_key != null ? String(d.latent_base_key) : undefined
          ),
          anchor_manifest_key_present: secretKeyPresent(
            d.anchor_manifest_key != null ? String(d.anchor_manifest_key) : undefined
          ),
        }
        const r = d.reference_asset_id
        const rs = r != null && r !== '' ? String(r).trim() : ''
        if (rs && isValidUuid(rs)) profileRefId = rs
      }
    }
  }

  if (profileRefId) {
    reference_asset_id = profileRefId
  } else {
    const fb = await supabaseServer
      .from('source_assets')
      .select('id')
      .eq('project_id', projectId)
      .eq('asset_type', 'reference')
      .or('validation_status.eq.validated,asset_status.eq.validated,asset_status.eq.active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (fb.error) {
      reference_asset_error = fb.error.message
    } else if (fb.data?.id) {
      reference_asset_id = String(fb.data.id)
    }
  }

  if (reference_asset_id) {
    const { row, error } = await fetchSourceAssetMetaRow(reference_asset_id)
    const built = buildAssetMetaForRenderInput(row, error)
    reference_asset_meta = built.meta
    if (built.err) reference_asset_error = built.err
  }

  const srcRaw = sequence.source_asset_id
  const srcStr = srcRaw != null && srcRaw !== '' ? String(srcRaw).trim() : ''
  const resolvedSourceAssetId = srcStr && isValidUuid(srcStr) ? srcStr : null

  if (resolvedSourceAssetId) {
    const { row, error } = await fetchSourceAssetMetaRow(resolvedSourceAssetId)
    const built = buildAssetMetaForRenderInput(row, error)
    source_asset_meta = built.meta
    source_asset_error = built.err
  }

  if (chunkIndexSafe > 0) {
    const prev = await supabaseServer
      .from('sequence_chunks')
      .select(
        'id, chunk_index, render_status, output_asset_key, identity_score, style_score, state_out_key'
      )
      .eq('scene_id', sceneId)
      .eq('chunk_index', chunkIndexSafe - 1)
      .maybeSingle()
    if (prev.error) {
      prev_chunk_error = prev.error.message
    } else if (prev.data?.id) {
      const pd = prev.data as Record<string, unknown>
      prev_chunk_id = String(pd.id)
      const oak = pd.output_asset_key != null ? String(pd.output_asset_key) : ''
      const rsRaw = pd.render_status != null ? String(pd.render_status).trim() : ''
      prevChunkRenderStatus = rsRaw !== '' ? rsRaw : null
      prev_chunk_meta = {
        render_status: prevChunkRenderStatus,
        output_asset_key_present: secretKeyPresent(oak),
        output_asset_key_basename: storageKeyBasename(oak || null),
        identity_score: parseNum(pd.identity_score),
        style_score: parseNum(pd.style_score),
      }

      const rawSok = pd.state_out_key != null ? String(pd.state_out_key).trim() : ''
      const expectedPrevKey = expectedRenderChunkStateOutKey(projectId, String(pd.id))
      const allowedPrev = rsRaw === 'rendered' || rsRaw === 'approved'

      if (allowedPrev && rawSok !== '' && rawSok === expectedPrevKey) {
        prevStateOutKey = rawSok
        prevStateOutConsistencyChecked = true
        const seqCur = String(sequenceId).trim()
        if (!seqCur || !isValidUuid(seqCur)) {
          prevStateOutConsistencyFailureReason = 'sequence_mismatch'
          await safeAddRenderChunkStateKeyJobEvent({
            job_id: jobId,
            level: 'warn',
            step: 'prev_state_out_consistency_failed',
            message: 'Current sequence_id is not valid for state-out consistency',
            payload: {
              project_id: projectId,
              chunk_id: chunkId,
              prev_chunk_id: String(pd.id),
              state_out_key: rawSok,
              reason: 'sequence_mismatch',
              sequence_id_current_valid: false,
            },
          })
        } else {
          const ver = await verifyPrevChunkStateOutForSequenceConsistency({
            storageKey: rawSok,
            projectId,
            prevChunkId: String(pd.id),
            sceneId,
            sequenceId: seqCur,
          })
          if (!ver.ok) {
            prevStateOutConsistencyFailureReason = ver.reason
            await safeAddRenderChunkStateKeyJobEvent({
              job_id: jobId,
              level: 'warn',
              step: 'prev_state_out_consistency_failed',
              message: `Previous state-out consistency check failed: ${ver.reason}`,
              payload: {
                project_id: projectId,
                chunk_id: chunkId,
                prev_chunk_id: String(pd.id),
                state_out_key: rawSok,
                reason: ver.reason,
              },
            })
          } else {
            const inUpd = await supabaseServer
              .from('sequence_chunks')
              .update({ state_in_key: rawSok } as Record<string, unknown>)
              .eq('id', chunkId)
              .eq('render_status', 'running')
              .select('id')
            if (inUpd.error) {
              stateInKeyUpdateError = inUpd.error.message
              await safeAddRenderChunkStateKeyJobEvent({
                job_id: jobId,
                level: 'warn',
                step: 'render_chunk_state_in_key_update_failed',
                message: inUpd.error.message,
                payload: {
                  project_id: projectId,
                  chunk_id: chunkId,
                  prev_chunk_id: prev_chunk_id,
                  state_in_key: rawSok,
                  error: inUpd.error.message,
                },
              })
            } else {
              const rows = inUpd.data
              const rowCount = Array.isArray(rows) ? rows.length : 0
              if (rowCount === 0) {
                await safeAddRenderChunkStateKeyJobEvent({
                  job_id: jobId,
                  level: 'info',
                  step: 'render_chunk_state_in_key_update_skipped',
                  message: 'state_in_key update skipped: chunk not in running status',
                  payload: {
                    project_id: projectId,
                    chunk_id: chunkId,
                    reason: 'chunk_not_running',
                  },
                })
              } else {
                stateInKey = rawSok
                prevStateOutConsistencyPassed = true
              }
            }
          }
        }
      } else {
        const ignoreReason =
          allowedPrev && rawSok === ''
            ? 'missing_state_out_key'
            : allowedPrev && rawSok !== '' && rawSok !== expectedPrevKey
              ? 'invalid_state_out_key'
              : 'wrong_render_status'
        await safeAddRenderChunkStateKeyJobEvent({
          job_id: jobId,
          level: 'info',
          step: 'prev_state_out_ignored',
          message: 'Previous chunk state_out_key not applied as state_in_key',
          payload: {
            project_id: projectId,
            chunk_id: chunkId,
            prev_chunk_id: String(pd.id),
            reason: ignoreReason,
            prev_render_status: prevChunkRenderStatus,
          },
        })
      }
    }
  }

  const sceneIndexNum = parseNum(scene.scene_index)
  const diffRaw = scene.difficulty_level
  const difficulty_level =
    diffRaw != null && String(diffRaw).trim() !== '' ? String(diffRaw) : null

  return {
    project_id: projectId,
    sequence_id: sequenceId,
    scene_id: sceneId,
    chunk_id: chunkId,
    chunk_index: chunkIndexSafe,
    source_asset_id: resolvedSourceAssetId,
    reference_asset_id,
    identity_profile_id,
    prev_chunk_id,
    input_manifest_key: null,
    sequence_meta: {
      duration_sec: parseNum(sequence.duration_sec),
      fps: parseNum(sequence.fps),
      width: parseNum(sequence.width),
      height: parseNum(sequence.height),
    },
    scene_meta: {
      scene_index: sceneIndexNum,
      difficulty_level,
    },
    identity_meta,
    source_asset_meta,
    reference_asset_meta,
    prev_chunk_meta,
    identity_error,
    source_asset_error,
    reference_asset_error,
    prev_chunk_error,
    state_in_key: stateInKey,
    prev_state_out_key: prevStateOutKey,
    prev_chunk_render_status: prevChunkRenderStatus,
    prev_state_out_consistency_checked: prevStateOutConsistencyChecked,
    prev_state_out_consistency_passed: prevStateOutConsistencyPassed,
    ...(prevStateOutConsistencyFailureReason != null
      ? { prev_state_out_consistency_failure_reason: prevStateOutConsistencyFailureReason }
      : {}),
    ...(stateInKeyUpdateError != null ? { state_in_key_update_error: stateInKeyUpdateError } : {}),
  }
}

async function handleRenderChunkJob(payload: RenderChunkPayload) {
  const now = new Date().toISOString()
  const jobId = payload.job_id
  const projectId = payload.project_id
  const chunkId = payload.chunk_id

  if (await shouldSkipTerminalJob(jobId, 'render_chunk')) return

  await addJobEvent({
    job_id: jobId,
    level: 'info',
    step: 'render_chunk_received',
    message: 'Render chunk job received',
    payload: { project_id: projectId, chunk_id: chunkId },
  })

  if (!chunkId || !isValidUuid(chunkId)) {
    const finished = new Date().toISOString()
    await updateAnalyzeJobStatus({
      job_id: jobId,
      status: 'failed',
      progress: 10,
      started_at: now,
      finished_at: finished,
      error_code: 'RENDER_CHUNK_INPUT_INVALID',
      error_message: 'chunk_id is missing or invalid',
      output_asset_key: null,
    })
    await markCostFailed(jobId)
    await addJobEvent({
      job_id: jobId,
      level: 'error',
      step: 'render_chunk_input_invalid',
      message: 'chunk_id is missing or invalid',
      payload: { project_id: projectId, chunk_id: chunkId },
    })
    return
  }

  const chunkRow = await supabaseServer
    .from('sequence_chunks')
    .select(
      'id, scene_id, chunk_index, render_status, identity_score, style_score, identity_attempt_count'
    )
    .eq('id', chunkId)
    .maybeSingle()

  if (chunkRow.error || !chunkRow.data?.id || !chunkRow.data.scene_id) {
    const finished = new Date().toISOString()
    await updateAnalyzeJobStatus({
      job_id: jobId,
      status: 'failed',
      progress: 10,
      started_at: now,
      finished_at: finished,
      error_code: 'RENDER_CHUNK_NOT_FOUND',
      error_message: chunkRow.error ? chunkRow.error.message : 'chunk not found',
      output_asset_key: null,
    })
    await markCostFailed(jobId)
    await addJobEvent({
      job_id: jobId,
      level: 'error',
      step: 'render_chunk_not_found',
      message: 'Chunk not found or unreadable',
      payload: { project_id: projectId, chunk_id: chunkId },
    })
    return
  }

  const sceneRow = await supabaseServer
    .from('sequence_scenes')
    .select('id, sequence_id, scene_index, difficulty_level')
    .eq('id', String(chunkRow.data.scene_id))
    .maybeSingle()
  if (sceneRow.error || !sceneRow.data?.sequence_id) {
    const finished = new Date().toISOString()
    await updateAnalyzeJobStatus({
      job_id: jobId,
      status: 'failed',
      progress: 10,
      started_at: now,
      finished_at: finished,
      error_code: 'RENDER_CHUNK_NOT_FOUND',
      error_message: sceneRow.error ? sceneRow.error.message : 'scene not found',
      output_asset_key: null,
    })
    await markCostFailed(jobId)
    await addJobEvent({
      job_id: jobId,
      level: 'error',
      step: 'render_chunk_not_found',
      message: 'Scene for chunk not found or unreadable',
      payload: { project_id: projectId, chunk_id: chunkId },
    })
    return
  }

  const seqRow = await supabaseServer
    .from('sequences')
    .select('id, project_id, source_asset_id, duration_sec, fps, width, height')
    .eq('id', String(sceneRow.data.sequence_id))
    .maybeSingle()
  const resolvedProjectId = String(seqRow.data?.project_id ?? '').trim()
  if (seqRow.error || !resolvedProjectId || resolvedProjectId !== projectId) {
    const finished = new Date().toISOString()
    await updateAnalyzeJobStatus({
      job_id: jobId,
      status: 'failed',
      progress: 10,
      started_at: now,
      finished_at: finished,
      error_code: 'RENDER_CHUNK_NOT_FOUND',
      error_message: seqRow.error
        ? seqRow.error.message
        : !resolvedProjectId
          ? 'sequence not found'
          : 'chunk project mismatch',
      output_asset_key: null,
    })
    await markCostFailed(jobId)
    await addJobEvent({
      job_id: jobId,
      level: 'error',
      step: 'render_chunk_not_found',
      message: 'Sequence not found or project mismatch',
      payload: { project_id: projectId, chunk_id: chunkId, resolved_project_id: resolvedProjectId },
    })
    return
  }

  const transition = await supabaseServer
    .from('sequence_chunks')
    .update({ render_status: 'running' })
    .eq('id', chunkId)
    .eq('render_status', 'queued')
    .select('id')
    .maybeSingle()

  if (transition.error) {
    const finished = new Date().toISOString()
    await updateAnalyzeJobStatus({
      job_id: jobId,
      status: 'failed',
      progress: 10,
      started_at: now,
      finished_at: finished,
      error_code: 'RENDER_CHUNK_STATE_TRANSITION_FAILED',
      error_message: transition.error.message,
      output_asset_key: null,
    })
    await markCostFailed(jobId)
    await addJobEvent({
      job_id: jobId,
      level: 'error',
      step: 'render_chunk_state_transition_failed',
      message: transition.error.message,
      payload: { project_id: projectId, chunk_id: chunkId },
    })
    return
  }

  if (!transition.data?.id) {
    const recheck = await supabaseServer
      .from('sequence_chunks')
      .select('render_status')
      .eq('id', chunkId)
      .maybeSingle()
    const s = String(recheck.data?.render_status ?? '').trim()
    const finished = new Date().toISOString()
    if (s === 'running' || s === 'rendered' || s === 'approved') {
      const step =
        s === 'running'
          ? 'render_chunk_skip_already_running'
          : s === 'rendered'
            ? 'render_chunk_skip_already_rendered'
            : 'render_chunk_skip_already_approved'
      await updateAnalyzeJobStatus({
        job_id: jobId,
        status: 'success',
        progress: 100,
        started_at: now,
        finished_at: finished,
        error_code: null,
        error_message: null,
        output_asset_key: null,
      })
      await markCostSuccess(jobId)
      await addJobEvent({
        job_id: jobId,
        level: 'warn',
        step,
        message: `Chunk already ${s}, skipping`,
        payload: { project_id: projectId, chunk_id: chunkId, render_status: s },
      })
      return
    }

    await updateAnalyzeJobStatus({
      job_id: jobId,
      status: 'failed',
      progress: 10,
      started_at: now,
      finished_at: finished,
      error_code: 'RENDER_CHUNK_STATE_TRANSITION_FAILED',
      error_message: `unexpected_chunk_status:${s || 'unknown'}`,
      output_asset_key: null,
    })
    await markCostFailed(jobId)
    await addJobEvent({
      job_id: jobId,
      level: 'error',
      step: 'render_chunk_state_transition_failed',
      message: 'Chunk status transition failed',
      payload: { project_id: projectId, chunk_id: chunkId, render_status: s || null },
    })
    return
  }

  await updateAnalyzeJobStatus({
    job_id: jobId,
    status: 'running',
    progress: 5,
    started_at: now,
    error_code: null,
    error_message: null,
    output_asset_key: null,
  })
  await markCostRunning(jobId)
  await addJobEvent({
    job_id: jobId,
    level: 'info',
    step: 'render_chunk_started',
    message: 'Render chunk started',
    payload: { project_id: projectId, chunk_id: chunkId },
  })

  const renderInput = await resolveRenderInputContract({
    jobId,
    projectId,
    chunkId,
    chunk: {
      id: String(chunkRow.data.id),
      scene_id: String(chunkRow.data.scene_id),
      chunk_index: chunkRow.data.chunk_index as number | string | null,
      identity_score: chunkRow.data.identity_score as number | string | null | undefined,
      style_score: chunkRow.data.style_score as number | string | null | undefined,
    },
    scene: {
      id: String(sceneRow.data.id),
      sequence_id: String(sceneRow.data.sequence_id),
      scene_index: sceneRow.data.scene_index as number | string | null,
      difficulty_level: sceneRow.data.difficulty_level as string | null | undefined,
    },
    sequence: {
      id: String(seqRow.data!.id),
      project_id: String(seqRow.data!.project_id),
      source_asset_id: seqRow.data!.source_asset_id as string | null | undefined,
      duration_sec: seqRow.data!.duration_sec as number | string | null | undefined,
      fps: seqRow.data!.fps as number | string | null | undefined,
      width: seqRow.data!.width as number | string | null | undefined,
      height: seqRow.data!.height as number | string | null | undefined,
    },
  })
  await safeAddJobEventRenderInputResolved(jobId, renderInput)

  const outputPath = `projects/${projectId}/chunks/${chunkId}/render.webp`
  let webpBuffer: Buffer
  try {
    webpBuffer = await renderChunkDummyWebp({ projectId, chunkId })
  } catch (err) {
    const msg = getErrorMessage(err)
    await supabaseServer.from('sequence_chunks').update({ render_status: 'failed' }).eq('id', chunkId)
    const finished = new Date().toISOString()
    await updateAnalyzeJobStatus({
      job_id: jobId,
      status: 'failed',
      progress: 10,
      started_at: now,
      finished_at: finished,
      error_code: 'RENDER_CHUNK_FAILED',
      error_message: msg,
      output_asset_key: null,
    })
    await markCostFailed(jobId)
    await addJobEvent({
      job_id: jobId,
      level: 'error',
      step: 'render_chunk_failed',
      message: msg,
      payload: { project_id: projectId, chunk_id: chunkId },
    })
    return
  }

  const upload = await supabaseServer.storage.from('project-media').upload(outputPath, webpBuffer, {
    contentType: 'image/webp',
    upsert: true,
  })
  if (upload.error) {
    await supabaseServer.from('sequence_chunks').update({ render_status: 'failed' }).eq('id', chunkId)
    const finished = new Date().toISOString()
    await updateAnalyzeJobStatus({
      job_id: jobId,
      status: 'failed',
      progress: 10,
      started_at: now,
      finished_at: finished,
      error_code: 'RENDER_CHUNK_UPLOAD_FAILED',
      error_message: upload.error.message,
      output_asset_key: null,
    })
    await markCostFailed(jobId)
    await addJobEvent({
      job_id: jobId,
      level: 'error',
      step: 'render_chunk_upload_failed',
      message: upload.error.message,
      payload: { project_id: projectId, chunk_id: chunkId, path: outputPath },
    })
    return
  }

  await supabaseServer.from('sequence_chunks').update({ render_status: 'rendered' }).eq('id', chunkId)

  const outKeyUpdate = await supabaseServer
    .from('sequence_chunks')
    .update({ output_asset_key: outputPath } as Record<string, unknown>)
    .eq('id', chunkId)
  if (outKeyUpdate.error) {
    await addJobEvent({
      job_id: jobId,
      level: 'warn',
      step: 'render_chunk_output_key_update_skipped',
      message: `sequence_chunks.output_asset_key update skipped: ${outKeyUpdate.error.message}`,
      payload: { project_id: projectId, chunk_id: chunkId, path: outputPath },
    })
  }

  const finished = new Date().toISOString()
  await updateAnalyzeJobStatus({
    job_id: jobId,
    status: 'success',
    progress: 100,
    started_at: now,
    finished_at: finished,
    error_code: null,
    error_message: null,
    output_asset_key: outputPath,
  })
  await markCostSuccess(jobId)
  await addJobEvent({
    job_id: jobId,
    level: 'info',
    step: 'render_chunk_uploaded',
    message: 'Render chunk uploaded',
    payload: { project_id: projectId, chunk_id: chunkId, path: outputPath, byte_length: webpBuffer.length },
  })

  const outputBasename = storageKeyBasename(outputPath)
  await safeAddRenderChunkIdentityScoreJobEvent({
    job_id: jobId,
    level: 'info',
    step: 'render_chunk_identity_score_started',
    message: 'Render chunk identity score calculation started',
    payload: {
      project_id: projectId,
      chunk_id: chunkId,
      output_basename: outputBasename,
    },
  })

  const embeddingScoreResult = await calculateEmbeddingRenderChunkIdentityScore({
    jobId,
    projectId,
    chunkId,
    renderInput,
    outputAssetKey: outputPath,
  })

  let identityCalc: BasicRenderChunkIdentityScoreResult
  let normalizedScore: number | null = null
  let measuredIdentityScoreOverride: number | null = null
  let identityEmbeddingUnavailableEventSent = false

  if (embeddingScoreResult.ok) {
    normalizedScore = normalizeRenderChunkIdentityScoreForPersist(embeddingScoreResult.score01)
    measuredIdentityScoreOverride = normalizedScore
    identityCalc = {
      score: embeddingScoreResult.score01,
      referenceAssetId: embeddingScoreResult.referenceAssetId,
      referenceSource: embeddingScoreResult.referenceSource,
    }
    await safeAddRenderChunkIdentityScoreJobEvent({
      job_id: jobId,
      level: 'info',
      step: 'identity_embedding_score_calculated',
      message: 'Render chunk identity score calculated from embeddings (cosine)',
      payload: {
        project_id: projectId,
        chunk_id: chunkId,
        score: embeddingScoreResult.score01,
        raw_cosine: embeddingScoreResult.rawCosine,
        normalized_score: normalizedScore,
        normalization_policy: IDENTITY_COSINE_NORMALIZATION_POLICY,
        model_version: embeddingScoreResult.referenceModelVersion,
        output_model_version: embeddingScoreResult.outputModelVersion,
        identity_profile_id: embeddingScoreResult.identityProfileId,
        embedding_dimensions: embeddingScoreResult.embeddingDimensions,
        score_source: 'embedding',
        output_basename: outputBasename,
      },
    })
  } else {
    identityCalc = await calculateBasicRenderChunkIdentityScore({
      jobId,
      projectId,
      chunkId,
      outputPath,
      renderInput,
    })
    normalizedScore =
      identityCalc.score !== null && Number.isFinite(identityCalc.score)
        ? normalizeRenderChunkIdentityScoreForPersist(identityCalc.score)
        : null
    measuredIdentityScoreOverride = normalizedScore

    if (normalizedScore !== null) {
      await safeAddRenderChunkIdentityScoreJobEvent({
        job_id: jobId,
        level: 'info',
        step: 'identity_embedding_score_fallback_pixel',
        message: 'Embedding-based identity score unavailable; using pixel fallback',
        payload: {
          project_id: projectId,
          chunk_id: chunkId,
          error_code: embeddingScoreResult.errorCode,
          reason: embeddingScoreResult.reason,
          score_source: 'pixel_fallback',
          output_basename: outputBasename,
        },
      })
    } else {
      identityEmbeddingUnavailableEventSent = true
      await safeAddRenderChunkIdentityScoreJobEvent({
        job_id: jobId,
        level: 'info',
        step: 'identity_embedding_score_unavailable',
        message: 'Embedding and pixel identity scores unavailable',
        payload: {
          project_id: projectId,
          chunk_id: chunkId,
          error_code: embeddingScoreResult.errorCode,
          reason: embeddingScoreResult.reason,
          score_source: 'unavailable',
          pixel_reason_code: identityCalc.reasonCode ?? null,
          pixel_error_message: identityCalc.errorMessage ?? null,
          output_basename: outputBasename,
        },
      })
    }
  }

  if (normalizedScore !== null) {
    const idUpd = await supabaseServer
      .from('sequence_chunks')
      .update({ identity_score: normalizedScore } as Record<string, unknown>)
      .eq('id', chunkId)
    if (idUpd.error) {
      console.warn(
        'sequence_chunks.identity_score update failed',
        chunkId,
        idUpd.error.message
      )
      await safeAddRenderChunkIdentityScoreJobEvent({
        job_id: jobId,
        level: 'warn',
        step: 'render_chunk_identity_score_update_failed',
        message: idUpd.error.message,
        payload: {
          project_id: projectId,
          chunk_id: chunkId,
          reference_asset_id: identityCalc.referenceAssetId,
          reference_source: identityCalc.referenceSource,
          score: normalizedScore,
          reason_code: 'IDENTITY_SCORE_DB_UPDATE_FAILED',
          output_basename: outputBasename,
        },
      })
    }
    await safeAddRenderChunkIdentityScoreJobEvent({
      job_id: jobId,
      level: 'info',
      step: 'render_chunk_identity_score_recorded',
      message: 'Render chunk identity score recorded',
      payload: {
        project_id: projectId,
        chunk_id: chunkId,
        reference_asset_id: identityCalc.referenceAssetId,
        reference_source: identityCalc.referenceSource,
        score: normalizedScore,
        reason_code: identityCalc.reasonCode ?? null,
        output_basename: outputBasename,
      },
    })
  } else {
    measuredIdentityScoreOverride = null
    if (!identityEmbeddingUnavailableEventSent) {
      const isHardFail = identityCalc.reasonCode === 'IDENTITY_SCORE_CALCULATION_FAILED'
      await safeAddRenderChunkIdentityScoreJobEvent({
        job_id: jobId,
        level: isHardFail ? 'warn' : 'info',
        step: isHardFail
          ? 'render_chunk_identity_score_failed'
          : 'render_chunk_identity_score_skipped',
        message: isHardFail
          ? 'Render chunk identity score calculation failed'
          : 'Render chunk identity score skipped',
        payload: {
          project_id: projectId,
          chunk_id: chunkId,
          reference_asset_id: identityCalc.referenceAssetId,
          reference_source: identityCalc.referenceSource,
          score: null,
          reason_code: identityCalc.reasonCode ?? null,
          error_message: identityCalc.errorMessage,
          output_basename: outputBasename,
        },
      })
    }
  }

  const identityScoreSourceForGate: 'embedding' | 'pixel_fallback' | 'unavailable' =
    embeddingScoreResult.ok
      ? 'embedding'
      : normalizedScore !== null
        ? 'pixel_fallback'
        : 'unavailable'

  await persistRenderChunkStateOut({
    jobId,
    projectId,
    chunkId,
    sceneId: String(sceneRow.data.id),
    sequenceId: String(seqRow.data!.id),
    outputPath,
    normalizedScore,
  })

  const gateRecordSummary = await recordRenderChunkQualityGateEvaluation({
    jobId,
    projectId,
    chunkId,
    identityScoreRaw: chunkRow.data.identity_score,
    measuredIdentityScoreOverride,
    scoreSource: identityScoreSourceForGate,
  })
  await evaluateAutoRerenderAfterRenderChunk({
    jobId,
    projectId,
    sequenceId: String(seqRow.data!.id),
    chunkId,
    normalizedScore,
    identityAttemptCountRaw: chunkRow.data.identity_attempt_count,
    gateRecordSummary,
    scoreSource: identityScoreSourceForGate,
  })
  await addJobEvent({
    job_id: jobId,
    level: 'info',
    step: 'render_chunk_completed',
    message: 'Render chunk completed',
    payload: { project_id: projectId, chunk_id: chunkId, path: outputPath },
  })
}

const worker = new Worker(
  'job-queue',
  async (job) => {
    const { job_type, payload } = job.data

    switch (job_type) {
      case QUEUE_NAMES.ANALYZE:
        console.log('ANALYZE job received', payload)
        await handleAnalyzeJob(payload as AnalyzePayload)
        break
      case QUEUE_NAMES.BUILD_IDENTITY:
        console.log('BUILD_IDENTITY job received', payload)
        await handleBuildIdentityJob(payload as BuildIdentityPayload)
        break
      case QUEUE_NAMES.PREVIEW: {
        const p = payload as PreviewPayload
        console.log('PREVIEW job received', {
          job_id: p.job_id,
          project_id: p.project_id,
          instruction_length: p.instruction?.length ?? 0,
        })
        await handlePreviewJob(p)
        break
      }
      case QUEUE_NAMES.RENDER_CHUNK: {
        const p = payload as RenderChunkPayload
        console.log('RENDER_CHUNK job received', {
          job_id: p.job_id,
          project_id: p.project_id,
          chunk_id: p.chunk_id,
        })
        await handleRenderChunkJob(p)
        break
      }

      default:
        throw new Error('Unsupported job_type in this stage')
    }
  },
  {
    connection: redisConnection.connection,
  }
)

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed`, err)
})

worker.on('error', (err) => {
  console.error('Worker error:', err)
})

// ???????? ????
process.stdin.resume()
