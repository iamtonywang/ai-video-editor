import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import {
  insertSourceAssetForOwner,
  isValidProjectUuid,
  verifyProjectOwnershipForUser,
} from '@/lib/server/insert-source-asset'

const BUCKET = 'project-media'

const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const

const MIME_TO_EXT: Record<string, 'jpg' | 'png' | 'webp'> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

const ALLOWED_FILENAME_EXT = new Set(['jpg', 'jpeg', 'png', 'webp'])

const MAX_BYTES = 10 * 1024 * 1024

function extFromFileName(name: string): string | null {
  const m = name.trim().match(/\.([a-zA-Z0-9]+)$/)
  return m ? m[1].toLowerCase() : null
}

function filenameExtMatchesMime(mime: string, ext: string): boolean {
  if (mime === 'image/jpeg') return ext === 'jpg' || ext === 'jpeg'
  if (mime === 'image/png') return ext === 'png'
  if (mime === 'image/webp') return ext === 'webp'
  return false
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createAuthServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ ok: false, error: 'AUTH_REQUIRED' }, { status: 401 })
    }

    const formData = await req.formData()
    const project_id_raw = formData.get('project_id')
    const project_id =
      typeof project_id_raw === 'string'
        ? project_id_raw.trim()
        : project_id_raw != null
          ? String(project_id_raw).trim()
          : ''

    if (!project_id) {
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

    const fileEntry = formData.get('file')
    if (!(fileEntry instanceof File) || fileEntry.size === 0) {
      return NextResponse.json({ ok: false, error: 'FILE_REQUIRED' }, { status: 400 })
    }

    const file = fileEntry

    if (file.size > MAX_BYTES) {
      return NextResponse.json({ ok: false, error: 'FILE_TOO_LARGE' }, { status: 400 })
    }

    if (!ALLOWED_MIMES.includes(file.type as (typeof ALLOWED_MIMES)[number])) {
      return NextResponse.json({ ok: false, error: 'INVALID_FILE_TYPE' }, { status: 400 })
    }

    const extFromMime = MIME_TO_EXT[file.type]
    if (!extFromMime) {
      return NextResponse.json({ ok: false, error: 'INVALID_FILE_TYPE' }, { status: 400 })
    }

    const nameExt = extFromFileName(file.name)
    if (nameExt != null) {
      if (!ALLOWED_FILENAME_EXT.has(nameExt)) {
        return NextResponse.json({ ok: false, error: 'INVALID_FILE_EXTENSION' }, { status: 400 })
      }
      if (!filenameExtMatchesMime(file.type, nameExt)) {
        return NextResponse.json(
          { ok: false, error: 'FILE_EXTENSION_MISMATCH' },
          { status: 400 }
        )
      }
    }

    const ownerCheck = await verifyProjectOwnershipForUser(user.id, project_id)
    if (ownerCheck.ok !== true) {
      return NextResponse.json(
        { ok: false, error: ownerCheck.error },
        { status: ownerCheck.status }
      )
    }

    const { data: buckets, error: bucketListError } =
      await supabaseAdmin.storage.listBuckets()

    if (bucketListError) {
      return NextResponse.json(
        { ok: false, error: bucketListError.message },
        { status: 500 }
      )
    }

    if (!buckets?.some((b) => b.name === BUCKET)) {
      return NextResponse.json(
        { ok: false, error: 'STORAGE_BUCKET_MISSING' },
        { status: 503 }
      )
    }

    const shortId = randomUUID().replace(/-/g, '').slice(0, 8)
    const objectPath = `projects/${project_id}/references/ref_${shortId}.${extFromMime}`

    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(objectPath, file, {
        contentType: file.type,
        upsert: false,
      })

    if (uploadError) {
      return NextResponse.json(
        { ok: false, error: uploadError.message },
        { status: 500 }
      )
    }

    const insertResult = await insertSourceAssetForOwner({
      ownerUserId: user.id,
      project_id,
      asset_type: 'reference',
      asset_key: objectPath,
      asset_status: 'validated',
    })

    if (!insertResult.ok) {
      try {
        await supabaseAdmin.storage.from(BUCKET).remove([objectPath])
      } catch {
        // best-effort cleanup
      }
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
        asset_type: 'reference' as const,
        asset_key: insertResult.data.asset_key,
        asset_status: 'validated' as const,
      },
    })
  } catch (error) {
    console.error('POST /api/source/upload error:', error)

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
