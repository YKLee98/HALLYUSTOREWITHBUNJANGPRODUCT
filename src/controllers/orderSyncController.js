// src/controllers/orderSyncController.js
// Shopify 주문 웹훅을 수신하여 BullMQ 작업 큐에 주문 처리 작업을 추가합니다.

const config = require('../config');
const logger = require('../config/logger');
const { getQueue } = require('../jobs/queues');
const { ApiError, AppError } = require('../utils/customErrors');
const redis = require('../config/redisClient');

/**
 * Shopify 'orders/create' 또는 'orders/paid' 웹훅을 처리합니다.
 * 유효한 주문이면 BullMQ의 주문 처리 큐에 작업을 추가합니다.
 * @param {import('express').Request} req - Express 요청 객체 (rawBody 포함).
 * @param {import('express').Response} res - Express 응답 객체.
 * @param {import('express').NextFunction} next - Express next 미들웨어 함수.
 */
async function handleShopifyOrderCreateWebhook(req, res, next) {
  let shopifyOrder;
  try {
    if (!req.rawBody) {
      throw new ApiError('Webhook raw body is missing.', 400, 'RAW_BODY_MISSING_FOR_PARSING');
    }
    shopifyOrder = JSON.parse(req.rawBody.toString('utf8'));
  } catch (parseError) {
    logger.error('[OrderSyncCtrlr] Failed to parse Shopify order webhook payload:', parseError);
    return res.status(400).json({ error: 'Invalid webhook payload.' });
  }

  const shopifyOrderId = shopifyOrder?.id || 'Unknown';
  const financialStatus = shopifyOrder?.financial_status;
  const shopDomain = req.get('X-Shopify-Shop-Domain');

  logger.info(`[OrderSyncCtrlr] Received Shopify order webhook for Order ID: ${shopifyOrderId} from ${shopDomain}. Financial Status: ${financialStatus}`);

  // Idempotency 체크: 이미 처리한 웹훅인지 확인
  const webhookId = req.get('X-Shopify-Webhook-Id');
  if (webhookId && redis) {
    try {
      const idempotencyKey = `webhook:processed:${webhookId}`;
      const alreadyProcessed = await redis.get(idempotencyKey);
      
      if (alreadyProcessed) {
        logger.info(`[OrderSyncCtrlr] Webhook ${webhookId} already processed. Skipping.`);
        return res.status(200).send('Webhook already processed.');
      }
      
      // 처리 완료 표시 (24시간 보관)
      await redis.set(idempotencyKey, '1', 'EX', 86400);
    } catch (redisError) {
      logger.warn(`[OrderSyncCtrlr] Redis error during idempotency check:`, redisError);
      // Redis 에러는 무시하고 계속 진행
    }
  }

  // 결제 완료된 주문만 처리
  if (financialStatus === 'paid' || financialStatus === 'partially_paid') {
    if (!config.redis.enabled) {
      logger.error(`[OrderSyncCtrlr] Redis is disabled. Cannot add order ${shopifyOrderId} to BullMQ queue.`);
      return res.status(200).send('Webhook received, but job queue is disabled. Order processing skipped.');
    }

    const orderQueueName = config.bullmq.queues.order;
    const orderQueue = getQueue(orderQueueName);

    if (!orderQueue) {
      logger.error(`[OrderSyncCtrlr] BullMQ order queue "${orderQueueName}" is not available.`);
      return res.status(500).send('Order processing queue unavailable.');
    }

    try {
      const jobData = { 
        shopifyOrder, 
        receivedAt: new Date().toISOString(), 
        sourceShop: shopDomain,
        webhookId: webhookId 
      };
      
      // 작업 ID는 주문 ID 사용 (중복 방지)
      const jobId = `shopify-order-${shopifyOrderId}`;
      
      // 기존 작업 확인
      const existingJob = await orderQueue.getJob(jobId);
      if (existingJob) {
        const jobState = await existingJob.getState();
        
        // 완료되거나 실패한 작업은 재시도 가능
        if (['completed', 'failed'].includes(jobState)) {
          logger.info(`[OrderSyncCtrlr] Removing old job for order ${shopifyOrderId} (state: ${jobState})`);
          await existingJob.remove();
        } else {
          // 진행 중인 작업은 스킵
          logger.info(`[OrderSyncCtrlr] Order ${shopifyOrderId} already in queue with state: ${jobState}`);
          return res.status(200).send('Order already being processed.');
        }
      }
      
      await orderQueue.add('ProcessShopifyOrder', jobData, { 
        jobId,
        removeOnComplete: { age: 3600 }, // 1시간 후 삭제
        removeOnFail: false, // 실패 시 보관
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        }
      });

      logger.info(`[OrderSyncCtrlr] Shopify Order ID: ${shopifyOrderId} successfully added to queue "${orderQueueName}" with Job ID: ${jobId}.`);
      res.status(200).send('Webhook received and order queued for processing.');
      
    } catch (queueError) {
      logger.error(`[OrderSyncCtrlr] Failed to add Shopify Order ID: ${shopifyOrderId} to queue:`, queueError);
      next(new AppError(`주문 처리 큐에 작업 추가 실패 (Order ID: ${shopifyOrderId})`, 503, 'QUEUE_ADD_FAILED', true, queueError));
    }
  } else {
    logger.info(`[OrderSyncCtrlr] Shopify Order ID: ${shopifyOrderId} financial_status is '${financialStatus}'. Skipping.`);
    res.status(200).send('Webhook received, order not in processable payment status.');
  }
}

/**
 * Shopify 'orders/updated' 웹훅을 처리합니다.
 */
async function handleShopifyOrderUpdateWebhook(req, res, next) {
  let shopifyOrder;
  try {
    if (!req.rawBody) {
      throw new ApiError('Webhook raw body is missing.', 400, 'RAW_BODY_MISSING_FOR_PARSING');
    }
    shopifyOrder = JSON.parse(req.rawBody.toString('utf8'));
  } catch (parseError) {
    logger.error('[OrderSyncCtrlr] Failed to parse order update webhook:', parseError);
    return res.status(400).json({ error: 'Invalid webhook payload.' });
  }

  const shopifyOrderId = shopifyOrder?.id || 'Unknown';
  logger.info(`[OrderSyncCtrlr] Received order update webhook for Order ID: ${shopifyOrderId}`);

  // 주문 상태 변경 감지 및 처리
  try {
    // 취소된 주문 처리
    if (shopifyOrder.cancelled_at) {
      logger.info(`[OrderSyncCtrlr] Order ${shopifyOrderId} has been cancelled.`);
      // 필요한 경우 재고 복구 등의 작업 수행
    }

    // 환불 처리
    if (shopifyOrder.refunds && shopifyOrder.refunds.length > 0) {
      logger.info(`[OrderSyncCtrlr] Order ${shopifyOrderId} has refunds.`);
      // 환불 처리 로직
    }

    res.status(200).send('Webhook processed successfully.');
  } catch (error) {
    logger.error(`[OrderSyncCtrlr] Error processing order update:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Shopify 'orders/cancelled' 웹훅을 처리합니다.
 */
async function handleShopifyOrderCancelWebhook(req, res, next) {
  let shopifyOrder;
  try {
    if (!req.rawBody) {
      throw new ApiError('Webhook raw body is missing.', 400, 'RAW_BODY_MISSING_FOR_PARSING');
    }
    shopifyOrder = JSON.parse(req.rawBody.toString('utf8'));
  } catch (parseError) {
    logger.error('[OrderSyncCtrlr] Failed to parse order cancel webhook:', parseError);
    return res.status(400).json({ error: 'Invalid webhook payload.' });
  }

  const shopifyOrderId = shopifyOrder?.id || 'Unknown';
  const orderQueueName = config.bullmq.queues.order;
  
  logger.info(`[OrderSyncCtrlr] Received order cancel webhook for Order ID: ${shopifyOrderId}`);

  try {
    // 큐에서 대기 중인 작업 제거
    if (config.redis.enabled) {
      const orderQueue = getQueue(orderQueueName);
      if (orderQueue) {
        const jobId = `shopify-order-${shopifyOrderId}`;
        const job = await orderQueue.getJob(jobId);
        
        if (job) {
          const state = await job.getState();
          if (['waiting', 'delayed'].includes(state)) {
            await job.remove();
            logger.info(`[OrderSyncCtrlr] Removed queued job for cancelled order ${shopifyOrderId}`);
          }
        }
      }
    }

    // 재고 복구 로직
    const { restoreInventory } = require('../services/inventoryService');
    if (restoreInventory) {
      await restoreInventory(shopifyOrder);
    }

    res.status(200).send('Order cancellation processed.');
  } catch (error) {
    logger.error(`[OrderSyncCtrlr] Error processing order cancellation:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * 주문 처리 상태 확인 API
 */
async function checkOrderProcessingStatus(req, res, next) {
  const { orderId } = req.params;
  
  if (!config.redis.enabled) {
    return res.status(503).json({ error: 'Queue system is disabled' });
  }

  try {
    const orderQueue = getQueue(config.bullmq.queues.order);
    const jobId = `shopify-order-${orderId}`;
    const job = await orderQueue.getJob(jobId);
    
    if (!job) {
      return res.status(404).json({ 
        message: '주문 처리 작업을 찾을 수 없습니다.',
        orderId 
      });
    }
    
    const state = await job.getState();
    const logs = await job.getLogsList();
    
    res.json({
      orderId,
      jobId: job.id,
      state,
      progress: job.progress,
      attemptsMade: job.attemptsMade,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
      logs: logs.logs,
      data: {
        receivedAt: job.data.receivedAt,
        sourceShop: job.data.sourceShop
      }
    });
    
  } catch (error) {
    logger.error(`[OrderSyncCtrlr] Error checking order status:`, error);
    next(new AppError('주문 상태 확인 실패', 500, 'ORDER_STATUS_CHECK_FAILED'));
  }
}

module.exports = {
  handleShopifyOrderCreateWebhook,
  handleShopifyOrderUpdateWebhook,
  handleShopifyOrderCancelWebhook,
  checkOrderProcessingStatus
};