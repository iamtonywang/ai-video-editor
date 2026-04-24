import { createBrowserClient } from '@supabase/ssr'

/**
 * 브라우저 전용 Supabase Auth (anon key). Magic link 등 클라이언트 컴포넌트에서 사용.
 * 기존 `client.ts`의 싱글톤(supabaseClient)과 별도 — Auth 세션/쿠키 동기화는 @supabase/ssr 권장 패턴.
 */
export function createAuthBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
