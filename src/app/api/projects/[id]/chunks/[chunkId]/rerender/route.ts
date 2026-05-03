import { NextResponse } from 'next/server'
import { jobQueue } from '@/lib/queue'
import { enqueueRenderChunkRerenderJob } from '@/lib/server/enqueue-render-chunk-rerender'
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

    const enqueueResult = await enqueueRenderChunkRerenderJob({
      supabase: supabaseAdmin,
      jobQueue,
      projectId,
      chunkId,
      sequenceId,
      reason: 'manual_rerender',
    })

    if (!enqueueResult.ok) {
      if (enqueueResult.code === 'DUP_JOB_QUERY_FAILED') {
        return NextResponse.json(
          { ok: false, error: enqueueResult.code, error_detail: enqueueResult.message },
          { status: 500 }
        )
      }
      if (enqueueResult.code === 'CHUNK_ALREADY_RUNNING') {
        return NextResponse.json({ ok: false, error: 'CHUNK_ALREADY_RUNNING' }, { status: 409 })
      }
      if (enqueueResult.code === 'RERENDER_STATE_CHANGED') {
        return NextResponse.json({ ok: false, error: 'RERENDER_STATE_CHANGED' }, { status: 409 })
      }
      if (enqueueResult.code === 'RERENDER_STATUS_NOT_ALLOWED') {
        return NextResponse.json(
          { ok: false, error: 'RERENDER_STATUS_NOT_ALLOWED', error_detail: enqueueResult.message },
          { status: 400 }
        )
      }
      return NextResponse.json(
        {
          ok: false,
          error: enqueueResult.code,
          error_detail: enqueueResult.message,
        },
        { status: 500 }
      )
    }

    const { data: jobRow } = await supabaseAdmin
      .from('jobs')
      .select('id, project_id, sequence_id, chunk_id, status, created_at')
      .eq('id', enqueueResult.jobId)
      .maybeSingle()

    const { data: chunkAfter } = await supabaseAdmin
      .from('sequence_chunks')
      .select('identity_attempt_count')
      .eq('id', chunkId)
      .maybeSingle()

    return NextResponse.json({
      ok: true,
      data: {
        job_id: jobRow?.id ?? enqueueResult.jobId,
        project_id: jobRow?.project_id ?? projectId,
        sequence_id: jobRow?.sequence_id ?? sequenceId,
        chunk_id: jobRow?.chunk_id ?? chunkId,
        status: jobRow?.status ?? 'queued',
        render_status: 'queued',
        identity_attempt_count: parseAttemptCount(chunkAfter?.identity_attempt_count),
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
