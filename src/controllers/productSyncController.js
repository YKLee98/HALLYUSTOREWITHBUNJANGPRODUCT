// src/controllers/productSyncController.js
// 상품 동기화 관련 API 요청을 처리하고, BullMQ 작업 큐에 작업을 추가합니다.

const logger = require('../config/logger');
const config = require('../config');
const { getQueue } = require('../jobs/queues');
const { AppError, ValidationError } = require('../utils/customErrors');
const { param, validationResult } = require('express-validator');

/**
 * POST /api/sync/catalog/full
 * 전체 카탈로그 동기화 작업을 BullMQ에 추가합니다.
 */
async function triggerFullCatalogSync(req, res, next) {
  const jobName = 'ManualTrigger-FetchBunjangCatalog-Full';
  const queueName = config.bullmq.queues.catalog;
  logger.info(`[ProductSyncCtrlr] API call to trigger full catalog sync. Adding to queue: ${queueName}`);
  
  if (!config.redis.enabled) {
    return next(new AppError('Redis is disabled, catalog sync job cannot be queued.', 503, 'QUEUE_SYSTEM_DISABLED'));
  }
  const catalogQueue = getQueue(queueName);
  if (!catalogQueue) {
    return next(new AppError(`Catalog processing queue "${queueName}" is not available.`, 503, 'QUEUE_INSTANCE_UNAVAILABLE'));
  }

  try {
    const jobData = { catalogType: 'full', triggeredBy: 'api_manual_full_sync', requestedBy: req.ip };
    const jobId = `manual-full-catalog-${new Date().toISOString().split('T')[0]}`; // 하루에 한 번만 실행
    
    // 기존 작업 확인
    const existingJob = await catalogQueue.getJob(jobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (['waiting', 'active', 'delayed'].includes(state)) {
        logger.info(`[ProductSyncCtrlr] Full catalog sync job already in progress. Job ID: ${jobId}, State: ${state}`);
        return res.status(409).json({
          message: '전체 카탈로그 동기화가 이미 진행 중입니다.',
          existingJobId: existingJob.id,
          state: state,
          timestamp: new Date().toISOString(),
        });
      }
    }
    
    const job = await catalogQueue.add(jobName, jobData, {
      jobId,
      removeOnComplete: { count: 10 }, // 완료된 작업 10개만 보관
      removeOnFail: false // 실패한 작업은 보관
    });
    
    logger.info(`[ProductSyncCtrlr] Job "${jobName}" (ID: ${job.id}) added to queue "${queueName}" for full catalog sync.`);
    res.status(202).json({ 
      message: '전체 카탈로그 동기화 작업이 성공적으로 큐에 추가되었습니다.',
      jobId: job.id,
      queueName: queueName,
      jobName: job.name,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(`[ProductSyncCtrlr] Error adding full catalog sync job to queue "${queueName}":`, error);
    next(new AppError('전체 카탈로그 동기화 작업 추가 중 오류가 발생했습니다.', 500, 'QUEUE_JOB_ADD_FAILED_FULL_CATALOG', true, error));
  }
}

/**
 * POST /api/sync/catalog/segment
 * 세그먼트 카탈로그 동기화 작업을 BullMQ에 추가합니다.
 */
async function triggerSegmentCatalogSync(req, res, next) {
  const jobName = 'ManualTrigger-FetchBunjangCatalog-Segment';
  const queueName = config.bullmq.queues.catalog;
  logger.info(`[ProductSyncCtrlr] API call to trigger segment catalog sync. Adding to queue: ${queueName}`);

  if (!config.redis.enabled) return next(new AppError('Redis is disabled.', 503, 'QUEUE_SYSTEM_DISABLED'));
  const catalogQueue = getQueue(queueName);
  if (!catalogQueue) return next(new AppError(`Queue "${queueName}" not available.`, 503, 'QUEUE_INSTANCE_UNAVAILABLE'));

  try {
    const jobData = { catalogType: 'segment', triggeredBy: 'api_manual_segment_sync', requestedBy: req.ip };
    const hour = new Date().getHours().toString().padStart(2, '0');
    const jobId = `manual-segment-catalog-${new Date().toISOString().split('T')[0]}-${hour}`;
    
    // 기존 작업 확인
    const existingJob = await catalogQueue.getJob(jobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (['waiting', 'active', 'delayed'].includes(state)) {
        logger.info(`[ProductSyncCtrlr] Segment catalog sync job already in progress. Job ID: ${jobId}, State: ${state}`);
        return res.status(409).json({
          message: '세그먼트 카탈로그 동기화가 이미 진행 중입니다.',
          existingJobId: existingJob.id,
          state: state,
          timestamp: new Date().toISOString(),
        });
      }
    }
    
    const job = await catalogQueue.add(jobName, jobData, {
      jobId,
      removeOnComplete: { count: 50 },
      removeOnFail: false
    });
    
    logger.info(`[ProductSyncCtrlr] Job "${jobName}" (ID: ${job.id}) added to queue "${queueName}" for segment catalog sync.`);
    res.status(202).json({
      message: '세그먼트 카탈로그 동기화 작업이 큐에 추가되었습니다.',
      jobId: job.id,
      queueName: queueName,
      jobName: job.name,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(`[ProductSyncCtrlr] Error adding segment catalog sync job to queue "${queueName}":`, error);
    next(new AppError('세그먼트 카탈로그 동기화 작업 추가 실패.', 500, 'QUEUE_JOB_ADD_FAILED_SEGMENT_CATALOG', true, error));
  }
}

/**
 * POST /api/sync/product/:bunjangPid
 * 특정 번개장터 상품 ID를 받아 해당 상품만 재동기화하는 작업을 큐에 추가합니다.
 */
async function triggerSingleProductSync(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new ValidationError('잘못된 상품 ID 형식입니다.', errors.array());
  }

  const { bunjangPid } = req.params;
  const jobName = 'ManualTrigger-SyncSingleProduct';
  const queueName = config.bullmq.queues.productSync;
  logger.info(`[ProductSyncCtrlr] API call to resync Bunjang product PID: ${bunjangPid}. Adding to queue: ${queueName}`);

  if (!config.redis.enabled) return next(new AppError('Redis is disabled.', 503, 'QUEUE_SYSTEM_DISABLED'));
  const productSyncQueue = getQueue(queueName);
  if (!productSyncQueue) return next(new AppError(`Queue "${queueName}" not available.`, 503, 'QUEUE_INSTANCE_UNAVAILABLE'));
  
  try {
    const jobData = { bunjangPid, triggeredBy: 'api_manual_single_product_sync', requestedBy: req.ip };
    
    // 중복 방지: PID만 사용하여 고유 ID 생성
    const jobId = `manual-single-product-${bunjangPid}`;
    
    // 기존 작업이 있는지 확인
    const existingJob = await productSyncQueue.getJob(jobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (['waiting', 'active', 'delayed'].includes(state)) {
        logger.info(`[ProductSyncCtrlr] Product sync job already in progress for PID: ${bunjangPid}. Job ID: ${jobId}, State: ${state}`);
        return res.status(409).json({
          message: `이미 처리 중인 동기화 작업이 있습니다 (PID: ${bunjangPid})`,
          existingJobId: existingJob.id,
          state: state,
          timestamp: new Date().toISOString(),
        });
      } else if (state === 'completed') {
        // 완료된 작업은 제거하고 새로 추가
        await existingJob.remove();
      }
    }
    
    const job = await productSyncQueue.add(jobName, jobData, { 
      jobId,
      removeOnComplete: true,
      removeOnFail: false,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000,
      }
    });

    logger.info(`[ProductSyncCtrlr] Job "${jobName}" (ID: ${job.id}) for Bunjang PID ${bunjangPid} added to queue "${queueName}".`);
    res.status(202).json({
      message: `번개장터 상품(PID: ${bunjangPid}) 재동기화 작업이 큐에 추가되었습니다.`,
      jobId: job.id,
      queueName: queueName,
      jobName: job.name,
      bunjangPid,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(`[ProductSyncCtrlr] Error adding single product sync job for PID ${bunjangPid} to queue "${queueName}":`, error);
    next(new AppError(`개별 상품(PID: ${bunjangPid}) 동기화 작업 추가 실패.`, 500, 'QUEUE_JOB_ADD_FAILED_SINGLE_PRODUCT', true, error));
  }
}

/**
 * GET /api/sync/status/:jobId
 * 작업 상태 확인
 */
async function checkJobStatus(req, res, next) {
  const { jobId } = req.params;
  const { queue } = req.query; // queue 이름을 쿼리 파라미터로 받음
  
  if (!queue) {
    return next(new AppError('Queue name is required', 400, 'QUEUE_NAME_MISSING'));
  }
  
  try {
    const queueInstance = getQueue(queue);
    if (!queueInstance) {
      return next(new AppError(`Queue "${queue}" not found`, 404, 'QUEUE_NOT_FOUND'));
    }
    
    const job = await queueInstance.getJob(jobId);
    if (!job) {
      return res.status(404).json({
        message: '작업을 찾을 수 없습니다.',
        jobId,
        queue
      });
    }
    
    const state = await job.getState();
    const progress = job.progress;
    
    res.json({
      jobId: job.id,
      queue: queue,
      state: state,
      progress: progress,
      data: job.data,
      timestamp: new Date().toISOString(),
      ...(state === 'failed' && { failedReason: job.failedReason }),
      ...(state === 'completed' && { returnValue: job.returnvalue })
    });
    
  } catch (error) {
    logger.error(`[ProductSyncCtrlr] Error checking job status:`, error);
    next(new AppError('작업 상태 확인 실패', 500, 'JOB_STATUS_CHECK_FAILED', true, error));
  }
}

/**
 * Validation middleware for bunjangPid
 */
const validateBunjangPid = [
  param('bunjangPid')
    .isNumeric()
    .withMessage('번개장터 상품 ID는 숫자여야 합니다.')
    .isLength({ min: 1, max: 20 })
    .withMessage('유효한 번개장터 상품 ID를 입력하세요.')
];

module.exports = {
  triggerFullCatalogSync,
  triggerSegmentCatalogSync,
  triggerSingleProductSync,
  checkJobStatus,
  validateBunjangPid
};