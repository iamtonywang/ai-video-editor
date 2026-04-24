'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import styles from './projects.module.css'

type ProjectListItem = {
  id: string
  title: string
  workflow_status: string
  created_at: string
  updated_at: string | null
}

type ProjectsResponse =
  | { ok: true; data: ProjectListItem[] }
  | { ok: false; error: string }

function formatDate(value: string | null) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString()
}

export default function ProjectsPage() {
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<ProjectListItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [needsLogin, setNeedsLogin] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const res = await fetch('/api/projects', {
          method: 'GET',
          cache: 'no-store',
        })

        if (res.status === 401) {
          if (!cancelled) {
            setNeedsLogin(true)
            setItems([])
            setError(null)
            setLoading(false)
          }
          return
        }

        const body = (await res.json()) as ProjectsResponse
        if (!res.ok || !body.ok) {
          if (!cancelled) {
            setError(body.ok ? 'UNKNOWN_ERROR' : body.error)
            setItems([])
            setNeedsLogin(false)
            setLoading(false)
          }
          return
        }

        if (!cancelled) {
          setItems(body.data)
          setNeedsLogin(false)
          setError(null)
          setLoading(false)
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'UNKNOWN_ERROR')
          setItems([])
          setNeedsLogin(false)
          setLoading(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const empty = useMemo(() => !loading && !needsLogin && !error && items.length === 0, [
    loading,
    needsLogin,
    error,
    items.length,
  ])

  return (
    <main className={`${styles.page} font-latin`} lang="en">
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>Projects</h1>
          <p className={styles.subtitle}>Your workspace projects</p>
        </header>

        <div className={styles.topActions}>
          <Link href="/" className={styles.actionLink}>
            Back to home
          </Link>
        </div>

        {loading && <p className={styles.meta}>Loading…</p>}

        {needsLogin && (
          <div className={styles.error}>
            <p style={{ margin: 0 }}>Login required.</p>
          </div>
        )}

        {error && !needsLogin && (
          <div className={styles.error}>
            <p style={{ margin: 0 }}>{error}</p>
          </div>
        )}

        {empty && <div className={styles.empty}>No projects yet</div>}

        {!loading && !needsLogin && !error && items.length > 0 && (
          <ul className={styles.list}>
            {items.map((p) => {
              const updatedLabel = formatDate(p.updated_at)
              const createdLabel = formatDate(p.created_at)
              return (
                <li key={p.id}>
                  <Link href={`/projects/${p.id}`} className={styles.cardLink}>
                    <div className={styles.projectTitleRow}>
                      <p className={styles.projectTitle}>{p.title}</p>
                      <span className={styles.status}>{p.workflow_status}</span>
                    </div>
                    <p className={styles.meta}>
                      {updatedLabel
                        ? `Updated ${updatedLabel}`
                        : createdLabel
                          ? `Created ${createdLabel}`
                          : null}
                    </p>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </main>
  )
}

