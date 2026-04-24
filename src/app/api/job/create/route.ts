import { NextRequest, NextResponse } from 'next/server'
import { jobQueue } from '@/lib/queue'
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

const ALLOWED_IDENTITY_STATUS = ['building', 'ready', 'failed', 'stale']

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const project_id = body?.project_id
    const job_type =
      typeof body?.job_type === 'string' ? body.job_type.trim() : ''
    const status =
      typeof body?.status === 'string' ? body.status.trim() : ''
    const reference_asset_id = body?.reference_asset_id
    const embedding_key =
      typeof body?.embedding_key === 'string' ? body.embedding_key.trim() : ''
    const latent_base_key =
      typeof body?.latent_base_key === 'string'
        ? body.latent_base_key.trim()
        : ''
    const anchor_manifest_key =
      typeof body?.anchor_manifest_key === 'string'
        ? body.anchor_manifest_key.trim()
        : ''
    const identity_status =
      typeof body?.identity_status === 'string' ? body.identity_status.trim() : ''
    const build_score =
      typeof body?.build_score === 'number' ? body.build_score : undefined

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

    const latestChunkIdentityGate = await supabaseAdmin
      .from('gate_evaluations')
      .select('decision')
      .eq('project_id', project_id)
      .eq('gate_type', 'identity')
      .eq('scope_type', 'chunk')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (latestChunkIdentityGate.error) {
      return NextResponse.json(
        { ok: false, error: latestChunkIdentityGate.error.message },
        { status: 500 }
      )
    }

    if (latestChunkIdentityGate.data?.decision === 'blocked') {
      return NextResponse.json(
        { ok: false, error: 'CHUNK_IDENTITY_GATE_BLOCKED' },
        { status: 403 }
      )
    }

    if (job_type === 'build_identity') {
      if (
        !reference_asset_id ||
        !embedding_key ||
        !latent_base_key ||
        !anchor_manifest_key ||
        !identity_status
      ) {
        return NextResponse.json(
          { ok: false, error: 'BUILD_IDENTITY_PAYLOAD_REQUIRED' },
          { status: 400 }
        )
      }

      if (!ALLOWED_IDENTITY_STATUS.includes(identity_status)) {
        return NextResponse.json(
          { ok: false, error: 'INVALID_IDENTITY_STATUS' },
          { status: 400 }
        )
      }
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

    try {
      const queuePayload =
        job_type === 'build_identity'
          ? {
              job_id: data.id,
              project_id,
              reference_asset_id,
              embedding_key,
              latent_base_key,
              anchor_manifest_key,
              identity_status,
              build_score,
            }
          : {
              job_id: data.id,
              project_id,
            }

      await jobQueue.add('job', {
        job_type,
        payload: queuePayload,
      }, { jobId: String(data.id) })
    } catch (error) {
      console.error('POST /api/job/create enqueue error:', error)

      const errorDetail =
        error instanceof Error ? error.message : 'UNKNOWN_ERROR'

      return NextResponse.json(
        {
          ok: false,
          error: 'JOB_ENQUEUE_FAILED',
          error_detail: errorDetail,
        },
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
