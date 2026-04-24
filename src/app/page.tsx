'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import type { User } from '@supabase/supabase-js'
import { createAuthBrowserClient } from '@/lib/supabase/auth-browser'
import styles from './page.module.css'
import authStyles from './login/page.module.css'

const ERROR_TEXT: Record<string, string> = {
  auth_callback_failed: 'Sign-in could not be completed. Try again.',
}

const SIGNUP_SUCCESS_MESSAGE =
  '회원가입이 완료됐습니다. 가입한 이메일과 비밀번호로 로그인하세요.'

function HomeAuthForm() {
  const searchParams = useSearchParams()
  const urlError = searchParams.get('error')
  const [user, setUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const suppressNextSignedInRef = useRef(false)

  useEffect(() => {
    const supabase = createAuthBrowserClient()
    let cancelled = false

    const setUserIfMounted = (u: User | null) => {
      if (!cancelled) setUser(u)
    }

    void supabase.auth
      .getUser()
      .then(({ data: { user: u } }) => {
        if (!cancelled) {
          setUser(u ?? null)
        }
      })
      .catch(() => {
        if (!cancelled) setUser(null)
      })
      .finally(() => {
        if (!cancelled) setAuthLoading(false)
      })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && suppressNextSignedInRef.current) {
        suppressNextSignedInRef.current = false
        try {
          await supabase.auth.signOut()
        } finally {
          setUserIfMounted(null)
          if (!cancelled) setAuthLoading(false)
        }
        return
      }

      setUserIfMounted(session?.user ?? null)
      if (!cancelled) setAuthLoading(false)
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  return (
    <main className={`${styles.page} font-latin`} lang="en">
      <div className={styles.content}>
        <header className={styles.header}>
          <h1 className={styles.title}>SHAWWANG</h1>
          <p className={styles.subtitle}>AI Video Engine</p>
        </header>

        {authLoading && (
          <p className={styles.authLoading}>Checking your session…</p>
        )}

        {!authLoading && user && (
          <div className={styles.welcome}>
            <p className={styles.welcomeTitle}>Welcome</p>
            <p className={styles.welcomeEmail}>{user.email}</p>
            <p className={styles.welcomeHint}>
              Project workspace will be available next.
            </p>
          </div>
        )}

        {!authLoading && !user && (
          <>
            <p className={styles.hint}>
              Sign in with email and password, or create an account.
            </p>

            {urlError && (
              <p className={authStyles.error} role="alert">
                {ERROR_TEXT[urlError] ?? 'Something went wrong.'}
              </p>
            )}

            {error && (
              <p className={authStyles.error} role="alert">
                {error}
              </p>
            )}
            {message && <p className={authStyles.success}>{message}</p>}

            <div className={authStyles.formBlock}>
              <div className={authStyles.fieldGroup}>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  className={styles.input}
                  autoComplete="email"
                  spellCheck={false}
                  disabled={submitting}
                  aria-label="Email"
                />
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Password"
                  className={styles.input}
                  autoComplete="current-password"
                  disabled={submitting}
                  aria-label="Password"
                />
              </div>
              <div className={authStyles.buttonRow}>
                <button
                  type="button"
                  className={styles.button}
                  disabled={submitting}
                  onClick={async () => {
                    setError(null)
                    setMessage(null)
                    const trimmed = email.trim()
                    if (!trimmed) {
                      setError('Email is required.')
                      return
                    }
                    if (!password) {
                      setError('Password is required.')
                      return
                    }
                    setSubmitting(true)
                    try {
                      const supabase = createAuthBrowserClient()
                      const { data, error: signInError } =
                        await supabase.auth.signInWithPassword({
                          email: trimmed,
                          password,
                        })
                      if (signInError) {
                        setError(signInError.message)
                        return
                      }
                      if (data.user) {
                        setUser(data.user)
                      }
                    } catch (e) {
                      setError(
                        e instanceof Error
                          ? e.message
                          : 'Could not sign in. Please try again.'
                      )
                    } finally {
                      setSubmitting(false)
                    }
                  }}
                >
                  {submitting ? 'Working…' : 'Log in'}
                </button>
                <button
                  type="button"
                  className={authStyles.buttonSecondary}
                  disabled={submitting}
                  onClick={async () => {
                    setError(null)
                    setMessage(null)
                    const trimmed = email.trim()
                    if (!trimmed) {
                      setError('Email is required.')
                      return
                    }
                    if (!password) {
                      setError('Password is required.')
                      return
                    }
                    setSubmitting(true)
                    try {
                      const supabase = createAuthBrowserClient()
                      const { data, error: signUpError } =
                        await supabase.auth.signUp({
                          email: trimmed,
                          password,
                        })
                      if (signUpError) {
                        suppressNextSignedInRef.current = false
                        setError(signUpError.message)
                        return
                      }
                      suppressNextSignedInRef.current = Boolean(data.session)
                      if (data.session) {
                        await supabase.auth.signOut()
                      }
                      setUser(null)
                      setMessage(SIGNUP_SUCCESS_MESSAGE)
                    } catch (e) {
                      suppressNextSignedInRef.current = false
                      setError(
                        e instanceof Error
                          ? e.message
                          : 'Could not sign up. Please try again.'
                      )
                    } finally {
                      setSubmitting(false)
                    }
                  }}
                >
                  {submitting ? 'Working…' : 'Sign up'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  )
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <main className={`${styles.page} font-latin`} lang="en">
          <div className={styles.content}>
            <p className={authStyles.subtle}>Loading…</p>
          </div>
        </main>
      }
    >
      <HomeAuthForm />
    </Suspense>
  )
}
