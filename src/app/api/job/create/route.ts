import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

const ALLOWED_JOB_TYPE = [
  'analyze',
  'build_identity',
  'render_chunk',
  'preview',
  'quality_eval',
]

const ALLOWED_STATUS = [
  'queued',
  'running',
  'success',
  'failed',
  'canceled',
]

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const project_id = body?.project_id
    const job_type =
      typeof body?.job_type === 'string' ? body.job_type.trim() : ''
    const status =
      typeof body?.status === 'string' ? body.status.trim() : ''

    if (!project_id || !job_type || !status) {
      return NextResponse.json(
        { ok: false, error: 'REQUIRED_FIELDS_MISSING' },
        { status: 400 }
      )
    }

    if (!ALLOWED_JOB_TYPE.includes(job_type)) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_JOB_TYPE' },
        { status: 400 }
      )
    }

    if (!ALLOWED_STATUS.includes(status)) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_STATUS' },
        { status: 400 }
      )
    }

    const { data, error } = await supabaseAdmin
      .from('jobs')
      .insert({
        project_id,
        job_type,
        status,
      })
      .select('id, project_id, job_type, status, created_at')
      .single()

    if (error) {
      if (
        error.message.includes('foreign key') ||
        error.message.includes('violates foreign key constraint')
      ) {
        return NextResponse.json(
          { ok: false, error: 'INVALID_PROJECT_ID' },
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
        { ok: false, error: 'JOB_CREATE_NO_DATA' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      ok: true,
      data: {
        job_id: data.id,
        project_id: data.project_id,
        job_type: data.job_type,
        status: data.status,
        created_at: data.created_at,
      },
    })
  } catch (error) {
    console.error('POST /api/job/create error:', error)

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
