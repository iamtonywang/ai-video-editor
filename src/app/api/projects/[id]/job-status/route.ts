import { NextResponse } from 'next/server'
import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { supabaseAdmin } from '@/lib/supabase/admin'

type RouteContext = {
  params: Promise<{ id?: string }>
}

function isValidProjectUuid(projectId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    projectId
  )
}

export async function GET(_req: Request, context: RouteContext) {
  try {
    const supabase = await createAuthServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ ok: false, error: 'AUTH_REQUIRED' }, { status: 401 })
    }

    const resolved = await context.params
    const project_id = typeof resolved?.id === 'string' ? resolved.id.trim() : ''

    if (!project_id || !isValidProjectUuid(project_id)) {
      return NextResponse.json({ ok: false, error: 'INVALID_PROJECT_ID' }, { status: 400 })
    }

    const { data: projectRow, error: projectError } = await supabaseAdmin
      .from('projects')
      .select('id')
      .eq('id', project_id)
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
      .select(
        'id, job_type, status, progress, error_code, error_message, created_at, started_at, finished_at, output_asset_key, kill_signal, cost_estimate, cost_accumulated, cost_actual, soft_cost_limit, hard_cost_limit, estimated_cost_preflight, budget_precheck_status, budget_precheck_reason'
      )
      .eq('project_id', project_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (jobError) {
      return NextResponse.json({ ok: false, error: jobError.message }, { status: 500 })
    }

    if (!jobRow?.id) {
      return NextResponse.json({
        ok: true,
        data: { job: null, latest_event: null },
      })
    }

    const { data: eventRow, error: eventError } = await supabaseAdmin
      .from('job_events')
      .select('level, step, message, event_ts')
      .eq('job_id', String(jobRow.id))
      .order('event_ts', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (eventError) {
      return NextResponse.json({ ok: false, error: eventError.message }, { status: 500 })
    }

    const outputAssetKey =
      jobRow.output_asset_key == null ? null : String(jobRow.output_asset_key).trim()

    let preview_url: string | null = null
    if (
      jobRow.job_type === 'preview' &&
      jobRow.status === 'success' &&
      outputAssetKey &&
      outputAssetKey !== ''
    ) {
      const signed = await supabaseAdmin.storage
        .from('project-media')
        .createSignedUrl(outputAssetKey, 3600)
      if (!signed.error && signed.data?.signedUrl) {
        preview_url = signed.data.signedUrl
      }
    }

    const row = jobRow as {
      kill_signal?: boolean | null
      cost_estimate?: number | null
      cost_accumulated?: number | null
      cost_actual?: number | null
      soft_cost_limit?: number | null
      hard_cost_limit?: number | null
      estimated_cost_preflight?: number | null
      budget_precheck_status?: string | null
      budget_precheck_reason?: string | null
    }

    return NextResponse.json({
      ok: true,
      data: {
        job: {
          id: String(jobRow.id),
          job_type: jobRow.job_type,
          status: jobRow.status,
          progress: jobRow.progress,
          error_code: jobRow.error_code,
          error_message: jobRow.error_message,
          created_at: jobRow.created_at,
          started_at: jobRow.started_at,
          finished_at: jobRow.finished_at,
          output_asset_key: outputAssetKey ? outputAssetKey : null,
          preview_url,
          kill_signal: row.kill_signal == null ? false : Boolean(row.kill_signal),
          cost_estimate: row.cost_estimate ?? null,
          cost_accumulated: row.cost_accumulated ?? null,
          cost_actual: row.cost_actual ?? null,
          soft_cost_limit: row.soft_cost_limit ?? null,
          hard_cost_limit: row.hard_cost_limit ?? null,
          estimated_cost_preflight: row.estimated_cost_preflight ?? null,
          budget_precheck_status: row.budget_precheck_status ?? null,
          budget_precheck_reason: row.budget_precheck_reason ?? null,
        },
        latest_event: eventRow
          ? {
              level: eventRow.level,
              step: eventRow.step,
              message: eventRow.message,
              event_ts: eventRow.event_ts,
            }
          : null,
      },
    })
  } catch (error) {
    console.error('GET /api/projects/[id]/job-status error:', error)
    const detail = error instanceof Error ? error.message : 'UNKNOWN_ERROR'
    return NextResponse.json(
      { ok: false, error: 'INVALID_REQUEST', error_detail: detail },
      { status: 400 }
    )
  }
}

