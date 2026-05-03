import type { Queue } from 'bullmq'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getMvpJobCostPolicy } from '@/lib/costs/policy'
import { parseIdentityAttemptCount } from '@/lib/server/parse-identity-attempt-count'

const RERENDER_ALLOWED_RENDER_STATUS = new Set<string>(['failed', 'rerender_pending'])

export type EnqueueRenderChunkRerenderReason = 'manual_rerender' | 'auto_rerender'

export type EnqueueRenderChunkRerenderResult =
  | { ok: true; jobId: string }
  | { ok: false; code: string; message: string }

/**
 * Enqueues a render_chunk job after transitioning the chunk from `failed` or
 * `rerender_pending` to `queued`, matching the mechanical flow of
 * `POST .../chunks/[chunkId]/rerender` (duplicate job guard, job row, BullMQ).
 */
export async function enqueueRenderChunkRerenderJob(params: {
  supabase: SupabaseClient
  jobQueue: Queue
  projectId: string
  chunkId: string
  sequenceId: string
  reason: EnqueueRenderChunkRerenderReason
}): Promise<EnqueueRenderChunkRerenderResult> {
  const { supabase, jobQueue, projectId, chunkId, sequenceId, reason } = params

  const dupJob = await supabase
    .from('jobs')
    .select('id')
    .eq('chunk_id', chunkId)
    .eq('job_type', 'render_chunk')
    .in('status', ['queued', 'running'])
    .limit(1)
    .maybeSingle()

  if (dupJob.error) {
    return { ok: false, code: 'DUP_JOB_QUERY_FAILED', message: dupJob.error.message }
  }
  if (dupJob.data?.id != null && String(dupJob.data.id).trim() !== '') {
    return {
      ok: false,
      code: 'CHUNK_ALREADY_RUNNING',
      message: 'render_chunk job already queued or running for chunk',
    }
  }

  const chunkRes = await supabase
    .from('sequence_chunks')
    .select('id, render_status, identity_attempt_count')
    .eq('id', chunkId)
    .maybeSingle()

  if (chunkRes.error || !chunkRes.data?.id) {
    return {
      ok: false,
      code: 'CHUNK_NOT_FOUND',
      message: chunkRes.error?.message ?? 'CHUNK_NOT_FOUND',
    }
  }

  const currentRenderStatus = String(chunkRes.data.render_status ?? '').trim()
  if (!RERENDER_ALLOWED_RENDER_STATUS.has(currentRenderStatus)) {
    return {
      ok: false,
      code: 'RERENDER_STATUS_NOT_ALLOWED',
      message: `chunk render_status not eligible: ${currentRenderStatus}`,
    }
  }

  const previousRenderStatus = currentRenderStatus
  const previousIdentityAttemptCount = parseIdentityAttemptCount(
    chunkRes.data.identity_attempt_count
  )
  const nextIdentityAttemptCount = previousIdentityAttemptCount + 1

  const transition = await supabase
    .from('sequence_chunks')
    .update({
      render_status: 'queued',
      identity_attempt_count: nextIdentityAttemptCount,
    })
    .eq('id', chunkId)
    .in('render_status', ['failed', 'rerender_pending'])
    .select('id')

  if (transition.error) {
    return { ok: false, code: 'TRANSITION_FAILED', message: transition.error.message }
  }
  if (!transition.data || transition.data.length === 0) {
    return { ok: false, code: 'RERENDER_STATE_CHANGED', message: 'chunk state changed during transition' }
  }

  const job_type = 'render_chunk'
  const costSnapshot = getMvpJobCostPolicy(job_type)

  const jobInsertPayload: Record<string, unknown> = {
    project_id: projectId,
    sequence_id: sequenceId,
    chunk_id: chunkId,
    job_type,
    status: 'queued',
    cost_estimate: costSnapshot.cost_estimate,
    cost_accumulated: costSnapshot.cost_accumulated,
    soft_cost_limit: costSnapshot.soft_cost_limit,
    hard_cost_limit: costSnapshot.hard_cost_limit,
    estimated_cost_preflight: costSnapshot.estimated_cost_preflight,
    budget_precheck_status: costSnapshot.budget_precheck_status,
    budget_precheck_reason: costSnapshot.budget_precheck_reason,
    kill_signal: false,
  }

  const { data: jobRow, error: jobInsertError } = await supabase
    .from('jobs')
    .insert(jobInsertPayload)
    .select('id, project_id, sequence_id, chunk_id, job_type, status, created_at')
    .single()

  if (jobInsertError || !jobRow?.id) {
    const rollback = await supabase
      .from('sequence_chunks')
      .update({
        render_status: previousRenderStatus,
        identity_attempt_count: previousIdentityAttemptCount,
      })
      .eq('id', chunkId)
    if (rollback.error) {
      console.warn(
        'enqueueRenderChunkRerenderJob jobs insert rollback chunk failed',
        rollback.error.message
      )
    }
    return {
      ok: false,
      code: 'JOB_CREATE_FAILED',
      message: jobInsertError?.message ?? 'NO_DATA',
    }
  }

  const jobId = String(jobRow.id)

  const { error: reqEventError } = await supabase.from('job_events').insert({
    job_id: jobId,
    level: 'info',
    step: 'rerender_requested',
    message: 'Render chunk rerender requested',
    payload: {
      project_id: projectId,
      sequence_id: sequenceId,
      chunk_id: chunkId,
      previous_render_status: previousRenderStatus,
      current_render_status: 'queued',
      previous_identity_attempt_count: previousIdentityAttemptCount,
      identity_attempt_count: nextIdentityAttemptCount,
      reason,
    },
  })
  if (reqEventError) {
    console.warn('enqueueRenderChunkRerenderJob rerender_requested job_events warning:', reqEventError.message)
  }

  const queuePayload = {
    job_id: jobRow.id,
    project_id: projectId,
    chunk_id: chunkId,
  }

  try {
    await jobQueue.add('job', { job_type, payload: queuePayload }, { jobId: String(jobRow.id) })
  } catch (enqueueErr) {
    const errorDetail = enqueueErr instanceof Error ? enqueueErr.message : 'UNKNOWN_ERROR'
    const now = new Date().toISOString()

    try {
      await supabase
        .from('jobs')
        .update({
          status: 'failed',
          error_code: 'JOB_ENQUEUE_FAILED',
          error_message: errorDetail,
          finished_at: now,
          updated_at: now,
        })
        .eq('id', jobRow.id)
    } catch (e) {
      console.warn('enqueueRenderChunkRerenderJob enqueue failure jobs update exception:', e)
    }

    try {
      const fixChunk = await supabase.from('sequence_chunks').update({ render_status: 'failed' }).eq('id', chunkId)
      if (fixChunk.error) {
        console.warn('enqueueRenderChunkRerenderJob enqueue failure chunk fix warning:', fixChunk.error.message)
      }
    } catch (e) {
      console.warn('enqueueRenderChunkRerenderJob enqueue failure chunk fix exception:', e)
    }

    try {
      const { error: ce1 } = await supabase.from('job_events').insert({
        job_id: jobId,
        level: 'error',
        step: 'render_chunk_enqueue_failed',
        message: 'Failed to enqueue render_chunk job',
        payload: {
          project_id: projectId,
          sequence_id: sequenceId,
          chunk_id: chunkId,
          previous_render_status: previousRenderStatus,
          attempted_render_status: 'queued',
          previous_identity_attempt_count: previousIdentityAttemptCount,
          attempted_identity_attempt_count: nextIdentityAttemptCount,
          error: errorDetail,
          job_type,
          reason,
        },
      })
      if (ce1) {
        console.warn(
          'enqueueRenderChunkRerenderJob render_chunk_enqueue_failed job_events warning:',
          ce1.message
        )
      }
    } catch (e) {
      console.warn('enqueueRenderChunkRerenderJob render_chunk_enqueue_failed job_events exception:', e)
    }

    try {
      const { error: ce2 } = await supabase.from('job_events').insert({
        job_id: jobId,
        level: 'error',
        step: 'enqueue_failed',
        message: 'Failed to enqueue job',
        payload: {
          project_id: projectId,
          sequence_id: sequenceId,
          chunk_id: chunkId,
          error: errorDetail,
          job_type,
          reason,
        },
      })
      if (ce2) {
        console.warn('enqueueRenderChunkRerenderJob enqueue_failed job_events warning:', ce2.message)
      }
    } catch (e) {
      console.warn('enqueueRenderChunkRerenderJob enqueue_failed job_events exception:', e)
    }

    return { ok: false, code: 'JOB_ENQUEUE_FAILED', message: errorDetail }
  }

  const { error: enqEventError } = await supabase.from('job_events').insert({
    job_id: jobId,
    level: 'info',
    step: 'rerender_enqueued',
    message: 'Render chunk rerender enqueued',
    payload: {
      project_id: projectId,
      sequence_id: sequenceId,
      chunk_id: chunkId,
      job_type,
      reason,
    },
  })
  if (enqEventError) {
    console.warn('enqueueRenderChunkRerenderJob rerender_enqueued job_events warning:', enqEventError.message)
  }

  return { ok: true, jobId }
}
