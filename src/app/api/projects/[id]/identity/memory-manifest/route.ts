import { NextResponse } from 'next/server'

import { isValidUuid } from '@/lib/is-valid-uuid'
import { readIdentityMemoryManifest } from '@/lib/server/identity/read-identity-memory-manifest'
import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { supabaseAdmin } from '@/lib/supabase/admin'

type RouteContext = {
  params: Promise<{ id?: string }>
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const resolved = await context.params
    const idRaw = resolved?.id
    const projectId = typeof idRaw === 'string' ? idRaw.trim() : ''

    if (typeof idRaw !== 'string' || projectId === '' || !isValidUuid(projectId)) {
      return NextResponse.json({ ok: false, error: 'INVALID_PROJECT_ID' }, { status: 400 })
    }

    const supabase = await createAuthServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ ok: false, error: 'AUTH_REQUIRED' }, { status: 401 })
    }

    const { data: projectRow, error: projectError } = await supabaseAdmin
      .from('projects')
      .select('id, active_identity_profile_id')
      .eq('id', projectId)
      .eq('owner_user_id', user.id)
      .maybeSingle()

    if (projectError) {
      console.error('PROJECT_QUERY_FAILED', {
        projectId,
        userId: user.id,
        error: projectError,
      })
      return NextResponse.json({ ok: false, error: 'PROJECT_QUERY_FAILED' }, { status: 500 })
    }

    if (!projectRow) {
      return NextResponse.json({ ok: false, error: 'PROJECT_NOT_FOUND' }, { status: 404 })
    }

    const rawProfileId = projectRow.active_identity_profile_id
    const profileId =
      rawProfileId == null
        ? ''
        : typeof rawProfileId === 'string'
          ? rawProfileId.trim()
          : String(rawProfileId).trim()

    if (typeof rawProfileId !== 'string' || profileId === '' || !isValidUuid(profileId)) {
      return NextResponse.json({ ok: false, error: 'IDENTITY_PROFILE_NOT_FOUND' }, { status: 404 })
    }

    const result = await readIdentityMemoryManifest({
      projectId,
      identityProfileId: profileId,
    })

    if (!result.ok) {
      switch (result.reason) {
        case 'invalid_input':
        case 'schema_invalid':
        case 'field_invalid':
        case 'parse_failed':
        case 'too_large':
        case 'manifest_key_not_canonical':
          return NextResponse.json({ ok: false, error: result.reason }, { status: 400 })
        case 'download_failed':
          console.error(
            'GET /api/projects/[id]/identity/memory-manifest readIdentityMemoryManifest:',
            result.reason,
            { projectId }
          )
          return NextResponse.json({ ok: false, error: 'MANIFEST_NOT_FOUND' }, { status: 404 })
        default:
          return NextResponse.json({ ok: false, error: 'UNKNOWN_ERROR' }, { status: 500 })
      }
    }

    return NextResponse.json({
      ok: true,
      data: {
        manifest: result.manifest,
      },
    })
  } catch (error) {
    console.error('GET /api/projects/[id]/identity/memory-manifest error:', error)
    return NextResponse.json({ ok: false, error: 'INVALID_REQUEST' }, { status: 400 })
  }
}
