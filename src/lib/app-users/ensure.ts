import { supabaseAdmin } from '@/lib/supabase/admin'
import type { User } from '@supabase/supabase-js'

/**
 * auth.users.id 기준 public.app_users 행이 없으면 최소 컬럼으로 생성.
 * service role는 이 테이블에 한해 최소로만 사용 (RLS/권한 미가정인 환경 대응).
 */
export async function ensureAppUserForAuthUser(user: User) {
  const { data: existing, error: selectError } = await supabaseAdmin
    .from('app_users')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  if (selectError) {
    throw new Error(`APP_USER_SELECT_FAILED: ${selectError.message}`)
  }

  if (existing) return

  const { error: insertError } = await supabaseAdmin.from('app_users').insert({
    id: user.id,
    email: user.email ?? '',
    login_method: 'email',
    user_status: 'active',
  })

  if (insertError) {
    throw new Error(`APP_USER_INSERT_FAILED: ${insertError.message}`)
  }
}
