'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
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

type CreateProjectResponse =
  | {
      ok: true
      data: {
        project_id: string
        title: string
        workflow_status: string
        created_at: string
        owner_user_id: string
      }
    }
  | { ok: false; error: string; error_detail?: string }

function formatDate(value: string | null) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString()
}

export default function ProjectsPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<ProjectListItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [needsLogin, setNeedsLogin] = useState(false)

  const [newTitle, setNewTitle] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

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

  async function handleCreateProject(event: FormEvent) {
    event.preventDefault()
    setCreateError(null)
    setDeleteError(null)

    const title = newTitle.trim()
    if (!title) {
      setCreateError('Title is required.')
      return
    }

    setCreating(true)
    try {
      const response = await fetch('/api/projects/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })

      const body = (await response.json()) as CreateProjectResponse
      if (!response.ok || !body.ok) {
        setCreateError(body.ok ? 'UNKNOWN_ERROR' : body.error)
        return
      }

      router.push(`/projects/${body.data.project_id}`)
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'UNKNOWN_ERROR')
    } finally {
      setCreating(false)
    }
  }

  async function handleDeleteProject(id: string) {
    setCreateError(null)
    setDeleteError(null)

    const confirmed = confirm('Delete this project? This cannot be undone.')
    if (!confirmed) return

    setDeletingId(id)
    try {
      const response = await fetch(`/api/projects/${id}`, {
        method: 'DELETE',
        cache: 'no-store',
      })
      const body = (await response.json()) as { ok?: boolean; error?: string }
      if (!response.ok || !body.ok) {
        setDeleteError(body.error ?? 'UNKNOWN_ERROR')
        return
      }

      setItems((prev) => prev.filter((p) => p.id !== id))
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'UNKNOWN_ERROR')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <main className={`${styles.page} font-latin`} lang="en">
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>Projects</h1>
          <p className={styles.subtitle}>Your workspace projects</p>
          <div className={styles.topActions}>
            <Link href="/" className={styles.actionLink}>
              Back to home
            </Link>
          </div>
        </header>

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

        {deleteError && !needsLogin && (
          <div className={styles.error}>
            <p style={{ margin: 0 }}>{deleteError}</p>
          </div>
        )}

        {!loading && !needsLogin && !error && (
          <section className={styles.createCard} aria-label="Create new project">
            <form className={styles.createForm} onSubmit={handleCreateProject}>
              <div className={styles.createStack}>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className={styles.createInput}
                  placeholder="Project title"
                  aria-label="Project title"
                  disabled={creating}
                  spellCheck={false}
                />
                <button
                  type="submit"
                  className={styles.createButton}
                  disabled={creating}
                >
                  {creating ? 'Creating…' : 'Create New Project'}
                </button>
              </div>
              {createError && <p className={styles.createError}>{createError}</p>}
            </form>
          </section>
        )}

        {empty && <div className={styles.empty}>No projects yet</div>}

        {!loading && !needsLogin && !error && items.length > 0 && (
          <ul className={styles.list}>
            {items.map((p) => {
              const updatedLabel = formatDate(p.updated_at)
              const createdLabel = formatDate(p.created_at)
              const isDeleting = deletingId === p.id
              return (
                <li key={p.id}>
                  <div className={styles.card}>
                    <Link href={`/projects/${p.id}`} className={styles.cardMainLink}>
                      <div className={styles.cardCenter}>
                        <p className={styles.projectTitle}>{p.title}</p>
                        <p className={styles.meta}>
                          {updatedLabel
                            ? `Updated ${updatedLabel}`
                            : createdLabel
                              ? `Created ${createdLabel}`
                              : null}
                        </p>
                        <span className={styles.status}>{p.workflow_status}</span>
                      </div>
                    </Link>
                    <div className={styles.cardActions}>
                      <button
                        type="button"
                        className={styles.deleteButton}
                        disabled={isDeleting}
                        onClick={() => handleDeleteProject(p.id)}
                        aria-label={`Delete project ${p.title}`}
                      >
                        {isDeleting ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </main>
  )
}

