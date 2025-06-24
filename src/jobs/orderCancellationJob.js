// src/jobs/orderCancellationJob.js
// BullMQ를 사용한 주문 취소 작업 프로세서

const { Worker, Queue } = require('bullmq');
const config = require('../config');
const logger = require('../config/logger');
const orderCancellationService = require('../services/orderCancellationService');
const redis = require('../config/redisClient');

const QUEUE_NAME = 'order-cancellation';

// 큐 생성
const orderCancellationQueue = new Queue(QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // 5초
    },
    removeOnComplete: {
      age: 24 * 3600, // 24시간 후 삭제
      count: 100, // 최대 100개 유지
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // 7일 후 삭제
    },
  },
});

// 워커 생성
const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { orderId, options = {} } = job.data;
    
    logger.info(`[OrderCancellationJob] Processing job ${job.id} for order ${orderId}`);
    
    try {
      const result = await orderCancellationService.processCancellationForOrder(
        orderId,
        {
          ...options,
          jobId: job.id,
          attemptNumber: 1, // 항상 1 (재시도 없음)
        }
      );
      
      logger.info(`[OrderCancellationJob] Job ${job.id} completed:`, result);
      
      return result;
      
    } catch (error) {
      logger.error(`[OrderCancellationJob] Job ${job.id} failed:`, error);
      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 5, // 동시 처리 작업 수
  }
);

// 워커 이벤트 핸들러
worker.on('completed', (job, returnValue) => {
  logger.info(`[OrderCancellationJob] Job ${job.id} completed successfully`);
});

worker.on('failed', (job, err) => {
  logger.error(`[OrderCancellationJob] Job ${job.id} failed:`, err);
});

worker.on('error', (err) => {
  logger.error('[OrderCancellationJob] Worker error:', err);
});

/**
 * 주문 취소 작업 스케줄링
 * @param {string} orderId - Shopify 주문 ID
 * @param {object} options - 취소 옵션
 * @param {number} delay - 지연 시간 (밀리초)
 */
async function scheduleOrderCancellation(orderId, options = {}, delay = 0) {
  const job = await orderCancellationQueue.add(
    'cancel-order',
    {
      orderId,
      options,
    },
    {
      delay,
      priority: options.priority || 1,
    }
  );
  
  logger.info(`[OrderCancellationJob] Scheduled cancellation job ${job.id} for order ${orderId}`);
  return job;
}

/**
 * 실패한 주문 일괄 처리 작업 스케줄링
 * @param {object} options - 처리 옵션
 */
async function scheduleBatchProcessing(options = {}) {
  const job = await orderCancellationQueue.add(
    'batch-process',
    {
      type: 'batch',
      options,
    },
    {
      repeat: {
        pattern: '0 */6 * * *', // 6시간마다 실행
      },
    }
  );
  
  logger.info(`[OrderCancellationJob] Scheduled batch processing job ${job.id}`);
  return job;
}

// 배치 처리 워커
const batchWorker = new Worker(
  `${QUEUE_NAME}-batch`,
  async (job) => {
    if (job.data.type === 'batch') {
      logger.info(`[OrderCancellationJob] Running batch processing`);
      const result = await orderCancellationService.processFailedOrders(job.data.options);
      return result;
    }
  },
  {
    connection: redis,
    concurrency: 1,
  }
);

module.exports = {
  orderCancellationQueue,
  scheduleOrderCancellation,
  scheduleBatchProcessing,
  worker,
  batchWorker,
};