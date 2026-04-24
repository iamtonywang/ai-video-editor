import { Queue } from 'bullmq'
import { redisConnection } from './redis'

export const jobQueue = new Queue('job-queue', {
  connection: redisConnection.connection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 500,
  },
})

export const QUEUE_NAMES = {
  ANALYZE: 'analyze',
  BUILD_IDENTITY: 'build_identity',
  RENDER_CHUNK: 'render_chunk',
  PREVIEW: 'preview',
  QUALITY_EVAL: 'quality_eval',
} as const