'use client'

import { useEffect, useMemo, useState } from 'react'
import styles from './page.module.css'

type GateStatus = 'passed' | 'blocked' | 'no_gate'

type GateStatusResponse = {
  ok: boolean
  data?: {
    status: GateStatus
    measured_value: number | null
    threshold: number | null
    reason_code: string | null
  }
  error?: string
}

type PageProps = {
  params: Promise<{ id: string }>
}

export default function ProjectGateStatusPage({ params }: PageProps) {
  const [projectId, setProjectId] = useState('')
  const [status, setStatus] = useState<GateStatus>('no_gate')
  const [measuredValue, setMeasuredValue] = useState<number | null>(null)
  const [threshold, setThreshold] = useState<number | null>(null)
  const [reasonCode, setReasonCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadGateStatus() {
      try {
        const resolvedParams = await params
        const id = typeof resolvedParams?.id === 'string' ? resolvedParams.id.trim() : ''

        if (!id) {
          if (!cancelled) {
            setErrorMessage('Project ID is invalid.')
            setLoading(false)
          }
          return
        }

        if (!cancelled) {
          setProjectId(id)
        }

        const response = await fetch(`/api/projects/${id}/gate-status`, {
          method: 'GET',
          cache: 'no-store',
        })
        const body = (await response.json()) as GateStatusResponse

        if (!response.ok || !body.ok || !body.data) {
          if (!cancelled) {
            setErrorMessage('Failed to load gate status.')
            setLoading(false)
          }
          return
        }

        if (!cancelled) {
          setStatus(body.data.status)
          setMeasuredValue(body.data.measured_value)
          setThreshold(body.data.threshold)
          setReasonCode(body.data.reason_code)
          setLoading(false)
        }
      } catch {
        if (!cancelled) {
          setErrorMessage('Failed to load gate status.')
          setLoading(false)
        }
      }
    }

    loadGateStatus()

    return () => {
      cancelled = true
    }
  }, [params])

  const statusClassName = useMemo(() => {
    if (status === 'passed') return styles.statusPassed
    if (status === 'blocked') return styles.statusBlocked
    return styles.statusNoGate
  }, [status])

  const actionLabel = useMemo(() => {
    if (status === 'blocked') return 'Retry Identity Build'
    if (status === 'passed') return 'Continue'
    return 'Run Identity Check'
  }, [status])

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <p className={styles.label}>Project</p>
          <p className={styles.projectId}>{projectId || 'Unknown Project'}</p>
          <h1 className={styles.title}>Gate Status</h1>
        </header>

        <section className={styles.card} aria-live="polite">
          {loading ? (
            <p className={styles.meta}>Loading gate status...</p>
          ) : errorMessage ? (
            <p className={styles.error}>{errorMessage}</p>
          ) : (
            <>
              <p className={`${styles.statusText} ${statusClassName}`}>{status}</p>
              <p className={styles.meta}>
                measured_value: {measuredValue == null ? '-' : measuredValue}
              </p>
              <p className={styles.meta}>
                threshold: {threshold == null ? '-' : threshold}
              </p>
              {reasonCode ? <p className={styles.reason}>reason_code: {reasonCode}</p> : null}
            </>
          )}
        </section>

        <section className={styles.actions}>
          <button type="button" className={styles.actionButton}>
            {actionLabel}
          </button>
        </section>
      </div>
    </main>
  )
}
