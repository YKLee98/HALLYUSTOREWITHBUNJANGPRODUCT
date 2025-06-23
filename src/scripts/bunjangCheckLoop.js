// src/scripts/bunjangCheckLoop.js
// 백그라운드에서 계속 실행되는 간단한 스크립트 (DB 삭제 기능 포함)

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config');
const logger = require('../config/logger');
const bunjangService = require('../services/bunjangService');
const shopifyService = require('../services/shopifyService');
const inventoryService = require('../services/inventoryService');
const SyncedProduct = require('../models/syncedProduct.model');
const { connectDB } = require('../config/database');

// 설정
const CHECK_INTERVAL = 2 * 60 * 60 * 1000; // 2시간
const BATCH_SIZE = 10;
const DELAY_BETWEEN_BATCHES = 2000;
const DELETE_AFTER_DRAFT = process.env.DELETE_SOLD_PRODUCTS === 'true' || true; // 기본값 true

// 로그 함수
function log(message, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, data);
  logger.info(message, data);
}

// 단일 상품 체크 및 처리
async function checkAndProcessProduct(product) {
  const result = {
    pid: product.bunjangPid,
    title: product.bunjangProductName,
    action: 'no_change',
    deleted: false
  };

  try {
    // 번개장터 상태 확인
    let isAvailable = false;
    let currentStatus = 'UNKNOWN';
    
    try {
      const bunjangDetails = await bunjangService.getBunjangProductDetails(product.bunjangPid);
      if (bunjangDetails) {
        currentStatus = bunjangDetails.status || bunjangDetails.saleStatus;
        isAvailable = currentStatus === 'SELLING' && (bunjangDetails.quantity || 0) > 0;
      }
    } catch (error) {
      // 404 에러는 판매 완료로 처리
      if (error.originalError?.response?.status === 404 || 
          error.message.includes('404') || 
          error.message.includes('Not Found')) {
        currentStatus = 'SOLD_OR_DELETED';
        isAvailable = false;
      } else {
        throw error;
      }
    }

    // 이미 처리된 상품 스킵
    if (product.bunjangSoldAt) {
      result.action = 'already_processed';
      return result;
    }

    // 판매된 상품 처리
    if (!isAvailable) {
      log(`Product sold on Bunjang: ${product.bunjangPid} - ${product.bunjangProductName}`);
      
      // Shopify DRAFT로 변경
      if (product.shopifyGid) {
        let newTitle = product.bunjangProductName;
        if (!newTitle.includes('[번개장터 판매완료]')) {
          newTitle = `[번개장터 판매완료] ${newTitle}`;
        }

        await shopifyService.updateProduct({
          id: product.shopifyGid,
          title: newTitle,
          status: 'DRAFT',
          tags: ['sold_bunjang_only', 'bunjang_sold_auto_check']
        });

        await inventoryService.syncBunjangInventoryToShopify(product.bunjangPid, 0);
        
        log(`Updated to DRAFT: ${product.shopifyGid}`);
        result.action = 'marked_draft';
      }

      // DB에서 삭제
      if (DELETE_AFTER_DRAFT) {
        await SyncedProduct.deleteOne({ _id: product._id });
        log(`Deleted from DB: ${product.bunjangPid}`);
        result.deleted = true;
      } else {
        // 삭제하지 않고 상태만 업데이트
        await SyncedProduct.updateOne(
          { _id: product._id },
          {
            $set: {
              bunjangSoldAt: new Date(),
              soldFrom: 'bunjang',
              shopifyStatus: 'DRAFT',
              bunjangLastStatus: currentStatus,
              lastBunjangStatusCheckAt: new Date()
            }
          }
        );
      }
    } else {
      // 아직 판매 중인 상품 - 상태만 업데이트
      await SyncedProduct.updateOne(
        { _id: product._id },
        {
          $set: {
            bunjangLastStatus: currentStatus,
            lastBunjangStatusCheckAt: new Date(),
            bunjangQuantity: 1
          }
        }
      );
    }

  } catch (error) {
    log(`Error processing product ${product.bunjangPid}: ${error.message}`);
    result.error = error.message;
  }

  return result;
}

// 메인 체크 함수
async function runCheck() {
  log('=== Starting Bunjang sold products check ===');
  
  const stats = {
    total: 0,
    checked: 0,
    soldOnBunjang: 0,
    markedDraft: 0,
    deleted: 0,
    errors: 0
  };

  try {
    // 체크할 상품 조회
    const query = {
      syncStatus: 'SYNCED',
      bunjangPid: { $exists: true },
      shopifyGid: { $exists: true },
      bunjangSoldAt: { $exists: false },
      $or: [
        { shopifyStatus: 'ACTIVE' },
        { shopifyStatus: { $exists: false } },
        { shopifyStatus: null }
      ]
    };

    stats.total = await SyncedProduct.countDocuments(query);
    log(`Found ${stats.total} products to check`);

    if (stats.total === 0) {
      log('No products to check');
      return stats;
    }

    // 배치 처리
    let skip = 0;
    while (skip < stats.total) {
      const products = await SyncedProduct.find(query)
        .skip(skip)
        .limit(BATCH_SIZE)
        .lean();

      if (products.length === 0) break;

      log(`Processing batch: ${skip + 1}-${skip + products.length} / ${stats.total}`);

      // 동시 처리
      const results = await Promise.all(
        products.map(product => checkAndProcessProduct(product))
      );

      // 결과 집계
      results.forEach(result => {
        stats.checked++;
        if (result.error) {
          stats.errors++;
        } else if (result.action === 'marked_draft') {
          stats.soldOnBunjang++;
          stats.markedDraft++;
          if (result.deleted) {
            stats.deleted++;
          }
        }
      });

      skip += BATCH_SIZE;

      // Rate limiting
      if (skip < stats.total) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
      }
    }

    log('=== Check completed ===', stats);
    return stats;

  } catch (error) {
    log('Check failed with error:', { error: error.message });
    throw error;
  }
}

// 메인 루프
async function main() {
  log('🚀 Bunjang Check Loop Started');
  log(`Check interval: ${CHECK_INTERVAL / 1000 / 60} minutes`);
  log(`Delete after DRAFT: ${DELETE_AFTER_DRAFT}`);

  try {
    // DB 연결
    await connectDB();
    log('✅ Database connected');

    // 첫 실행
    log('Running initial check in 5 seconds...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    try {
      await runCheck();
    } catch (error) {
      log('Initial check failed:', { error: error.message });
    }

    // 정기 실행
    log(`Setting up interval check every ${CHECK_INTERVAL / 1000 / 60} minutes`);
    
    setInterval(async () => {
      log('Running scheduled check...');
      try {
        await runCheck();
      } catch (error) {
        log('Scheduled check failed:', { error: error.message });
      }
    }, CHECK_INTERVAL);

    // 프로세스 유지
    log('Process will continue running. Press Ctrl+C to stop.');
    
  } catch (error) {
    log('Failed to start:', { error: error.message });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  log('SIGINT received, shutting down...');
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log('SIGTERM received, shutting down...');
  await mongoose.connection.close();
  process.exit(0);
});

// 에러 핸들링
process.on('uncaughtException', (error) => {
  log('Uncaught Exception:', { error: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason, promise) => {
  log('Unhandled Rejection:', { reason, promise });
});

// 실행
if (require.main === module) {
  main().catch(error => {
    log('Fatal error:', { error: error.message });
    process.exit(1);
  });
}

module.exports = { runCheck };
