// src/services/orderService.js
// Shopify 주문 웹훅 수신 후 번개장터 주문 생성 등의 로직을 담당합니다.

const config = require('../config');
const logger = require('../config/logger');
const bunjangService = require('./bunjangService');
const shopifyService = require('./shopifyService');
const inventoryService = require('./inventoryService');
const SyncedProduct = require('../models/syncedProduct.model');
const { AppError, ExternalServiceError, NotFoundError, ValidationError } = require('../utils/customErrors');
const { getQueue } = require('../jobs/queues');
const { mapShopifyItemToBunjangOrderPayload } = require('../mappers/orderMapper');

// 환경 변수로 상태 체크 스킵 여부 제어
const SKIP_STATUS_CHECK = process.env.SKIP_BUNJANG_STATUS_CHECK === 'true';

/**
 * Shopify 주문 데이터를 기반으로 번개장터에 주문을 생성합니다.
 * @param {object} shopifyOrder - Shopify 주문 객체 (웹훅 페이로드 또는 DB에서 가져온 객체).
 * @param {string} [jobId='N/A'] - 호출한 BullMQ 작업 ID (로깅용).
 * @returns {Promise<{success: boolean, bunjangOrderIds?: array, message?: string}>} 처리 결과.
 */
async function processShopifyOrderForBunjang(shopifyOrder, jobId = 'N/A') {
  const shopifyOrderId = shopifyOrder.id; // Shopify REST API ID
  const shopifyOrderGid = shopifyOrder.admin_graphql_api_id; // Shopify GraphQL GID
  logger.info(`[OrderSvc:Job-${jobId}] Processing Shopify Order ID: ${shopifyOrderId} (GID: ${shopifyOrderGid}) for Bunjang.`);

  // Shopify 주문 객체 유효성 검사
  if (!shopifyOrder || !shopifyOrderId || !shopifyOrderGid || !Array.isArray(shopifyOrder.line_items) || shopifyOrder.line_items.length === 0) {
    throw new ValidationError('유효하지 않은 Shopify 주문 데이터입니다. (ID 또는 line_items 누락)', [{field: 'shopifyOrder', message: 'Order data invalid or missing line items.'}]);
  }

  const bunjangOrderIdentifier = `${config.bunjang.orderIdentifierPrefix || 'BunjangOrder-'}${shopifyOrderId}`;
  let bunjangOrderSuccessfullyCreatedOverall = false;
  let createdBunjangOrderIds = [];

  // 이미 처리된 주문인지 확인 (중복 방지)
  try {
    const existingMetafield = await shopifyService.getOrderMetafield(shopifyOrderGid, "bunjang", "order_ids");
    if (existingMetafield && existingMetafield.value) {
      logger.info(`[OrderSvc:Job-${jobId}] Bunjang order already exists for Shopify Order ${shopifyOrderId}. Skipping.`);
      return { success: true, alreadyProcessed: true, bunjangOrderIds: JSON.parse(existingMetafield.value) };
    }
  } catch (error) {
    logger.warn(`[OrderSvc:Job-${jobId}] Could not check existing order metadata: ${error.message}`);
  }

  // Shopify 주문의 각 line item을 순회
  for (const item of shopifyOrder.line_items) {
    const productId = item.product_id;
    
    // 1. 먼저 DB에서 확인
    let syncedProduct = await SyncedProduct.findOne({
      $or: [
        { shopifyGid: `gid://shopify/Product/${productId}` },
        { 'shopifyData.id': productId },
        { 'shopifyData.id': String(productId) }
      ]
    }).lean();
    
    // 2. DB에 없으면 Shopify에서 태그 확인하여 자동 연결
    if (!syncedProduct) {
      logger.info(`[OrderSvc:Job-${jobId}] Product not in DB, checking Shopify tags for product ${productId}`);
      
      const productQuery = `
        query getProductTags($id: ID!) {
          product(id: $id) {
            id
            tags
          }
        }
      `;
      
      try {
        const productGid = `gid://shopify/Product/${productId}`;
        const response = await shopifyService.shopifyGraphqlRequest(productQuery, { id: productGid });
        
        if (response.data?.product?.tags) {
          const bunjangPidTag = response.data.product.tags.find(tag => tag.startsWith('bunjang_pid:'));
          
          if (bunjangPidTag) {
            const bunjangPid = bunjangPidTag.split(':')[1];
            logger.info(`[OrderSvc:Job-${jobId}] Found bunjang_pid tag: ${bunjangPid} for product ${productId}`);
            
            // 임시 syncedProduct 객체 생성
            syncedProduct = {
              bunjangPid: bunjangPid,
              shopifyGid: productGid,
              // 이 상품은 DB에 없으므로 나중에 동기화 필요
              needsSync: true
            };
          }
        }
      } catch (error) {
        logger.error(`[OrderSvc:Job-${jobId}] Failed to check Shopify tags for product ${productId}: ${error.message}`);
      }
    }
    
    if (!syncedProduct || !syncedProduct.bunjangPid) {
      logger.warn(`[OrderSvc:Job-${jobId}] No bunjang connection found for product ${productId}, skipping`);
      continue;
    }
    
    const bunjangPid = syncedProduct.bunjangPid;
    logger.info(`[OrderSvc:Job-${jobId}] Processing order for Bunjang PID: ${bunjangPid}`);
    
    try {
      // 3. 번개장터 상품 상세 정보 조회
      const bunjangProductDetails = await bunjangService.getBunjangProductDetails(bunjangPid);
      
      if (!bunjangProductDetails) {
        logger.error(`[OrderSvc:Job-${jobId}] Bunjang product details not found for PID ${bunjangPid}`);
        await shopifyService.updateOrder({ 
          id: shopifyOrderGid, 
          tags: [`${bunjangOrderIdentifier}_Error`, `PID-${bunjangPid}-NotFound`] 
        });
        continue;
      }

      // 4. 상태 체크 (환경 변수로 스킵 가능)
      if (!SKIP_STATUS_CHECK) {
        const productStatus = bunjangProductDetails.status || bunjangProductDetails.saleStatus;
        const productQuantity = bunjangProductDetails.quantity || 0;
        
        if (productStatus !== 'SELLING') {
          logger.warn(`[OrderSvc:Job-${jobId}] Bunjang product ${bunjangPid} is not in SELLING status. Current status: ${productStatus}`);
          await shopifyService.updateOrder({ 
            id: shopifyOrderGid, 
            tags: [`${bunjangOrderIdentifier}_Error`, `PID-${bunjangPid}-NotSelling-${productStatus}`] 
          });
          continue;
        }
        
        if (productQuantity === 0) {
          logger.warn(`[OrderSvc:Job-${jobId}] Bunjang product ${bunjangPid} has no stock. Quantity: ${productQuantity}`);
          await shopifyService.updateOrder({ 
            id: shopifyOrderGid, 
            tags: [`${bunjangOrderIdentifier}_Error`, `PID-${bunjangPid}-NoStock`] 
          });
          continue;
        }
      }

      // 5. 주문 페이로드 생성
      const bunjangOrderPayload = mapShopifyItemToBunjangOrderPayload(item, bunjangPid, bunjangProductDetails);
      
      // 6. 번개장터 주문 생성 API 호출
      try {
        const bunjangApiResponse = await bunjangService.createBunjangOrderV2(bunjangOrderPayload);
        
        if (bunjangApiResponse && bunjangApiResponse.id) {
          const bunjangOrderId = bunjangApiResponse.id;
          logger.info(`[OrderSvc:Job-${jobId}] ✅ Successfully created Bunjang order for PID ${bunjangPid}. Bunjang Order ID: ${bunjangOrderId}`);
          createdBunjangOrderIds.push(String(bunjangOrderId));
          bunjangOrderSuccessfullyCreatedOverall = true;

          // 7. Shopify 주문에 태그 추가 (개별 성공)
          const tagsToAdd = [`BunjangOrder-${bunjangOrderId}`, `PID-${bunjangPid}-Success`];
          await shopifyService.updateOrder({ id: shopifyOrderGid, tags: tagsToAdd });
          
          // 8. 포인트 잔액 확인
          try {
            const pointBalance = await bunjangService.getBunjangPointBalance();
            if (pointBalance) {
              logger.info(`[OrderSvc:Job-${jobId}] Current Bunjang point balance: ${pointBalance.balance.toLocaleString()} KRW`);
              
              const LOW_BALANCE_THRESHOLD = config.bunjang.lowBalanceThreshold || 1000000;
              if (pointBalance.balance < LOW_BALANCE_THRESHOLD) {
                logger.warn(`[OrderSvc:Job-${jobId}] ⚠️ LOW POINT BALANCE WARNING: ${pointBalance.balance.toLocaleString()} KRW < ${LOW_BALANCE_THRESHOLD.toLocaleString()} KRW`);
                await shopifyService.updateOrder({ 
                  id: shopifyOrderGid, 
                  tags: [`LowPointBalance`, `Balance-${pointBalance.balance}`] 
                });
              }
            }
          } catch (balanceError) {
            logger.warn(`[OrderSvc:Job-${jobId}] Failed to check point balance: ${balanceError.message}`);
          }
          
          // 9. 재고 상태 업데이트
          await inventoryService.handleProductSoldStatus(
            bunjangPid,
            syncedProduct.shopifyGid,
            'shopify'
          );
          
        } else {
          logger.error(`[OrderSvc:Job-${jobId}] Bunjang API response missing order ID for PID ${bunjangPid}`);
          await shopifyService.updateOrder({ 
            id: shopifyOrderGid, 
            tags: [`${bunjangOrderIdentifier}_Error`, `PID-${bunjangPid}-InvalidResponse`] 
          });
        }
        
      } catch (apiError) {
        const errorMessage = apiError.message || 'Unknown API error';
        const errorCode = apiError.errorCode || 'UNKNOWN_ERROR';
        const errorTag = `PID-${bunjangPid}-${errorCode}`;
        
        logger.error(`[OrderSvc:Job-${jobId}] Failed to create Bunjang order for PID ${bunjangPid}: ${errorMessage}`, {
          errorStack: apiError.stack,
          originalError: apiError.originalError?.message
        });
        
        await shopifyService.updateOrder({ id: shopifyOrderGid, tags: [`${bunjangOrderIdentifier}_Error`, errorTag] });
      }

    } catch (error) {
      logger.error(`[OrderSvc:Job-${jobId}] Unexpected error processing Bunjang order for PID ${bunjangPid}: ${error.message}`, {
        stack: error.stack
      });
      await shopifyService.updateOrder({ id: shopifyOrderGid, tags: [`${bunjangOrderIdentifier}_Error`, `PID-${bunjangPid}-Exception`] });
    }
  }

  // 주문 처리 완료 후 메타필드 업데이트
  if (createdBunjangOrderIds.length > 0) {
    const metafieldsInput = [
      { 
        namespace: "bunjang", 
        key: "order_ids", 
        value: JSON.stringify(createdBunjangOrderIds), 
        type: "json" 
      },
      { 
        namespace: "bunjang", 
        key: "order_created_at", 
        value: new Date().toISOString(), 
        type: "date_time" 
      },
      {
        namespace: "bunjang",
        key: "order_count",
        value: String(createdBunjangOrderIds.length),
        type: "single_line_text_field"
      }
    ];
    
    await shopifyService.updateOrder({ 
      id: shopifyOrderGid, 
      tags: ['BunjangOrderPlaced', bunjangOrderIdentifier, `Orders-${createdBunjangOrderIds.length}`],
      metafields: metafieldsInput 
    });
    
    logger.info(`[OrderSvc:Job-${jobId}] Successfully updated Shopify order with Bunjang order information`);
  }

  if (bunjangOrderSuccessfullyCreatedOverall) {
    logger.info(`[OrderSvc:Job-${jobId}] ✅ Bunjang order(s) successfully created for Shopify Order ${shopifyOrderId}: ${createdBunjangOrderIds.join(', ')}`);
    return { success: true, bunjangOrderIds: createdBunjangOrderIds };
  } else {
    logger.warn(`[OrderSvc:Job-${jobId}] ❌ No Bunjang orders created for Shopify Order ${shopifyOrderId}`);
    return { success: false, message: '번개장터 주문 생성 실패' };
  }
}

/**
 * Shopify 주문을 큐에 추가합니다.
 * @param {object} shopifyOrder - Shopify 주문 객체
 * @returns {Promise<void>}
 */
async function queueBunjangOrderCreation(shopifyOrder) {
  try {
    logger.info(`[OrderSvc] Queuing Bunjang order creation for Shopify order ${shopifyOrder.id}`);
    
    // Redis와 BullMQ가 활성화되어 있는지 확인
    if (!config.redis.enabled) {
      logger.warn(`[OrderSvc] Redis is disabled. Processing order ${shopifyOrder.id} directly without queue.`);
      // Redis가 비활성화된 경우 직접 처리 (개발/테스트 환경용)
      return await processShopifyOrderForBunjang(shopifyOrder, `DIRECT-${shopifyOrder.id}`);
    }
    
    // BullMQ 큐에 추가
    const orderQueueName = config.bullmq.queues.order;
    const orderQueue = getQueue(orderQueueName);
    
    if (!orderQueue) {
      logger.error(`[OrderSvc] Order queue "${orderQueueName}" not available. Processing order ${shopifyOrder.id} directly.`);
      // 큐가 없는 경우 직접 처리
      return await processShopifyOrderForBunjang(shopifyOrder, `DIRECT-${shopifyOrder.id}`);
    }
    
    const jobData = { 
      shopifyOrder, 
      receivedAt: new Date().toISOString() 
    };
    
    // 중복 방지를 위한 고유 작업 ID
    const jobId = `shopify-order-${shopifyOrder.id}`;
    
    const job = await orderQueue.add('ProcessShopifyOrder', jobData, { 
      jobId,
      removeOnComplete: true,
      removeOnFail: false,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      }
    });
    
    logger.info(`[OrderSvc] Order ${shopifyOrder.id} successfully added to queue with job ID: ${job.id}`);
    
    return { queued: true, jobId: job.id };
    
  } catch (error) {
    logger.error(`[OrderSvc] Failed to queue order ${shopifyOrder.id}: ${error.message}`, { stack: error.stack });
    throw error;
  }
}

/**
 * 번개장터 주문 상태를 동기화합니다.
 * @param {Date|string} startDate - 조회 시작일
 * @param {Date|string} endDate - 조회 종료일 (최대 15일 간격)
 * @param {string} [jobId='N/A'] - 작업 ID (로깅용)
 * @returns {Promise<{success: boolean, syncedOrders: number, errors: number}>}
 */
async function syncBunjangOrderStatuses(startDate, endDate, jobId = 'N/A') {
  logger.info(`[OrderSvc:Job-${jobId}] Starting Bunjang order status sync from ${startDate} to ${endDate}`);
  
  // 날짜 포맷 변환 (UTC ISO 형식으로)
  const startDateUTC = new Date(startDate).toISOString();
  const endDateUTC = new Date(endDate).toISOString();
  
  // 날짜 범위 검증 (최대 15일)
  const diffDays = (new Date(endDateUTC) - new Date(startDateUTC)) / (1000 * 60 * 60 * 24);
  if (diffDays > 15) {
    throw new ValidationError('번개장터 주문 조회는 최대 15일 범위만 가능합니다.', [
      { field: 'dateRange', message: `요청된 범위: ${diffDays}일` }
    ]);
  }
  
  let syncedCount = 0;
  let errorCount = 0;
  let page = 0;
  let hasMore = true;
  
  try {
    while (hasMore) {
      const ordersResponse = await bunjangService.getBunjangOrders({
        statusUpdateStartDate: startDateUTC,
        statusUpdateEndDate: endDateUTC,
        page: page,
        size: 100 // 최대값 사용
      });
      
      if (!ordersResponse || !ordersResponse.data) break;
      
      for (const order of ordersResponse.data) {
        try {
          await updateShopifyOrderFromBunjangStatus(order, jobId);
          syncedCount++;
        } catch (error) {
          logger.error(`[OrderSvc:Job-${jobId}] Failed to sync order ${order.id}: ${error.message}`);
          errorCount++;
        }
      }
      
      hasMore = page < (ordersResponse.totalPages - 1);
      page++;
    }
    
    logger.info(`[OrderSvc:Job-${jobId}] Order status sync completed. Synced: ${syncedCount}, Errors: ${errorCount}`);
    return { success: true, syncedOrders: syncedCount, errors: errorCount };
    
  } catch (error) {
    logger.error(`[OrderSvc:Job-${jobId}] Order status sync failed: ${error.message}`);
    throw error;
  }
}

/**
 * 번개장터 주문 상태를 기반으로 Shopify 주문을 업데이트합니다.
 * @param {object} bunjangOrder - 번개장터 주문 정보
 * @param {string} [jobId='N/A'] - 작업 ID
 */
async function updateShopifyOrderFromBunjangStatus(bunjangOrder, jobId = 'N/A') {
  const bunjangOrderId = bunjangOrder.id;
  
  // Shopify에서 해당 번개장터 주문과 연결된 주문 찾기
  const query = `
    query findOrderByBunjangId($query: String!) {
      orders(first: 1, query: $query) {
        edges {
          node {
            id
            name
            tags
            fulfillmentOrders(first: 10) {
              edges {
                node {
                  id
                  status
                }
              }
            }
          }
        }
      }
    }
  `;
  
  const searchQuery = `tag:"BunjangOrder-${bunjangOrderId}"`;
  const response = await shopifyService.shopifyGraphqlRequest(query, { query: searchQuery });
  
  if (!response.data.orders.edges || response.data.orders.edges.length === 0) {
    logger.warn(`[OrderSvc:Job-${jobId}] No Shopify order found for Bunjang order ${bunjangOrderId}`);
    return;
  }
  
  const shopifyOrder = response.data.orders.edges[0].node;
  const shopifyOrderGid = shopifyOrder.id;
  
  // 각 주문 아이템의 상태 확인
  for (const orderItem of bunjangOrder.orderItems) {
    const status = orderItem.status;
    const productId = orderItem.product.id;
    
    logger.info(`[OrderSvc:Job-${jobId}] Bunjang order ${bunjangOrderId}, product ${productId} status: ${status}`);
    
    // 상태별 처리
    switch(status) {
      case 'SHIP_READY':
      case 'IN_TRANSIT':
      case 'DELIVERY_COMPLETED':
        // 배송 관련 상태 - Shopify fulfillment 업데이트 필요
        await updateShopifyFulfillmentStatus(shopifyOrderGid, status, orderItem, jobId);
        break;
        
      case 'PURCHASE_CONFIRM':
        // 구매 확정 - 메타필드 업데이트
        await shopifyService.updateOrder({
          id: shopifyOrderGid,
          metafields: [{
            namespace: 'bunjang',
            key: 'purchase_confirmed',
            value: 'true',
            type: 'single_line_text_field'
          }, {
            namespace: 'bunjang',
            key: 'purchase_confirmed_at',
            value: orderItem.purchaseConfirmedAt || new Date().toISOString(),
            type: 'date_time'
          }],
          tags: [`BunjangStatus-PurchaseConfirmed`]
        });
        break;
        
      case 'CANCEL_REQUESTED_BEFORE_SHIPPING':
      case 'REFUNDED':
      case 'RETURN_REQUESTED':
      case 'RETURNED':
        // 취소/반품 관련 - 태그 추가
        await shopifyService.updateOrder({
          id: shopifyOrderGid,
          tags: [`BunjangStatus-${status}`, `BunjangOrder-${bunjangOrderId}-${status}`]
        });
        
        // 상품 상태 복원 필요
        try {
          const syncedProduct = await SyncedProduct.findOne({ bunjangPid: String(productId) });
          if (syncedProduct) {
            await inventoryService.restoreProductStatus(
              syncedProduct.bunjangPid,
              syncedProduct.shopifyGid
            );
          }
        } catch (error) {
          logger.error(`[OrderSvc:Job-${jobId}] Failed to restore product status for PID ${productId}: ${error.message}`);
        }
        break;
        
      default:
        logger.warn(`[OrderSvc:Job-${jobId}] Unknown Bunjang order status: ${status}`);
    }
  }
  
  // 주문 상태 메타필드 업데이트
  await shopifyService.updateOrder({
    id: shopifyOrderGid,
    metafields: [{
      namespace: 'bunjang',
      key: 'last_status_sync',
      value: new Date().toISOString(),
      type: 'date_time'
    }]
  });
}

/**
 * Shopify fulfillment 상태를 업데이트합니다.
 * @param {string} shopifyOrderGid - Shopify 주문 GID
 * @param {string} bunjangStatus - 번개장터 주문 상태
 * @param {object} orderItem - 번개장터 주문 아이템
 * @param {string} [jobId='N/A'] - 작업 ID
 */
async function updateShopifyFulfillmentStatus(shopifyOrderGid, bunjangStatus, orderItem, jobId = 'N/A') {
  logger.info(`[OrderSvc:Job-${jobId}] Updating Shopify fulfillment for order ${shopifyOrderGid} with Bunjang status: ${bunjangStatus}`);
  
  // 배송 정보가 있는 경우
  if (orderItem.delivery && orderItem.delivery.invoice) {
    const trackingCompany = bunjangService.mapDeliveryCompany(orderItem.delivery.invoice.companyCode);
    const trackingNumber = orderItem.delivery.invoice.no;
    const trackingUrl = bunjangService.getTrackingUrl(orderItem.delivery.invoice.companyCode, trackingNumber);
    
    logger.info(`[OrderSvc:Job-${jobId}] Delivery info - Company: ${trackingCompany}, Tracking: ${trackingNumber}`);
    
    // Shopify fulfillment 업데이트 로직
    // 실제 구현은 shopifyService의 fulfillment 관련 메서드 호출
  }
}

/**
 * 판매 완료된 상품들의 상태를 확인합니다.
 * @param {string} [jobId='N/A'] - 작업 ID
 * @returns {Promise<{checked: number, needsUpdate: number}>}
 */
async function checkSoldProductsStatus(jobId = 'N/A') {
  logger.info(`[OrderSvc:Job-${jobId}] Starting sold products status check`);
  
  try {
    // 번개장터에서 판매되어 DRAFT 상태인 상품들 찾기
    const soldProducts = await SyncedProduct.find({
      soldFrom: 'bunjang',
      shopifyStatus: 'DRAFT'
    }).limit(100);
    
    let checkedCount = 0;
    let needsUpdateCount = 0;
    
    for (const product of soldProducts) {
      try {
        // 번개장터 상품 상태 확인
        const bunjangDetails = await bunjangService.getBunjangProductDetails(product.bunjangPid);
        
        if (bunjangDetails && bunjangDetails.status === 'SELLING') {
          // 다시 판매 중인 경우
          logger.warn(`[OrderSvc:Job-${jobId}] Product ${product.bunjangPid} is back to SELLING status`);
          needsUpdateCount++;
          
          // 상품 상태 복원
          await inventoryService.restoreProductStatus(
            product.bunjangPid,
            product.shopifyGid
          );
        }
        
        checkedCount++;
      } catch (error) {
        logger.error(`[OrderSvc:Job-${jobId}] Failed to check product ${product.bunjangPid}: ${error.message}`);
      }
    }
    
    logger.info(`[OrderSvc:Job-${jobId}] Sold products check completed. Checked: ${checkedCount}, Needs update: ${needsUpdateCount}`);
    
    return {
      checked: checkedCount,
      needsUpdate: needsUpdateCount
    };
    
  } catch (error) {
    logger.error(`[OrderSvc:Job-${jobId}] Failed to check sold products: ${error.message}`);
    throw error;
  }
}

/**
 * 오래된 판매 완료 상품들을 아카이브합니다.
 * @param {number} [daysOld=30] - 며칠 이상 된 상품을 아카이브할지
 * @returns {Promise<{found: number, archived: number}>}
 */
async function archiveOldSoldProducts(daysOld = 30) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);
    
    logger.info(`[OrderSvc] Archiving sold products older than ${daysOld} days (before ${cutoffDate.toISOString()})`);
    
    const oldProducts = await SyncedProduct.find({
      soldFrom: { $exists: true },
      soldAt: { $lt: cutoffDate },
      shopifyStatus: 'DRAFT'
    }).limit(100);
    
    let archivedCount = 0;
    
    for (const product of oldProducts) {
      try {
        await shopifyService.updateProductStatus(product.shopifyGid, 'ARCHIVED');
        
        product.shopifyStatus = 'ARCHIVED';
        product.archivedAt = new Date();
        await product.save();
        
        archivedCount++;
        logger.info(`[OrderSvc] Archived product ${product.shopifyGid} (PID: ${product.bunjangPid})`);
      } catch (error) {
        logger.error(`[OrderSvc] Failed to archive product ${product.shopifyGid}: ${error.message}`);
      }
    }
    
    logger.info(`[OrderSvc] Archive completed. Found: ${oldProducts.length}, Archived: ${archivedCount}`);
    
    return {
      found: oldProducts.length,
      archived: archivedCount,
      failed: oldProducts.length - archivedCount
    };
    
  } catch (error) {
    logger.error('[OrderSvc] Failed to archive old sold products:', error);
    throw error;
  }
}

/**
 * 특정 Shopify 주문을 재처리합니다 (디버깅 용도)
 * @param {string} shopifyOrderId - Shopify 주문 ID
 * @returns {Promise<object>} 처리 결과
 */
async function reprocessShopifyOrder(shopifyOrderId) {
  try {
    logger.info(`[OrderSvc] Reprocessing Shopify order ${shopifyOrderId}`);
    
    // Shopify에서 주문 정보 가져오기
    const orderGid = `gid://shopify/Order/${shopifyOrderId}`;
    const query = `
      query getOrder($id: ID!) {
        order(id: $id) {
          id
          name
          createdAt
          lineItems(first: 250) {
            edges {
              node {
                id
                title
                quantity
                product {
                  id
                }
              }
            }
          }
        }
      }
    `;
    
    const response = await shopifyService.shopifyGraphqlRequest(query, { id: orderGid });
    
    if (!response.data.order) {
      throw new NotFoundError(`Shopify order ${shopifyOrderId} not found`);
    }
    
    // REST API 형식으로 변환
    const order = {
      id: shopifyOrderId,
      admin_graphql_api_id: orderGid,
      name: response.data.order.name,
      line_items: response.data.order.lineItems.edges.map(edge => ({
        id: edge.node.id,
        title: edge.node.title,
        quantity: edge.node.quantity,
        product_id: edge.node.product?.id?.split('/').pop()
      }))
    };
    
    logger.info(`[OrderSvc] Order details fetched. Line items: ${order.line_items.length}`);
    
    // 주문 재처리
    const result = await processShopifyOrderForBunjang(order, `REPROCESS-${shopifyOrderId}`);
    
    logger.info(`[OrderSvc] Reprocess completed for order ${shopifyOrderId}:`, result);
    
    return result;
    
  } catch (error) {
    logger.error(`[OrderSvc] Failed to reprocess order ${shopifyOrderId}:`, error);
    throw error;
  }
}

/**
 * 특정 번개장터 상품의 주문 가능 여부를 테스트합니다
 * @param {string} bunjangPid - 번개장터 상품 ID
 * @returns {Promise<object>} 테스트 결과
 */
async function testBunjangProductOrder(bunjangPid) {
  try {
    logger.info(`[OrderSvc] Testing order capability for Bunjang PID ${bunjangPid}`);
    
    // 1. 상품 정보 조회
    const product = await bunjangService.getBunjangProductDetails(bunjangPid);
    
    if (!product) {
      return {
        success: false,
        reason: 'PRODUCT_NOT_FOUND',
        message: '상품을 찾을 수 없습니다.'
      };
    }
    
    // 2. 상태 확인
    const status = product.status || product.saleStatus;
    if (status !== 'SELLING') {
      return {
        success: false,
        reason: 'NOT_SELLING',
        message: `상품이 판매 중이 아닙니다. 현재 상태: ${status}`,
        productDetails: {
          pid: bunjangPid,
          name: product.name,
          status: status,
          quantity: product.quantity
        }
      };
    }
    
    // 3. 재고 확인
    if (product.quantity === 0) {
      return {
        success: false,
        reason: 'NO_STOCK',
        message: '재고가 없습니다.',
        productDetails: {
          pid: bunjangPid,
          name: product.name,
          status: status,
          quantity: product.quantity
        }
      };
    }
    
    // 4. 포인트 잔액 확인
    const balance = await bunjangService.getBunjangPointBalance();
    const totalPrice = product.price + (product.shippingFee || 0);
    
    if (balance && balance.balance < totalPrice) {
      return {
        success: false,
        reason: 'INSUFFICIENT_POINTS',
        message: `포인트가 부족합니다. 필요: ${totalPrice.toLocaleString()}원, 잔액: ${balance.balance.toLocaleString()}원`,
        productDetails: {
          pid: bunjangPid,
          name: product.name,
          price: product.price,
          shippingFee: product.shippingFee,
          totalNeeded: totalPrice
        },
        pointBalance: balance.balance
      };
    }
    
    return {
      success: true,
      message: '주문 가능한 상품입니다.',
      productDetails: {
        pid: bunjangPid,
        name: product.name,
        status: status,
        quantity: product.quantity,
        price: product.price,
        shippingFee: product.shippingFee,
        totalPrice: totalPrice
      },
      pointBalance: balance?.balance
    };
    
  } catch (error) {
    logger.error(`[OrderSvc] Failed to test product order for PID ${bunjangPid}:`, error);
    return {
      success: false,
      reason: 'ERROR',
      message: error.message,
      error: error
    };
  }
}

// 주문 처리를 위한 별칭 (레거시 호환성)
const createBunjangOrdersForShopifyOrder = processShopifyOrderForBunjang;

module.exports = {
  processShopifyOrderForBunjang,
  createBunjangOrdersForShopifyOrder, // 레거시 호환성
  queueBunjangOrderCreation,
  syncBunjangOrderStatuses,
  updateShopifyOrderFromBunjangStatus,
  updateShopifyFulfillmentStatus,
  checkSoldProductsStatus,
  archiveOldSoldProducts,
  reprocessShopifyOrder,
  testBunjangProductOrder
};
