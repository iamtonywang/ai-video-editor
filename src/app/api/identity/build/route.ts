import { NextRequest, NextResponse } from 'next/server'
import { jobQueue } from '@/lib/queue'
import { supabaseAdmin } from '@/lib/supabase/admin'

const ALLOWED_IDENTITY_STATUS = ['building', 'ready', 'failed', 'stale']

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const project_id = body?.project_id
    const reference_asset_id = body?.reference_asset_id
    const embedding_key = typeof body?.embedding_key === 'string' ? body.embedding_key.trim() : ''
    const latent_base_key = typeof body?.latent_base_key === 'string' ? body.latent_base_key.trim() : ''
    const anchor_manifest_key = typeof body?.anchor_manifest_key === 'string' ? body.anchor_manifest_key.trim() : ''
    const identity_status = typeof body?.identity_status === 'string' ? body.identity_status.trim() : ''
    const build_score = typeof body?.build_score === 'number' ? body.build_score : undefined

    if (
      !project_id ||
      !reference_asset_id ||
      !embedding_key ||
      !latent_base_key ||
      !anchor_manifest_key ||
      !identity_status
    ) {
      return NextResponse.json(
        { ok: false, error: 'REQUIRED_FIELDS_MISSING' },
        { status: 400 }
      )
    }

    if (!ALLOWED_IDENTITY_STATUS.includes(identity_status)) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_IDENTITY_STATUS' },
        { status: 400 }
      )
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
      })
    } catch (enqueueError) {
      const enqueueMessage =
        enqueueError instanceof Error ? enqueueError.message : 'UNKNOWN_ERROR'
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
