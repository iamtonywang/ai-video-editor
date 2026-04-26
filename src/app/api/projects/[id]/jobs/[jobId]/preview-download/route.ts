import { NextResponse } from 'next/server'

import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { supabaseAdmin } from '@/lib/supabase/admin'

type RouteContext = {
  params: Promise<{ id?: string; jobId?: string }>
}

function isValidUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

export async function GET(_req: Request, context: RouteContext) {
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
      .select('id, job_type, output_asset_key')
      .eq('id', jobId)
      .eq('project_id', projectId)
      .eq('job_type', 'preview')
      .maybeSingle()

    if (jobError) {
      return NextResponse.json({ ok: false, error: jobError.message }, { status: 500 })
    }

    if (!jobRow?.id) {
      return NextResponse.json({ ok: false, error: 'JOB_NOT_FOUND' }, { status: 404 })
    }

    const output_asset_key =
      jobRow.output_asset_key == null ? '' : String(jobRow.output_asset_key).trim()

    if (!output_asset_key) {
      return NextResponse.json({ ok: false, error: 'OUTPUT_ASSET_KEY_MISSING' }, { status: 404 })
    }

    const { data: fileData, error: downloadError } = await supabaseAdmin.storage
      .from('project-media')
      .download(output_asset_key)

    if (downloadError || !fileData) {
      return NextResponse.json(
        { ok: false, error: downloadError?.message ?? 'DOWNLOAD_FAILED' },
        { status: 500 }
      )
    }

    const arrayBuffer = await fileData.arrayBuffer()
    const filename = `preview-${jobId}.webp`

    return new Response(arrayBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'image/webp',
        'Content-Disposition': `attachment; filename=\"${filename}\"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    console.error('GET /api/projects/[id]/jobs/[jobId]/preview-download error:', error)
    const detail = error instanceof Error ? error.message : 'UNKNOWN_ERROR'
    return NextResponse.json(
      { ok: false, error: 'INVALID_REQUEST', error_detail: detail },
      { status: 400 }
    )
  }
}

