import { NextResponse } from 'next/server'
import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { supabaseAdmin } from '@/lib/supabase/admin'

type RouteContext = {
  params: Promise<{ projectId?: string; chunkId?: string }>
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
    const projectId = typeof resolved?.projectId === 'string' ? resolved.projectId.trim() : ''
    const chunkId = typeof resolved?.chunkId === 'string' ? resolved.chunkId.trim() : ''

    if (!projectId || !chunkId || !isValidUuid(projectId) || !isValidUuid(chunkId)) {
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
      return NextResponse.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 })
    }

    const { data: chunkRow, error: chunkError } = await supabaseAdmin
      .from('sequence_chunks')
      .select('id, scene_id, render_status')
      .eq('id', chunkId)
      .maybeSingle()

    if (chunkError) {
      return NextResponse.json({ ok: false, error: chunkError.message }, { status: 500 })
    }

    if (!chunkRow?.id || !chunkRow.scene_id) {
      return NextResponse.json({ ok: false, error: 'CHUNK_NOT_FOUND' }, { status: 404 })
    }

    const { data: sceneRow, error: sceneError } = await supabaseAdmin
      .from('sequence_scenes')
      .select('id, sequence_id')
      .eq('id', String(chunkRow.scene_id))
      .maybeSingle()

    if (sceneError) {
      return NextResponse.json({ ok: false, error: sceneError.message }, { status: 500 })
    }

    if (!sceneRow?.sequence_id) {
      return NextResponse.json({ ok: false, error: 'SCENE_NOT_FOUND' }, { status: 404 })
    }

    const { data: seqRow, error: seqError } = await supabaseAdmin
      .from('sequences')
      .select('id, project_id')
      .eq('id', String(sceneRow.sequence_id))
      .maybeSingle()

    if (seqError) {
      return NextResponse.json({ ok: false, error: seqError.message }, { status: 500 })
    }

    const resolvedProjectId = String(seqRow?.project_id ?? '').trim()
    if (!resolvedProjectId) {
      return NextResponse.json({ ok: false, error: 'SEQUENCE_NOT_FOUND' }, { status: 404 })
    }

    if (resolvedProjectId !== projectId) {
      return NextResponse.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 })
    }

    const render_status = String(chunkRow.render_status ?? '').trim() || null

    const expectedPrefix = `projects/${projectId}/chunks/${chunkId}/`
    let output_asset_key: string | null = null
    let result_url: string | null = null

    const { data: jobRow, error: jobError } = await supabaseAdmin
      .from('jobs')
      .select('id, output_asset_key, created_at')
      .eq('project_id', projectId)
      .eq('job_type', 'render_chunk')
      .eq('status', 'success')
      .like('output_asset_key', `${expectedPrefix}%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (jobError) {
      return NextResponse.json({ ok: false, error: jobError.message }, { status: 500 })
    }

    if (jobRow?.output_asset_key != null) {
      const key = String(jobRow.output_asset_key).trim()
      if (key && key.startsWith(expectedPrefix)) {
        output_asset_key = key
      }
    }

    if (!output_asset_key) {
      // Optional fallback: try to find a job_id from latest job_events by chunk_id.
      try {
        const { data: eventRow, error: eventError } = await supabaseAdmin
          .from('job_events')
          .select('job_id')
          .contains('payload', { chunk_id: chunkId })
          .order('event_ts', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (!eventError && eventRow?.job_id) {
          const { data: fallbackJob, error: fallbackJobError } = await supabaseAdmin
            .from('jobs')
            .select('output_asset_key')
            .eq('id', String(eventRow.job_id))
            .eq('project_id', projectId)
            .eq('job_type', 'render_chunk')
            .eq('status', 'success')
            .maybeSingle()

          if (!fallbackJobError && fallbackJob?.output_asset_key != null) {
            const key = String(fallbackJob.output_asset_key).trim()
            if (key && key.startsWith(expectedPrefix)) {
              output_asset_key = key
            }
          }
        }
      } catch {
        // ignore fallback errors
      }
    }

    if (output_asset_key && output_asset_key.startsWith(expectedPrefix)) {
      // Optional filename check (best-effort).
      if (output_asset_key.endsWith('/render.webp')) {
        const signed = await supabaseAdmin.storage
          .from('project-media')
          .createSignedUrl(output_asset_key, 3600)
        if (!signed.error && signed.data?.signedUrl) {
          result_url = signed.data.signedUrl
        }
      } else {
        // If unexpected filename, don't generate a result URL.
        result_url = null
      }
    }

    return NextResponse.json({
      ok: true,
      chunk_id: chunkId,
      render_status,
      output_asset_key,
      result_url,
    })
  } catch (error) {
    console.error('GET /api/projects/[projectId]/chunks/[chunkId]/result error:', error)
    const detail = error instanceof Error ? error.message : 'UNKNOWN_ERROR'
    return NextResponse.json(
      { ok: false, error: 'INVALID_REQUEST', error_detail: detail },
      { status: 400 }
    )
  }
}

