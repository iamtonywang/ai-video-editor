import { NextResponse } from 'next/server'

import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { supabaseAdmin } from '@/lib/supabase/admin'

type RouteContext = {
  params: Promise<{ sourceAssetId?: string }>
}

function isValidUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

export async function DELETE(_req: Request, context: RouteContext) {
  try {
    const supabase = await createAuthServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ ok: false, error: 'AUTH_REQUIRED' }, { status: 401 })
    }

    const resolved = await context.params
    const sourceAssetId =
      typeof resolved?.sourceAssetId === 'string' ? resolved.sourceAssetId.trim() : ''

    if (!sourceAssetId || !isValidUuid(sourceAssetId)) {
      return NextResponse.json({ ok: false, error: 'INVALID_ID' }, { status: 400 })
    }

    const { data: assetRow, error: assetError } = await supabaseAdmin
      .from('source_assets')
      .select('id, project_id, asset_type, asset_key')
      .eq('id', sourceAssetId)
      .maybeSingle()

    if (assetError) {
      return NextResponse.json({ ok: false, error: assetError.message }, { status: 500 })
    }

    if (!assetRow?.id) {
      return NextResponse.json({ ok: false, error: 'SOURCE_ASSET_NOT_FOUND' }, { status: 404 })
    }

    const projectId = String(assetRow.project_id ?? '').trim()
    if (!projectId || !isValidUuid(projectId)) {
      return NextResponse.json({ ok: false, error: 'INVALID_PROJECT_ID' }, { status: 400 })
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

    const assetType = String(assetRow.asset_type ?? '').trim()
    if (assetType !== 'reference') {
      return NextResponse.json({ ok: false, error: 'INVALID_ASSET_TYPE' }, { status: 409 })
    }

    const { data: runningRow, error: runningError } = await supabaseAdmin
      .from('jobs')
      .select('id')
      .eq('project_id', projectId)
      .eq('job_type', 'build_identity')
      .in('status', ['queued', 'running'])
      .limit(1)
      .maybeSingle()

    if (runningError) {
      return NextResponse.json({ ok: false, error: runningError.message }, { status: 500 })
    }

    if (runningRow?.id != null && String(runningRow.id).trim() !== '') {
      return NextResponse.json({ ok: false, error: 'REFERENCE_IN_USE' }, { status: 409 })
    }

    const deleted_asset_key = String(assetRow.asset_key ?? '').trim()
    if (!deleted_asset_key) {
      return NextResponse.json({ ok: false, error: 'ASSET_KEY_MISSING' }, { status: 500 })
    }

    const { error: removeError } = await supabaseAdmin.storage
      .from('project-media')
      .remove([deleted_asset_key])

    if (removeError) {
      return NextResponse.json({ ok: false, error: removeError.message }, { status: 500 })
    }

    const { error: deleteError } = await supabaseAdmin
      .from('source_assets')
      .delete()
      .eq('id', sourceAssetId)

    if (deleteError) {
      return NextResponse.json({ ok: false, error: deleteError.message }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      data: { source_asset_id: sourceAssetId, deleted_asset_key },
    })
  } catch (error) {
    console.error('DELETE /api/source/[sourceAssetId] error:', error)
    const detail = error instanceof Error ? error.message : 'UNKNOWN_ERROR'
    return NextResponse.json(
      { ok: false, error: 'INVALID_REQUEST', error_detail: detail },
      { status: 400 }
    )
  }
}

