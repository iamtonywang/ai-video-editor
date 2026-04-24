'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import type { User } from '@supabase/supabase-js'
import { createAuthBrowserClient } from '@/lib/supabase/auth-browser'
import styles from './page.module.css'
import authStyles from './login/page.module.css'

const ERROR_TEXT: Record<string, string> = {
  auth_callback_failed: 'Sign-in could not be completed. Try again.',
}

const AUTH_LOADING_FAILSAFE_MS = 2500

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
  const [loggingOut, setLoggingOut] = useState(false)
  const suppressNextSignedInRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    let subscription: { unsubscribe: () => void } | null = null
    let settled = false
    let loadingTimer: ReturnType<typeof setTimeout> | null = null

    const finishAuthLoading = () => {
      if (cancelled || settled) return
      settled = true
      if (loadingTimer) clearTimeout(loadingTimer)
      setAuthLoading(false)
    }

    loadingTimer = setTimeout(() => {
      setUser(null)
      finishAuthLoading()
    }, AUTH_LOADING_FAILSAFE_MS)

    const setUserIfMounted = (u: User | null) => {
      if (!cancelled) setUser(u)
    }

    let supabase: ReturnType<typeof createAuthBrowserClient> | null = null
    try {
      supabase = createAuthBrowserClient()
    } catch {
      finishAuthLoading()
    }

    if (supabase) {
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
          finishAuthLoading()
        })

      const {
        data: { subscription: nextSub },
      } = supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN' && suppressNextSignedInRef.current) {
          suppressNextSignedInRef.current = false
          setUserIfMounted(null)
          finishAuthLoading()
          void supabase?.auth.signOut().catch(() => {})
          return
        }

        setUserIfMounted(session?.user ?? null)
        finishAuthLoading()
      })

      subscription = nextSub
    }

    return () => {
      cancelled = true
      if (loadingTimer) clearTimeout(loadingTimer)
      subscription?.unsubscribe()
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
            {error && (
              <p className={authStyles.error} role="alert">
                {error}
              </p>
            )}
            <Link href="/projects" className={styles.button}>
              Go to projects
            </Link>
            <button
              type="button"
              className={`${styles.button} ${styles.logoutButton}`}
              disabled={loggingOut}
              onClick={async () => {
                setError(null)
                setMessage(null)
                setLoggingOut(true)
                try {
                  const supabase = createAuthBrowserClient()
                  await supabase.auth.signOut()
                  setUser(null)
                  setAuthLoading(false)
                } catch (e) {
                  setError(
                    e instanceof Error
                      ? e.message
                      : 'Could not sign out. Please try again.'
                  )
                } finally {
                  setLoggingOut(false)
                }
              }}
            >
              {loggingOut ? 'Signing out…' : 'Log out'}
            </button>
          </div>
        )}

        {!authLoading && !user && (
          <>
            <p className={styles.hint}>
              Sign in with email and password.
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
                <Link
                  href="/signup"
                  className={authStyles.buttonSecondary}
                  aria-disabled={submitting}
                  tabIndex={submitting ? -1 : 0}
                  onClick={(event) => {
                    if (submitting) event.preventDefault()
                  }}
                >
                  Create account
                </Link>
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
