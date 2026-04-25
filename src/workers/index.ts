import { Worker } from 'bullmq'
import sharp from 'sharp'
import { redisConnection } from '@/lib/queue/redis'
import { QUEUE_NAMES } from '@/lib/queue'
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
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'UNKNOWN_ERROR'
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

async function handleAnalyzeJob(payload: AnalyzePayload) {
  const now = new Date().toISOString()

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

  try {
    await updateAnalyzeJobStatus({
      job_id: payload.job_id,
      status: 'running',
      progress: 10,
      started_at: now,
      error_code: null,
      error_message: null,
    })

    await addJobEvent({
      job_id: payload.job_id,
      level: 'info',
      step: 'worker_received',
      message: 'Build identity worker received job',
    })

    // Mock build_identity phase for this step.
    await new Promise((resolve) => setTimeout(resolve, 300))

    if (payload.force_fail) {
      throw new Error('BUILD_IDENTITY_FORCED_FAILURE')
    }

    const createIdentity = await supabaseServer
      .from('identity_profiles')
      .insert({
        project_id: payload.project_id,
        reference_asset_id: payload.reference_asset_id,
        embedding_key: payload.embedding_key,
        latent_base_key: payload.latent_base_key,
        anchor_manifest_key: payload.anchor_manifest_key,
        identity_status: payload.identity_status,
        build_score: payload.build_score,
      })
      .select('id')
      .single()
    if (createIdentity.error) {
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

async function handlePreviewJob(payload: PreviewPayload) {
  const now = new Date().toISOString()
  const jobId = payload.job_id
  const projectId = payload.project_id
  const instructionLength = (payload.instruction ?? '').length

  await updateAnalyzeJobStatus({
    job_id: jobId,
    status: 'running',
    progress: 5,
    started_at: now,
    error_code: null,
    error_message: null,
    output_asset_key: null,
  })

  await addJobEvent({
    job_id: jobId,
    level: 'info',
    step: 'preview_received',
    message: 'Preview job received',
    payload: {
      project_id: projectId,
      job_type: 'preview',
      instruction_present: instructionLength > 0,
      instruction_length: instructionLength,
    },
  })

  let webpBuffer: Buffer
  try {
    webpBuffer = await renderPreviewWebp(payload.instruction ?? '')
  } catch (renderErr) {
    const msg = getErrorMessage(renderErr)
    const finished = new Date().toISOString()
    await updateAnalyzeJobStatus({
      job_id: jobId,
      status: 'failed',
      progress: 5,
      started_at: now,
      finished_at: finished,
      error_code: 'PREVIEW_RENDER_FAILED',
      error_message: msg,
      output_asset_key: null,
    })
    await addJobEvent({
      job_id: jobId,
      level: 'error',
      step: 'preview_render_failed',
      message: msg,
      payload: {
        job_id: jobId,
        project_id: projectId,
        job_type: 'preview',
        error_code: 'PREVIEW_RENDER_FAILED',
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
