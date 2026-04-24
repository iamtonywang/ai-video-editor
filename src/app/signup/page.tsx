'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { User } from '@supabase/supabase-js'
import { createAuthBrowserClient } from '@/lib/supabase/auth-browser'
import styles from '../page.module.css'
import authStyles from '../login/page.module.css'

const SIGNUP_SUCCESS_MESSAGE =
  '회원가입이 완료됐습니다. 가입한 이메일과 비밀번호로 로그인하세요.'

export default function SignupPage() {
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
    const supabase = createAuthBrowserClient()

    void supabase.auth
      .getUser()
      .then(({ data: { user: u } }) => {
        if (!cancelled) setUser(u ?? null)
      })
      .catch(() => {
        if (!cancelled) setUser(null)
      })
      .finally(() => {
        if (!cancelled) setAuthLoading(false)
      })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && suppressNextSignedInRef.current) {
        suppressNextSignedInRef.current = false
        if (!cancelled) {
          setUser(null)
          setAuthLoading(false)
        }
        void supabase.auth.signOut().catch(() => {})
        return
      }
      if (!cancelled) {
        setUser(session?.user ?? null)
        setAuthLoading(false)
      }
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  async function handleLogout() {
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
        e instanceof Error ? e.message : 'Could not sign out. Please try again.'
      )
    } finally {
      setLoggingOut(false)
    }
  }

  async function handleSignup(event: FormEvent) {
    event.preventDefault()
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
      const { data, error: signUpError } = await supabase.auth.signUp({
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
        e instanceof Error ? e.message : 'Could not sign up. Please try again.'
      )
    } finally {
      setSubmitting(false)
    }
  }

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
            <button
              type="button"
              className={`${styles.button} ${styles.logoutButton}`}
              disabled={loggingOut}
              onClick={handleLogout}
            >
              {loggingOut ? 'Signing out…' : 'Log out'}
            </button>
          </div>
        )}

        {!authLoading && !user && (
          <>
            <p className={styles.hint}>Create an account with email and password.</p>

            {error && (
              <p className={authStyles.error} role="alert">
                {error}
              </p>
            )}
            {message && <p className={authStyles.success}>{message}</p>}

            <form className={authStyles.formBlock} onSubmit={handleSignup}>
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
                  autoComplete="new-password"
                  disabled={submitting}
                  aria-label="Password"
                />
              </div>

              <div className={authStyles.buttonRow}>
                <button
                  type="submit"
                  className={styles.button}
                  disabled={submitting}
                >
                  {submitting ? 'Working…' : 'Create account'}
                </button>
                <Link
                  href="/"
                  className={authStyles.buttonSecondary}
                  aria-disabled={submitting}
                  tabIndex={submitting ? -1 : 0}
                  onClick={(event) => {
                    if (submitting) event.preventDefault()
                  }}
                >
                  Back to login
                </Link>
              </div>
            </form>
          </>
        )}
      </div>
    </main>
  )
}

