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

    const { data, error } = await supabaseAdmin
      .from('gate_evaluations')
      .select(
        'project_id, gate_type, decision, measured_value, threshold, reason_code, created_at'
      )
      .eq('project_id', project_id)
      .eq('gate_type', 'identity')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 }
      )
    }

    if (!data) {
      return NextResponse.json({
        ok: true,
        data: {
          project_id,
          gate_type: 'identity',
          status: 'no_gate',
          measured_value: null,
          threshold: null,
          reason_code: null,
          evaluated_at: null,
        },
      })
    }

    return NextResponse.json({
      ok: true,
      data: {
        project_id: data.project_id,
        gate_type: 'identity',
        status: data.decision,
        measured_value: data.measured_value,
        threshold: data.threshold,
        reason_code: data.reason_code,
        evaluated_at: data.created_at,
      },
    })
  } catch (error) {
    console.error('GET /api/projects/[id]/gate-status error:', error)

    const errorDetail =
      error instanceof Error ? error.message : 'UNKNOWN_ERROR'

    return NextResponse.json(
      { ok: false, error: 'INVALID_REQUEST', error_detail: errorDetail },
      { status: 400 }
    )
  }
}
