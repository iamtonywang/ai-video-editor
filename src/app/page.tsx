import type { CSSProperties } from 'react'
import Link from 'next/link'
import { supabaseAdmin } from '@/lib/supabase/admin'
import styles from './page.module.css'

type ProjectRow = {
  id: string
  title: string | null
  workflow_status: string | null
  created_at: string | null
}

type IdentityGateSummary = 'passed' | 'blocked' | 'no_gate'

function identityGateColor(summary: IdentityGateSummary): string {
  if (summary === 'passed') return '#16a34a'
  if (summary === 'blocked') return '#dc2626'
  return '#6b7280'
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
  const { data } = await supabaseAdmin
    .from('projects')
    .select('id, title, workflow_status, created_at')
    .order('created_at', { ascending: false })
    .limit(5)

  const projects: ProjectRow[] = (data ?? []) as ProjectRow[]

  const projectIds = projects.map((p) => p.id)
  const latestIdentityGateByProject = new Map<string, 'passed' | 'blocked'>()

  if (projectIds.length > 0) {
    const { data: gateRows } = await supabaseAdmin
      .from('gate_evaluations')
      .select('project_id, decision, created_at')
      .eq('gate_type', 'identity')
      .in('project_id', projectIds)
      .order('created_at', { ascending: false })

    for (const g of gateRows ?? []) {
      const pid = typeof g.project_id === 'string' ? g.project_id : ''
      if (!pid || latestIdentityGateByProject.has(pid)) continue
      if (g.decision === 'passed' || g.decision === 'blocked') {
        latestIdentityGateByProject.set(pid, g.decision)
      }
    }
  }

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

  const gateStyleBase: CSSProperties = {
    margin: '0.35rem 0 0',
    fontSize: '0.6875rem',
    lineHeight: 1.35,
    fontWeight: 500,
    letterSpacing: '0.02em',
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

              const identityGate: IdentityGateSummary =
                latestIdentityGateByProject.get(row.id) ?? 'no_gate'

              return (
                <Link
                  key={row.id}
                  href={`/projects/${row.id}`}
                  style={cardStyle}
                  prefetch={false}
                >
                  <p style={titleStyle}>{displayTitle}</p>
                  <p style={metaStyle}>{status}</p>
                  <p
                    style={{
                      ...gateStyleBase,
                      color: identityGateColor(identityGate),
                    }}
                  >
                    {identityGate}
                  </p>
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
