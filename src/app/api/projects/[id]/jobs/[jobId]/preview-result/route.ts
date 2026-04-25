import { NextResponse } from 'next/server'

import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { supabaseAdmin } from '@/lib/supabase/admin'

type RouteContext = {
  params: Promise<{ id?: string; jobId?: string }>
}

function isValidUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

export async function DELETE(_req: Request, context: RouteContext) {
  try {
    const supabase = await createAuthServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ ok: false, error: 'AUTH_REQUIRED' }, { status: 401 })
    }

    const resolved = await context.params
    const projectId = typeof resolved?.id === 'string' ? resolved.id.trim() : ''
    const jobId = typeof resolved?.jobId === 'string' ? resolved.jobId.trim() : ''

    if (!projectId || !jobId || !isValidUuid(projectId) || !isValidUuid(jobId)) {
      return NextResponse.json({ ok: false, error: 'INVALID_ID' }, { status: 400 })
    }

    const { data: projectRow, error: projectError } = await supabaseAdmin
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .eq('owner_user_id', user.id)
      .maybeSingle()

    if (projectError) {
      return NextResponse.json({ ok: false, error: projectError.message }, { status: 500 })
    }

    if (!projectRow) {
      return NextResponse.json({ ok: false, error: 'PROJECT_NOT_FOUND' }, { status: 404 })
    }

    const { data: jobRow, error: jobError } = await supabaseAdmin
      .from('jobs')
      .select('id, job_type, output_asset_key')
      .eq('id', jobId)
      .eq('project_id', projectId)
      .eq('job_type', 'preview')
      .maybeSingle()

    if (jobError) {
      return NextResponse.json({ ok: false, error: jobError.message }, { status: 500 })
    }

    if (!jobRow?.id) {
      return NextResponse.json({ ok: false, error: 'JOB_NOT_FOUND' }, { status: 404 })
    }

    const deleted_asset_key =
      jobRow.output_asset_key == null ? null : String(jobRow.output_asset_key).trim()

    if (deleted_asset_key && deleted_asset_key !== '') {
      try {
        const { error: removeError } = await supabaseAdmin.storage
          .from('project-media')
          .remove([deleted_asset_key])
        if (removeError) {
          console.warn(
            'DELETE /api/projects/[id]/jobs/[jobId]/preview-result storage remove warning:',
            removeError.message
          )
        }
      } catch (error) {
        console.warn(
          'DELETE /api/projects/[id]/jobs/[jobId]/preview-result storage remove exception:',
          error
        )
      }
    }

    const now = new Date().toISOString()
    const { error: updateError } = await supabaseAdmin
      .from('jobs')
      .update({
        output_asset_key: null,
        error_code: null,
        error_message: null,
        updated_at: now,
      })
      .eq('id', jobId)
      .eq('project_id', projectId)

    if (updateError) {
      return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 })
    }

    const { error: eventError } = await supabaseAdmin.from('job_events').insert({
      job_id: jobId,
      level: 'info',
      step: 'preview_result_deleted',
      message: 'Preview result deleted by user',
      payload: {
        project_id: projectId,
        job_id: jobId,
        deleted_asset_key,
        requested_by_user_id: user.id,
      },
    })

    if (eventError) {
      return NextResponse.json({ ok: false, error: eventError.message }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      data: { job_id: jobId, deleted_asset_key },
    })
  } catch (error) {
    console.error('DELETE /api/projects/[id]/jobs/[jobId]/preview-result error:', error)
    const detail = error instanceof Error ? error.message : 'UNKNOWN_ERROR'
    return NextResponse.json(
      { ok: false, error: 'INVALID_REQUEST', error_detail: detail },
      { status: 400 }
    )
  }
}

