import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { ensureAppUserForAuthUser } from '@/lib/app-users/ensure'

function isOwnerInsertError(msg: string): boolean {
  const m = msg.toLowerCase()
  return (
    m.includes('owner_user_id') ||
    (m.includes('foreign key') && m.includes('owner')) ||
    (m.includes('fkey') && m.includes('owner')) ||
    (m.includes('violates') && m.includes('owner'))
  )
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createAuthServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json(
        { ok: false, error: 'AUTH_REQUIRED' },
        { status: 401 }
      )
    }

    const body = await req.json()
    const title = typeof body?.title === 'string' ? body.title.trim() : ''

    if (!title) {
      return NextResponse.json(
        { ok: false, error: 'TITLE_REQUIRED' },
        { status: 400 }
      )
    }

    try {
      await ensureAppUserForAuthUser(user)
    } catch (syncErr) {
      const detail =
        syncErr instanceof Error ? syncErr.message : 'Unknown sync error'
      console.error('app_users sync:', detail)
      return NextResponse.json(
        {
          ok: false,
          error: 'APP_USER_SYNC_FAILED',
          error_detail: detail,
        },
        { status: 500 }
      )
    }

    const { data, error } = await supabaseAdmin
      .from('projects')
      .insert({
        title,
        workflow_status: 'draft',
        auto_edit_enabled: false,
        owner_user_id: user.id,
      })
      .select('id, title, workflow_status, created_at, owner_user_id')
      .single()

    if (error) {
      if (isOwnerInsertError(error.message)) {
        return NextResponse.json(
          {
            ok: false,
            error: 'OWNER_USER_ID_PERSIST_FAILED',
            error_detail: error.message,
          },
          { status: 500 }
        )
      }
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 }
      )
    }

    if (!data) {
      return NextResponse.json(
        { ok: false, error: 'PROJECT_CREATE_NO_DATA' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      ok: true,
      data: {
        project_id: data.id,
        title: data.title,
        workflow_status: data.workflow_status,
        created_at: data.created_at,
        owner_user_id: data.owner_user_id,
      },
    })
  } catch (error) {
    console.error('POST /api/projects/create error:', error)
    return NextResponse.json(
      { ok: false, error: 'INVALID_REQUEST' },
      { status: 400 }
    )
  }
}
