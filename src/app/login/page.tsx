'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createAuthBrowserClient } from '@/lib/supabase/auth-browser'
import formStyles from '../page.module.css'
import styles from './page.module.css'

const ERROR_TEXT: Record<string, string> = {
  auth_callback_failed: 'Sign-in could not be completed. Try again.',
}

const SIGNUP_NO_SESSION =
  '가입은 완료됐지만 이메일 확인 설정 때문에 세션이 없습니다. Supabase Auth 설정을 확인하세요.'

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const urlError = searchParams.get('error')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  return (
    <main className={`${formStyles.page} font-latin`} lang="en">
      <div className={formStyles.content}>
        <header className={formStyles.header}>
          <h1 className={formStyles.title}>Log in</h1>
          <p className={formStyles.subtitle}>
            Sign in with email and password, or create an account.
          </p>
        </header>

        {urlError && (
          <p className={styles.error} role="alert">
            {ERROR_TEXT[urlError] ?? 'Something went wrong.'}
          </p>
        )}

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {message && <p className={styles.success}>{message}</p>}

        <div className={styles.formBlock}>
          <div className={styles.fieldGroup}>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              className={formStyles.input}
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
              className={formStyles.input}
              autoComplete="current-password"
              disabled={submitting}
              aria-label="Password"
            />
          </div>
          <div className={styles.buttonRow}>
            <button
              type="button"
              className={formStyles.button}
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
                  const { error: signInError } =
                    await supabase.auth.signInWithPassword({
                      email: trimmed,
                      password,
                    })
                  if (signInError) {
                    setError(signInError.message)
                    return
                  }
                  router.replace('/')
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
              className={styles.buttonSecondary}
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
                  const { data, error: signUpError } = await supabase.auth.signUp(
                    {
                      email: trimmed,
                      password,
                    }
                  )
                  if (signUpError) {
                    setError(signUpError.message)
                    return
                  }
                  if (data.session) {
                    router.replace('/')
                    return
                  }
                  setMessage(SIGNUP_NO_SESSION)
                } catch (e) {
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

        <p className={styles.subtle}>
          <Link className={styles.topLink} href="/">
            ← Back to home
          </Link>
        </p>
      </div>
    </main>
  )
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className={`${formStyles.page} font-latin`} lang="en">
          <div className={formStyles.content}>
            <p className={styles.subtle}>Loading…</p>
          </div>
        </main>
      }
    >
      <LoginForm />
    </Suspense>
  )
}
