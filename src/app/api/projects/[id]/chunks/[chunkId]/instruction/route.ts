import { NextResponse } from 'next/server'

import { isValidUuid } from '@/lib/is-valid-uuid'
import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { supabaseAdmin } from '@/lib/supabase/admin'

const INSTRUCTION_MAX_LENGTH = 2000

/** `queued` / `running` 제외 — `sequence/chunk/create`의 `ALLOWED_RENDER_STATUS`와 동일 집합에서 제거. */
const INSTRUCTION_PATCH_ALLOWED_RENDER_STATUS = [
  'pending',
  'rendered',
  'gate_pending',
  'approved',
  'failed',
  'rerender_pending',
  'degraded',
  'stopped',
] as const

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id?: string; chunkId?: string }> }
) {
  try {
    const { id: projectIdRaw, chunkId: chunkIdRaw } = await context.params
    const projectId =
      typeof projectIdRaw === 'string' ? projectIdRaw.trim() : ''
    const chunkId = typeof chunkIdRaw === 'string' ? chunkIdRaw.trim() : ''

    if (
      typeof projectIdRaw !== 'string' ||
      typeof chunkIdRaw !== 'string' ||
      projectId === '' ||
      chunkId === '' ||
      !isValidUuid(projectId) ||
      !isValidUuid(chunkId)
    ) {
      return NextResponse.json({ ok: false, error: 'INVALID_PARAMS' }, { status: 400 })
    }

    const supabase = await createAuthServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ ok: false, error: 'AUTH_REQUIRED' }, { status: 401 })
    }

    const { data: chunkRow, error: chunkError } = await supabaseAdmin
      .from('sequence_chunks')
      .select('id, scene_id, render_status')
      .eq('id', chunkId)
      .maybeSingle()

    if (chunkError) {
      console.error('PATCH chunk instruction sequence_chunks read:', chunkError)
      return NextResponse.json({ ok: false, error: 'CHUNK_FETCH_FAILED' }, { status: 500 })
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
      console.error('PATCH chunk instruction sequence_scenes read:', sceneError)
      return NextResponse.json({ ok: false, error: 'SCENE_FETCH_FAILED' }, { status: 500 })
    }

    if (!sceneRow?.sequence_id) {
      return NextResponse.json({ ok: false, error: 'SCENE_NOT_FOUND' }, { status: 404 })
    }

    const { data: seqRow, error: seqError } = await supabaseAdmin
      .from('sequences')
      .select('id, project_id')
      .eq('id', String(sceneRow.sequence_id))
      .maybeSingle()

    if (seqError) {
      console.error('PATCH chunk instruction sequences read:', seqError)
      return NextResponse.json({ ok: false, error: 'SEQUENCE_FETCH_FAILED' }, { status: 500 })
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
      .eq('id', projectId)
      .eq('owner_user_id', user.id)
      .maybeSingle()

    if (ownerError) {
      console.error('PATCH chunk instruction projects owner read:', {
        projectId,
        userId: user.id,
        error: ownerError,
      })
      return NextResponse.json({ ok: false, error: 'PROJECT_OWNER_QUERY_FAILED' }, { status: 500 })
    }

    if (!ownerProject?.id) {
      return NextResponse.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 })
    }

    const rs = String(chunkRow.render_status ?? '').trim()
    if (rs === 'queued' || rs === 'running') {
      return NextResponse.json({ ok: false, error: 'CHUNK_RENDER_IN_PROGRESS' }, { status: 409 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ ok: false, error: 'INVALID_REQUEST' }, { status: 400 })
    }

    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ ok: false, error: 'INSTRUCTION_INVALID' }, { status: 400 })
    }

    const instructionRaw = (body as Record<string, unknown>).instruction
    if (typeof instructionRaw !== 'string') {
      return NextResponse.json({ ok: false, error: 'INSTRUCTION_INVALID' }, { status: 400 })
    }

    const cleanInstruction = instructionRaw.trim()
    if (cleanInstruction.length === 0) {
      return NextResponse.json({ ok: false, error: 'INSTRUCTION_REQUIRED' }, { status: 400 })
    }

    if (cleanInstruction.length > INSTRUCTION_MAX_LENGTH) {
      return NextResponse.json({ ok: false, error: 'INSTRUCTION_TOO_LONG' }, { status: 400 })
    }

    const allowedStatuses = [...INSTRUCTION_PATCH_ALLOWED_RENDER_STATUS]

    const { data, error: updateError } = await supabaseAdmin
      .from('sequence_chunks')
      .update({ instruction: cleanInstruction })
      .eq('id', chunkId)
      .in('render_status', allowedStatuses)
      .select('id, instruction, render_status')
      .maybeSingle()

    if (updateError) {
      console.error('PATCH chunk instruction sequence_chunks update:', updateError)
      return NextResponse.json({ ok: false, error: 'INSTRUCTION_UPDATE_FAILED' }, { status: 500 })
    }

    if (!data?.id) {
      return NextResponse.json({ ok: false, error: 'CHUNK_RENDER_IN_PROGRESS' }, { status: 409 })
    }

    return NextResponse.json({
      ok: true,
      data: {
        chunk_id: String(data.id),
        instruction: typeof data.instruction === 'string' ? data.instruction : String(data.instruction ?? ''),
        render_status:
          data.render_status == null ? '' : String(data.render_status).trim(),
      },
    })
  } catch (error) {
    console.error('PATCH /api/projects/[id]/chunks/[chunkId]/instruction error:', error)
    return NextResponse.json({ ok: false, error: 'INVALID_REQUEST' }, { status: 400 })
  }
}
