import { NextRequest, NextResponse } from 'next/server'
import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { supabaseAdmin } from '@/lib/supabase/admin'

const ALLOWED_READINESS_STATUS = ['pending', 'analyzing', 'ready', 'failed']

function isValidProjectUuid(projectId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    projectId
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

    const project_id = body?.project_id
    const source_asset_id = body?.source_asset_id
    const duration_sec = body?.duration_sec
    const fps = body?.fps
    const width = body?.width
    const height = body?.height
    const scene_count = body?.scene_count
    const readiness_status =
      typeof body?.readiness_status === 'string'
        ? body.readiness_status.trim()
        : ''

    if (
      !project_id ||
      !source_asset_id ||
      duration_sec == null ||
      fps == null ||
      width == null ||
      height == null ||
      scene_count == null ||
      !readiness_status
    ) {
      return NextResponse.json(
        { ok: false, error: 'REQUIRED_FIELDS_MISSING' },
        { status: 400 }
      )
    }

    const projectIdStr =
      typeof project_id === 'string' ? project_id.trim() : String(project_id).trim()

    if (!isValidProjectUuid(projectIdStr)) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_PROJECT_ID' },
        { status: 400 }
      )
    }

    const { data: projectRow, error: projectError } = await supabaseAdmin
      .from('projects')
      .select('id')
      .eq('id', projectIdStr)
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

    if (!ALLOWED_READINESS_STATUS.includes(readiness_status)) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_READINESS_STATUS' },
        { status: 400 }
      )
    }

    if (
      typeof duration_sec !== 'number' ||
      typeof fps !== 'number' ||
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      typeof scene_count !== 'number'
    ) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_FIELD_TYPE' },
        { status: 400 }
      )
    }

    if (duration_sec <= 0 || fps <= 0 || width <= 0 || height <= 0) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_NUMERIC_RANGE' },
        { status: 400 }
      )
    }

    if (scene_count < 0) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_SCENE_COUNT' },
        { status: 400 }
      )
    }

    const latestIdentityGate = await supabaseAdmin
      .from('gate_evaluations')
      .select('decision')
      .eq('project_id', projectIdStr)
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
      .from('sequences')
      .insert({
        project_id: projectIdStr,
        source_asset_id,
        duration_sec,
        fps,
        width,
        height,
        scene_count,
        readiness_status,
      })
      .select('id, project_id, source_asset_id, readiness_status, created_at')
      .single()

    if (error) {
      if (error.message.includes('duplicate key')) {
        return NextResponse.json(
          { ok: false, error: 'SEQUENCE_ALREADY_EXISTS' },
          { status: 409 }
        )
      }

      if (
        error.message.includes('foreign key') ||
        error.message.includes('violates foreign key constraint')
      ) {
        return NextResponse.json(
          { ok: false, error: 'INVALID_PROJECT_OR_SOURCE_ASSET' },
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
        { ok: false, error: 'SEQUENCE_CREATE_NO_DATA' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      ok: true,
      data: {
        sequence_id: data.id,
        project_id: data.project_id,
        source_asset_id: data.source_asset_id,
        readiness_status: data.readiness_status,
        created_at: data.created_at,
      },
    })
  } catch (error) {
    console.error('POST /api/sequence/create error:', error)

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
