import { NextResponse } from 'next/server'
import { createAuthServerClient } from '@/lib/supabase/auth-server'
import { supabaseAdmin } from '@/lib/supabase/admin'

export async function GET() {
  try {
    const supabase = await createAuthServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ ok: false, error: 'AUTH_REQUIRED' }, { status: 401 })
    }

    const { data, error } = await supabaseAdmin
      .from('projects')
      .select('id, title, workflow_status, created_at, updated_at')
      .eq('owner_user_id', user.id)
      .order('updated_at', { ascending: false })

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      data: data ?? [],
    })
  } catch (error) {
    console.error('GET /api/projects error:', error)
    return NextResponse.json({ ok: false, error: 'INVALID_REQUEST' }, { status: 400 })
  }
}

