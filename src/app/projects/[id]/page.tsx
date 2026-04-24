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

  const [referenceAssetKey, setReferenceAssetKey] = useState('')
  const [registeringRef, setRegisteringRef] = useState(false)
  const [referenceError, setReferenceError] = useState<string | null>(null)

  const [jobStatusLoading, setJobStatusLoading] = useState(false)
  const [jobStatusError, setJobStatusError] = useState<string | null>(null)
  const [stoppingJob, setStoppingJob] = useState(false)
  const [stopJobError, setStopJobError] = useState<string | null>(null)
  const [promptAccordionOpen, setPromptAccordionOpen] = useState(false)
  const [previewInstruction, setPreviewInstruction] = useState('')
  const [previewSubmitting, setPreviewSubmitting] = useState(false)
  const [previewValidationError, setPreviewValidationError] = useState<string | null>(null)
  const [previewSubmitError, setPreviewSubmitError] = useState<string | null>(null)
  const [jobStatus, setJobStatus] = useState<{
    job: null | {
      id: string
      job_type: string
      status: string
      progress: number | null
      error_code: string | null
      error_message: string | null
      created_at: string
      started_at: string | null
      finished_at: string | null
    }
    latest_event: null | {
      level: string
      step: string
      message: string
      event_ts: string
    }
  }>({ job: null, latest_event: null })

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

  const refreshJobStatus = useCallback(async (id: string) => {
    setJobStatusLoading(true)
    setJobStatusError(null)
    try {
      const response = await fetch(`/api/projects/${id}/job-status`, {
        method: 'GET',
        cache: 'no-store',
      })
      const body = (await response.json()) as
        | {
            ok: true
            data: {
              job: null | {
                id: string
                job_type: string
                status: string
                progress: number | null
                error_code: string | null
                error_message: string | null
                created_at: string
                started_at: string | null
                finished_at: string | null
              }
              latest_event: null | {
                level: string
                step: string
                message: string
                event_ts: string
              }
            }
          }
        | { ok: false; error: string }

      if (!response.ok || !body.ok) {
        setJobStatusError(body.ok ? FALLBACK_ERROR_MESSAGE : body.error)
        return
      }

      setJobStatus(body.data)
    } catch {
      setJobStatusError(FALLBACK_ERROR_MESSAGE)
    } finally {
      setJobStatusLoading(false)
    }
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

        void refreshJobStatus(id)
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

  const shouldPollJobStatus = useMemo(() => {
    const s = jobStatus.job?.status ?? ''
    return s === 'queued' || s === 'running'
  }, [jobStatus.job?.status])

  useEffect(() => {
    if (!projectId) return
    if (!shouldPollJobStatus) return

    let cancelled = false
    const pollId = setInterval(() => {
      if (cancelled) return
      void refreshJobStatus(projectId)
    }, 2500)

    return () => {
      cancelled = true
      clearInterval(pollId)
    }
  }, [projectId, shouldPollJobStatus, refreshJobStatus])

  const stopButtonVisible = useMemo(() => {
    const s = jobStatus.job?.status ?? ''
    return !!jobStatus.job?.id && (s === 'queued' || s === 'running')
  }, [jobStatus.job?.id, jobStatus.job?.status])

  async function handleRegisterReferenceAsset() {
    setReferenceError(null)
    setActionMessage(null)

    const asset_key = referenceAssetKey.trim()
    if (!asset_key) {
      setReferenceError('Asset key is required.')
      return
    }

    if (!projectId) {
      setReferenceError('Project ID is required.')
      return
    }

    setRegisteringRef(true)
    try {
      const response = await fetch('/api/source/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          asset_type: 'reference',
          asset_key,
          asset_status: 'validated',
        }),
      })

      const body = (await response.json()) as { ok?: boolean; error?: string }
      if (!response.ok || !body.ok) {
        setReferenceError(body.error ?? FALLBACK_ERROR_MESSAGE)
        return
      }

      setReferenceAssetKey('')
      await Promise.all([
        refreshExecutionContext(projectId),
        refreshGateStatus(projectId),
        refreshJobStatus(projectId),
      ])
    } catch {
      setReferenceError(FALLBACK_ERROR_MESSAGE)
    } finally {
      setRegisteringRef(false)
    }
  }

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
          refreshJobStatus(projectId),
        ])
      } else if (response.status === 409) {
        setActionMessage('Already running')
        await Promise.all([
          refreshExecutionContext(projectId),
          refreshGateStatus(projectId),
          refreshJobStatus(projectId),
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

  async function handleStopJob() {
    const jobId = jobStatus.job?.id ?? ''
    if (!projectId || !jobId) return

    setStopJobError(null)

    if (!confirm('Stop this job?')) return

    setStoppingJob(true)
    try {
      const response = await fetch(
        `/api/projects/${projectId}/jobs/${jobId}/cancel`,
        { method: 'POST' }
      )

      const body = (await response.json()) as
        | { ok: true; data: { job_id: string; status: 'canceled' } }
        | { ok: false; error: string; status?: string }

      if (!response.ok || !body.ok) {
        if (!body.ok && body.error === 'JOB_NOT_CANCELABLE') {
          setStopJobError(`JOB_NOT_CANCELABLE (status: ${body.status ?? '-'})`)
          return
        }
        setStopJobError(body.ok ? FALLBACK_ERROR_MESSAGE : body.error)
        return
      }

      await Promise.all([
        refreshJobStatus(projectId),
        refreshExecutionContext(projectId),
        refreshGateStatus(projectId),
      ])
    } catch {
      setStopJobError(FALLBACK_ERROR_MESSAGE)
    } finally {
      setStoppingJob(false)
    }
  }

  async function handleRunPreview() {
    setPreviewValidationError(null)
    setPreviewSubmitError(null)

    const instruction = previewInstruction.trim()
    if (!instruction) {
      setPreviewValidationError('Enter an instruction to run preview.')
      return
    }

    if (!projectId) {
      setPreviewValidationError('Project ID is required.')
      return
    }

    setPreviewSubmitting(true)
    try {
      const response = await fetch('/api/job/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          job_type: 'preview',
          status: 'queued',
          instruction,
        }),
      })

      const body = (await response.json()) as {
        ok?: boolean
        error?: string
      }

      if (!response.ok || !body.ok) {
        setPreviewSubmitError(body.error ?? FALLBACK_ERROR_MESSAGE)
      }
    } catch {
      setPreviewSubmitError(FALLBACK_ERROR_MESSAGE)
    } finally {
      await refreshJobStatus(projectId)
      setPreviewSubmitting(false)
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
          <section className={styles.jobCard} aria-label="Job status">
            <p className={styles.jobTitle}>Job Status</p>
            {jobStatusLoading ? (
              <p className={styles.metaHint}>Loading…</p>
            ) : jobStatusError ? (
              <p className={styles.referenceError} role="alert">
                {jobStatusError}
              </p>
            ) : !jobStatus.job ? (
              <p className={styles.metaHint}>No job yet</p>
            ) : (
              <div className={styles.jobGrid}>
                <div className={styles.jobRow}>
                  <span className={styles.jobKey}>job_type</span>
                  <span className={styles.jobValue}>{jobStatus.job.job_type}</span>
                </div>
                <div className={styles.jobRow}>
                  <span className={styles.jobKey}>status</span>
                  <span className={styles.jobValue}>{jobStatus.job.status}</span>
                </div>
                <div className={styles.jobRow}>
                  <span className={styles.jobKey}>progress</span>
                  <span className={styles.jobValue}>
                    {jobStatus.job.progress == null ? '-' : jobStatus.job.progress}
                  </span>
                </div>
                <div className={styles.jobRow}>
                  <span className={styles.jobKey}>latest_event</span>
                  <span className={styles.jobValue}>
                    {jobStatus.latest_event?.message ?? '-'}
                  </span>
                </div>
                {jobStatus.job.error_code ? (
                  <div className={styles.jobRow}>
                    <span className={styles.jobKey}>error_code</span>
                    <span className={styles.jobValue}>{jobStatus.job.error_code}</span>
                  </div>
                ) : null}
                {jobStatus.job.error_message ? (
                  <div className={styles.jobRow}>
                    <span className={styles.jobKey}>error_message</span>
                    <span className={styles.jobValue}>{jobStatus.job.error_message}</span>
                  </div>
                ) : null}
                {stopButtonVisible ? (
                  <div className={styles.jobActions}>
                    <button
                      type="button"
                      className={styles.stopButton}
                      disabled={stoppingJob}
                      onClick={handleStopJob}
                    >
                      {stoppingJob ? 'Stopping...' : 'Stop'}
                    </button>
                  </div>
                ) : null}
                {stopJobError ? (
                  <p className={styles.referenceError} role="alert">
                    {stopJobError}
                  </p>
                ) : null}
              </div>
            )}
          </section>

          <section className={styles.promptCard} aria-label="Prompt">
            <button
              type="button"
              className={styles.promptToggle}
              aria-expanded={promptAccordionOpen}
              onClick={() => setPromptAccordionOpen((open) => !open)}
            >
              Prompt
            </button>
            {promptAccordionOpen ? (
              <>
                <p className={styles.promptNotImplementedHint}>
                  Preview placeholder completed. Real rendering is not connected yet.
                </p>
                <textarea
                  className={styles.promptTextarea}
                  value={previewInstruction}
                  onChange={(e) => setPreviewInstruction(e.target.value)}
                  placeholder="Describe what you want to preview…"
                  aria-label="Preview instruction"
                  rows={5}
                  disabled={previewSubmitting}
                  spellCheck={true}
                />
                <button
                  type="button"
                  className={styles.promptRunButton}
                  disabled={previewSubmitting}
                  onClick={handleRunPreview}
                >
                  {previewSubmitting ? 'Running…' : 'Run Preview'}
                </button>
                {previewValidationError ? (
                  <p className={styles.referenceError} role="alert">
                    {previewValidationError}
                  </p>
                ) : null}
                {previewSubmitError ? (
                  <p className={styles.referenceError} role="alert">
                    {previewSubmitError}
                  </p>
                ) : null}
              </>
            ) : null}
          </section>

          <section className={styles.referenceCard} aria-label="Register reference asset">
            <p className={styles.referenceTitle}>Reference asset</p>
            <input
              type="text"
              value={referenceAssetKey}
              onChange={(e) => setReferenceAssetKey(e.target.value)}
              className={styles.referenceInput}
              placeholder="asset_key (e.g. storage/path.ext)"
              aria-label="Reference asset key"
              disabled={registeringRef}
              spellCheck={false}
            />
            <button
              type="button"
              className={styles.referenceButton}
              disabled={registeringRef}
              onClick={handleRegisterReferenceAsset}
            >
              {registeringRef ? 'Registering…' : 'Register Reference Asset'}
            </button>
            {referenceError ? (
              <p className={styles.referenceError} role="alert">
                {referenceError}
              </p>
            ) : null}
          </section>

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
