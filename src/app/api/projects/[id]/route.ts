import { NextResponse, type NextRequest } from 'next/server'
import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { supabaseAdmin } from '@/lib/supabase/admin'

function isValidProjectId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

const PROJECT_MEDIA_BUCKET = 'project-media'

async function listAllFilesUnderPrefix(prefix: string): Promise<string[]> {
  const storage = supabaseAdmin.storage.from(PROJECT_MEDIA_BUCKET)
  const normalizedPrefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '')

  const { data, error } = await storage.list(normalizedPrefix, { limit: 1000 })
  if (error) throw error

  const files: string[] = []
  for (const entry of data ?? []) {
    const name = entry?.name ? String(entry.name) : ''
    if (!name) continue
    // Supabase Storage list() returns both files and "folders" by name.
    // We treat missing metadata as folder-ish and attempt one-level recursion.
    const hasMetadata = (entry as { metadata?: unknown })?.metadata != null
    if (hasMetadata) {
      files.push(`${normalizedPrefix}/${name}`)
    } else {
      const childPrefix = `${normalizedPrefix}/${name}`
      const { data: childData, error: childError } = await storage.list(childPrefix, { limit: 1000 })
      if (childError) throw childError
      for (const child of childData ?? []) {
        const childName = child?.name ? String(child.name) : ''
        if (!childName) continue
        const childHasMetadata = (child as { metadata?: unknown })?.metadata != null
        if (childHasMetadata) {
          files.push(`${childPrefix}/${childName}`)
        }
      }
    }
  }

  return files
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id?: string }> }
) {
  try {
    const supabase = await createAuthServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ ok: false, error: 'AUTH_REQUIRED' }, { status: 401 })
    }

    const resolved = await context.params
    const id = typeof resolved?.id === 'string' ? resolved.id.trim() : ''

    if (!id || !isValidProjectId(id)) {
      return NextResponse.json({ ok: false, error: 'INVALID_PROJECT_ID' }, { status: 400 })
    }

    const { data: existing, error: selectError } = await supabaseAdmin
      .from('projects')
      .select('id')
      .eq('id', id)
      .eq('owner_user_id', user.id)
      .maybeSingle()

    if (selectError) {
      return NextResponse.json({ ok: false, error: selectError.message }, { status: 500 })
    }

    if (!existing) {
      return NextResponse.json({ ok: false, error: 'PROJECT_NOT_FOUND' }, { status: 404 })
    }

    // Best-effort Storage cleanup (do not block DB deletion).
    try {
      const referencePrefix = `projects/${id}/references`
      const previewPrefix = `projects/${id}/previews`

      const storagePaths = new Set<string>()
      try {
        const refs = await listAllFilesUnderPrefix(referencePrefix)
        for (const p of refs) storagePaths.add(p)
      } catch (error) {
        console.error('DELETE /api/projects/[id] storage list references error:', error)
      }

      try {
        const previews = await listAllFilesUnderPrefix(previewPrefix)
        for (const p of previews) storagePaths.add(p)
      } catch (error) {
        console.error('DELETE /api/projects/[id] storage list previews error:', error)
      }

      const paths = Array.from(storagePaths)
      if (paths.length > 0) {
        const { error: removeError } = await supabaseAdmin.storage
          .from(PROJECT_MEDIA_BUCKET)
          .remove(paths)
        if (removeError) {
          console.error('DELETE /api/projects/[id] storage remove error:', removeError)
        } else {
          console.log(`DELETE /api/projects/[id] removed ${paths.length} storage objects`)
        }
      } else {
        console.log('DELETE /api/projects/[id] removed 0 storage objects')
      }
    } catch (error) {
      console.error('DELETE /api/projects/[id] storage cleanup error:', error)
    }

    const { error: deleteError } = await supabaseAdmin
      .from('projects')
      .delete()
      .eq('id', id)
      .eq('owner_user_id', user.id)

    if (deleteError) {
      return NextResponse.json({ ok: false, error: deleteError.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('DELETE /api/projects/[id] error:', error)
    return NextResponse.json({ ok: false, error: 'INVALID_REQUEST' }, { status: 400 })
  }
}

