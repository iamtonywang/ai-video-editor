import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const title = typeof body?.title === 'string' ? body.title.trim() : ''

    if (!title) {
      return NextResponse.json(
        { ok: false, error: 'TITLE_REQUIRED' },
        { status: 400 }
      )
    }

    const { data, error } = await supabaseAdmin
      .from('projects')
      .insert({
        title,
        workflow_status: 'draft',
        auto_edit_enabled: false,
      })
      .select('id, title, workflow_status, created_at')
      .single()

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
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
