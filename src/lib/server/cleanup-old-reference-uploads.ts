import 'server-only'

import { supabaseAdmin } from '@/lib/supabase/admin'

const PROJECT_MEDIA_BUCKET = 'project-media'

/** Matches execution-context / identity/build “active reference” selection. */
const REFERENCE_LATEST_OR =
  'validation_status.eq.validated,asset_status.eq.validated,asset_status.eq.active'

export type ReferenceUploadCleanupResult = {
  cleanup_deleted_count: number
  cleanup_skipped_reason: string | null
}

/**
 * After a new reference source_asset row is inserted, best-effort cleanup of older
 * reference rows for the same project. Must not throw (caller wraps in try/catch).
 */
export async function cleanupOldReferenceUploadsAfterNewReference(params: {
  project_id: string
  new_source_asset_id: string
}): Promise<ReferenceUploadCleanupResult> {
  const { project_id, new_source_asset_id } = params

  const { data: latestRow, error: latestError } = await supabaseAdmin
    .from('source_assets')
    .select('id')
    .eq('project_id', project_id)
    .eq('asset_type', 'reference')
    .or(REFERENCE_LATEST_OR)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latestError) {
    console.warn('[reference-upload-cleanup] latest reference lookup failed:', latestError.message)
    return { cleanup_deleted_count: 0, cleanup_skipped_reason: 'LATEST_LOOKUP_FAILED' }
  }

  const latestId =
    latestRow?.id != null && String(latestRow.id).trim() !== ''
      ? String(latestRow.id)
      : null

  if (!latestId || latestId !== new_source_asset_id) {
    return { cleanup_deleted_count: 0, cleanup_skipped_reason: 'NEW_REFERENCE_NOT_LATEST' }
  }

  const { data: runningRow, error: runningError } = await supabaseAdmin
    .from('jobs')
    .select('id')
    .eq('project_id', project_id)
    .eq('job_type', 'build_identity')
    .in('status', ['queued', 'running'])
    .limit(1)
    .maybeSingle()

  if (runningError) {
    console.warn('[reference-upload-cleanup] build_identity job check failed:', runningError.message)
    return { cleanup_deleted_count: 0, cleanup_skipped_reason: 'BUILD_IDENTITY_CHECK_FAILED' }
  }

  if (runningRow?.id != null && String(runningRow.id).trim() !== '') {
    return { cleanup_deleted_count: 0, cleanup_skipped_reason: 'BUILD_IDENTITY_RUNNING' }
  }

  const { data: oldRows, error: listError } = await supabaseAdmin
    .from('source_assets')
    .select('id, asset_key')
    .eq('project_id', project_id)
    .eq('asset_type', 'reference')
    .neq('id', new_source_asset_id)

  if (listError) {
    console.warn('[reference-upload-cleanup] old references list failed:', listError.message)
    return { cleanup_deleted_count: 0, cleanup_skipped_reason: 'OLD_REFERENCES_LIST_FAILED' }
  }

  let deleted = 0
  const prefix = `projects/${project_id}/references/`

  for (const row of oldRows ?? []) {
    const id = row?.id != null ? String(row.id) : ''
    const asset_key = row?.asset_key != null ? String(row.asset_key).trim() : ''
    if (!id || !asset_key) continue
    if (!asset_key.startsWith(prefix)) {
      console.warn('[reference-upload-cleanup] skip non-project reference path:', asset_key)
      continue
    }

    const { error: removeError } = await supabaseAdmin.storage
      .from(PROJECT_MEDIA_BUCKET)
      .remove([asset_key])

    if (removeError) {
      console.warn('[reference-upload-cleanup] storage remove failed:', asset_key, removeError.message)
      continue
    }

    const { error: deleteError } = await supabaseAdmin.from('source_assets').delete().eq('id', id)

    if (deleteError) {
      console.warn('[reference-upload-cleanup] source_assets delete failed:', id, deleteError.message)
      continue
    }

    deleted += 1
  }

  return { cleanup_deleted_count: deleted, cleanup_skipped_reason: null }
}
