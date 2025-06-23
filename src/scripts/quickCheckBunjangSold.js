// src/scripts/quickCheckBunjangSold.js
// 번개장터에서 팔린 상품을 빠르게 확인하고 Shopify를 DRAFT로 변경하는 스크립트

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config');
const logger = require('../config/logger');
const bunjangService = require('../services/bunjangService');
const shopifyService = require('../services/shopifyService');
const inventoryService = require('../services/inventoryService');
const SyncedProduct = require('../models/syncedProduct.model');
const { connectDB, disconnectDB } = require('../config/database');

// 스크립트 설정
const BATCH_SIZE = 10; // 동시에 처리할 상품 수
const DELAY_BETWEEN_BATCHES = 2000; // 배치 간 대기 시간 (ms)
const DRY_RUN = process.argv.includes('--dry-run'); // 실제 변경 없이 확인만
const DELETE_FROM_DB = process.argv.includes('--delete') || process.env.DELETE_SOLD_PRODUCTS === 'true'; // DB에서 삭제 옵션

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkSingleProduct(product) {
  const result = {
    pid: product.bunjangPid,
    title: product.bunjangProductName,
    shopifyGid: product.shopifyGid,
    action: 'no_change',
    error: null,
    isProductNotFound: false  // 404 에러 플래그 추가
  };

  try {
    // 1. 번개장터 상품 상태 확인
    console.log(`Checking PID ${product.bunjangPid}: ${product.bunjangProductName}`);
    
    let bunjangDetails = null;
    let isProductNotFound = false;
    
    try {
      bunjangDetails = await bunjangService.getBunjangProductDetails(product.bunjangPid);
    } catch (error) {
      // 404 에러는 상품이 팔렸거나 삭제된 것으로 간주
      if (error.originalError?.response?.status === 404 || 
          error.message.includes('404') || 
          error.message.includes('Not Found') ||
          error.message.includes('PRODUCT_NOT_FOUND')) {
        console.log(`  ⚠️ Product not found (404) - likely SOLD`);
        isProductNotFound = true;
      } else {
        // 다른 에러는 그대로 throw
        throw error;
      }
    }
    
    // 2. 판매 상태 확인
    let isAvailable = false;
    let currentStatus = 'NOT_FOUND';
    
    if (!isProductNotFound && bunjangDetails) {
      currentStatus = bunjangDetails.status || bunjangDetails.saleStatus || 'UNKNOWN';
      isAvailable = currentStatus === 'SELLING' && (bunjangDetails.quantity || 0) > 0;
      console.log(`  Status: ${currentStatus}, Quantity: ${bunjangDetails.quantity || 0}, Available: ${isAvailable}`);
    } else {
      // 404 에러인 경우 판매 완료로 처리
      currentStatus = 'SOLD_OR_DELETED';
      isAvailable = false;
      console.log(`  Status: ${currentStatus} (404 Error)`);
    }

    // 3. 이미 처리된 상품인지 확인
    if (product.bunjangSoldAt) {
      console.log(`  Already marked as sold at: ${product.bunjangSoldAt}`);
      result.action = 'already_processed';
      return result;
    }

    // 4. 판매된 상품 처리 (404 에러 포함)
    if (!isAvailable || isProductNotFound) {
      if (isProductNotFound) {
        console.log(`  ⚠️ Product not found on Bunjang (404) - treating as SOLD!`);
      } else {
        console.log(`  ⚠️ Product is SOLD on Bunjang!`);
      }
      
      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would mark as DRAFT`);
        result.action = 'would_mark_draft';
        result.isProductNotFound = isProductNotFound;
        return result;
      }

      // 5. Shopify 상품 업데이트
      if (product.shopifyGid) {
        // 제목 업데이트
        let newTitle = product.bunjangProductName;
        if (!newTitle.includes('[번개장터 판매완료]')) {
          newTitle = `[번개장터 판매완료] ${newTitle}`;
        }

        console.log(`  Updating Shopify product to DRAFT...`);
        
        await shopifyService.updateProduct({
          id: product.shopifyGid,
          title: newTitle,
          status: 'DRAFT',
          tags: ['sold_bunjang_only', 'bunjang_sold_auto_check', isProductNotFound ? 'bunjang_404' : 'bunjang_sold']
        });

        // 재고를 0으로 설정
        await inventoryService.syncBunjangInventoryToShopify(product.bunjangPid, 0);

        console.log(`  ✅ Successfully marked as DRAFT`);
        result.action = 'marked_draft';
        result.isProductNotFound = isProductNotFound;
      }

      // 6. DB 업데이트 또는 삭제
      if (DELETE_FROM_DB) {
        // DB에서 삭제
        await SyncedProduct.deleteOne({ _id: product._id });
        console.log(`  ✅ Deleted from database`);
        result.action = 'marked_draft_and_deleted';
      } else {
        // DB 업데이트만
        await SyncedProduct.updateOne(
          { _id: product._id },
          {
            $set: {
              bunjangSoldAt: new Date(),
              soldFrom: 'bunjang',
              shopifyStatus: 'DRAFT',
              bunjangLastStatus: currentStatus,
              lastBunjangStatusCheckAt: new Date(),
              notes: isProductNotFound ? 'Product returned 404 - treated as sold' : null
            }
          }
        );
      }
    } else {
      // 아직 판매 중인 상품
      console.log(`  Still available for sale`);
      
      // 상태만 업데이트
      await SyncedProduct.updateOne(
        { _id: product._id },
        {
          $set: {
            bunjangLastStatus: currentStatus,
            lastBunjangStatusCheckAt: new Date(),
            bunjangQuantity: bunjangDetails.quantity || 1
          }
        }
      );
    }

  } catch (error) {
    console.error(`  ❌ Error: ${error.message}`);
    result.error = error.message;
  }

  return result;
}

async function processBatch(products) {
  const results = await Promise.all(products.map(checkSingleProduct));
  return results;
}

async function main() {
  console.log('=== 번개장터 판매 상품 빠른 체크 스크립트 ===');
  console.log(`실행 시간: ${new Date().toISOString()}`);
  console.log(`DRY RUN 모드: ${DRY_RUN ? 'ON' : 'OFF'}`);
  console.log(`DB 삭제 모드: ${DELETE_FROM_DB ? 'ON' : 'OFF'}`);
  console.log('');

  try {
    // DB 연결
    await connectDB();
    console.log('✅ Database connected');

    // 체크할 상품 조회
    const query = {
      syncStatus: 'SYNCED',
      bunjangPid: { $exists: true },
      shopifyGid: { $exists: true },
      // 아직 번개장터에서 판매되지 않은 상품들
      bunjangSoldAt: { $exists: false },
      // ACTIVE 상태이거나 상태가 없는 상품들
      $or: [
        { shopifyStatus: 'ACTIVE' },
        { shopifyStatus: { $exists: false } },
        { shopifyStatus: null }
      ]
    };

    const totalCount = await SyncedProduct.countDocuments(query);
    console.log(`\n📊 체크할 상품 총 ${totalCount}개\n`);

    if (totalCount === 0) {
      console.log('체크할 상품이 없습니다.');
      return;
    }

    // 통계
    const stats = {
      total: totalCount,
      checked: 0,
      soldOnBunjang: 0,
      notFoundProducts: 0,  // 404 에러 카운트 추가
      markedDraft: 0,
      deletedFromDB: 0,  // DB 삭제 카운트 추가
      alreadyProcessed: 0,
      errors: 0,
      soldProducts: []
    };

    // 배치 처리
    let skip = 0;
    while (skip < totalCount) {
      const products = await SyncedProduct.find(query)
        .skip(skip)
        .limit(BATCH_SIZE)
        .lean();

      if (products.length === 0) break;

      console.log(`\n처리 중: ${skip + 1}-${skip + products.length} / ${totalCount}`);
      console.log('─'.repeat(50));

      const results = await processBatch(products);

      // 결과 집계
      results.forEach(result => {
        stats.checked++;
        
        if (result.error) {
          stats.errors++;
        } else if (result.action === 'marked_draft' || result.action === 'would_mark_draft' || result.action === 'marked_draft_and_deleted') {
          stats.soldOnBunjang++;
          if (result.action === 'marked_draft' || result.action === 'marked_draft_and_deleted') {
            stats.markedDraft++;
            if (result.action === 'marked_draft_and_deleted') {
              stats.deletedFromDB++;
            }
          }
          // 404 에러로 판매 처리된 상품 카운트
          if (result.isProductNotFound) {
            stats.notFoundProducts++;
          }
          stats.soldProducts.push({
            pid: result.pid,
            title: result.title,
            shopifyGid: result.shopifyGid,
            isNotFound: result.isProductNotFound || false
          });
        } else if (result.action === 'already_processed') {
          stats.alreadyProcessed++;
        }
      });

      skip += BATCH_SIZE;

      // 다음 배치 전 대기
      if (skip < totalCount) {
        console.log(`\n다음 배치까지 ${DELAY_BETWEEN_BATCHES}ms 대기...`);
        await sleep(DELAY_BETWEEN_BATCHES);
      }
    }

    // 최종 결과 출력
    console.log('\n' + '='.repeat(60));
    console.log('📊 최종 결과:');
    console.log('='.repeat(60));
    console.log(`총 체크한 상품: ${stats.checked}개`);
    console.log(`번개장터에서 판매된 상품: ${stats.soldOnBunjang}개`);
    console.log(`  - 404 에러 (삭제/판매): ${stats.notFoundProducts}개`);
    console.log(`  - 정상 조회 후 판매 확인: ${stats.soldOnBunjang - stats.notFoundProducts}개`);
    console.log(`DRAFT로 변경된 상품: ${stats.markedDraft}개`);
    console.log(`DB에서 삭제된 상품: ${stats.deletedFromDB}개`);
    console.log(`이미 처리된 상품: ${stats.alreadyProcessed}개`);
    console.log(`에러 발생: ${stats.errors}개`);

    if (stats.soldProducts.length > 0) {
      console.log('\n🛍️ 번개장터에서 판매된 상품 목록:');
      console.log('─'.repeat(60));
      stats.soldProducts.forEach((product, index) => {
        console.log(`${index + 1}. PID: ${product.pid} ${product.isNotFound ? '[404]' : ''}`);
        console.log(`   제목: ${product.title}`);
        console.log(`   Shopify: ${product.shopifyGid}`);
        console.log('');
      });
    }

    if (DRY_RUN) {
      console.log('\n⚠️  DRY RUN 모드로 실행되어 실제 변경은 적용되지 않았습니다.');
      console.log('실제로 적용하려면 --dry-run 옵션 없이 다시 실행하세요.');
    }

  } catch (error) {
    console.error('\n❌ 스크립트 실행 중 에러 발생:', error);
  } finally {
    // DB 연결 종료
    await disconnectDB();
    console.log('\n✅ Database disconnected');
    console.log('\n스크립트 종료');
    process.exit(0);
  }
}

// 스크립트 실행
if (require.main === module) {
  main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

module.exports = { checkSingleProduct, processBatch };
