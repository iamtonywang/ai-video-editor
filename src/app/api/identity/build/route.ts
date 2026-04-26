import { NextRequest, NextResponse } from 'next/server'
import { jobQueue } from '@/lib/queue'
import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { supabaseAdmin } from '@/lib/supabase/admin'

const ALLOWED_IDENTITY_STATUS = ['building', 'ready', 'failed', 'stale']

function isValidProjectUuid(projectId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    projectId
  )
}

function trimStr(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (v != null && String(v).trim() !== '') return String(v).trim()
  return ''
}

function asProjectId(v: unknown): string {
  const s = trimStr(v)
  return s
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

    const project_id = asProjectId(body?.project_id)
    if (!project_id) {
      return NextResponse.json(
        { ok: false, error: 'REQUIRED_FIELDS_MISSING' },
        { status: 400 }
      )
    }

    if (!isValidProjectUuid(project_id)) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_PROJECT_ID' },
        { status: 400 }
      )
    }

    const { data: projectRow, error: projectError } = await supabaseAdmin
      .from('projects')
      .select('id')
      .eq('id', project_id)
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

    const { data: dupRow, error: dupError } = await supabaseAdmin
      .from('jobs')
      .select('id')
      .eq('project_id', project_id)
      .eq('job_type', 'build_identity')
      .in('status', ['queued', 'running'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (dupError) {
      return NextResponse.json(
        { ok: false, error: dupError.message },
        { status: 500 }
      )
    }

    if (dupRow?.id != null) {
      return NextResponse.json(
        {
          ok: false,
          error: 'BUILD_IDENTITY_ALREADY_RUNNING',
          job_id: String(dupRow.id),
        },
        { status: 409 }
      )
    }

    const reference_asset_id_in = trimStr(body?.reference_asset_id)
    const embedding_key_in = trimStr(body?.embedding_key)
    const latent_base_key_in = trimStr(body?.latent_base_key)
    const anchor_manifest_key_in = trimStr(body?.anchor_manifest_key)
    const identity_status_in = trimStr(body?.identity_status)
    const build_score =
      typeof body?.build_score === 'number' ? body.build_score : undefined

    const manualMode =
      reference_asset_id_in !== '' &&
      embedding_key_in !== '' &&
      latent_base_key_in !== '' &&
      anchor_manifest_key_in !== '' &&
      identity_status_in !== ''

    let reference_asset_id: string
    let embedding_key: string
    let latent_base_key: string
    let anchor_manifest_key: string
    let identity_status: string

    if (manualMode) {
      reference_asset_id = reference_asset_id_in
      embedding_key = embedding_key_in
      latent_base_key = latent_base_key_in
      anchor_manifest_key = anchor_manifest_key_in
      identity_status = identity_status_in

      if (!ALLOWED_IDENTITY_STATUS.includes(identity_status)) {
        return NextResponse.json(
          { ok: false, error: 'INVALID_IDENTITY_STATUS' },
          { status: 400 }
        )
      }
    } else {
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

      if (refRow?.id == null || String(refRow.id).trim() === '') {
        return NextResponse.json(
          { ok: false, error: 'REFERENCE_ASSET_REQUIRED' },
          { status: 400 }
        )
      }

      reference_asset_id = String(refRow.id)

      const { count, error: countError } = await supabaseAdmin
        .from('identity_profiles')
        .select('*', { count: 'exact', head: true })
        .eq('project_id', project_id)

      if (countError) {
        return NextResponse.json(
          { ok: false, error: countError.message },
          { status: 500 }
        )
      }

      const nextN = (count ?? 0) + 1
      const vSeg = `v${nextN}`
      const base = `projects/${project_id}/identity/${vSeg}`
      embedding_key = `${base}/embedding`
      latent_base_key = `${base}/latent-base`
      anchor_manifest_key = `${base}/anchor-manifest`
      identity_status = 'building'
    }

    const { data, error } = await supabaseAdmin
      .from('jobs')
      .insert({
        project_id,
        job_type: 'build_identity',
        status: 'queued',
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

    if (!data || !data.id) {
      return NextResponse.json(
        { ok: false, error: 'JOB_CREATE_NO_DATA' },
        { status: 500 }
      )
    }

    try {
      await jobQueue.add('job', {
        job_type: 'build_identity',
        payload: {
          job_id: data.id,
          project_id,
          reference_asset_id,
          embedding_key,
          latent_base_key,
          anchor_manifest_key,
          identity_status,
          build_score,
        },
      }, { jobId: String(data.id) })
    } catch (enqueueError) {
      const enqueueMessage =
        enqueueError instanceof Error ? enqueueError.message : 'UNKNOWN_ERROR'

      const now = new Date().toISOString()
      try {
        const { error: fixError } = await supabaseAdmin
          .from('jobs')
          .update({
            status: 'failed',
            error_code: 'JOB_ENQUEUE_FAILED',
            error_message: enqueueMessage,
            finished_at: now,
            updated_at: now,
          })
          .eq('id', data.id)
        if (fixError) {
          console.warn('POST /api/identity/build enqueue failure fix warning:', fixError.message)
        }
      } catch (fixException) {
        console.warn('POST /api/identity/build enqueue failure fix exception:', fixException)
      }

      try {
        const { error: eventError } = await supabaseAdmin.from('job_events').insert({
          job_id: data.id,
          level: 'error',
          step: 'enqueue_failed',
          message: 'Failed to enqueue identity build job',
          payload: {
            error: enqueueMessage,
            job_type: 'build_identity',
            project_id,
          },
        })
        if (eventError) {
          console.warn(
            'POST /api/identity/build enqueue_failed job_events insert warning:',
            eventError.message
          )
        }
      } catch (eventException) {
        console.warn(
          'POST /api/identity/build enqueue_failed job_events insert exception:',
          eventException
        )
      }

      return NextResponse.json(
        { ok: false, error: 'JOB_ENQUEUE_FAILED', error_detail: enqueueMessage },
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
    console.error('POST /api/identity/build error:', error)

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
