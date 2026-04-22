import { Worker } from 'bullmq'
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

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'UNKNOWN_ERROR'
}

type AnalyzeJobStatus = 'running' | 'success' | 'failed'

async function assertDbResult<T extends { error: { message: string } | null }>(
  label: string,
  promise: Promise<T>
) {
  const result = await promise
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
  await assertDbResult(
    'job_events_insert_failed',
    supabaseServer.from('job_events').insert({
      job_id: params.job_id,
      level: params.level,
      step: params.step,
      message: params.message,
      payload: params.payload ?? null,
    })
  )
}

async function updateAnalyzeJobStatus(params: {
  job_id: string
  status: AnalyzeJobStatus
  progress: number
  started_at?: string
  finished_at?: string
  error_code?: string | null
  error_message?: string | null
}) {
  const now = new Date().toISOString()
  await assertDbResult(
    `jobs_${params.status}_update_failed`,
    supabaseServer
      .from('jobs')
      .update({
        status: params.status,
        progress: params.progress,
        started_at: params.started_at,
        finished_at: params.finished_at,
        updated_at: now,
        error_code: params.error_code ?? null,
        error_message: params.error_message ?? null,
      })
      .eq('id', params.job_id)
  )
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

    const gateEvaluationInsert = await supabaseServer.from('gate_evaluations').insert({
      project_id: payload.project_id,
      scope_type: 'job',
      gate_type: 'identity',
      job_id: payload.job_id,
      decision: 'passed',
      measured_value: null,
      threshold: null,
    })
    if (gateEvaluationInsert.error) {
      await addJobEvent({
        job_id: payload.job_id,
        level: 'error',
        step: 'build_identity_gate_record_failed',
        message: `gate_evaluations_insert_failed: ${gateEvaluationInsert.error.message}`,
      })
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
