import { NextRequest, NextResponse } from 'next/server'
import { createAuthServerClient } from '@/lib/supabase/auth-server'
import {
  insertSourceAssetForOwner,
  isValidProjectUuid,
} from '@/lib/server/insert-source-asset'

const ALLOWED_ASSET_TYPE = ['source', 'reference', 'audio', 'bg']
const ALLOWED_ASSET_STATUS = ['uploaded', 'validated', 'active', 'failed', 'expired']

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

    const project_id_raw = body?.project_id
    const project_id =
      typeof project_id_raw === 'string'
        ? project_id_raw.trim()
        : project_id_raw != null
          ? String(project_id_raw).trim()
          : ''
    const asset_type = typeof body?.asset_type === 'string' ? body.asset_type.trim() : ''
    const asset_key = typeof body?.asset_key === 'string' ? body.asset_key.trim() : ''
    const asset_status = typeof body?.asset_status === 'string' ? body.asset_status.trim() : ''

    if (!project_id || !asset_type || !asset_key || !asset_status) {
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

    if (!ALLOWED_ASSET_TYPE.includes(asset_type)) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_ASSET_TYPE' },
        { status: 400 }
      )
    }

    if (!ALLOWED_ASSET_STATUS.includes(asset_status)) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_ASSET_STATUS' },
        { status: 400 }
      )
    }

    const insertResult = await insertSourceAssetForOwner({
      ownerUserId: user.id,
      project_id,
      asset_type,
      asset_key,
      asset_status,
    })

    if (!insertResult.ok) {
      return NextResponse.json(
        { ok: false, error: insertResult.error },
        { status: insertResult.status }
      )
    }

    return NextResponse.json({
      ok: true,
      data: {
        source_asset_id: insertResult.data.id,
        project_id: insertResult.data.project_id,
        asset_type: insertResult.data.asset_type,
        asset_key: insertResult.data.asset_key,
        asset_status: insertResult.data.asset_status,
        created_at: insertResult.data.created_at,
      },
    })
  } catch (error) {
    console.error('POST /api/source/register error:', error)

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
