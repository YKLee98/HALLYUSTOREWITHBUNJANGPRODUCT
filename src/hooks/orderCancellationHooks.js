// src/hooks/orderCancellationHooks.js
// 주문 생성/업데이트 웹훅에서 자동 취소 로직 통합

const logger = require('../config/logger');
const orderCancellationService = require('../services/orderCancellationService');
const { scheduleOrderCancellation } = require('../jobs/orderCancellationJob');

/**
 * 주문 생성 웹훅 후 처리 - 번개장터 주문 실패 확인
 * @param {object} order - Shopify 주문 객체
 * @param {object} bunjangResult - 번개장터 주문 생성 결과
 */
async function handleOrderCreationResult(order, bunjangResult) {
  const orderId = order.admin_graphql_api_id || `gid://shopify/Order/${order.id}`;
  
  logger.info(`[OrderCancellationHook] Checking order ${order.name} for Bunjang failures`);
  
  // 번개장터 주문이 전혀 생성되지 않은 경우
  if (!bunjangResult.success && bunjangResult.bunjangOrderIds?.length === 0) {
    logger.error(`[OrderCancellationHook] No Bunjang orders created for Shopify order ${order.name}`);
    
    // 즉시 취소 예약 (5초 후 실행하여 웹훅 응답 시간 확보)
    await scheduleOrderCancellation(orderId, {
      reason: 'bunjang_order_failed',
      source: 'order_creation_webhook',
      attemptNumber: 1,
    }, 5000); // 5초 후 실행
    
    logger.info(`[OrderCancellationHook] Scheduled immediate cancellation for order ${order.name}`);
    
    return {
      scheduled: true,
      delay: 5000,
      immediate: true,
    };
  }
  
  // 부분 실패 확인
  const hasErrors = order.tags?.some(tag => 
    orderCancellationService.CANCELLATION_CONFIG.errorTagPatterns.some(pattern => {
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      return regex.test(tag);
    })
  );
  
  if (hasErrors) {
    logger.warn(`[OrderCancellationHook] Partial failures detected for order ${order.name}`);
    
    // 부분 실패도 즉시 취소 예약
    await scheduleOrderCancellation(orderId, {
      reason: 'partial_bunjang_failure',
      source: 'order_creation_webhook',
      attemptNumber: 1,
      partialCancel: true,
    }, 5000); // 5초 후 실행
    
    logger.info(`[OrderCancellationHook] Scheduled immediate partial cancellation for order ${order.name}`);
    
    return {
      scheduled: true,
      partial: true,
      delay: 5000,
      immediate: true,
    };
  }
  
  return {
    scheduled: false,
  };
}

/**
 * 주문 업데이트 웹훅에서 실패 태그 모니터링
 * @param {object} updatedOrder - 업데이트된 주문
 * @param {object} previousTags - 이전 태그 (있는 경우)
 */
async function handleOrderUpdate(updatedOrder, previousTags = []) {
  const orderId = updatedOrder.admin_graphql_api_id || `gid://shopify/Order/${updatedOrder.id}`;
  
  // 새로 추가된 에러 태그 확인
  const newTags = updatedOrder.tags.filter(tag => !previousTags.includes(tag));
  const errorCheck = orderCancellationService.checkBunjangOrderErrors(newTags);
  
  if (errorCheck.hasError) {
    logger.warn(`[OrderCancellationHook] New error tags detected for order ${updatedOrder.name}:`, errorCheck.errorTypes);
    
    // 긴급 에러인지 확인
    const isUrgent = errorCheck.errorTypes.some(tag => 
      tag.includes('URGENT-') || 
      tag.includes('InsufficientPoints') || 
      tag.includes('AuthenticationError')
    );
    
    const delay = isUrgent ? 0 : 60000; // 긴급은 즉시, 아니면 1분 후
    
    await scheduleOrderCancellation(orderId, {
      reason: 'error_tags_added',
      source: 'order_update_webhook',
      errorTypes: errorCheck.errorTypes,
      isUrgent,
    }, delay);
    
    return {
      scheduled: true,
      urgent: isUrgent,
      errors: errorCheck.errorTypes,
    };
  }
  
  return {
    scheduled: false,
  };
}

/**
 * 수동 주문 취소 트리거
 * @param {string} orderNameOrId - 주문 이름 (#1001) 또는 ID
 * @param {object} options - 취소 옵션
 */
async function triggerManualCancellation(orderNameOrId, options = {}) {
  logger.info(`[OrderCancellationHook] Manual cancellation triggered for ${orderNameOrId}`);
  
  let orderId = orderNameOrId;
  
  // 주문 이름으로 검색
  if (orderNameOrId.startsWith('#')) {
    const query = `
      query findOrderByName($name: String!) {
        orders(first: 1, query: $name) {
          edges {
            node {
              id
            }
          }
        }
      }
    `;
    
    const response = await require('../services/shopifyService').shopifyGraphqlRequest(query, { 
      name: `name:${orderNameOrId}` 
    });
    
    if (response.data?.orders?.edges?.[0]) {
      orderId = response.data.orders.edges[0].node.id;
    } else {
      throw new Error(`Order ${orderNameOrId} not found`);
    }
  }
  
  // 즉시 실행
  return await orderCancellationService.manualCancelOrder(orderId, {
    ...options,
    source: 'manual_trigger',
  });
}


module.exports = {
  handleOrderCreationResult,
  handleOrderUpdate,
  triggerManualCancellation,
};
