// src/schedulers/orderSyncScheduler.js
// 번개장터 주문 상태 동기화를 주기적으로 실행하는 스케줄러

const { Queue } = require('bullmq');
const cron = require('node-cron');
const config = require('../config');
const logger = require('../config/logger');
const redisConnection = require('../config/redisClient');

const ORDER_STATUS_SYNC_QUEUE = config.bullmq?.queues?.orderStatusSync || 'order-status-sync-queue';

// 주문 상태 동기화 큐
const orderStatusSyncQueue = new Queue(ORDER_STATUS_SYNC_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // 5초부터 시작
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

/**
 * 주문 상태 동기화 작업을 큐에 추가
 * @param {object} options - 동기화 옵션
 * @param {Date} [options.startDate] - 조회 시작일
 * @param {Date} [options.endDate] - 조회 종료일
 * @param {boolean} [options.immediate=false] - 즉시 실행 여부
 */
async function scheduleOrderStatusSync(options = {}) {
  try {
    const { startDate, endDate, immediate = false } = options;
    
    const jobData = {
      startDate: startDate || new Date(Date.now() - 24 * 60 * 60 * 1000), // 기본: 24시간 전
      endDate: endDate || new Date(), // 기본: 현재 시간
      scheduledAt: new Date(),
    };
    
    // 날짜 범위 검증 (최대 15일)
    const diffDays = (jobData.endDate - jobData.startDate) / (1000 * 60 * 60 * 24);
    if (diffDays > 15) {
      logger.error('[OrderSyncScheduler] Date range exceeds 15 days limit', {
        startDate: jobData.startDate,
        endDate: jobData.endDate,
        diffDays,
      });
      return null;
    }
    
    const job = await orderStatusSyncQueue.add(
      'syncOrderStatuses',
      jobData,
      {
        delay: immediate ? 0 : 60000, // 즉시 실행하거나 1분 후 실행
      }
    );
    
    logger.info('[OrderSyncScheduler] Order status sync job scheduled', {
      jobId: job.id,
      startDate: jobData.startDate,
      endDate: jobData.endDate,
      immediate,
    });
    
    return job;
    
  } catch (error) {
    logger.error('[OrderSyncScheduler] Failed to schedule order status sync', {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * 크론 작업 초기화
 */
function initializeCronJobs() {
  // 매 시간 정각에 실행 (최근 2시간의 주문 상태 동기화)
  if (config.scheduler.orderStatusSyncHourlyCron) {
    cron.schedule(config.scheduler.orderStatusSyncHourlyCron, async () => {
      logger.info('[OrderSyncScheduler] Hourly order status sync triggered');
      try {
        await scheduleOrderStatusSync({
          startDate: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2시간 전
          endDate: new Date(),
          immediate: true,
        });
      } catch (error) {
        logger.error('[OrderSyncScheduler] Hourly sync scheduling failed', error);
      }
    }, {
      scheduled: true,
      timezone: config.scheduler.timezone
    });
  }
  
  // 매일 오전 2시에 전일 주문 전체 동기화
  if (config.scheduler.orderStatusSyncDailyCron) {
    cron.schedule(config.scheduler.orderStatusSyncDailyCron, async () => {
      logger.info('[OrderSyncScheduler] Daily order status sync triggered');
      try {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        await scheduleOrderStatusSync({
          startDate: yesterday,
          endDate: today,
          immediate: true,
        });
      } catch (error) {
        logger.error('[OrderSyncScheduler] Daily sync scheduling failed', error);
      }
    }, {
      scheduled: true,
      timezone: config.scheduler.timezone
    });
  }
  
  // 매 30분마다 최근 1시간 주문 동기화 (선택사항 - 더 빈번한 동기화가 필요한 경우)
  if (config.bunjang.enableFrequentSync === 'true' && config.scheduler.orderStatusSyncFrequentCron) {
    cron.schedule(config.scheduler.orderStatusSyncFrequentCron, async () => {
      logger.info('[OrderSyncScheduler] 30-minute order status sync triggered');
      try {
        await scheduleOrderStatusSync({
          startDate: new Date(Date.now() - 60 * 60 * 1000), // 1시간 전
          endDate: new Date(),
          immediate: true,
        });
      } catch (error) {
        logger.error('[OrderSyncScheduler] 30-minute sync scheduling failed', error);
      }
    }, {
      scheduled: true,
      timezone: config.scheduler.timezone
    });
  }
  
  logger.info('[OrderSyncScheduler] Cron jobs initialized', {
    hourly: config.scheduler.orderStatusSyncHourlyCron,
    daily: config.scheduler.orderStatusSyncDailyCron,
    frequent: config.bunjang.enableFrequentSync === 'true' ? config.scheduler.orderStatusSyncFrequentCron : 'disabled'
  });
}

/**
 * 수동으로 특정 기간의 주문 동기화 실행
 * @param {string} startDate - 시작일 (ISO 형식)
 * @param {string} endDate - 종료일 (ISO 형식)
 */
async function manualOrderSync(startDate, endDate) {
  logger.info('[OrderSyncScheduler] Manual order sync requested', { startDate, endDate });
  
  try {
    const job = await scheduleOrderStatusSync({
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      immediate: true,
    });
    
    return {
      success: true,
      jobId: job.id,
      message: `주문 동기화 작업이 예약되었습니다. Job ID: ${job.id}`,
    };
  } catch (error) {
    logger.error('[OrderSyncScheduler] Manual sync failed', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * 큐 상태 확인
 * @returns {Promise<object>} 큐 상태 정보
 */
async function getQueueStatus() {
  try {
    const [waiting, active, completed, failed] = await Promise.all([
      orderStatusSyncQueue.getWaitingCount(),
      orderStatusSyncQueue.getActiveCount(),
      orderStatusSyncQueue.getCompletedCount(),
      orderStatusSyncQueue.getFailedCount(),
    ]);
    
    return {
      queue: ORDER_STATUS_SYNC_QUEUE,
      counts: {
        waiting,
        active,
        completed,
        failed,
      },
    };
  } catch (error) {
    logger.error('[OrderSyncScheduler] Failed to get queue status', error);
    throw error;
  }
}

/**
 * 실패한 작업 재시도
 * @param {number} [limit=10] - 재시도할 작업 수 제한
 */
async function retryFailedJobs(limit = 10) {
  try {
    const failedJobs = await orderStatusSyncQueue.getFailed(0, limit);
    let retriedCount = 0;
    
    for (const job of failedJobs) {
      try {
        await job.retry();
        retriedCount++;
        logger.info(`[OrderSyncScheduler] Retried failed job ${job.id}`);
      } catch (error) {
        logger.error(`[OrderSyncScheduler] Failed to retry job ${job.id}:`, error);
      }
    }
    
    return {
      totalFailed: failedJobs.length,
      retried: retriedCount,
    };
  } catch (error) {
    logger.error('[OrderSyncScheduler] Failed to retry failed jobs', error);
    throw error;
  }
}

/**
 * 대기 중인 작업 정리
 * @param {number} [olderThanHours=24] - 지정된 시간보다 오래된 작업 제거
 */
async function cleanOldJobs(olderThanHours = 24) {
  try {
    const grace = olderThanHours * 60 * 60 * 1000; // 밀리초 변환
    const cleaned = await orderStatusSyncQueue.clean(grace, 100, 'completed');
    const cleanedFailed = await orderStatusSyncQueue.clean(grace * 7, 100, 'failed'); // 실패한 작업은 7일 후 삭제
    
    logger.info('[OrderSyncScheduler] Cleaned old jobs', {
      completed: cleaned.length,
      failed: cleanedFailed.length,
    });
    
    return {
      completedCleaned: cleaned.length,
      failedCleaned: cleanedFailed.length,
    };
  } catch (error) {
    logger.error('[OrderSyncScheduler] Failed to clean old jobs', error);
    throw error;
  }
}

// 환경 변수로 스케줄러 활성화 여부 제어
if (config.scheduler.enableOrderSyncScheduler !== false) {
  initializeCronJobs();
  logger.info('[OrderSyncScheduler] Order sync scheduler started');
} else {
  logger.info('[OrderSyncScheduler] Order sync scheduler is disabled');
}

module.exports = {
  scheduleOrderStatusSync,
  orderStatusSyncQueue,
  manualOrderSync,
  getQueueStatus,
  retryFailedJobs,
  cleanOldJobs,
};