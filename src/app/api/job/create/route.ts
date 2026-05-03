import { NextRequest, NextResponse } from 'next/server'
import { jobQueue } from '@/lib/queue'
import { getMvpJobCostPolicy } from '@/lib/costs/policy'
import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { supabaseAdmin } from '@/lib/supabase/admin'

const ALLOWED_JOB_TYPE = [
  'analyze',
  'build_identity',
  'render_chunk',
  'preview',
]

const ALLOWED_IDENTITY_STATUS = ['building', 'ready', 'failed', 'stale']
const ALLOWED_PREVIEW_INPUT_MODE = ['prompt_image', 'image_remix'] as const

function isValidUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

type RenderChunkQueuedRollbackResult = {
  rollback_success: boolean
  rollback_to_status: string | null
  rollback_error: string | null
}

/**
 * After jobs insert fails, restore chunk from `queued` to the status observed
 * before this route set it to queued (single guarded update).
 */
async function rollbackRenderChunkQueuedToPreviousStatus(params: {
  chunkId: string
  previousRenderStatus: string | null
}): Promise<RenderChunkQueuedRollbackResult> {
  const prev = params.previousRenderStatus
  if (prev == null || String(prev).trim() === '') {
    return {
      rollback_success: false,
      rollback_to_status: null,
      rollback_error: 'NO_PREVIOUS_STATUS',
    }
  }
  const toStatus = String(prev).trim()
  const rb = await supabaseAdmin
    .from('sequence_chunks')
    .update({ render_status: toStatus })
    .eq('id', params.chunkId)
    .eq('render_status', 'queued')
    .select('id')

  if (rb.error) {
    return {
      rollback_success: false,
      rollback_to_status: null,
      rollback_error: rb.error.message,
    }
  }
  const rows = rb.data
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      rollback_success: false,
      rollback_to_status: null,
      rollback_error: 'ROLLBACK_NO_MATCHING_CHUNK_QUEUED',
    }
  }
  return {
    rollback_success: true,
    rollback_to_status: toStatus,
    rollback_error: null,
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createAuthServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ ok: false, error: 'AUTH_REQUIRED' }, { status: 401 })
    }

    const body = await req.json()

    const project_id = body?.project_id
    const job_type =
      typeof body?.job_type === 'string' ? body.job_type.trim() : ''
    const reference_asset_id = body?.reference_asset_id
    const embedding_key =
      typeof body?.embedding_key === 'string' ? body.embedding_key.trim() : ''
    const latent_base_key =
      typeof body?.latent_base_key === 'string'
        ? body.latent_base_key.trim()
        : ''
    const anchor_manifest_key =
      typeof body?.anchor_manifest_key === 'string'
        ? body.anchor_manifest_key.trim()
        : ''
    const identity_status =
      typeof body?.identity_status === 'string' ? body.identity_status.trim() : ''
    const build_score =
      typeof body?.build_score === 'number' ? body.build_score : undefined
    const instruction =
      typeof body?.instruction === 'string' ? body.instruction.trim() : ''
    const input_mode_raw =
      typeof body?.input_mode === 'string' ? body.input_mode.trim() : ''
    const input_mode =
      input_mode_raw === '' ? 'prompt_image' : input_mode_raw
    const chunk_id_raw = body?.chunk_id
    const chunk_id =
      typeof chunk_id_raw === 'string'
        ? chunk_id_raw.trim()
        : chunk_id_raw != null
          ? String(chunk_id_raw).trim()
          : ''

    if (!project_id || !job_type) {
      return NextResponse.json(
        { ok: false, error: 'REQUIRED_FIELDS_MISSING' },
        { status: 400 }
      )
    }

    if (!ALLOWED_JOB_TYPE.includes(job_type)) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_JOB_TYPE' },
        { status: 400 }
      )
    }

    const { data: projectRow, error: projectError } = await supabaseAdmin
      .from('projects')
      .select('id')
      .eq('id', project_id)
      .eq('owner_user_id', user.id)
      .maybeSingle()

    if (projectError) {
      return NextResponse.json(
        { ok: false, error: projectError.message },
        { status: 500 }
      )
    }

    if (!projectRow) {
      return NextResponse.json(
        { ok: false, error: 'PROJECT_NOT_FOUND' },
        { status: 404 }
      )
    }

    let renderChunkContext:
      | null
      | { chunk_id: string; scene_id: string; sequence_id: string; project_id: string; render_status: string | null } =
      null

    if (job_type === 'render_chunk') {
      if (!chunk_id) {
        return NextResponse.json({ ok: false, error: 'CHUNK_ID_REQUIRED' }, { status: 400 })
      }
      if (!isValidUuid(chunk_id)) {
        return NextResponse.json({ ok: false, error: 'INVALID_CHUNK_ID' }, { status: 400 })
      }

      const chunkRow = await supabaseAdmin
        .from('sequence_chunks')
        .select('id, scene_id, render_status')
        .eq('id', chunk_id)
        .maybeSingle()
      if (chunkRow.error) {
        return NextResponse.json({ ok: false, error: chunkRow.error.message }, { status: 500 })
      }
      if (!chunkRow.data?.id || !chunkRow.data.scene_id) {
        return NextResponse.json({ ok: false, error: 'CHUNK_NOT_FOUND' }, { status: 404 })
      }

      const sceneRow = await supabaseAdmin
        .from('sequence_scenes')
        .select('id, sequence_id')
        .eq('id', String(chunkRow.data.scene_id))
        .maybeSingle()
      if (sceneRow.error) {
        return NextResponse.json({ ok: false, error: sceneRow.error.message }, { status: 500 })
      }
      if (!sceneRow.data?.sequence_id) {
        return NextResponse.json({ ok: false, error: 'SCENE_NOT_FOUND' }, { status: 404 })
      }

      const seqRow = await supabaseAdmin
        .from('sequences')
        .select('id, project_id')
        .eq('id', String(sceneRow.data.sequence_id))
        .maybeSingle()
      if (seqRow.error) {
        return NextResponse.json({ ok: false, error: seqRow.error.message }, { status: 500 })
      }
      const resolvedProjectId = String(seqRow.data?.project_id ?? '').trim()
      if (!resolvedProjectId) {
        return NextResponse.json({ ok: false, error: 'SEQUENCE_NOT_FOUND' }, { status: 404 })
      }

      if (resolvedProjectId !== String(project_id)) {
        return NextResponse.json({ ok: false, error: 'CHUNK_PROJECT_MISMATCH' }, { status: 403 })
      }

      renderChunkContext = {
        chunk_id: String(chunkRow.data.id),
        scene_id: String(chunkRow.data.scene_id),
        sequence_id: String(sceneRow.data.sequence_id),
        project_id: resolvedProjectId,
        render_status:
          chunkRow.data.render_status == null ? null : String(chunkRow.data.render_status).trim(),
      }

      const s = renderChunkContext.render_status ?? ''
      if (s === 'queued' || s === 'running' || s === 'rendered' || s === 'approved') {
        return NextResponse.json(
          { ok: false, error: 'CHUNK_ALREADY_RENDERED_OR_RUNNING', render_status: s },
          { status: 409 }
        )
      }

      const chunkIdentityGateForRequest = await supabaseAdmin
        .from('gate_evaluations')
        .select('decision')
        .eq('project_id', String(project_id))
        .eq('gate_type', 'identity')
        .eq('scope_type', 'chunk')
        .eq('chunk_id', renderChunkContext.chunk_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (chunkIdentityGateForRequest.error) {
        return NextResponse.json(
          { ok: false, error: chunkIdentityGateForRequest.error.message },
          { status: 500 }
        )
      }

      if (chunkIdentityGateForRequest.data?.decision === 'blocked') {
        return NextResponse.json(
          { ok: false, error: 'CHUNK_IDENTITY_GATE_BLOCKED' },
          { status: 403 }
        )
      }
    }

    const { data: dupRow, error: dupError } = await supabaseAdmin
      .from('jobs')
      .select('id')
      .eq('project_id', project_id)
      .eq('job_type', job_type)
      .in('status', ['queued', 'running'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (dupError) {
      return NextResponse.json(
        { ok: false, error: dupError.message },
        { status: 500 }
      )
    }

    if (dupRow?.id != null && String(dupRow.id).trim() !== '') {
      return NextResponse.json(
        {
          ok: false,
          error: 'JOB_ALREADY_RUNNING',
          job_id: String(dupRow.id),
        },
        { status: 409 }
      )
    }

    if (job_type === 'build_identity') {
      if (
        !reference_asset_id ||
        !embedding_key ||
        !latent_base_key ||
        !anchor_manifest_key ||
        !identity_status
      ) {
        return NextResponse.json(
          { ok: false, error: 'BUILD_IDENTITY_PAYLOAD_REQUIRED' },
          { status: 400 }
        )
      }

      if (!ALLOWED_IDENTITY_STATUS.includes(identity_status)) {
        return NextResponse.json(
          { ok: false, error: 'INVALID_IDENTITY_STATUS' },
          { status: 400 }
        )
      }
    }

    if (job_type === 'preview') {
      if (!ALLOWED_PREVIEW_INPUT_MODE.includes(input_mode as (typeof ALLOWED_PREVIEW_INPUT_MODE)[number])) {
        return NextResponse.json(
          { ok: false, error: 'INVALID_INPUT_MODE' },
          { status: 400 }
        )
      }

      if (input_mode === 'prompt_image') {
        if (!instruction) {
          return NextResponse.json(
            { ok: false, error: 'INSTRUCTION_REQUIRED' },
            { status: 400 }
          )
        }
      } else if (input_mode === 'image_remix') {
        const refId =
          typeof reference_asset_id === 'string'
            ? reference_asset_id.trim()
            : reference_asset_id != null
              ? String(reference_asset_id).trim()
              : ''

        if (!refId) {
          return NextResponse.json(
            { ok: false, error: 'REFERENCE_ASSET_REQUIRED' },
            { status: 400 }
          )
        }

        if (!isValidUuid(refId)) {
          return NextResponse.json(
            { ok: false, error: 'INVALID_REFERENCE_ASSET_ID' },
            { status: 400 }
          )
        }

        const refCheck = await supabaseAdmin
          .from('source_assets')
          .select('id')
          .eq('id', refId)
          .eq('project_id', project_id)
          .eq('asset_type', 'reference')
          .or('validation_status.eq.validated,asset_status.eq.validated,asset_status.eq.active')
          .maybeSingle()

        if (refCheck.error) {
          return NextResponse.json(
            { ok: false, error: refCheck.error.message },
            { status: 500 }
          )
        }

        if (!refCheck.data?.id) {
          return NextResponse.json(
            { ok: false, error: 'REFERENCE_ASSET_NOT_ALLOWED' },
            { status: 403 }
          )
        }
      }
    }

    const costSnapshot = getMvpJobCostPolicy(job_type)

    let previousChunkRenderStatus: string | null = null
    if (job_type === 'render_chunk' && renderChunkContext) {
      previousChunkRenderStatus = renderChunkContext.render_status ?? null
      const updateChunkQueued = await supabaseAdmin
        .from('sequence_chunks')
        .update({ render_status: 'queued' })
        .eq('id', renderChunkContext.chunk_id)
        .select('id')
        .maybeSingle()
      if (updateChunkQueued.error) {
        return NextResponse.json({ ok: false, error: 'CHUNK_STATUS_UPDATE_FAILED' }, { status: 500 })
      }
    }

    const { data, error } = await supabaseAdmin
      .from('jobs')
      .insert({
        project_id,
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
      })
      .select('id, project_id, job_type, status, created_at')
      .single()

    if (error) {
      const rollbackFields: Record<string, unknown> = {}
      if (job_type === 'render_chunk' && renderChunkContext) {
        const rb = await rollbackRenderChunkQueuedToPreviousStatus({
          chunkId: renderChunkContext.chunk_id,
          previousRenderStatus: previousChunkRenderStatus,
        })
        rollbackFields.rollback_success = rb.rollback_success
        rollbackFields.rollback_to_status = rb.rollback_to_status
        rollbackFields.rollback_error = rb.rollback_error
      }

      if (
        error.message.includes('foreign key') ||
        error.message.includes('violates foreign key constraint')
      ) {
        return NextResponse.json(
          { ok: false, error: 'INVALID_PROJECT_ID', ...rollbackFields },
          { status: 400 }
        )
      }

      return NextResponse.json(
        { ok: false, error: error.message, ...rollbackFields },
        { status: 500 }
      )
    }

    if (!data) {
      const rollbackFields: Record<string, unknown> = {}
      if (job_type === 'render_chunk' && renderChunkContext) {
        const rb = await rollbackRenderChunkQueuedToPreviousStatus({
          chunkId: renderChunkContext.chunk_id,
          previousRenderStatus: previousChunkRenderStatus,
        })
        rollbackFields.rollback_success = rb.rollback_success
        rollbackFields.rollback_to_status = rb.rollback_to_status
        rollbackFields.rollback_error = rb.rollback_error
      }
      return NextResponse.json(
        { ok: false, error: 'JOB_CREATE_NO_DATA', ...rollbackFields },
        { status: 500 }
      )
    }

    try {
      const queuePayload =
        job_type === 'build_identity'
          ? {
              job_id: data.id,
              project_id,
              reference_asset_id,
              embedding_key,
              latent_base_key,
              anchor_manifest_key,
              identity_status,
              build_score,
            }
          : job_type === 'preview'
            ? {
                job_id: data.id,
                project_id,
                input_mode,
                instruction,
                reference_asset_id:
                  typeof reference_asset_id === 'string'
                    ? reference_asset_id.trim()
                    : reference_asset_id == null
                      ? null
                      : String(reference_asset_id).trim(),
              }
            : job_type === 'render_chunk'
              ? {
                  job_id: data.id,
                  project_id,
                  chunk_id: chunk_id,
                }
            : {
                job_id: data.id,
                project_id,
              }

      await jobQueue.add('job', {
        job_type,
        payload: queuePayload,
      }, { jobId: String(data.id) })
    } catch (error) {
      console.error('POST /api/job/create enqueue error:', error)

      const errorDetail =
        error instanceof Error ? error.message : 'UNKNOWN_ERROR'

      const now = new Date().toISOString()
      try {
        const { error: fixError } = await supabaseAdmin
          .from('jobs')
          .update({
            status: 'failed',
            error_code: 'JOB_ENQUEUE_FAILED',
            error_message: errorDetail,
            finished_at: now,
            updated_at: now,
          })
          .eq('id', data.id)
        if (fixError) {
          console.warn('POST /api/job/create enqueue failure fix warning:', fixError.message)
        }
      } catch (fixException) {
        console.warn('POST /api/job/create enqueue failure fix exception:', fixException)
      }

      if (job_type === 'render_chunk' && renderChunkContext) {
        try {
          const fixChunk = await supabaseAdmin
            .from('sequence_chunks')
            .update({ render_status: 'failed' })
            .eq('id', renderChunkContext.chunk_id)
          if (fixChunk.error) {
            console.warn('POST /api/job/create enqueue failure chunk fix warning:', fixChunk.error.message)
          }
        } catch (chunkFixException) {
          console.warn('POST /api/job/create enqueue failure chunk fix exception:', chunkFixException)
        }

        try {
          const { error: chunkEventError } = await supabaseAdmin.from('job_events').insert({
            job_id: data.id,
            level: 'error',
            step: 'render_chunk_enqueue_failed',
            message: 'Failed to enqueue render_chunk job',
            payload: {
              chunk_id: renderChunkContext.chunk_id,
              previous_render_status: previousChunkRenderStatus,
              attempted_render_status: 'queued',
              error: errorDetail,
              job_type,
              project_id,
            },
          })
          if (chunkEventError) {
            console.warn(
              'POST /api/job/create render_chunk_enqueue_failed job_events insert warning:',
              chunkEventError.message
            )
          }
        } catch (eventException) {
          console.warn(
            'POST /api/job/create render_chunk_enqueue_failed job_events insert exception:',
            eventException
          )
        }
      }

      try {
        const { error: eventError } = await supabaseAdmin.from('job_events').insert({
          job_id: data.id,
          level: 'error',
          step: 'enqueue_failed',
          message: 'Failed to enqueue job',
          payload: {
            error: errorDetail,
            job_type,
            project_id,
            ...(job_type === 'render_chunk' ? { chunk_id } : {}),
          },
        })
        if (eventError) {
          console.warn(
            'POST /api/job/create enqueue_failed job_events insert warning:',
            eventError.message
          )
        }
      } catch (eventException) {
        console.warn(
          'POST /api/job/create enqueue_failed job_events insert exception:',
          eventException
        )
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

    return NextResponse.json({
      ok: true,
      data: {
        job_id: data.id,
        project_id: data.project_id,
        job_type: data.job_type,
        status: data.status,
        created_at: data.created_at,
      },
    })
  } catch (error) {
    console.error('POST /api/job/create error:', error)

    const errorDetail =
      error instanceof Error ? error.message : 'UNKNOWN_ERROR'

    return NextResponse.json(
      {
        ok: false,
        error: 'INVALID_REQUEST',
        error_detail: errorDetail,
      },
      { status: 400 }
    )
  }
}
