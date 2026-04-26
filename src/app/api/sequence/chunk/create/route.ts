import { NextRequest, NextResponse } from 'next/server'
import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { supabaseAdmin } from '@/lib/supabase/admin'

const ALLOWED_RENDER_STATUS = [
  'pending',
  'queued',
  'running',
  'rendered',
  'gate_pending',
  'approved',
  'failed',
  'rerender_pending',
  'degraded',
  'stopped',
]

function isValidSceneUuid(sceneId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    sceneId
  )
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

    const scene_id = body?.scene_id
    const chunk_index = body?.chunk_index
    const start_sec = body?.start_sec
    const end_sec = body?.end_sec
    const overlap_prev_frames = body?.overlap_prev_frames
    const overlap_next_frames = body?.overlap_next_frames
    const identity_pass = body?.identity_pass
    const identity_attempt_count = body?.identity_attempt_count
    const identity_score =
      typeof body?.identity_score === 'number'
        ? body.identity_score
        : body?.identity_score === null
          ? null
          : undefined
    const render_status =
      typeof body?.render_status === 'string'
        ? body.render_status.trim()
        : ''

    if (
      !scene_id ||
      chunk_index == null ||
      start_sec == null ||
      end_sec == null ||
      overlap_prev_frames == null ||
      overlap_next_frames == null ||
      identity_pass == null ||
      identity_attempt_count == null ||
      !render_status
    ) {
      return NextResponse.json(
        { ok: false, error: 'REQUIRED_FIELDS_MISSING' },
        { status: 400 }
      )
    }

    const sceneIdStr =
      typeof scene_id === 'string' ? scene_id.trim() : String(scene_id).trim()

    if (!isValidSceneUuid(sceneIdStr)) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_SCENE_ID' },
        { status: 400 }
      )
    }

    if (
      typeof chunk_index !== 'number' ||
      typeof start_sec !== 'number' ||
      typeof end_sec !== 'number' ||
      typeof overlap_prev_frames !== 'number' ||
      typeof overlap_next_frames !== 'number' ||
      typeof identity_pass !== 'boolean' ||
      typeof identity_attempt_count !== 'number' ||
      (body?.identity_score !== undefined &&
        body?.identity_score !== null &&
        typeof body?.identity_score !== 'number')
    ) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_FIELD_TYPE' },
        { status: 400 }
      )
    }

    if (!ALLOWED_RENDER_STATUS.includes(render_status)) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_RENDER_STATUS' },
        { status: 400 }
      )
    }

    if (chunk_index < 0) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_CHUNK_INDEX' },
        { status: 400 }
      )
    }

    if (start_sec < 0 || end_sec <= start_sec) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_TIME_RANGE' },
        { status: 400 }
      )
    }

    if (overlap_prev_frames < 0 || overlap_next_frames < 0) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_OVERLAP_RANGE' },
        { status: 400 }
      )
    }

    if (identity_attempt_count < 0) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_IDENTITY_ATTEMPT_COUNT' },
        { status: 400 }
      )
    }

    const sceneSequence = await supabaseAdmin
      .from('sequence_scenes')
      .select('sequence_id')
      .eq('id', sceneIdStr)
      .maybeSingle()

    if (sceneSequence.error) {
      return NextResponse.json(
        { ok: false, error: sceneSequence.error.message },
        { status: 500 }
      )
    }

    if (!sceneSequence.data?.sequence_id) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_SCENE_ID' },
        { status: 400 }
      )
    }

    const sequenceProject = await supabaseAdmin
      .from('sequences')
      .select('project_id')
      .eq('id', sceneSequence.data.sequence_id)
      .maybeSingle()

    if (sequenceProject.error) {
      return NextResponse.json(
        { ok: false, error: sequenceProject.error.message },
        { status: 500 }
      )
    }

    if (!sequenceProject.data?.project_id) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_SCENE_ID' },
        { status: 400 }
      )
    }

    const resolvedProjectId = String(sequenceProject.data.project_id).trim()

    const { data: projectRow, error: projectError } = await supabaseAdmin
      .from('projects')
      .select('id')
      .eq('id', resolvedProjectId)
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

    const latestIdentityGate = await supabaseAdmin
      .from('gate_evaluations')
      .select('decision')
      .eq('project_id', resolvedProjectId)
      .eq('gate_type', 'identity')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (latestIdentityGate.error) {
      return NextResponse.json(
        { ok: false, error: latestIdentityGate.error.message },
        { status: 500 }
      )
    }

    if (latestIdentityGate.data?.decision === 'blocked') {
      return NextResponse.json(
        { ok: false, error: 'IDENTITY_GATE_BLOCKED' },
        { status: 403 }
      )
    }

    const chunkInsertPayload: Record<string, unknown> = {
      scene_id: sceneIdStr,
      chunk_index,
      start_sec,
      end_sec,
      overlap_prev_frames,
      overlap_next_frames,
      identity_pass,
      identity_attempt_count,
      render_status,
    }
    if (identity_score !== undefined) {
      chunkInsertPayload.identity_score = identity_score
    }

    const { data, error } = await supabaseAdmin
      .from('sequence_chunks')
      .insert(chunkInsertPayload)
      .select('id, scene_id, chunk_index, start_sec, end_sec, render_status, created_at')
      .single()

    if (error) {
      if (error.message.includes('duplicate key')) {
        return NextResponse.json(
          { ok: false, error: 'CHUNK_ALREADY_EXISTS' },
          { status: 409 }
        )
      }

      if (
        error.message.includes('foreign key') ||
        error.message.includes('violates foreign key constraint')
      ) {
        return NextResponse.json(
          { ok: false, error: 'INVALID_SCENE_ID' },
          { status: 400 }
        )
      }

      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 }
      )
    }

    if (!data) {
      return NextResponse.json(
        { ok: false, error: 'CHUNK_CREATE_NO_DATA' },
        { status: 500 }
      )
    }

    const chunkIdentityGateConfig = await supabaseAdmin
      .from('quality_gates')
      .select('threshold')
      .eq('project_id', resolvedProjectId)
      .eq('gate_type', 'identity')
      .eq('scope_type', 'chunk')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (chunkIdentityGateConfig.error) {
      console.error(
        'quality_gates_chunk_identity_read_failed:',
        chunkIdentityGateConfig.error.message
      )
    } else if (!chunkIdentityGateConfig.data) {
      console.error('quality_gates_chunk_identity_missing_for_project')
    } else if (identity_score == null) {
      console.error('chunk_gate_score_missing')
    } else {
      const threshold = chunkIdentityGateConfig.data.threshold
      const decision = identity_score >= threshold ? 'passed' : 'blocked'
      const reasonCode =
        decision === 'blocked' ? 'CHUNK_IDENTITY_SCORE_BELOW_THRESHOLD' : null

      const gateEvaluationInsert = await supabaseAdmin.from('gate_evaluations').insert({
        project_id: resolvedProjectId,
        gate_type: 'identity',
        scope_type: 'chunk',
        chunk_id: data.id,
        measured_value: identity_score,
        threshold,
        decision,
        reason_code: reasonCode,
      })

      if (gateEvaluationInsert.error) {
        console.error(
          'gate_evaluations_chunk_identity_insert_failed:',
          gateEvaluationInsert.error.message
        )
      }
    }

    return NextResponse.json({
      ok: true,
      data: {
        chunk_id: data.id,
        scene_id: data.scene_id,
        chunk_index: data.chunk_index,
        start_sec: data.start_sec,
        end_sec: data.end_sec,
        render_status: data.render_status,
        created_at: data.created_at,
      },
    })
  } catch (error) {
    console.error('POST /api/sequence/chunk/create error:', error)

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
