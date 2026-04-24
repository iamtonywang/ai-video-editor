import { NextResponse, type NextRequest } from 'next/server'
import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { supabaseAdmin } from '@/lib/supabase/admin'

function isValidProjectId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
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

