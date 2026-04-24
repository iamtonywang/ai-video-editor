import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

type RouteContext = {
  params: Promise<{ id: string }>
}

function isValidProjectUuid(projectId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    projectId
  )
}

export async function GET(_req: Request, context: RouteContext) {
  try {
    const { id } = await context.params
    const project_id = typeof id === 'string' ? id.trim() : ''

    if (!project_id) {
      return NextResponse.json(
        { ok: false, error: 'PROJECT_ID_REQUIRED' },
        { status: 400 }
      )
    }

    if (!isValidProjectUuid(project_id)) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_PROJECT_ID' },
        { status: 400 }
      )
    }

    const { data: refRow, error: refError } = await supabaseAdmin
      .from('source_assets')
      .select('id')
      .eq('project_id', project_id)
      .eq('asset_type', 'reference')
      .or('validation_status.eq.validated,asset_status.eq.validated,asset_status.eq.active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (refError) {
      return NextResponse.json(
        { ok: false, error: refError.message },
        { status: 500 }
      )
    }

    const reference_asset_id =
      refRow?.id != null && String(refRow.id).trim() !== ''
        ? String(refRow.id)
        : null
    const has_reference_asset = reference_asset_id !== null

    const { data: jobRow, error: jobError } = await supabaseAdmin
      .from('jobs')
      .select('id')
      .eq('project_id', project_id)
      .eq('job_type', 'build_identity')
      .in('status', ['queued', 'running'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (jobError) {
      return NextResponse.json(
        { ok: false, error: jobError.message },
        { status: 500 }
      )
    }

    const running_build_identity_job_id =
      jobRow?.id != null && String(jobRow.id).trim() !== ''
        ? String(jobRow.id)
        : null
    const has_running_build_identity = running_build_identity_job_id !== null

    const can_run_identity =
      has_reference_asset && !has_running_build_identity

    let blocked_reason: string | null = null
    if (!has_reference_asset) {
      blocked_reason = 'REFERENCE_ASSET_REQUIRED'
    } else if (has_running_build_identity) {
      blocked_reason = 'BUILD_IDENTITY_ALREADY_RUNNING'
    }

    return NextResponse.json({
      ok: true,
      data: {
        project_id,
        reference_asset_id,
        has_reference_asset,
        has_running_build_identity,
        running_build_identity_job_id,
        can_run_identity,
        blocked_reason,
      },
    })
  } catch (error) {
    console.error('GET /api/projects/[id]/execution-context error:', error)

    const errorDetail =
      error instanceof Error ? error.message : 'UNKNOWN_ERROR'

    return NextResponse.json(
      { ok: false, error: 'INVALID_REQUEST', error_detail: errorDetail },
      { status: 400 }
    )
  }
}
