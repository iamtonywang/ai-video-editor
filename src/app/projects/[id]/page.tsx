'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

const PLATFORM_URLS = {
  youtube: 'https://www.youtube.com',
  instagram: 'https://www.instagram.com',
  tiktok: 'https://www.tiktok.com',
} as const

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

  const referenceFileInputRef = useRef<HTMLInputElement>(null)
  const [uploadReferenceSubmitting, setUploadReferenceSubmitting] = useState(false)
  const [uploadReferenceValidationError, setUploadReferenceValidationError] = useState<
    string | null
  >(null)
  const [uploadReferenceError, setUploadReferenceError] = useState<string | null>(null)
  const [uploadReferenceAssetKey, setUploadReferenceAssetKey] = useState<string | null>(null)
  const [referenceChosenFileLabel, setReferenceChosenFileLabel] = useState('')

  const [inputType, setInputType] = useState<'ai' | 'upload' | 'link'>('upload')
  const [linkPlatform, setLinkPlatform] = useState<'youtube' | 'instagram' | 'tiktok'>(
    'youtube'
  )
  const [linkUrl, setLinkUrl] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const [jobStatusLoading, setJobStatusLoading] = useState(false)
  const [jobStatusError, setJobStatusError] = useState<string | null>(null)
  const [stoppingJob, setStoppingJob] = useState(false)
  const [stopJobError, setStopJobError] = useState<string | null>(null)
  const [promptAccordionOpen, setPromptAccordionOpen] = useState(false)
  const [previewInstruction, setPreviewInstruction] = useState('')
  const [previewSubmitting, setPreviewSubmitting] = useState(false)
  const [previewValidationError, setPreviewValidationError] = useState<string | null>(null)
  const [previewSubmitError, setPreviewSubmitError] = useState<string | null>(null)
  const [previewImageFailed, setPreviewImageFailed] = useState(false)
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
      output_asset_key: string | null
      preview_url?: string | null
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
                output_asset_key: string | null
                preview_url: string | null
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
    return 'Prepare Source'
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

  const previewResultAssetKey = useMemo(() => {
    const job = jobStatus.job
    if (!job || job.job_type !== 'preview' || job.status !== 'success') return null
    const key = job.output_asset_key?.trim()
    return key ? key : null
  }, [jobStatus.job])

  const shouldShowPreviewResult = useMemo(() => {
    const job = jobStatus.job
    return !!job && job.job_type === 'preview' && job.status === 'success'
  }, [jobStatus.job?.job_type, jobStatus.job?.status])

  const previewImageUrl = useMemo(() => {
    const u = jobStatus.job?.preview_url?.trim()
    return u ? u : null
  }, [jobStatus.job?.preview_url])

  useEffect(() => {
    setPreviewImageFailed(false)
  }, [previewResultAssetKey])

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

  async function handleUploadReferenceFile() {
    setUploadReferenceValidationError(null)
    setUploadReferenceError(null)

    if (!projectId) {
      setUploadReferenceValidationError('Project ID is required.')
      return
    }

    const input = referenceFileInputRef.current
    const file = input?.files?.[0] ?? null
    if (!file) {
      setUploadReferenceValidationError('Select a JPEG, PNG, or WebP file to upload.')
      return
    }

    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp'])
    if (!allowed.has(file.type)) {
      setUploadReferenceValidationError('Only JPEG, PNG, or WebP images are allowed.')
      return
    }

    setUploadReferenceSubmitting(true)
    try {
      const formData = new FormData()
      formData.append('project_id', projectId)
      formData.append('file', file)

      const response = await fetch('/api/source/upload', {
        method: 'POST',
        body: formData,
      })

      const body = (await response.json()) as {
        ok?: boolean
        error?: string
        data?: { asset_key?: string }
      }

      if (!response.ok || !body.ok) {
        setUploadReferenceError(body.error ?? FALLBACK_ERROR_MESSAGE)
        return
      }

      const key = body.data?.asset_key
      if (key) {
        setUploadReferenceAssetKey(key)
      }
      if (input) input.value = ''
      await Promise.all([
        refreshExecutionContext(projectId),
        refreshGateStatus(projectId),
        refreshJobStatus(projectId),
      ])
    } catch {
      setUploadReferenceError(FALLBACK_ERROR_MESSAGE)
    } finally {
      setUploadReferenceSubmitting(false)
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
          <h1 className={styles.title}>내 프로젝트</h1>
          <p className={styles.headerSubtitle}>
            필요한 내용을 입력하고 결과를 확인하세요.
          </p>
        </header>

        <section className={styles.actions}>
          <div className={styles.workflowStep}>
            <section className={styles.inputTypeCard} aria-label="Input type">
              <p className={styles.inputTypeTitle}>작업 방식</p>
              <div className={styles.inputTypeGroup} role="group" aria-label="Input type">
                <button
                  type="button"
                  className={`${styles.inputTypeButton} ${
                    inputType === 'ai' ? styles.inputTypeButtonActive : ''
                  }`}
                  aria-pressed={inputType === 'ai'}
                  onClick={() => setInputType('ai')}
                >
                  AI 생성
                </button>
                <button
                  type="button"
                  className={`${styles.inputTypeButton} ${
                    inputType === 'upload' ? styles.inputTypeButtonActive : ''
                  }`}
                  aria-pressed={inputType === 'upload'}
                  onClick={() => setInputType('upload')}
                >
                  파일 업로드
                </button>
                <button
                  type="button"
                  className={`${styles.inputTypeButton} ${
                    inputType === 'link' ? styles.inputTypeButtonActive : ''
                  }`}
                  aria-pressed={inputType === 'link'}
                  onClick={() => setInputType('link')}
                >
                  링크 입력
                </button>
              </div>
              {inputType === 'ai' ? (
                <p className={styles.inputTypeHint}>
                  프롬프트를 입력하면 미리보기를 생성할 수 있습니다.
                </p>
              ) : null}
            </section>

            {inputType === 'upload' ? (
              <section className={styles.referenceCard} aria-label="Source">
                <div className={styles.sourceUploadBlock}>
                  <input
                    ref={referenceFileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className={styles.sourceFileInputHidden}
                    disabled={uploadReferenceSubmitting || registeringRef}
                    tabIndex={-1}
                    aria-label="Reference image file"
                    onChange={() => {
                      setUploadReferenceValidationError(null)
                      setUploadReferenceError(null)
                      const inputEl = referenceFileInputRef.current
                      const f = inputEl?.files?.[0]
                      setReferenceChosenFileLabel(f?.name ?? '')
                    }}
                  />
                  <button
                    type="button"
                    className={styles.sourceChooseFileButton}
                    disabled={uploadReferenceSubmitting || registeringRef}
                    onClick={() => referenceFileInputRef.current?.click()}
                  >
                    파일 선택
                  </button>
                  <p className={styles.sourceFileNameLine} aria-live="polite">
                    {referenceChosenFileLabel.trim()
                      ? referenceChosenFileLabel
                      : '선택된 파일 없음'}
                  </p>
                  <button
                    type="button"
                    className={styles.sourceUploadButton}
                    disabled={uploadReferenceSubmitting || registeringRef}
                    onClick={handleUploadReferenceFile}
                  >
                    {uploadReferenceSubmitting ? '업로드 중…' : '업로드'}
                  </button>
                </div>

                {false ? (
                  <>
                    <input
                      type="text"
                      value={referenceAssetKey}
                      onChange={(e) => setReferenceAssetKey(e.target.value)}
                      className={styles.referenceInput}
                      placeholder="Storage path or asset key"
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
                      {registeringRef ? '저장 중…' : '저장'}
                    </button>
                    {referenceError ? (
                      <p className={styles.referenceError} role="alert">
                        {referenceError}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </section>
            ) : null}

            {inputType === 'link' ? (
              <section className={styles.linkCard} aria-label="Link or platform source">
                <p className={styles.referenceTitle}>링크 입력</p>
                <div
                  className={styles.linkPlatformGroup}
                  role="group"
                  aria-label="Platform preset"
                >
                  <button
                    type="button"
                    className={`${styles.linkPlatformButton} ${
                      linkPlatform === 'youtube' ? styles.linkPlatformButtonActive : ''
                    }`}
                    aria-pressed={linkPlatform === 'youtube'}
                    aria-label="Open YouTube"
                    onClick={() => {
                      setLinkPlatform('youtube')
                      window.open(PLATFORM_URLS.youtube, '_blank', 'noopener,noreferrer')
                    }}
                  >
                    YouTube
                  </button>
                  <button
                    type="button"
                    className={`${styles.linkPlatformButton} ${
                      linkPlatform === 'instagram' ? styles.linkPlatformButtonActive : ''
                    }`}
                    aria-pressed={linkPlatform === 'instagram'}
                    aria-label="Open Instagram"
                    onClick={() => {
                      setLinkPlatform('instagram')
                      window.open(PLATFORM_URLS.instagram, '_blank', 'noopener,noreferrer')
                    }}
                  >
                    Instagram
                  </button>
                  <button
                    type="button"
                    className={`${styles.linkPlatformButton} ${
                      linkPlatform === 'tiktok' ? styles.linkPlatformButtonActive : ''
                    }`}
                    aria-pressed={linkPlatform === 'tiktok'}
                    aria-label="Open TikTok"
                    onClick={() => {
                      setLinkPlatform('tiktok')
                      window.open(PLATFORM_URLS.tiktok, '_blank', 'noopener,noreferrer')
                    }}
                  >
                    TikTok
                  </button>
                </div>
                <input
                  type="url"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  className={styles.referenceInput}
                  placeholder="영상 URL을 입력하세요"
                  aria-label="Platform video URL"
                  spellCheck={false}
                />
                <p className={styles.linkImportHint}>
                  링크 불러오기는 아직 연결되지 않았습니다.
                </p>
              </section>
            ) : null}

            {inputType === 'upload' ? (
              <>
                {uploadReferenceValidationError ? (
                  <p className={styles.referenceError} role="alert">
                    {uploadReferenceValidationError}
                  </p>
                ) : null}
                {uploadReferenceError ? (
                  <p className={styles.referenceError} role="alert">
                    {uploadReferenceError}
                  </p>
                ) : null}
                {uploadReferenceAssetKey ? (
                  <p className={styles.sourceUploadSuccess} aria-live="polite">
                    업로드 완료:{' '}
                    <span className={styles.sourceUploadKey}>{uploadReferenceAssetKey}</span>
                  </p>
                ) : null}
              </>
            ) : null}
          </div>

          <div className={styles.workflowStep}>
            <section className={styles.promptCard} aria-label="Prompt">
              <button
                type="button"
                className={styles.promptToggle}
                aria-expanded={promptAccordionOpen}
                onClick={() => setPromptAccordionOpen((open) => !open)}
              >
                프롬프트
              </button>
              {promptAccordionOpen ? (
                <>
                  <p className={styles.promptNotImplementedHint}>
                    미리보기는 현재 임시 화면입니다. 실제 렌더링은 아직 연결되지 않았습니다.
                  </p>
                  <textarea
                    className={styles.promptTextarea}
                    value={previewInstruction}
                    onChange={(e) => setPreviewInstruction(e.target.value)}
                    placeholder="원하는 미리보기 내용을 입력하세요…"
                    aria-label="Preview instruction"
                    rows={5}
                    disabled={previewSubmitting}
                    spellCheck={true}
                  />
                </>
              ) : null}
            </section>
          </div>

          <div className={styles.workflowStep}>
            <section className={styles.generateCard} aria-label="Generate preview">
              <button
                type="button"
                className={styles.promptRunButton}
                disabled={previewSubmitting}
                onClick={handleRunPreview}
              >
                {previewSubmitting ? '생성 중…' : '생성하기'}
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
            </section>
          </div>

          <div className={styles.workflowStep}>
            <section className={styles.jobCard} aria-label="Progress">
              {jobStatusLoading ? (
                <p className={styles.metaHint}>불러오는 중…</p>
              ) : jobStatusError ? (
                <p className={styles.referenceError} role="alert">
                  {jobStatusError}
                </p>
              ) : !jobStatus.job ? (
                <p className={styles.metaHint}>아직 작업이 없습니다</p>
              ) : (
                <div className={styles.jobGrid}>
                  <div className={styles.jobRow}>
                    <span className={styles.jobKey}>작업 종류</span>
                    <span className={styles.jobValue}>{jobStatus.job.job_type}</span>
                  </div>
                  <div className={styles.jobRow}>
                    <span className={styles.jobKey}>상태</span>
                    <span className={styles.jobValue}>{jobStatus.job.status}</span>
                  </div>
                  <div className={styles.jobRow}>
                    <span className={styles.jobKey}>진행률</span>
                    <span className={styles.jobValue}>
                      {jobStatus.job.progress == null ? '-' : jobStatus.job.progress}
                    </span>
                  </div>
                  <div className={styles.jobRow}>
                    <span className={styles.jobKey}>최근 업데이트</span>
                    <span className={styles.jobValue}>
                      {jobStatus.latest_event?.message ?? '-'}
                    </span>
                  </div>
                  {jobStatus.job.error_code ? (
                    <div className={styles.jobRow}>
                      <span className={styles.jobKey}>오류 코드</span>
                      <span className={styles.jobValue}>{jobStatus.job.error_code}</span>
                    </div>
                  ) : null}
                  {jobStatus.job.error_message ? (
                    <div className={styles.jobRow}>
                      <span className={styles.jobKey}>메시지</span>
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
          </div>

          {shouldShowPreviewResult ? (
            <div className={styles.workflowStep}>
              <section className={styles.jobCard} aria-label="Result">
                <div className={styles.previewViewerBlock}>
                  <div
                    className={styles.previewViewerFrame}
                  >
                    {previewImageUrl && !previewImageFailed ? (
                      <img
                        src={previewImageUrl}
                        alt="preview"
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          borderRadius: 12,
                          display: 'block',
                        }}
                        onError={() => setPreviewImageFailed(true)}
                      />
                    ) : (
                      <p className={styles.previewViewerPlaceholderLabel}>
                        미리보기 준비 중
                      </p>
                    )}
                  </div>
                  <p className={styles.previewViewerKey}>{previewResultAssetKey ?? '-'}</p>
                </div>
                {!previewImageUrl || previewImageFailed ? (
                  <p
                    className={`${styles.promptNotImplementedHint} ${styles.previewResultDisclaimer}`}
                  >
                    미리보기는 현재 임시 화면입니다. 실제 렌더링은 아직 연결되지 않았습니다.
                  </p>
                ) : null}
              </section>
            </div>
          ) : null}

          <section className={styles.advancedSection} aria-label="Advanced status">
            <button
              type="button"
              className={styles.advancedToggle}
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              <span>고급 정보</span>
              <span className={styles.advancedToggleIcon}>{advancedOpen ? '▲' : '▼'}</span>
            </button>
            {advancedOpen ? (
              <div className={styles.advancedContent}>
                <p className={styles.advancedSectionHint}>
                  기술 확인이 필요할 때만 확인하세요.
                </p>
                <p className={styles.label}>프로젝트 ID</p>
                <p className={styles.projectId}>{projectId || '알 수 없음'}</p>
                <section className={styles.advancedGateCard} aria-live="polite">
                  {loading ? (
                    <p className={styles.meta}>상세 상태를 불러오는 중…</p>
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
                      {reasonCode ? (
                        <p className={styles.reason}>reason_code: {reasonCode}</p>
                      ) : null}
                    </>
                  )}
                </section>
                {inputType === 'upload' ? (
                  <>
                    <button
                      type="button"
                      className={styles.actionButton}
                      style={buttonStyle}
                      disabled={actionDisabled}
                      onClick={handleActionClick}
                    >
                      {actionButtonText}
                    </button>
                    {availabilityHint ? <p className={styles.metaHint}>{availabilityHint}</p> : null}
                    {contextLoadError && !errorMessage ? (
                      <p className={styles.metaHint}>{contextLoadError}</p>
                    ) : null}
                    {actionMessage ? <p className={styles.metaHint}>{actionMessage}</p> : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </section>
        </section>
      </div>
    </main>
  )
}
