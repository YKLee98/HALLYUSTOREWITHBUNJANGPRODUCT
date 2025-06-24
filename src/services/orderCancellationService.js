// src/services/orderCancellationService.js
// 번개장터 주문 생성 실패 시 Shopify 주문을 즉시 취소하는 서비스

const config = require('../config');
const logger = require('../config/logger');
const shopifyService = require('./shopifyService');
const SyncedProduct = require('../models/syncedProduct.model');
const { AppError, ExternalServiceError, NotFoundError, ValidationError } = require('../utils/customErrors');

const SERVICE_NAME = 'OrderCancellationSvc';

// 취소 옵션 설정
const CANCELLATION_CONFIG = {
  // 재시도 없이 즉시 취소
  enableRetryBeforeCancel: false,
  
  // 취소 정책
  cancelPartialOrders: true, // 부분 취소 허용
  autoRefund: true, // 자동 환불
  notifyCustomer: process.env.NOTIFY_CUSTOMER_ON_CANCEL !== 'false', // 기본값 true
  restockInventory: false, // 재고 복구 안함
  
  // 에러 태그 패턴
  errorTagPatterns: [
    'BunjangOrder-*_Error',
    'PID-*-NotAvailable',
    'PID-*-InsufficientStock',
    'PID-*-NotFound',
    'PID-*-CreateFail',
    'PID-*-Exception',
    'URGENT-InsufficientPoints',
    'URGENT-AuthenticationError'
  ]
};

/**
 * 주문에 번개장터 에러가 있는지 확인
 * @param {Array} tags - 주문 태그 배열
 * @returns {object} { hasError: boolean, errorTypes: Array }
 */
function checkBunjangOrderErrors(tags) {
  const errors = [];
  const hasError = tags.some(tag => {
    for (const pattern of CANCELLATION_CONFIG.errorTagPatterns) {
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      if (regex.test(tag)) {
        errors.push(tag);
        return true;
      }
    }
    return false;
  });
  
  return { hasError, errorTypes: errors };
}

/**
 * 특정 주문의 번개장터 주문 실패 여부를 확인하고 취소 처리
 * @param {string} orderId - Shopify 주문 ID (GID)
 * @param {object} options - 취소 옵션
 * @returns {Promise<object>} 처리 결과
 */
async function processCancellationForOrder(orderId, options = {}) {
  logger.info(`[${SERVICE_NAME}] Processing order ${orderId} for potential cancellation`);
  
  try {
    // 1. 주문 정보 조회
    const orderQuery = `
      query getOrderDetails($id: ID!) {
        order(id: $id) {
          id
          name
          displayFinancialStatus
          displayFulfillmentStatus
          cancelledAt
          tags
          currentTotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          lineItems(first: 250) {
            edges {
              node {
                id
                title
                quantity
                product {
                  id
                  tags
                }
                variant {
                  id
                  sku
                }
              }
            }
          }
          metafield(namespace: "bunjang", key: "order_ids") {
            value
          }
        }
      }
    `;
    
    const orderResponse = await shopifyService.shopifyGraphqlRequest(orderQuery, { id: orderId });
    const order = orderResponse.data?.order;
    
    if (!order) {
      throw new NotFoundError(`Order ${orderId} not found`);
    }
    
    // 2. 이미 취소된 주문인지 확인
    if (order.cancelledAt) {
      logger.info(`[${SERVICE_NAME}] Order ${order.name} is already cancelled`);
      return { success: true, alreadyCancelled: true };
    }
    
    // 3. 번개장터 에러 태그 확인
    const errorCheck = checkBunjangOrderErrors(order.tags);
    if (!errorCheck.hasError) {
      logger.info(`[${SERVICE_NAME}] Order ${order.name} has no Bunjang errors`);
      return { success: true, noErrors: true };
    }
    
    logger.warn(`[${SERVICE_NAME}] Order ${order.name} has Bunjang errors:`, errorCheck.errorTypes);
    
    // 4. 번개장터 주문이 일부라도 성공했는지 확인
    const bunjangOrderIds = order.metafield?.value ? JSON.parse(order.metafield.value) : [];
    const hasSuccessfulBunjangOrders = bunjangOrderIds.length > 0;
    
    // 5. 실패한 라인 아이템 식별
    const failedLineItems = [];
    const successfulLineItems = [];
    
    for (const edge of order.lineItems.edges) {
      const lineItem = edge.node;
      const sku = lineItem.variant?.sku;
      
      if (sku && sku.startsWith('BJ-')) {
        const bunjangPid = sku.substring(3);
        const hasErrorTag = order.tags.some(tag => 
          tag.includes(`PID-${bunjangPid}-`) && tag.includes('Error')
        );
        
        if (hasErrorTag) {
          failedLineItems.push(lineItem);
        } else if (hasSuccessfulBunjangOrders) {
          successfulLineItems.push(lineItem);
        }
      }
    }
    
    // 6. 취소 정책 결정
    const shouldCancelEntireOrder = failedLineItems.length === order.lineItems.edges.length;
    
    if (!shouldCancelEntireOrder && !hasSuccessfulBunjangOrders) {
      // 번개장터 주문이 하나도 성공하지 않았지만 일부 항목만 실패로 표시된 경우
      logger.warn(`[${SERVICE_NAME}] Partial failure detected but no successful Bunjang orders for ${order.name}`);
    }
    
    // 7. 즉시 취소 실행 (재시도 없음)
    logger.info(`[${SERVICE_NAME}] Proceeding with immediate cancellation for order ${order.name}`);
    
    // 부분 취소 우선 (실패한 항목만 취소)
    if (failedLineItems.length > 0 && successfulLineItems.length > 0) {
      return await cancelFailedLineItems(order, failedLineItems, options);
    } else if (failedLineItems.length > 0) {
      // 모든 항목이 실패한 경우 전체 취소
      return await cancelEntireOrder(order, options);
    } else {
      // 실패한 항목이 없는 경우
      logger.warn(`[${SERVICE_NAME}] No failed line items found for order ${order.name}`);
      return { 
        success: false, 
        reason: 'NO_FAILED_ITEMS',
        message: '실패한 항목을 찾을 수 없습니다.'
      };
    }
    
  } catch (error) {
    logger.error(`[${SERVICE_NAME}] Error processing order cancellation:`, error);
    throw error;
  }
}

/**
 * 전체 주문 취소
 * @param {object} order - 주문 정보
 * @param {object} options - 취소 옵션
 */
async function cancelEntireOrder(order, options = {}) {
  logger.info(`[${SERVICE_NAME}] Cancelling entire order ${order.name}`);
  
  const mutation = `
    mutation orderCancel($orderId: ID!, $notifyCustomer: Boolean!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!) {
      orderCancel(
        orderId: $orderId,
        notifyCustomer: $notifyCustomer,
        reason: $reason,
        refund: $refund,
        restock: $restock
      ) {
        job {
          id
          done
        }
        orderCancelUserErrors {
          field
          message
          code
        }
      }
    }
  `;
  
  const variables = {
    orderId: order.id,
    notifyCustomer: options.notifyCustomer ?? CANCELLATION_CONFIG.notifyCustomer,
    reason: 'OTHER', // CUSTOMER, INVENTORY, FRAUD, DECLINED, OTHER
    refund: options.autoRefund ?? CANCELLATION_CONFIG.autoRefund,
    restock: false // 재고 복구 안함
  };
  
  try {
    const response = await shopifyService.shopifyGraphqlRequest(mutation, variables);
    
    if (response.data?.orderCancel?.orderCancelUserErrors?.length > 0) {
      const errors = response.data.orderCancel.orderCancelUserErrors;
      const errorMessage = errors.map(e => `${e.code}: ${e.message}`).join(', ');
      throw new ExternalServiceError(SERVICE_NAME, null, `Order cancellation failed: ${errorMessage}`, 'ORDER_CANCEL_ERROR');
    }
    
    const job = response.data?.orderCancel?.job;
    
    if (job) {
      logger.info(`[${SERVICE_NAME}] Order cancellation job created: ${job.id}, Done: ${job.done}`);
      
      // 메타필드에 취소 정보 추가
      await shopifyService.updateOrder({
        id: order.id,
        metafields: [{
          namespace: 'bunjang',
          key: 'cancellation_reason',
          value: 'Bunjang order creation failed',
          type: 'single_line_text_field'
        }, {
          namespace: 'bunjang',
          key: 'cancelled_at',
          value: new Date().toISOString(),
          type: 'date_time'
        }],
        tags: [...order.tags, 'auto-cancelled', 'bunjang-order-failed']
      });
      
      return {
        success: true,
        cancelled: true,
        jobId: job.id,
        orderName: order.name
      };
    }
    
  } catch (error) {
    logger.error(`[${SERVICE_NAME}] Failed to cancel order ${order.name}:`, error);
    throw error;
  }
}

/**
 * 부분 주문 취소 (특정 라인 아이템만)
 * @param {object} order - 주문 정보
 * @param {Array} lineItemsToCancel - 취소할 라인 아이템
 * @param {object} options - 취소 옵션
 */
async function cancelFailedLineItems(order, lineItemsToCancel, options = {}) {
  logger.info(`[${SERVICE_NAME}] Cancelling ${lineItemsToCancel.length} failed line items from order ${order.name}`);
  
  // Shopify는 직접적인 부분 취소를 지원하지 않으므로, 환불을 통해 처리
  const mutation = `
    mutation refundCreate($input: RefundInput!) {
      refundCreate(input: $input) {
        refund {
          id
          totalRefundedSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;
  
  // 환불할 라인 아이템 준비
  const refundLineItems = lineItemsToCancel.map(item => ({
    lineItemId: item.id,
    quantity: item.quantity,
    restockType: 'NO_RESTOCK' // 재고 복구 안함
  }));
  
  const variables = {
    input: {
      orderId: order.id,
      note: 'Automatic refund due to Bunjang order creation failure',
      notify: options.notifyCustomer ?? CANCELLATION_CONFIG.notifyCustomer,
      refundLineItems: refundLineItems
    }
  };
  
  try {
    const response = await shopifyService.shopifyGraphqlRequest(mutation, variables);
    
    if (response.data?.refundCreate?.userErrors?.length > 0) {
      const errors = response.data.refundCreate.userErrors;
      const errorMessage = errors.map(e => `${e.code}: ${e.message}`).join(', ');
      throw new ExternalServiceError(SERVICE_NAME, null, `Refund creation failed: ${errorMessage}`, 'REFUND_CREATE_ERROR');
    }
    
    const refund = response.data?.refundCreate?.refund;
    
    if (refund) {
      logger.info(`[${SERVICE_NAME}] Refund created for order ${order.name}: ${refund.id}`);
      
      // 주문 태그 업데이트
      await shopifyService.updateOrder({
        id: order.id,
        tags: [...order.tags, 'partial-refund', 'bunjang-items-refunded']
      });
      
      return {
        success: true,
        refunded: true,
        refundId: refund.id,
        refundedAmount: refund.totalRefundedSet?.shopMoney?.amount,
        itemsRefunded: lineItemsToCancel.length
      };
    }
    
  } catch (error) {
    logger.error(`[${SERVICE_NAME}] Failed to create refund for order ${order.name}:`, error);
    throw error;
  }
}

/**
 * 실패한 주문들을 검색하고 일괄 처리
 * @param {object} options - 검색 및 처리 옵션
 */
async function processFailedOrders(options = {}) {
  logger.info(`[${SERVICE_NAME}] Starting batch processing of failed orders`);
  
  const query = `
    query findFailedOrders($query: String!, $first: Int!, $after: String) {
      orders(first: $first, after: $after, query: $query) {
        edges {
          node {
            id
            name
            tags
          }
          cursor
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;
  
  // 에러 태그를 가진 주문 검색
  const searchQuery = 'tag:*_Error OR tag:URGENT-*';
  let hasNextPage = true;
  let cursor = null;
  let processedCount = 0;
  let cancelledCount = 0;
  
  while (hasNextPage) {
    try {
      const response = await shopifyService.shopifyGraphqlRequest(query, {
        query: searchQuery,
        first: 50,
        after: cursor
      });
      
      const orders = response.data?.orders?.edges || [];
      hasNextPage = response.data?.orders?.pageInfo?.hasNextPage || false;
      cursor = response.data?.orders?.pageInfo?.endCursor;
      
      for (const edge of orders) {
        const order = edge.node;
        
        // 에러 태그 확인
        const errorCheck = checkBunjangOrderErrors(order.tags);
        if (errorCheck.hasError) {
          processedCount++;
          
          try {
            const result = await processCancellationForOrder(order.id, {
              ...options,
              attemptNumber: 1
            });
            
            if (result.cancelled || result.refunded) {
              cancelledCount++;
            }
            
          } catch (error) {
            logger.error(`[${SERVICE_NAME}] Failed to process order ${order.name}:`, error);
          }
          
          // Rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
    } catch (error) {
      logger.error(`[${SERVICE_NAME}] Error fetching failed orders:`, error);
      break;
    }
  }
  
  logger.info(`[${SERVICE_NAME}] Batch processing completed. Processed: ${processedCount}, Cancelled/Refunded: ${cancelledCount}`);
  
  return {
    processed: processedCount,
    cancelled: cancelledCount
  };
}

/**
 * 특정 주문 ID로 수동 취소 처리
 * @param {string} orderId - Shopify 주문 ID
 * @param {object} options - 취소 옵션
 */
async function manualCancelOrder(orderId, options = {}) {
  logger.info(`[${SERVICE_NAME}] Manual cancellation requested for order ${orderId}`);
  
  // GraphQL ID 형식 확인
  const gid = orderId.startsWith('gid://') ? orderId : `gid://shopify/Order/${orderId}`;
  
  return await processCancellationForOrder(gid, {
    ...options,
    manual: true
  });
}

module.exports = {
  processCancellationForOrder,
  processFailedOrders,
  manualCancelOrder,
  checkBunjangOrderErrors,
  CANCELLATION_CONFIG
};