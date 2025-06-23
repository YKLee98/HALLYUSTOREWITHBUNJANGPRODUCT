// src/routes/webhook.routes.js
// Shopify 웹훅을 처리하는 라우터
// 수정사항: 판매 상태에 따른 상품 처리 로직 추가

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const config = require('../config');
const logger = require('../config/logger');
const orderService = require('../services/orderService');
const inventoryService = require('../services/inventoryService');
const shopifyService = require('../services/shopifyService');
const SyncedProduct = require('../models/syncedProduct.model');

// Shopify 웹훅 검증 미들웨어
const verifyWebhook = (req, res, next) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const body = req.rawBody;
  const secret = config.shopify.webhookSecret;
  
  if (!hmac || !body) {
    logger.error('[Webhook] Missing HMAC or body');
    return res.status(401).send('Unauthorized');
  }
  
  const hash = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64');
  
  if (hash !== hmac) {
    logger.error('[Webhook] HMAC verification failed');
    return res.status(401).send('Unauthorized');
  }
  
  next();
};

// 주문 생성 웹훅
router.post('/orders/create', verifyWebhook, async (req, res) => {
  try {
    const order = req.body;
    logger.info(`[Webhook] Order created: #${order.order_number || order.name} (${order.id})`);
    
    // 번개장터 주문 처리를 위한 큐에 추가
    await orderService.queueBunjangOrderCreation(order);
    
    res.status(200).json({ status: 'success' });
  } catch (error) {
    logger.error('[Webhook] Failed to process order creation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 주문 결제 완료 웹훅
router.post('/orders/paid', verifyWebhook, async (req, res) => {
  try {
    const order = req.body;
    logger.info(`[Webhook] Order paid: #${order.order_number || order.name} (${order.id})`);
    
    // 주문 상품별 처리
    for (const lineItem of order.line_items || []) {
      try {
        const productId = lineItem.product_id;
        
        // DB에서 연결된 번개장터 상품 찾기
        const syncedProduct = await SyncedProduct.findOne({
          $or: [
            { shopifyGid: `gid://shopify/Product/${productId}` },
            { 'shopifyData.id': productId },
            { 'shopifyData.id': String(productId) }
          ]
        }).lean();
        
        if (syncedProduct && syncedProduct.bunjangPid) {
          logger.info(`[Webhook] Processing Bunjang product:`, {
            bunjangPid: syncedProduct.bunjangPid,
            productName: syncedProduct.bunjangProductName,
            quantity: lineItem.quantity
          });
          
          // 번개장터 주문이 생성될 때까지 대기 상태로 설정
          await inventoryService.handleProductSoldStatus(
            syncedProduct.bunjangPid,
            syncedProduct.shopifyGid,
            'shopify'
          );
        }
      } catch (itemError) {
        logger.error(`[Webhook] Failed to process line item ${lineItem.id}:`, itemError);
      }
    }
    
    res.status(200).json({ status: 'success' });
    
  } catch (error) {
    logger.error('[Webhook] Failed to process order payment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 주문 완료 웹훅 (번개장터 주문 생성 후 호출)
router.post('/orders/fulfilled', verifyWebhook, async (req, res) => {
  try {
    const order = req.body;
    logger.info(`[Webhook] Order fulfilled: #${order.order_number || order.name} (${order.id})`);
    
    // 주문에 번개장터 주문 태그가 있는지 확인
    const hasBunjangOrder = order.tags?.some(tag => tag.startsWith('BunjangOrder-'));
    
    // 주문 상품별 최종 처리
    for (const lineItem of order.line_items || []) {
      try {
        const productId = lineItem.product_id;
        
        // DB에서 연결된 번개장터 상품 찾기
        const syncedProduct = await SyncedProduct.findOne({
          $or: [
            { shopifyGid: `gid://shopify/Product/${productId}` },
            { 'shopifyData.id': productId },
            { 'shopifyData.id': String(productId) }
          ]
        }).lean();
        
        if (syncedProduct && syncedProduct.bunjangPid) {
          // 번개장터 주문 생성 여부에 따라 처리
          await inventoryService.processOrderCompletion(
            syncedProduct.bunjangPid,
            hasBunjangOrder
          );
        }
      } catch (itemError) {
        logger.error(`[Webhook] Failed to process fulfilled item ${lineItem.id}:`, itemError);
      }
    }
    
    res.status(200).json({ status: 'success' });
    
  } catch (error) {
    logger.error('[Webhook] Failed to process order fulfillment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 주문 업데이트 웹훅
router.post('/orders/updated', verifyWebhook, async (req, res) => {
  try {
    const order = req.body;
    logger.info(`[Webhook] Order updated: #${order.order_number || order.name} (${order.id})`);
    
    // 주문 상태가 cancelled로 변경된 경우
    if (order.cancelled_at || order.cancel_reason) {
      logger.info(`[Webhook] Order cancelled, restoring inventory`);
      
      // 재고 복구 로직
      for (const lineItem of order.line_items || []) {
        try {
          const productId = lineItem.product_id;
          
          const syncedProduct = await SyncedProduct.findOne({
            $or: [
              { shopifyGid: `gid://shopify/Product/${productId}` },
              { 'shopifyData.id': productId },
              { 'shopifyData.id': String(productId) }
            ]
          }).lean();
          
          if (syncedProduct && syncedProduct.bunjangPid) {
            // 상품 상태 복구
            await restoreProductStatus(syncedProduct);
            
            logger.info(`[Webhook] Product status restored for PID ${syncedProduct.bunjangPid}`);
          }
        } catch (itemError) {
          logger.error(`[Webhook] Failed to restore product status:`, itemError);
        }
      }
    }
    
    res.status(200).json({ status: 'success' });
    
  } catch (error) {
    logger.error('[Webhook] Failed to process order update:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 주문 취소 웹훅
router.post('/orders/cancelled', verifyWebhook, async (req, res) => {
  try {
    const order = req.body;
    logger.info(`[Webhook] Order cancelled: #${order.order_number || order.name} (${order.id})`);
    
    // 재고 복구 및 상태 복원
    for (const lineItem of order.line_items || []) {
      try {
        const productId = lineItem.product_id;
        
        const syncedProduct = await SyncedProduct.findOne({
          $or: [
            { shopifyGid: `gid://shopify/Product/${productId}` },
            { 'shopifyData.id': productId },
            { 'shopifyData.id': String(productId) }
          ]
        });
        
        if (syncedProduct && syncedProduct.bunjangPid) {
          // 상품 상태 복구
          await restoreProductStatus(syncedProduct);
          
          // DB 업데이트
          syncedProduct.shopifyStatus = 'ACTIVE';
          syncedProduct.soldFrom = null;
          syncedProduct.soldAt = null;
          syncedProduct.pendingBunjangOrder = false;
          syncedProduct.shopifySoldAt = null;
          await syncedProduct.save();
          
          logger.info(`[Webhook] Product restored for PID ${syncedProduct.bunjangPid}`);
        }
      } catch (itemError) {
        logger.error(`[Webhook] Failed to restore inventory for item ${lineItem.id}:`, itemError);
      }
    }
    
    res.status(200).json({ status: 'success' });
    
  } catch (error) {
    logger.error('[Webhook] Failed to process order cancellation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 상품 상태 복구 함수
async function restoreProductStatus(syncedProduct) {
  try {
    // 1. 재고를 1로 복구
    await inventoryService.syncBunjangInventoryToShopify(syncedProduct.bunjangPid, 1);
    
    // 2. SOLD OUT 또는 번개장터 판매완료 표시 제거
    if (syncedProduct.shopifyStatus === 'SOLD_OUT' || syncedProduct.shopifyStatus === 'DRAFT') {
      const query = `
        query getProduct($id: ID!) {
          product(id: $id) {
            id
            title
            status
            tags
          }
        }
      `;
      
      const response = await shopifyService.shopifyGraphqlRequest(query, { id: syncedProduct.shopifyGid });
      const product = response.data?.product;
      
      if (product) {
        let newTitle = product.title
          .replace('[SOLD OUT] ', '')
          .replace('[번개장터 판매완료] ', '');
        
        const updateInput = {
          id: syncedProduct.shopifyGid,
          title: newTitle,
          status: 'ACTIVE',
          tags: product.tags?.filter(tag => 
            tag !== 'sold_out' && 
            tag !== 'sold_both_platforms' && 
            tag !== 'sold_bunjang_only'
          ) || []
        };
        
        await shopifyService.updateProduct(updateInput);
        logger.info(`[Webhook] Product status restored: ${newTitle}`);
      }
    }
    
  } catch (error) {
    logger.error(`[Webhook] Failed to restore product status:`, error);
    throw error;
  }
}

// 상품 생성 웹훅
router.post('/products/create', verifyWebhook, async (req, res) => {
  try {
    const product = req.body;
    logger.info(`[Webhook] Product created: ${product.title} (${product.id})`);
    
    res.status(200).json({ status: 'success' });
  } catch (error) {
    logger.error('[Webhook] Failed to process product creation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 상품 업데이트 웹훅
router.post('/products/update', verifyWebhook, async (req, res) => {
  try {
    const product = req.body;
    logger.info(`[Webhook] Product updated: ${product.title} (${product.id})`);
    
    res.status(200).json({ status: 'success' });
  } catch (error) {
    logger.error('[Webhook] Failed to process product update:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 상품 삭제 웹훅
router.post('/products/delete', verifyWebhook, async (req, res) => {
  try {
    const product = req.body;
    logger.info(`[Webhook] Product deleted: ${product.id}`);
    
    // DB에서 동기화 정보 삭제
    const productGid = `gid://shopify/Product/${product.id}`;
    await SyncedProduct.deleteOne({ shopifyGid: productGid });
    
    logger.info(`[Webhook] Removed sync record for deleted product ${product.id}`);
    
    res.status(200).json({ status: 'success' });
  } catch (error) {
    logger.error('[Webhook] Failed to process product deletion:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;