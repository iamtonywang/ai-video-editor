import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { jobQueue } from '../../src/lib/queue/index'
import { redis } from '../../src/lib/queue/redis'

const baseUrl = process.env.TEST_BASE_URL ?? 'http://localhost:3000'
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Supabase env vars are required for integration tests')
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

after(async () => {
  await jobQueue.close()
  await redis.quit()
})

async function createTestProject(prefix: string): Promise<string> {
  const title = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const { data, error } = await supabase
    .from('projects')
    .insert({
      title,
      workflow_status: 'draft',
      auto_edit_enabled: false,
    })
    .select('id')
    .single()

  if (error || !data?.id) {
    throw new Error(`failed to create project: ${error?.message ?? 'NO_PROJECT_ID'}`)
  }

  return data.id
}

async function getAnyChunkId(): Promise<string> {
  const { data, error } = await supabase
    .from('sequence_chunks')
    .select('id')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data?.id) {
    throw new Error(`failed to fetch chunk id for gate setup: ${error?.message ?? 'NO_CHUNK_ID'}`)
  }

  return data.id
}

async function insertChunkIdentityGate(
  projectId: string,
  decision: 'blocked' | 'passed'
): Promise<void> {
  const chunkId = await getAnyChunkId()
  const measuredValue = decision === 'blocked' ? 0.1 : 0.95
  const threshold = 0.8

  const { error } = await supabase.from('gate_evaluations').insert({
    project_id: projectId,
    gate_type: 'identity',
    scope_type: 'chunk',
    chunk_id: chunkId,
    measured_value: measuredValue,
    threshold,
    decision,
    reason_code:
      decision === 'blocked' ? 'CHUNK_IDENTITY_SCORE_BELOW_THRESHOLD' : null,
  })

  if (error) {
    throw new Error(`failed to insert ${decision} chunk gate: ${error.message}`)
  }
}

async function countJobs(projectId: string): Promise<number> {
  const { count, error } = await supabase
    .from('jobs')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)

  if (error) {
    throw new Error(`failed to count jobs: ${error.message}`)
  }

  return count ?? 0
}

async function createAnalyzeJob(projectId: string): Promise<{
  status: number
  body: any
}> {
  const response = await fetch(`${baseUrl}/api/job/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: projectId,
      job_type: 'analyze',
      status: 'queued',
    }),
  })

  const body = await response.json()
  return { status: response.status, body }
}

async function hasQueueEntryForProject(projectId: string): Promise<boolean> {
  const jobs = await jobQueue.getJobs(
    ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'],
    0,
    200,
    true
  )

  return jobs.some((queueJob) => queueJob.data?.payload?.project_id === projectId)
}

async function waitForJobSuccess(jobId: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const { data, error } = await supabase
      .from('jobs')
      .select('status')
      .eq('id', jobId)
      .maybeSingle()

    if (error) {
      throw new Error(`failed to read job status: ${error.message}`)
    }

    if (data?.status === 'success') {
      return true
    }

    await sleep(300)
  }

  return false
}

test('CASE 1 blocked: chunk identity gate blocked blocks /api/job/create', async () => {
  const projectId = await createTestProject('job-create-blocked')
  await insertChunkIdentityGate(projectId, 'blocked')

  const jobsBefore = await countJobs(projectId)
  const result = await createAnalyzeJob(projectId)
  const jobsAfter = await countJobs(projectId)
  const queued = await hasQueueEntryForProject(projectId)

  assert.equal(
    result.status,
    403,
    'CASE 1 failed: /api/job/create must return 403 when latest chunk identity gate is blocked'
  )
  assert.equal(
    result.body?.error,
    'CHUNK_IDENTITY_GATE_BLOCKED',
    'CASE 1 failed: error code must be CHUNK_IDENTITY_GATE_BLOCKED'
  )
  assert.equal(
    jobsAfter,
    jobsBefore,
    'CASE 1 failed: jobs row count must not increase when blocked'
  )
  assert.equal(
    queued,
    false,
    'CASE 1 failed: queue enqueue must not happen when blocked'
  )
})

test('CASE 2 passed: chunk identity gate passed keeps existing /api/job/create behavior', async () => {
  const projectId = await createTestProject('job-create-passed')
  await insertChunkIdentityGate(projectId, 'passed')

  const jobsBefore = await countJobs(projectId)
  const result = await createAnalyzeJob(projectId)
  const jobsAfter = await countJobs(projectId)

  assert.equal(
    result.status,
    200,
    'CASE 2 failed: /api/job/create must return 200 when latest chunk identity gate is passed'
  )
  assert.equal(
    result.body?.ok,
    true,
    'CASE 2 failed: response body ok must be true'
  )
  assert.equal(
    jobsAfter,
    jobsBefore + 1,
    'CASE 2 failed: jobs row count must increase by 1'
  )

  const jobId = result.body?.data?.job_id
  assert.ok(jobId, 'CASE 2 failed: response must include created job_id')

  const success = await waitForJobSuccess(jobId, 10000)
  assert.equal(
    success,
    true,
    'CASE 2 failed: analyze job should eventually reach success status'
  )
})

test('CASE 3 no-gate: no chunk identity gate keeps existing /api/job/create behavior', async () => {
  const projectId = await createTestProject('job-create-no-gate')

  const jobsBefore = await countJobs(projectId)
  const result = await createAnalyzeJob(projectId)
  const jobsAfter = await countJobs(projectId)

  assert.equal(
    result.status,
    200,
    'CASE 3 failed: /api/job/create must return 200 when no chunk identity gate exists'
  )
  assert.equal(
    result.body?.ok,
    true,
    'CASE 3 failed: response body ok must be true for no-gate case'
  )
  assert.equal(
    jobsAfter,
    jobsBefore + 1,
    'CASE 3 failed: jobs row count must increase by 1 for no-gate case'
  )
})
