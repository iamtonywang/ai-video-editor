import 'server-only'

import { supabaseAdmin } from '@/lib/supabase/admin'

export function isValidProjectUuid(projectId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    projectId
  )
}

export type InsertSourceAssetRow = {
  id: string
  project_id: string
  asset_type: string
  asset_key: string
  asset_status: string
  created_at: string
}

export type InsertSourceAssetForOwnerResult =
  | { ok: true; data: InsertSourceAssetRow }
  | { ok: false; status: number; error: string }

export async function verifyProjectOwnershipForUser(
  ownerUserId: string,
  project_id: string
): Promise<InsertSourceAssetForOwnerResult | { ok: true }> {
  if (!isValidProjectUuid(project_id)) {
    return { ok: false, status: 400, error: 'INVALID_PROJECT_ID' }
  }

  const { data: projectRow, error: projectError } = await supabaseAdmin
    .from('projects')
    .select('id')
    .eq('id', project_id)
    .eq('owner_user_id', ownerUserId)
    .maybeSingle()

  if (projectError) {
    return { ok: false, status: 500, error: projectError.message }
  }

  if (!projectRow) {
    return { ok: false, status: 404, error: 'PROJECT_NOT_FOUND' }
  }

  return { ok: true }
}

export async function insertSourceAssetForOwner(params: {
  ownerUserId: string
  project_id: string
  asset_type: string
  asset_key: string
  asset_status: string
}): Promise<InsertSourceAssetForOwnerResult> {
  const { ownerUserId, project_id, asset_type, asset_key, asset_status } = params

  const ownerCheck = await verifyProjectOwnershipForUser(ownerUserId, project_id)
  if (ownerCheck.ok !== true) {
    return ownerCheck
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
      return { ok: false, status: 409, error: 'ASSET_ALREADY_EXISTS' }
    }
    return { ok: false, status: 500, error: error.message }
  }

  if (!data) {
    return { ok: false, status: 500, error: 'SOURCE_ASSET_CREATE_NO_DATA' }
  }

  return {
    ok: true,
    data: {
      id: String(data.id),
      project_id: String(data.project_id),
      asset_type: String(data.asset_type),
      asset_key: String(data.asset_key),
      asset_status: String(data.asset_status),
      created_at: String(data.created_at),
    },
  }
}
