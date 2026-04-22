import { Worker } from 'bullmq'
import { redisConnection } from '@/lib/queue/redis'
import { QUEUE_NAMES } from '@/lib/queue'

const worker = new Worker(
  'job-queue',
  async (job) => {
    const { job_type, payload } = job.data

    switch (job_type) {
      case QUEUE_NAMES.ANALYZE:
        console.log('ANALYZE job received', payload)
        break

      case QUEUE_NAMES.BUILD_IDENTITY:
        console.log('BUILD_IDENTITY job received', payload)
        break

      case QUEUE_NAMES.RENDER_CHUNK:
        console.log('RENDER_CHUNK job received', payload)
        break

      case QUEUE_NAMES.PREVIEW:
        console.log('PREVIEW job received', payload)
        break

      case QUEUE_NAMES.QUALITY_EVAL:
        console.log('QUALITY_EVAL job received', payload)
        break

      default:
        throw new Error('Unknown job_type')
    }
  },
  {
    connection: redisConnection.connection,
  }
)

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed`, err)
})

worker.on('error', (err) => {
  console.error('Worker error:', err)
})

// 프로세스 유지
process.stdin.resume()
