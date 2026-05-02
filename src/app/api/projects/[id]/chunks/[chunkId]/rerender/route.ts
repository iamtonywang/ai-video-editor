import { NextResponse } from 'next/server'
import { jobQueue } from '@/lib/queue'
import { getMvpJobCostPolicy } from '@/lib/costs/policy'
import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { supabaseAdmin } from '@/lib/supabase/admin'

type RouteContext = {
  params: Promise<{ id?: string; chunkId?: string }>
}

function isValidUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

function parseAttemptCount(raw: unknown): number {
  if (raw == null) return 0
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

const RERENDER_ALLOWED = new Set(['failed', 'rerender_pending'])

export async function POST(_req: Request, context: RouteContext) {
  try {
    const supabase = await createAuthServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ ok: false, error: 'AUTH_REQUIRED' }, { status: 401 })
    }

    const resolved = await context.params
    const projectIdRaw = typeof resolved?.id === 'string' ? resolved.id.trim() : ''
    const chunkIdRaw = typeof resolved?.chunkId === 'string' ? resolved.chunkId.trim() : ''

    if (!projectIdRaw) {
      return NextResponse.json({ ok: false, error: 'INVALID_PROJECT_ID' }, { status: 400 })
    }
    if (!isValidUuid(projectIdRaw)) {
      return NextResponse.json({ ok: false, error: 'INVALID_PROJECT_ID' }, { status: 400 })
    }

    if (!chunkIdRaw) {
      return NextResponse.json({ ok: false, error: 'INVALID_CHUNK_ID' }, { status: 400 })
    }
    if (!isValidUuid(chunkIdRaw)) {
      return NextResponse.json({ ok: false, error: 'INVALID_CHUNK_ID' }, { status: 400 })
    }

    const projectId = projectIdRaw
    const chunkId = chunkIdRaw

    const { data: chunkRow, error: chunkError } = await supabaseAdmin
      .from('sequence_chunks')
      .select('id, scene_id, render_status, identity_attempt_count')
      .eq('id', chunkId)
      .maybeSingle()

    if (chunkError) {
      return NextResponse.json({ ok: false, error: chunkError.message }, { status: 500 })
    }

    if (!chunkRow?.id || !chunkRow.scene_id) {
      return NextResponse.json({ ok: false, error: 'CHUNK_NOT_FOUND' }, { status: 404 })
    }

    const { data: sceneRow, error: sceneError } = await supabaseAdmin
      .from('sequence_scenes')
      .select('id, sequence_id')
      .eq('id', String(chunkRow.scene_id))
      .maybeSingle()

    if (sceneError) {
      return NextResponse.json({ ok: false, error: sceneError.message }, { status: 500 })
    }

    if (!sceneRow?.sequence_id) {
      return NextResponse.json({ ok: false, error: 'SCENE_NOT_FOUND' }, { status: 404 })
    }

    const sequenceId = String(sceneRow.sequence_id)

    const { data: seqRow, error: seqError } = await supabaseAdmin
      .from('sequences')
      .select('id, project_id')
      .eq('id', sequenceId)
      .maybeSingle()

    if (seqError) {
      return NextResponse.json({ ok: false, error: seqError.message }, { status: 500 })
    }

    const resolvedProjectId = String(seqRow?.project_id ?? '').trim()
    if (!resolvedProjectId) {
      return NextResponse.json({ ok: false, error: 'SEQUENCE_NOT_FOUND' }, { status: 404 })
    }

    if (resolvedProjectId !== projectId) {
      return NextResponse.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 })
    }

    const { data: ownerProject, error: ownerError } = await supabaseAdmin
      .from('projects')
      .select('id')
      .eq('id', resolvedProjectId)
      .eq('owner_user_id', user.id)
      .maybeSingle()

    if (ownerError) {
      return NextResponse.json({ ok: false, error: ownerError.message }, { status: 500 })
    }

    if (!ownerProject?.id) {
      return NextResponse.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 })
    }

    const currentRenderStatus = String(chunkRow.render_status ?? '').trim()
    if (!RERENDER_ALLOWED.has(currentRenderStatus)) {
      return NextResponse.json({ ok: false, error: 'RERENDER_STATUS_NOT_ALLOWED' }, { status: 400 })
    }

    const { data: dupJob, error: dupError } = await supabaseAdmin
      .from('jobs')
      .select('id')
      .eq('chunk_id', chunkId)
      .eq('job_type', 'render_chunk')
      .in('status', ['queued', 'running'])
      .limit(1)
      .maybeSingle()

    if (dupError) {
      return NextResponse.json({ ok: false, error: dupError.message }, { status: 500 })
    }

    if (dupJob?.id != null && String(dupJob.id).trim() !== '') {
      return NextResponse.json({ ok: false, error: 'CHUNK_ALREADY_RUNNING' }, { status: 409 })
    }

    const previousRenderStatus = currentRenderStatus
    const previousIdentityAttemptCount = parseAttemptCount(chunkRow.identity_attempt_count)
    const nextIdentityAttemptCount = previousIdentityAttemptCount + 1

    const { data: transitionRows, error: transitionError } = await supabaseAdmin
      .from('sequence_chunks')
      .update({
        render_status: 'queued',
        identity_attempt_count: nextIdentityAttemptCount,
      })
      .eq('id', chunkId)
      .in('render_status', ['failed', 'rerender_pending'])
      .select('id')

    if (transitionError) {
      return NextResponse.json({ ok: false, error: transitionError.message }, { status: 500 })
    }

    if (!transitionRows || transitionRows.length === 0) {
      return NextResponse.json({ ok: false, error: 'RERENDER_STATE_CHANGED' }, { status: 409 })
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

    const { data: jobRow, error: jobInsertError } = await supabaseAdmin
      .from('jobs')
      .insert(jobInsertPayload)
      .select('id, project_id, sequence_id, chunk_id, job_type, status, created_at')
      .single()

    if (jobInsertError || !jobRow?.id) {
      const rollback = await supabaseAdmin
        .from('sequence_chunks')
        .update({
          render_status: previousRenderStatus,
          identity_attempt_count: previousIdentityAttemptCount,
        })
        .eq('id', chunkId)
      if (rollback.error) {
        console.warn('POST rerender jobs insert rollback chunk failed', rollback.error.message)
      }
      return NextResponse.json(
        { ok: false, error: 'JOB_CREATE_FAILED', error_detail: jobInsertError?.message ?? 'NO_DATA' },
        { status: 500 }
      )
    }

    const jobId = String(jobRow.id)

    const { error: reqEventError } = await supabaseAdmin.from('job_events').insert({
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
        reason: 'manual_rerender',
      },
    })
    if (reqEventError) {
      console.warn('POST rerender rerender_requested job_events insert warning:', reqEventError.message)
    }

    const queuePayload = {
      job_id: jobRow.id,
      project_id: projectId,
      chunk_id: chunkId,
    }

    try {
      await jobQueue.add(
        'job',
        { job_type, payload: queuePayload },
        { jobId: String(jobRow.id) }
      )
    } catch (enqueueErr) {
      const errorDetail = enqueueErr instanceof Error ? enqueueErr.message : 'UNKNOWN_ERROR'
      const now = new Date().toISOString()

      try {
        await supabaseAdmin
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
        console.warn('POST rerender enqueue failure jobs update exception:', e)
      }

      try {
        const fixChunk = await supabaseAdmin
          .from('sequence_chunks')
          .update({ render_status: 'failed' })
          .eq('id', chunkId)
        if (fixChunk.error) {
          console.warn('POST rerender enqueue failure chunk fix warning:', fixChunk.error.message)
        }
      } catch (e) {
        console.warn('POST rerender enqueue failure chunk fix exception:', e)
      }

      try {
        const { error: ce1 } = await supabaseAdmin.from('job_events').insert({
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
            reason: 'manual_rerender',
          },
        })
        if (ce1) {
          console.warn('POST rerender render_chunk_enqueue_failed job_events warning:', ce1.message)
        }
      } catch (e) {
        console.warn('POST rerender render_chunk_enqueue_failed job_events exception:', e)
      }

      try {
        const { error: ce2 } = await supabaseAdmin.from('job_events').insert({
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
            reason: 'manual_rerender',
          },
        })
        if (ce2) {
          console.warn('POST rerender enqueue_failed job_events warning:', ce2.message)
        }
      } catch (e) {
        console.warn('POST rerender enqueue_failed job_events exception:', e)
      }

      return NextResponse.json(
        {
          ok: false,
          error: 'JOB_ENQUEUE_FAILED',
          error_detail: errorDetail,
        },
        { status: 500 }
      )
    }

    const { error: enqEventError } = await supabaseAdmin.from('job_events').insert({
      job_id: jobId,
      level: 'info',
      step: 'rerender_enqueued',
      message: 'Render chunk rerender enqueued',
      payload: {
        project_id: projectId,
        sequence_id: sequenceId,
        chunk_id: chunkId,
        job_type,
        reason: 'manual_rerender',
      },
    })
    if (enqEventError) {
      console.warn('POST rerender rerender_enqueued job_events insert warning:', enqEventError.message)
    }

    return NextResponse.json({
      ok: true,
      data: {
        job_id: jobRow.id,
        project_id: jobRow.project_id,
        sequence_id: jobRow.sequence_id,
        chunk_id: jobRow.chunk_id,
        status: jobRow.status,
        render_status: 'queued',
        identity_attempt_count: nextIdentityAttemptCount,
      },
      error: null,
    })
  } catch (error) {
    console.error('POST /api/projects/[id]/chunks/[chunkId]/rerender error:', error)
    const detail = error instanceof Error ? error.message : 'UNKNOWN_ERROR'
    return NextResponse.json(
      { ok: false, error: 'INVALID_REQUEST', error_detail: detail },
      { status: 400 }
    )
  }
}
