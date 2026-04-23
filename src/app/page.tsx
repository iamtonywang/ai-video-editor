import type { CSSProperties } from 'react'
import Link from 'next/link'
import { createClient } from '@supabase/supabase-js'
import styles from './page.module.css'

type ProjectRow = {
  id: string
  title: string | null
  workflow_status: string | null
  created_at: string | null
}

function formatCreatedAt(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default async function Home() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required'
    )
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey)

  const { data } = await supabase
    .from('projects')
    .select('id, title, workflow_status, created_at')
    .order('created_at', { ascending: false })
    .limit(5)

  const projects: ProjectRow[] = (data ?? []) as ProjectRow[]

  const listStyle: CSSProperties = {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    textAlign: 'left',
    marginTop: '0.25rem',
  }

  const cardStyle: CSSProperties = {
    display: 'block',
    boxSizing: 'border-box',
    width: '100%',
    padding: '0.875rem 1rem',
    border: '1px solid #d1d1d1',
    borderRadius: 14,
    textDecoration: 'none',
    color: '#111827',
    transition: 'border-color 0.15s ease',
  }

  const titleStyle: CSSProperties = {
    margin: 0,
    fontSize: '0.9375rem',
    fontWeight: 600,
    lineHeight: 1.35,
  }

  const metaStyle: CSSProperties = {
    margin: '0.35rem 0 0',
    fontSize: '0.75rem',
    lineHeight: 1.4,
    color: '#6b7280',
  }

  const emptyStyle: CSSProperties = {
    margin: 0,
    fontSize: '0.875rem',
    color: '#4b5563',
  }

  return (
    <main className={`${styles.page} font-latin`} lang="en">
      <div className={styles.content}>
        <header className={styles.header}>
          <h1 className={styles.title}>SHAWWANG</h1>
          <p className={styles.subtitle}>AI Video Engine</p>
        </header>

        {projects.length === 0 ? (
          <p style={emptyStyle}>No projects yet</p>
        ) : (
          <div style={listStyle}>
            {projects.map((row) => {
              const displayTitle =
                typeof row.title === 'string' && row.title.trim()
                  ? row.title.trim()
                  : 'Untitled'
              const status =
                typeof row.workflow_status === 'string' &&
                row.workflow_status.trim()
                  ? row.workflow_status.trim()
                  : '—'

              return (
                <Link
                  key={row.id}
                  href={`/projects/${row.id}`}
                  style={cardStyle}
                  prefetch={false}
                >
                  <p style={titleStyle}>{displayTitle}</p>
                  <p style={metaStyle}>{status}</p>
                  <p style={metaStyle}>{formatCreatedAt(row.created_at)}</p>
                </Link>
              )
            })}
          </div>
        )}
      </div>
    </main>
  )
}
