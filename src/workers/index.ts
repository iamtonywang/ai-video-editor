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

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'UNKNOWN_ERROR'
}

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

async function handleAnalyzeJob(payload: AnalyzePayload) {
  const now = new Date().toISOString()

  try {
    await assertDbResult(
      'jobs_running_update_failed',
      supabaseServer
        .from('jobs')
        .update({
          status: 'running',
          progress: 10,
          started_at: now,
          updated_at: now,
          error_code: null,
          error_message: null,
        })
        .eq('id', payload.job_id)
    )

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

    await assertDbResult(
      'jobs_success_update_failed',
      supabaseServer
        .from('jobs')
        .update({
          status: 'success',
          progress: 100,
          finished_at: now,
          updated_at: now,
        })
        .eq('id', payload.job_id)
    )

    await addJobEvent({
      job_id: payload.job_id,
      level: 'info',
      step: 'analyze_completed',
      message: 'Analyze job completed',
    })
  } catch (error) {
    const errorMessage = getErrorMessage(error)

    const failedUpdate = await supabaseServer
      .from('jobs')
      .update({
        status: 'failed',
        error_code: 'ANALYZE_WORKER_ERROR',
        error_message: errorMessage,
        finished_at: now,
        updated_at: now,
      })
      .eq('id', payload.job_id)
    if (failedUpdate.error) {
      console.error('jobs_failed_update_failed:', failedUpdate.error.message)
    }

    await addJobEvent({
      job_id: payload.job_id,
      level: 'error',
      step: 'analyze_failed',
      message: errorMessage,
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
