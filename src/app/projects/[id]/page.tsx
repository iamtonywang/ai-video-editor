'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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

type ExecutionContextResponse = {
  ok: boolean
  data?: {
    project_id: string
    reference_asset_id: string | null
    has_reference_asset: boolean
    has_running_build_identity: boolean
    running_build_identity_job_id: string | null
    can_run_identity: boolean
    blocked_reason: string | null
  }
  error?: string
}

type PageProps = {
  params: Promise<{ id: string }>
}

const FALLBACK_ERROR_MESSAGE = 'Something went wrong.'

function mapApiErrorToUserMessage(code: string | undefined): string {
  switch (code) {
    case 'INVALID_PROJECT_ID':
      return 'Invalid Project ID'
    case 'PROJECT_ID_REQUIRED':
      return 'Project ID is required'
    case 'REFERENCE_ASSET_REQUIRED':
      return 'Reference asset required'
    case 'BUILD_IDENTITY_ALREADY_RUNNING':
      return 'Already running'
    case 'CHUNK_IDENTITY_GATE_BLOCKED':
      return 'Chunk identity gate blocked'
    default:
      return FALLBACK_ERROR_MESSAGE
  }
}

export default function ProjectGateStatusPage({ params }: PageProps) {
  const [projectId, setProjectId] = useState('')
  const [status, setStatus] = useState<GateStatus>('no_gate')
  const [measuredValue, setMeasuredValue] = useState<number | null>(null)
  const [threshold, setThreshold] = useState<number | null>(null)
  const [reasonCode, setReasonCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const [canRunIdentity, setCanRunIdentity] = useState(false)
  const [blockedReason, setBlockedReason] = useState<string | null>(null)
  const [hasRunningBuildIdentity, setHasRunningBuildIdentity] = useState(false)

  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [contextLoadError, setContextLoadError] = useState<string | null>(null)

  const refreshExecutionContext = useCallback(async (id: string) => {
    const response = await fetch(`/api/projects/${id}/execution-context`, {
      method: 'GET',
      cache: 'no-store',
    })
    const body = (await response.json()) as ExecutionContextResponse
    if (!response.ok || !body.ok || !body.data) {
      setCanRunIdentity(false)
      setBlockedReason(null)
      setHasRunningBuildIdentity(false)
      setContextLoadError(mapApiErrorToUserMessage(body.error))
      return
    }
    setContextLoadError(null)
    setCanRunIdentity(!!body.data.can_run_identity)
    setBlockedReason(body.data.blocked_reason ?? null)
    setHasRunningBuildIdentity(!!body.data.has_running_build_identity)
  }, [])

  const refreshGateStatus = useCallback(async (id: string) => {
    const response = await fetch(`/api/projects/${id}/gate-status`, {
      method: 'GET',
      cache: 'no-store',
    })
    const gateBody = (await response.json()) as GateStatusResponse
    if (!response.ok || !gateBody.ok || !gateBody.data) {
      setErrorMessage(mapApiErrorToUserMessage(gateBody.error))
      return
    }
    setErrorMessage(null)
    setStatus(gateBody.data.status)
    setMeasuredValue(gateBody.data.measured_value)
    setThreshold(gateBody.data.threshold)
    setReasonCode(gateBody.data.reason_code)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadGateAndContext() {
      try {
        const resolvedParams = await params
        const id = typeof resolvedParams?.id === 'string' ? resolvedParams.id.trim() : ''

        if (!id) {
          if (!cancelled) {
            setErrorMessage(mapApiErrorToUserMessage('PROJECT_ID_REQUIRED'))
            setLoading(false)
          }
          return
        }

        if (!cancelled) {
          setProjectId(id)
          setContextLoadError(null)
        }

        const [gateResponse, execResponse] = await Promise.all([
          fetch(`/api/projects/${id}/gate-status`, {
            method: 'GET',
            cache: 'no-store',
          }),
          fetch(`/api/projects/${id}/execution-context`, {
            method: 'GET',
            cache: 'no-store',
          }),
        ])

        const gateBody = (await gateResponse.json()) as GateStatusResponse
        const execBody = (await execResponse.json()) as ExecutionContextResponse

        if (!cancelled) {
          if (!execResponse.ok || !execBody.ok || !execBody.data) {
            setCanRunIdentity(false)
            setBlockedReason(null)
            setHasRunningBuildIdentity(false)
            setContextLoadError(mapApiErrorToUserMessage(execBody.error))
          } else {
            setCanRunIdentity(!!execBody.data.can_run_identity)
            setBlockedReason(execBody.data.blocked_reason ?? null)
            setHasRunningBuildIdentity(!!execBody.data.has_running_build_identity)
            setContextLoadError(null)
          }
        }

        if (!gateResponse.ok || !gateBody.ok || !gateBody.data) {
          if (!cancelled) {
            setErrorMessage(mapApiErrorToUserMessage(gateBody.error))
            setLoading(false)
          }
          return
        }

        if (!cancelled) {
          setStatus(gateBody.data.status)
          setMeasuredValue(gateBody.data.measured_value)
          setThreshold(gateBody.data.threshold)
          setReasonCode(gateBody.data.reason_code)
          setLoading(false)
        }
      } catch {
        if (!cancelled) {
          setErrorMessage(FALLBACK_ERROR_MESSAGE)
          setLoading(false)
        }
      }
    }

    loadGateAndContext()

    return () => {
      cancelled = true
    }
  }, [params])

  const statusClassName = useMemo(() => {
    if (status === 'passed') return styles.statusPassed
    if (status === 'blocked') return styles.statusBlocked
    return styles.statusNoGate
  }, [status])

  const actionButtonText = useMemo(() => {
    if (status === 'passed') return 'Continue'
    if (isSubmitting) return 'Building...'
    if (hasRunningBuildIdentity) return 'Building...'
    if (status === 'blocked') return 'Retry Identity Build'
    return 'Run Identity Check'
  }, [status, isSubmitting, hasRunningBuildIdentity])

  const actionDisabled = useMemo(() => {
    if (status === 'passed') return true
    if (!canRunIdentity || isSubmitting) return true
    return false
  }, [status, canRunIdentity, isSubmitting])

  const availabilityHint = useMemo(() => {
    if (status === 'passed') return null
    if (canRunIdentity) return null
    if (hasRunningBuildIdentity && !isSubmitting) return 'Building...'
    const code = blockedReason ?? null
    if (!code) return null
    return mapApiErrorToUserMessage(code)
  }, [status, canRunIdentity, blockedReason, hasRunningBuildIdentity, isSubmitting])

  async function handleActionClick() {
    if (status === 'passed') return
    if (!canRunIdentity || isSubmitting || !projectId) return

    setIsSubmitting(true)
    setActionMessage(null)

    try {
      const response = await fetch('/api/identity/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      })
      const body = (await response.json()) as {
        ok?: boolean
        error?: string
        job_id?: string
      }

      if (response.ok && body.ok) {
        setActionMessage('Building started')
        await Promise.all([
          refreshExecutionContext(projectId),
          refreshGateStatus(projectId),
        ])
      } else if (response.status === 409) {
        setActionMessage('Already running')
        await Promise.all([
          refreshExecutionContext(projectId),
          refreshGateStatus(projectId),
        ])
      } else if (response.status === 400) {
        setActionMessage(mapApiErrorToUserMessage(body.error))
      } else {
        setActionMessage(mapApiErrorToUserMessage(body.error))
      }
    } catch {
      setActionMessage(FALLBACK_ERROR_MESSAGE)
    } finally {
      setIsSubmitting(false)
    }
  }

  const buttonStyle = useMemo(
    () =>
      ({
        opacity: actionDisabled ? 0.45 : 1,
        cursor: actionDisabled ? 'not-allowed' : 'pointer',
      }) as const,
    [actionDisabled]
  )

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
          <button
            type="button"
            className={styles.actionButton}
            style={buttonStyle}
            disabled={actionDisabled}
            onClick={handleActionClick}
          >
            {actionButtonText}
          </button>
          {availabilityHint ? (
            <p className={styles.metaHint}>
              {availabilityHint}
            </p>
          ) : null}
          {contextLoadError && !errorMessage ? (
            <p className={styles.metaHint}>
              {contextLoadError}
            </p>
          ) : null}
          {actionMessage ? (
            <p className={styles.metaHint}>
              {actionMessage}
            </p>
          ) : null}
        </section>
      </div>
    </main>
  )
}
