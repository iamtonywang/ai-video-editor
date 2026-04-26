import { NextRequest, NextResponse } from 'next/server'
import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { supabaseAdmin } from '@/lib/supabase/admin'

const ALLOWED_DIFFICULTY_LEVEL = ['low', 'medium', 'high']

function isValidSequenceUuid(sequenceId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    sequenceId
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

    const sequence_id = body?.sequence_id
    const scene_index = body?.scene_index
    const start_sec = body?.start_sec
    const end_sec = body?.end_sec
    const difficulty_level =
      typeof body?.difficulty_level === 'string'
        ? body.difficulty_level.trim()
        : ''

    if (
      !sequence_id ||
      scene_index == null ||
      start_sec == null ||
      end_sec == null ||
      !difficulty_level
    ) {
      return NextResponse.json(
        { ok: false, error: 'REQUIRED_FIELDS_MISSING' },
        { status: 400 }
      )
    }

    const sequenceIdStr =
      typeof sequence_id === 'string' ? sequence_id.trim() : String(sequence_id).trim()

    if (!isValidSequenceUuid(sequenceIdStr)) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_SEQUENCE_ID' },
        { status: 400 }
      )
    }

    if (
      typeof scene_index !== 'number' ||
      typeof start_sec !== 'number' ||
      typeof end_sec !== 'number'
    ) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_FIELD_TYPE' },
        { status: 400 }
      )
    }

    if (!ALLOWED_DIFFICULTY_LEVEL.includes(difficulty_level)) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_DIFFICULTY_LEVEL' },
        { status: 400 }
      )
    }

    if (scene_index < 0) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_SCENE_INDEX' },
        { status: 400 }
      )
    }

    if (start_sec < 0 || end_sec <= start_sec) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_TIME_RANGE' },
        { status: 400 }
      )
    }

    const sequenceProject = await supabaseAdmin
      .from('sequences')
      .select('project_id')
      .eq('id', sequenceIdStr)
      .maybeSingle()

    if (sequenceProject.error) {
      return NextResponse.json(
        { ok: false, error: sequenceProject.error.message },
        { status: 500 }
      )
    }

    if (!sequenceProject.data?.project_id) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_SEQUENCE_ID' },
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

    const { data, error } = await supabaseAdmin
      .from('sequence_scenes')
      .insert({
        sequence_id: sequenceIdStr,
        scene_index,
        start_sec,
        end_sec,
        difficulty_level,
      })
      .select('id, sequence_id, scene_index, start_sec, end_sec, difficulty_level, created_at')
      .single()

    if (error) {
      if (error.message.includes('duplicate key')) {
        return NextResponse.json(
          { ok: false, error: 'SCENE_ALREADY_EXISTS' },
          { status: 409 }
        )
      }

      if (
        error.message.includes('foreign key') ||
        error.message.includes('violates foreign key constraint')
      ) {
        return NextResponse.json(
          { ok: false, error: 'INVALID_SEQUENCE_ID' },
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
        { ok: false, error: 'SCENE_CREATE_NO_DATA' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      ok: true,
      data: {
        scene_id: data.id,
        sequence_id: data.sequence_id,
        scene_index: data.scene_index,
        start_sec: data.start_sec,
        end_sec: data.end_sec,
        difficulty_level: data.difficulty_level,
        created_at: data.created_at,
      },
    })
  } catch (error) {
    console.error('POST /api/sequence/scene/create error:', error)

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
