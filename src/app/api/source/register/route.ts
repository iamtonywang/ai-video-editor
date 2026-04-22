import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

const ALLOWED_ASSET_TYPE = ['source', 'reference', 'audio', 'bg']
const ALLOWED_ASSET_STATUS = ['uploaded', 'validated', 'active', 'failed', 'expired']

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const project_id = body?.project_id
    const asset_type = typeof body?.asset_type === 'string' ? body.asset_type.trim() : ''
    const asset_key = typeof body?.asset_key === 'string' ? body.asset_key.trim() : ''
    const asset_status = typeof body?.asset_status === 'string' ? body.asset_status.trim() : ''

    if (!project_id || !asset_type || !asset_key || !asset_status) {
      return NextResponse.json(
        { ok: false, error: 'REQUIRED_FIELDS_MISSING' },
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

    const { data, error } = await supabaseAdmin
      .from('source_assets')
      .insert({
        project_id,
        asset_type,
        asset_key,
        asset_status,
      })
      .select('id, project_id, asset_type, asset_key, asset_status, created_at')
      .single()

    if (error) {
      if (error.message.includes('duplicate key')) {
        return NextResponse.json(
          { ok: false, error: 'ASSET_ALREADY_EXISTS' },
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
        { ok: false, error: 'SOURCE_ASSET_CREATE_NO_DATA' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      ok: true,
      data: {
        source_asset_id: data.id,
        project_id: data.project_id,
        asset_type: data.asset_type,
        asset_key: data.asset_key,
        asset_status: data.asset_status,
        created_at: data.created_at,
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
