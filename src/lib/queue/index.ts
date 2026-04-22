import { Queue } from 'bullmq'
import { redisConnection } from './redis'

export const jobQueue = new Queue('job-queue', {
  connection: redisConnection.connection,
  defaultJobOptions: {
    removeOnComplete: 100, // 최근 100개 유지
    removeOnFail: 500,     // 실패는 더 길게 보관
  },
})

export const QUEUE_NAMES = {
  ANALYZE: 'analyze',
  BUILD_IDENTITY: 'build_identity',
  RENDER_CHUNK: 'render_chunk',
  PREVIEW: 'preview',
  QUALITY_EVAL: 'quality_eval',
} as const
