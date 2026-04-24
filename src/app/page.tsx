'use client'

import { FormEvent, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import styles from './page.module.css'

export default function Home() {
  const router = useRouter()
  const [projectId, setProjectId] = useState('')

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const id = projectId.trim()
    if (!id) return
    router.push(`/projects/${id}`)
  }

  return (
    <main className={`${styles.page} font-latin`} lang="en">
      <div className={styles.content}>
        <header className={styles.header}>
          <h1 className={styles.title}>SHAWWANG</h1>
          <p className={styles.subtitle}>AI Video Engine</p>
        </header>
        <p className={styles.hint}>Enter your project ID to continue</p>
        <p className={styles.hint}>
          <Link
            href="/login"
            style={{ color: '#2563eb', textDecoration: 'none' }}
          >
            Log in
          </Link>
          <span> to create projects (owner is saved on create API).</span>
        </p>

        <form className={styles.form} onSubmit={handleSubmit}>
          <input
            type="text"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            placeholder="Paste your project ID here"
            className={styles.input}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className={styles.button}>
            Enter Workspace
          </button>
        </form>
      </div>
    </main>
  )
}
