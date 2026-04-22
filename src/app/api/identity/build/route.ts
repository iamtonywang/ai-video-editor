import { NextRequest, NextResponse } from 'next/server'
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

    const insertPayload: {
      project_id: string
      reference_asset_id: string
      embedding_key: string
      latent_base_key: string
      anchor_manifest_key: string
      identity_status: string
      build_score?: number
    } = {
      project_id,
      reference_asset_id,
      embedding_key,
      latent_base_key,
      anchor_manifest_key,
      identity_status,
    }

    if (typeof build_score === 'number') {
      insertPayload.build_score = build_score
    }

    const { data, error } = await supabaseAdmin
      .from('identity_profiles')
      .insert(insertPayload)
      .select('id, project_id, reference_asset_id, identity_status, build_score, created_at')
      .single()

    if (error) {
      if (error.message.includes('duplicate key')) {
        return NextResponse.json(
          { ok: false, error: 'IDENTITY_ALREADY_EXISTS' },
          { status: 409 }
        )
      }

      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 }
      )
    }

    if (!data) {
      return NextResponse.json(
        { ok: false, error: 'IDENTITY_CREATE_NO_DATA' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      ok: true,
      data: {
        identity_profile_id: data.id,
        project_id: data.project_id,
        reference_asset_id: data.reference_asset_id,
        identity_status: data.identity_status,
        build_score: data.build_score,
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
