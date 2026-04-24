import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * 쿠키 기반 Supabase Auth 전용 클라이언트 (anon key만, service role 사용 안 함).
 * 로그인 세션이 있는 서버/Route 핸들러에서 getUser() 등에 사용.
 */
export async function createAuthServerClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Server Component 등에서 set 불가한 경우 — 세션 refresh는 middleware 등에서 보완
          }
        },
      },
    }
  )
}
