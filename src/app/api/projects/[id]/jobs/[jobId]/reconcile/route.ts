import { NextResponse } from 'next/server'

import { jobQueue } from '@/lib/queue'
import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { supabaseAdmin } from '@/lib/supabase/admin'

type RouteContext = {
  params: Promise<{ id?: string; jobId?: string }>
}

function isValidUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

export async function POST(_req: Request, context: RouteContext) {
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
      .select('id, status')
      .eq('id', jobId)
      .eq('project_id', projectId)
      .maybeSingle()

    if (jobError) {
      return NextResponse.json({ ok: false, error: jobError.message }, { status: 500 })
    }

    if (!jobRow?.id) {
      return NextResponse.json({ ok: false, error: 'JOB_NOT_FOUND' }, { status: 404 })
    }

    if (jobRow.status === 'success' || jobRow.status === 'failed' || jobRow.status === 'canceled') {
      return NextResponse.json({
        ok: true,
        data: {
          job_id: jobId,
          status: jobRow.status,
          reconciled: false,
          reason: 'JOB_ALREADY_TERMINAL',
        },
      })
    }

    if (jobRow.status !== 'queued') {
      return NextResponse.json(
        { ok: false, error: 'JOB_NOT_RECONCILABLE', status: jobRow.status },
        { status: 409 }
      )
    }

    let queueJob: unknown
    try {
      queueJob = await jobQueue.getJob(jobId)
    } catch (queueLookupError) {
      console.warn('POST /api/projects/[id]/jobs/[jobId]/reconcile queue lookup warning:', {
        projectId,
        jobId,
        error:
          queueLookupError instanceof Error ? queueLookupError.message : String(queueLookupError),
      })
      return NextResponse.json({ ok: false, error: 'QUEUE_LOOKUP_FAILED' }, { status: 500 })
    }

    if (queueJob) {
      return NextResponse.json({
        ok: true,
        data: {
          job_id: jobId,
          status: jobRow.status,
          reconciled: false,
          reason: 'QUEUE_JOB_EXISTS',
        },
      })
    }

    const now = new Date().toISOString()
    const reconcile = await supabaseAdmin
      .from('jobs')
      .update({
        status: 'canceled',
        error_code: 'QUEUE_JOB_NOT_FOUND',
        error_message: 'BullMQ job was not found for queued DB job',
        finished_at: now,
        updated_at: now,
      })
      .eq('id', jobId)
      .eq('project_id', projectId)
      .eq('status', 'queued')
      .select('id')
      .maybeSingle()

    if (reconcile.error) {
      return NextResponse.json({ ok: false, error: 'JOB_RECONCILE_FAILED' }, { status: 500 })
    }

    if (!reconcile.data) {
      const recheck = await supabaseAdmin
        .from('jobs')
        .select('status')
        .eq('id', jobId)
        .eq('project_id', projectId)
        .maybeSingle()

      return NextResponse.json(
        {
          ok: false,
          error: 'JOB_RECONCILE_RACE_CONDITION',
          status: recheck.error || !recheck.data ? null : recheck.data.status,
        },
        { status: 409 }
      )
    }

    const dedup = await supabaseAdmin
      .from('job_events')
      .select('id')
      .eq('job_id', jobId)
      .eq('step', 'queue_job_not_found_reconciled')
      .limit(1)
      .maybeSingle()

    if (dedup.error) {
      console.warn(
        'POST /api/projects/[id]/jobs/[jobId]/reconcile job_events dedup warning:',
        dedup.error.message
      )
    } else if (dedup.data?.id != null) {
      console.log('POST /api/projects/[id]/jobs/[jobId]/reconcile job_events dedup skip', {
        jobId,
      })
    } else {
      try {
        const { error: eventError } = await supabaseAdmin.from('job_events').insert({
          job_id: jobId,
          level: 'warn',
          step: 'queue_job_not_found_reconciled',
          message: 'Queued DB job canceled because BullMQ job was not found',
          payload: {
            project_id: projectId,
            job_id: jobId,
            requested_by_user_id: user.id,
            reason: 'queue_job_not_found',
            source: 'reconcile_api',
          },
        })
        if (eventError) {
          console.warn(
            'POST /api/projects/[id]/jobs/[jobId]/reconcile job_events insert warning:',
            eventError.message
          )
        }
      } catch (eventException) {
        console.warn(
          'POST /api/projects/[id]/jobs/[jobId]/reconcile job_events insert exception:',
          eventException
        )
      }
    }

    return NextResponse.json({
      ok: true,
      data: {
        job_id: jobId,
        status: 'canceled',
        reconciled: true,
      },
    })
  } catch (error) {
    console.error('POST /api/projects/[id]/jobs/[jobId]/reconcile error:', error)
    const detail = error instanceof Error ? error.message : 'UNKNOWN_ERROR'
    return NextResponse.json(
      { ok: false, error: 'INVALID_REQUEST', error_detail: detail },
      { status: 400 }
    )
  }
}

