'use client'

import { FormEvent, Suspense, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { createAuthBrowserClient } from '@/lib/supabase/auth-browser'
import formStyles from '../page.module.css'
import styles from './page.module.css'

const ERROR_TEXT: Record<string, string> = {
  auth_callback_failed: 'Sign-in could not be completed. Try again.',
}

function LoginForm() {
  const searchParams = useSearchParams()
  const urlError = searchParams.get('error')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  return (
    <main className={`${formStyles.page} font-latin`} lang="en">
      <div className={formStyles.content}>
        <header className={formStyles.header}>
          <h1 className={formStyles.title}>Log in</h1>
          <p className={formStyles.subtitle}>Email magic link</p>
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

        <form
          className={formStyles.form}
          onSubmit={async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault()
            setError(null)
            setMessage(null)
            const trimmed = email.trim()
            if (!trimmed) {
              setError('Email is required.')
              return
            }
            setSending(true)
            try {
              const supabase = createAuthBrowserClient()
              const { error: otpError } = await supabase.auth.signInWithOtp({
                email: trimmed,
                options: {
                  emailRedirectTo: `${window.location.origin}/auth/callback`,
                },
              })
              if (otpError) {
                setError(otpError.message)
                return
              }
              setMessage('Check your email for the sign-in link.')
            } catch (e) {
              setError(
                e instanceof Error ? e.message : 'Could not send magic link.'
              )
            } finally {
              setSending(false)
            }
          }}
        >
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            className={formStyles.input}
            autoComplete="email"
            spellCheck={false}
            disabled={sending}
            aria-label="Email"
          />
          <button
            type="submit"
            className={formStyles.button}
            disabled={sending}
          >
            {sending ? 'Sending…' : 'Send magic link'}
          </button>
        </form>

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
