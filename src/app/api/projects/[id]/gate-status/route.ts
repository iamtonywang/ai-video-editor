import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

type RouteContext = {
  params: Promise<{ id: string }>
}

type GateUiStatus = 'passed' | 'blocked' | 'no_gate'

type GateEvaluationScopeRow = {
  project_id: string
  gate_type: string
  decision: string | null
  measured_value: number | null
  threshold: number | null
  reason_code: string | null
  created_at: string
  scope_type: string | null
  chunk_id: string | null
  job_id: string | null
}

type ScopeGatePayload = {
  status: GateUiStatus
  measured_value: number | null
  threshold: number | null
  reason_code: string | null
  scope_type: string
  chunk_id: string | null
  job_id: string | null
  created_at: string | null
}

function isValidProjectUuid(projectId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    projectId
  )
}

function normalizeGateUiStatus(decision: string | null | undefined): GateUiStatus {
  if (decision === 'passed' || decision === 'blocked') {
    return decision
  }
  return 'no_gate'
}

function toFiniteNumberOrNull(v: unknown): number | null {
  if (v == null) return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function mapEvaluationToScopePayload(
  row: GateEvaluationScopeRow | null,
  scopeType: 'project' | 'job' | 'chunk'
): ScopeGatePayload | null {
  if (!row) {
    return null
  }
  return {
    status: normalizeGateUiStatus(row.decision == null ? undefined : String(row.decision)),
    measured_value: toFiniteNumberOrNull(row.measured_value),
    threshold: toFiniteNumberOrNull(row.threshold),
    reason_code: row.reason_code == null ? null : String(row.reason_code),
    scope_type: scopeType,
    chunk_id: row.chunk_id == null ? null : String(row.chunk_id),
    job_id: row.job_id == null ? null : String(row.job_id),
    created_at: row.created_at == null ? null : String(row.created_at),
  }
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

    const selectCols =
      'project_id, gate_type, decision, measured_value, threshold, reason_code, created_at, scope_type, chunk_id, job_id'

    const { data, error } = await supabaseAdmin
      .from('gate_evaluations')
      .select(selectCols)
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

    const [projectScopeRes, jobScopeRes, chunkScopeRes] = await Promise.all([
      supabaseAdmin
        .from('gate_evaluations')
        .select(selectCols)
        .eq('project_id', project_id)
        .eq('gate_type', 'identity')
        .eq('scope_type', 'project')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from('gate_evaluations')
        .select(selectCols)
        .eq('project_id', project_id)
        .eq('gate_type', 'identity')
        .eq('scope_type', 'job')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from('gate_evaluations')
        .select(selectCols)
        .eq('project_id', project_id)
        .eq('gate_type', 'identity')
        .eq('scope_type', 'chunk')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    if (projectScopeRes.error || jobScopeRes.error || chunkScopeRes.error) {
      const msg =
        projectScopeRes.error?.message ||
        jobScopeRes.error?.message ||
        chunkScopeRes.error?.message ||
        'GATE_SCOPE_QUERY_FAILED'
      return NextResponse.json({ ok: false, error: msg }, { status: 500 })
    }

    const scopes = {
      project: mapEvaluationToScopePayload(
        projectScopeRes.data as GateEvaluationScopeRow | null,
        'project'
      ),
      job: mapEvaluationToScopePayload(jobScopeRes.data as GateEvaluationScopeRow | null, 'job'),
      chunk: mapEvaluationToScopePayload(chunkScopeRes.data as GateEvaluationScopeRow | null, 'chunk'),
    }

    if (!data) {
      return NextResponse.json({
        ok: true,
        data: {
          project_id,
          gate_type: 'identity',
          status: 'no_gate' as GateUiStatus,
          measured_value: null,
          threshold: null,
          reason_code: null,
          evaluated_at: null,
          scopes,
        },
      })
    }

    const row = data as GateEvaluationScopeRow

    return NextResponse.json({
      ok: true,
      data: {
        project_id: row.project_id,
        gate_type: 'identity',
        status: normalizeGateUiStatus(row.decision == null ? undefined : String(row.decision)),
        measured_value: toFiniteNumberOrNull(row.measured_value),
        threshold: toFiniteNumberOrNull(row.threshold),
        reason_code: row.reason_code == null ? null : String(row.reason_code),
        evaluated_at: row.created_at == null ? null : String(row.created_at),
        scopes,
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
