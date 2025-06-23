// src/services/inventoryService.js
// Shopify와 번개장터 간의 재고 동기화를 담당하는 서비스

const config = require('../config');
const logger = require('../config/logger');
const shopifyService = require('./shopifyService');
const bunjangService = require('./bunjangService');
const SyncedProduct = require('../models/syncedProduct.model');
const { AppError, ValidationError } = require('../utils/customErrors');

// 환경변수에서 위치 ID 읽기
const BUNJANG_WAREHOUSE_GID = process.env.SHOPIFY_DEFAULT_LOCATION_ID;
const BUNJANG_WAREHOUSE_ID = BUNJANG_WAREHOUSE_GID?.split('/').pop() || BUNJANG_WAREHOUSE_GID;

// 환경변수 값 확인 로깅
logger.info(`[InventorySvc] Using location from environment: ${BUNJANG_WAREHOUSE_GID}`);
logger.info(`[InventorySvc] Location ID (numeric): ${BUNJANG_WAREHOUSE_ID}`);

/**
 * 번개장터 재고를 Shopify로 동기화
 * @param {string} bunjangPid - 번개장터 상품 ID
 * @param {number} quantity - 재고 수량
 * @returns {Promise<boolean>} 동기화 성공 여부
 */
async function syncBunjangInventoryToShopify(bunjangPid, quantity) {
  try {
    logger.info(`[InventorySvc] Syncing inventory for Bunjang PID ${bunjangPid}: ${quantity} units to location ${BUNJANG_WAREHOUSE_GID}`);
    
    // DB에서 연결된 Shopify 상품 찾기
    const syncedProduct = await SyncedProduct.findOne({ bunjangPid }).lean();
    if (!syncedProduct || !syncedProduct.shopifyGid) {
      logger.warn(`[InventorySvc] No Shopify product found for Bunjang PID ${bunjangPid}`);
      return false;
    }
    
    // Shopify 상품의 variant 정보 가져오기
    const query = `
      query getProductVariants($id: ID!) {
        product(id: $id) {
          id
          variants(first: 5) {
            edges {
              node {
                id
                inventoryItem {
                  id
                  inventoryLevels(first: 20) {
                    edges {
                      node {
                        id
                        location {
                          id
                          name
                        }
                        available
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    
    const response = await shopifyService.shopifyGraphqlRequest(query, { id: syncedProduct.shopifyGid });
    const product = response.data?.product;
    
    if (!product || !product.variants.edges.length) {
      logger.error(`[InventorySvc] No variants found for Shopify product ${syncedProduct.shopifyGid}`);
      return false;
    }
    
    // 첫 번째 variant의 inventory item ID 가져오기
    const inventoryItemId = product.variants.edges[0].node.inventoryItem?.id;
    if (!inventoryItemId) {
      logger.error(`[InventorySvc] No inventory item found for product ${syncedProduct.shopifyGid}`);
      return false;
    }
    
    // 재고 업데이트 - 환경변수의 위치 사용
    await shopifyService.updateInventoryLevel(inventoryItemId, BUNJANG_WAREHOUSE_GID, quantity);
    
    // DB 업데이트
    await SyncedProduct.updateOne(
      { bunjangPid },
      {
        $set: {
          bunjangQuantity: quantity,
          lastInventorySyncAt: new Date()
        }
      }
    );
    
    logger.info(`[InventorySvc] Successfully updated inventory for PID ${bunjangPid} to ${quantity} units at location ${BUNJANG_WAREHOUSE_GID}`);
    return true;
    
  } catch (error) {
    logger.error(`[InventorySvc] Failed to sync inventory for PID ${bunjangPid}:`, error);
    throw error;
  }
}

/**
 * 상품의 판매 상태를 확인하고 적절한 처리를 수행합니다.
 * @param {string} bunjangPid - 번개장터 상품 ID
 * @param {string} shopifyGid - Shopify 상품 GID
 * @param {string} soldFrom - 판매 출처 ('bunjang' | 'shopify' | 'both')
 * @returns {Promise<object>} 처리 결과
 */
async function handleProductSoldStatus(bunjangPid, shopifyGid, soldFrom) {
  try {
    logger.info(`[InventorySvc] Handling sold status for PID ${bunjangPid}, sold from: ${soldFrom}`);
    
    const result = {
      action: null,
      success: false,
      message: ''
    };
    
    // DB에서 상품 정보 가져오기
    const syncedProduct = await SyncedProduct.findOne({ bunjangPid });
    if (!syncedProduct) {
      logger.error(`[InventorySvc] Product not found in DB: PID ${bunjangPid}`);
      return result;
    }
    
    // 판매 출처별 처리
    switch (soldFrom) {
      case 'both':
        // Shopify와 번개장터 둘 다에서 팔린 경우: SOLD OUT으로 표기
        logger.info(`[InventorySvc] Product sold on both platforms. Marking as SOLD OUT.`);
        
        // 상품 상태를 SOLD OUT으로 업데이트
        await markProductAsSoldOut(shopifyGid, bunjangPid);
        
        // DB 업데이트
        syncedProduct.shopifyStatus = 'SOLD_OUT';
        syncedProduct.soldFrom = 'both';
        syncedProduct.soldAt = new Date();
        await syncedProduct.save();
        
        result.action = 'marked_sold_out';
        result.success = true;
        result.message = 'Product marked as SOLD OUT (sold on both platforms)';
        break;
        
      case 'bunjang':
        // 번개장터에서만 팔린 경우: DRAFT 상태로 변경
        logger.info(`[InventorySvc] Product sold only on Bunjang. Marking as DRAFT.`);
        
        // 상품 상태를 DRAFT로 변경하고 번개장터 판매 표시
        await markProductAsDraft(shopifyGid, bunjangPid, 'bunjang');
        
        // DB 업데이트
        syncedProduct.shopifyStatus = 'DRAFT';
        syncedProduct.soldFrom = 'bunjang';
        syncedProduct.soldAt = new Date();
        syncedProduct.bunjangSoldAt = new Date();
        await syncedProduct.save();
        
        result.action = 'marked_draft_bunjang';
        result.success = true;
        result.message = 'Product marked as DRAFT (sold only on Bunjang)';
        break;
        
      case 'shopify':
        // Shopify에서만 팔린 경우: 번개장터 주문 생성 대기
        logger.info(`[InventorySvc] Product sold on Shopify. Waiting for Bunjang order creation.`);
        
        // 재고를 0으로 설정하지만 삭제하지 않음
        await syncBunjangInventoryToShopify(bunjangPid, 0);
        
        // DB 업데이트
        syncedProduct.pendingBunjangOrder = true;
        syncedProduct.shopifySoldAt = new Date();
        await syncedProduct.save();
        
        result.action = 'pending_bunjang_order';
        result.success = true;
        result.message = 'Waiting for Bunjang order creation';
        break;
        
      default:
        logger.error(`[InventorySvc] Unknown soldFrom value: ${soldFrom}`);
        result.message = 'Unknown sold source';
    }
    
    return result;
    
  } catch (error) {
    logger.error(`[InventorySvc] Failed to handle sold status:`, error);
    throw error;
  }
}

/**
 * 상품을 DRAFT 상태로 변경합니다.
 * @param {string} shopifyGid - Shopify 상품 GID
 * @param {string} bunjangPid - 번개장터 상품 ID
 * @param {string} platform - 판매 플랫폼 ('bunjang' 또는 'shopify')
 */
async function markProductAsDraft(shopifyGid, bunjangPid, platform) {
  try {
    // 1. 재고를 0으로 설정
    await syncBunjangInventoryToShopify(bunjangPid, 0);
    
    // 2. 상품 정보 가져오기
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
    
    const response = await shopifyService.shopifyGraphqlRequest(query, { id: shopifyGid });
    const product = response.data?.product;
    
    if (product) {
      let newTitle = product.title;
      let tags = product.tags || [];
      
      // 플랫폼별 제목 처리
      if (platform === 'bunjang' && !newTitle.includes('[번개장터 판매완료]')) {
        newTitle = `[번개장터 판매완료] ${newTitle}`;
        tags.push('sold_bunjang_only');
      }
      
      // 상품 업데이트
      const updateInput = {
        id: shopifyGid,
        title: newTitle,
        status: 'DRAFT', // 상품을 비활성화
        tags: [...new Set(tags)] // 중복 제거
      };
      
      await shopifyService.updateProduct(updateInput);
      logger.info(`[InventorySvc] Product marked as DRAFT (${platform} sale): ${newTitle}`);
    }
    
  } catch (error) {
    logger.error(`[InventorySvc] Failed to mark product as DRAFT:`, error);
    throw error;
  }
}

/**
 * 상품을 SOLD OUT으로 표기합니다.
 * @param {string} shopifyGid - Shopify 상품 GID
 * @param {string} bunjangPid - 번개장터 상품 ID
 */
async function markProductAsSoldOut(shopifyGid, bunjangPid) {
  try {
    // 1. 재고를 0으로 설정
    await syncBunjangInventoryToShopify(bunjangPid, 0);
    
    // 2. 상품 제목에 [SOLD OUT] 추가
    const query = `
      query getProduct($id: ID!) {
        product(id: $id) {
          id
          title
          status
        }
      }
    `;
    
    const response = await shopifyService.shopifyGraphqlRequest(query, { id: shopifyGid });
    const product = response.data?.product;
    
    if (product) {
      let newTitle = product.title;
      if (!newTitle.includes('[SOLD OUT]')) {
        newTitle = `[SOLD OUT] ${newTitle}`;
      }
      
      // 상품 업데이트
      const updateInput = {
        id: shopifyGid,
        title: newTitle,
        status: 'DRAFT', // 상품을 비활성화
        tags: ['sold_out', 'sold_both_platforms']
      };
      
      await shopifyService.updateProduct(updateInput);
      logger.info(`[InventorySvc] Product marked as SOLD OUT: ${newTitle}`);
    }
    
  } catch (error) {
    logger.error(`[InventorySvc] Failed to mark product as sold out:`, error);
    throw error;
  }
}

/**
 * 주문 완료 후 상품 판매 상태를 처리합니다.
 * @param {string} bunjangPid - 번개장터 상품 ID
 * @param {boolean} bunjangOrderCreated - 번개장터 주문 생성 여부
 * @returns {Promise<object>} 처리 결과
 */
async function processOrderCompletion(bunjangPid, bunjangOrderCreated) {
  try {
    logger.info(`[InventorySvc] Processing order completion for PID ${bunjangPid}, Bunjang order created: ${bunjangOrderCreated}`);
    
    const syncedProduct = await SyncedProduct.findOne({ bunjangPid });
    if (!syncedProduct) {
      logger.error(`[InventorySvc] Product not found: PID ${bunjangPid}`);
      return { success: false, message: 'Product not found' };
    }
    
    // 판매 출처 결정
    let soldFrom = 'shopify';
    if (bunjangOrderCreated) {
      soldFrom = 'both';
    } else if (syncedProduct.bunjangSoldAt) {
      // 이미 번개장터에서 팔린 경우
      soldFrom = 'bunjang';
    }
    
    // 판매 상태 처리
    return await handleProductSoldStatus(bunjangPid, syncedProduct.shopifyGid, soldFrom);
    
  } catch (error) {
    logger.error(`[InventorySvc] Failed to process order completion:`, error);
    throw error;
  }
}

/**
 * 번개장터 재고 확인 및 동기화
 * @param {string} bunjangPid - 번개장터 상품 ID
 * @returns {Promise<number>} 현재 재고 수량
 */
async function checkAndSyncBunjangInventory(bunjangPid) {
  try {
    // 번개장터는 단일 재고 시스템이므로 항상 1 또는 0
    const productDetails = await bunjangService.getBunjangProductDetails(bunjangPid);
    
    if (!productDetails) {
      logger.warn(`[InventorySvc] Could not fetch Bunjang product details for PID ${bunjangPid}`);
      return -1;
    }
    
    // 상품이 판매 가능한 상태인지 확인
    const isAvailable = productDetails.status === 'SELLING' && productDetails.quantity > 0;
    const currentStock = isAvailable ? 1 : 0;
    
    logger.info(`[InventorySvc] Bunjang PID ${bunjangPid} stock: ${currentStock}`);
    
    // Shopify 재고 동기화
    const synced = await syncBunjangInventoryToShopify(bunjangPid, currentStock);
    
    if (synced) {
      logger.info(`[InventorySvc] Successfully synced inventory for PID ${bunjangPid}`);
    }
    
    return currentStock;
    
  } catch (error) {
    logger.error(`[InventorySvc] Failed to check Bunjang inventory for PID ${bunjangPid}:`, error);
    return -1;
  }
}

/**
 * 배치로 여러 상품의 재고를 동기화
 * @param {Array<string>} bunjangPids - 번개장터 상품 ID 배열
 * @returns {Promise<object>} 동기화 결과
 */
async function batchSyncInventory(bunjangPids) {
  const results = {
    success: 0,
    failed: 0,
    errors: []
  };
  
  logger.info(`[InventorySvc] Starting batch inventory sync for ${bunjangPids.length} products`);
  
  for (const pid of bunjangPids) {
    try {
      const stock = await checkAndSyncBunjangInventory(pid);
      if (stock >= 0) {
        results.success++;
      } else {
        results.failed++;
        results.errors.push({ pid, error: 'Could not fetch stock' });
      }
    } catch (error) {
      results.failed++;
      results.errors.push({ pid, error: error.message });
      logger.error(`[InventorySvc] Failed to sync inventory for PID ${pid}:`, error.message);
    }
    
    // Rate limiting - 3개마다 1초 대기
    if ((results.success + results.failed) % 3 === 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  logger.info(`[InventorySvc] Batch inventory sync completed:`, {
    total: bunjangPids.length,
    success: results.success,
    failed: results.failed
  });
  
  return results;
}

/**
 * 재고가 낮은 상품들을 확인합니다.
 * @param {number} threshold - 재고 임계값 (번개장터는 단일 재고이므로 의미 없음)
 * @returns {Promise<Array>} 낮은 재고 상품 목록
 */
async function checkLowStockProducts(threshold = 1) {
  try {
    // 번개장터는 단일 재고 시스템이므로 재고가 0인 상품만 확인
    const syncedProducts = await SyncedProduct.find({
      syncStatus: 'SYNCED',
      bunjangQuantity: { $eq: 0 }
    }).lean();
    
    logger.info(`[InventorySvc] Found ${syncedProducts.length} products with zero stock`);
    
    return syncedProducts;
    
  } catch (error) {
    logger.error(`[InventorySvc] Failed to check low stock products:`, error);
    throw error;
  }
}

/**
 * 낮은 재고 상품에 대한 알림을 발송합니다.
 * @param {Array} lowStockProducts - 낮은 재고 상품 목록
 */
async function sendLowStockNotification(lowStockProducts) {
  try {
    if (!lowStockProducts.length) return;
    
    // TODO: 이메일, Slack 등 알림 서비스 구현
    logger.warn(`[InventorySvc] Low stock alert: ${lowStockProducts.length} products have zero inventory`);
    
    lowStockProducts.forEach(product => {
      logger.warn(`[InventorySvc] Out of stock: ${product.bunjangProductName} (PID: ${product.bunjangPid})`);
    });
    
  } catch (error) {
    logger.error(`[InventorySvc] Failed to send low stock notification:`, error);
  }
}

/**
 * 전체 재고 동기화를 수행합니다.
 * @param {string} [jobId='MANUAL'] - 작업 ID
 * @returns {Promise<object>} 동기화 결과
 */
async function performFullInventorySync(jobId = 'MANUAL') {
  logger.info(`[InventorySvc:Job-${jobId}] Starting full inventory sync for location ${BUNJANG_WAREHOUSE_GID}`);
  
  const startTime = Date.now();
  const results = {
    totalProducts: 0,
    synced: 0,
    failed: 0,
    skipped: 0,
    deleted: 0,
    outOfStock: []
  };
  
  try {
    // 동기화된 모든 상품 조회
    const syncedProducts = await SyncedProduct.find({
      syncStatus: 'SYNCED',
      bunjangPid: { $exists: true }
    }).limit(1000).lean(); // 한 번에 최대 1000개 처리
    
    results.totalProducts = syncedProducts.length;
    
    logger.info(`[InventorySvc:Job-${jobId}] Found ${results.totalProducts} products to sync`);
    
    // 각 상품의 재고를 1로 설정
    for (const product of syncedProducts) {
      try {
        // 번개장터 상품은 항상 재고 1 (단일 재고)
        const success = await syncBunjangInventoryToShopify(product.bunjangPid, 1);
        
        if (success) {
          results.synced++;
        } else {
          results.skipped++;
        }
        
      } catch (error) {
        results.failed++;
        logger.error(`[InventorySvc:Job-${jobId}] Failed to sync inventory for PID ${product.bunjangPid}:`, error.message);
      }
      
      // Rate limiting - 2개 상품마다 1초 대기
      if (results.synced % 2 === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // 진행 상황 로깅 (100개마다)
      if ((results.synced + results.failed + results.skipped) % 100 === 0) {
        logger.info(`[InventorySvc:Job-${jobId}] Progress: ${results.synced + results.failed + results.skipped}/${results.totalProducts}`);
      }
    }
    
    const duration = Date.now() - startTime;
    logger.info(`[InventorySvc:Job-${jobId}] Full inventory sync completed in ${duration}ms at location ${BUNJANG_WAREHOUSE_GID}:`, {
      location: BUNJANG_WAREHOUSE_GID,
      total: results.totalProducts,
      synced: results.synced,
      failed: results.failed,
      skipped: results.skipped,
      durationSeconds: Math.round(duration / 1000)
    });
    
    return results;
    
  } catch (error) {
    logger.error(`[InventorySvc:Job-${jobId}] Full inventory sync failed:`, error);
    throw error;
  }
}

/**
 * 재고가 0이 되었을 때 상품을 삭제합니다.
 * 번개장터는 단일 재고이므로 이 함수는 사용하지 않습니다.
 * @param {string} bunjangPid - 번개장터 상품 ID
 * @param {string} shopifyGid - Shopify 상품 GID
 * @returns {Promise<boolean>} 삭제 성공 여부
 */
async function deleteProductIfOutOfStock(bunjangPid, shopifyGid) {
  try {
    logger.info(`[InventorySvc] Product deletion skipped. Bunjang single-stock items should always have inventory 1. PID: ${bunjangPid}`);
    
    // 삭제 대신 재고를 1로 유지
    await syncBunjangInventoryToShopify(bunjangPid, 1);
    
    return false; // 삭제하지 않음
    
  } catch (error) {
    logger.error(`[InventorySvc] Failed to handle out-of-stock product PID ${bunjangPid}:`, error);
    throw error;
  }
}

/**
 * 주문 처리 후 재고 업데이트
 * 번개장터 상품은 단일 재고이므로 주문 후에도 재고를 1로 유지합니다.
 * @param {string} bunjangPid - 번개장터 상품 ID
 * @param {number} orderedQuantity - 주문 수량
 * @returns {Promise<boolean>} 처리 성공 여부
 */
async function processOrderInventoryUpdate(bunjangPid, orderedQuantity = 1) {
  try {
    logger.info(`[InventorySvc] Processing order for PID ${bunjangPid}, maintaining inventory at 1 at location ${BUNJANG_WAREHOUSE_GID}`);
    
    // 번개장터는 단일 재고이므로 주문 후에도 재고를 1로 유지
    await syncBunjangInventoryToShopify(bunjangPid, 1);
    
    logger.info(`[InventorySvc] Inventory maintained at 1 for PID ${bunjangPid} after order at location ${BUNJANG_WAREHOUSE_GID}`);
    
    return true;
    
  } catch (error) {
    logger.error(`[InventorySvc] Failed to process order inventory update for PID ${bunjangPid}:`, error);
    throw error;
  }
}

/**
 * 특정 위치의 재고 레벨을 확인합니다.
 * @param {string} inventoryItemId - 재고 아이템 ID
 * @param {string} locationId - 위치 ID
 * @returns {Promise<number>} 현재 재고 수량
 */
async function getInventoryLevelAtLocation(inventoryItemId, locationId = BUNJANG_WAREHOUSE_GID) {
  try {
    const query = `
      query getInventoryLevel($itemId: ID!) {
        inventoryItem(id: $itemId) {
          id
          inventoryLevels(first: 20) {
            edges {
              node {
                id
                location {
                  id
                  name
                }
                available
              }
            }
          }
        }
      }`;
    
    const response = await shopifyService.shopifyGraphqlRequest(query, { itemId: inventoryItemId });
    const levels = response.data?.inventoryItem?.inventoryLevels?.edges || [];
    
    const targetLevel = levels.find(edge => edge.node.location.id === locationId);
    
    if (targetLevel) {
      logger.info(`[InventorySvc] Inventory at location ${targetLevel.node.location.name}: ${targetLevel.node.available} units`);
      return targetLevel.node.available;
    }
    
    logger.warn(`[InventorySvc] No inventory level found for location ${locationId}`);
    return 0;
    
  } catch (error) {
    logger.error(`[InventorySvc] Failed to get inventory level:`, error);
    throw error;
  }
}

/**
 * 재고 동기화 상태를 확인합니다.
 * @returns {Promise<object>} 동기화 상태 정보
 */
async function getInventorySyncStatus() {
  try {
    const stats = await SyncedProduct.aggregate([
      {
        $match: { syncStatus: 'SYNCED' }
      },
      {
        $group: {
          _id: null,
          totalProducts: { $sum: 1 },
          productsWithZeroStock: {
            $sum: { $cond: [{ $eq: ['$bunjangQuantity', 0] }, 1, 0] }
          },
          lastSyncTime: { $max: '$lastInventorySyncAt' }
        }
      }
    ]);
    
    const result = stats[0] || { totalProducts: 0, productsWithZeroStock: 0, lastSyncTime: null };
    
    logger.info(`[InventorySvc] Inventory sync status:`, {
      totalProducts: result.totalProducts,
      productsWithZeroStock: result.productsWithZeroStock,
      lastSyncTime: result.lastSyncTime
    });
    
    return {
      totalProducts: result.totalProducts,
      productsWithZeroStock: result.productsWithZeroStock,
      lastSyncTime: result.lastSyncTime,
      location: BUNJANG_WAREHOUSE_GID
    };
    
  } catch (error) {
    logger.error(`[InventorySvc] Failed to get inventory sync status:`, error);
    throw error;
  }
}

module.exports = {
  syncBunjangInventoryToShopify,
  batchSyncInventory,
  checkAndSyncBunjangInventory,
  handleProductSoldStatus,
  markProductAsSoldOut,
  markProductAsDraft,
  processOrderCompletion,
  checkLowStockProducts,
  sendLowStockNotification,
  performFullInventorySync,
  deleteProductIfOutOfStock,
  processOrderInventoryUpdate,
  getInventoryLevelAtLocation,
  getInventorySyncStatus,
  BUNJANG_WAREHOUSE_GID,
  BUNJANG_WAREHOUSE_ID
};