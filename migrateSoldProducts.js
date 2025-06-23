// migrateSoldProducts.js
// 번개장터 연동 상품(bunjang_import 태그 또는 BunJang Warehouse 위치)만 DRAFT로 변경하는 스크립트

const mongoose = require('mongoose');
const config = require('./src/config');
const SyncedProduct = require('./src/models/syncedProduct.model');
const inventoryService = require('./src/services/inventoryService');
const shopifyService = require('./src/services/shopifyService');
const logger = require('./src/config/logger');

// BunJang Warehouse 위치 ID
const BUNJANG_WAREHOUSE_GID = process.env.SHOPIFY_DEFAULT_LOCATION_ID

async function migrateSoldProducts() {
  try {
    console.log('🔄 번개장터 연동 판매 완료 상품 마이그레이션 시작...\n');
    
    // MongoDB 연결
    await mongoose.connect(config.database.connectionString, config.database.options);
    console.log('✅ MongoDB 연결 성공\n');
    
    // 1. 번개장터에서만 팔린 상품 찾기 (아직 DRAFT가 아닌 것들)
    console.log('1️⃣ 번개장터 판매 상품 확인...');
    const bunjangSoldProducts = await SyncedProduct.find({
      soldFrom: 'bunjang',
      shopifyStatus: { $ne: 'DRAFT' }
    });
    
    console.log(`   - 발견된 번개장터 판매 상품: ${bunjangSoldProducts.length}개`);
    
    // 2. 각 상품의 Shopify 정보 확인 후 필터링
    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;
    
    for (const product of bunjangSoldProducts) {
      try {
        console.log(`\n   처리 중: ${product.bunjangProductName} (PID: ${product.bunjangPid})`);
        
        // Shopify 상품 정보 가져오기 (태그와 재고 위치 확인)
        const query = `
          query getProductDetails($id: ID!) {
            product(id: $id) {
              id
              title
              status
              tags
              variants(first: 5) {
                edges {
                  node {
                    id
                    inventoryItem {
                      id
                      inventoryLevels(first: 10) {
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
        
        try {
          const response = await shopifyService.shopifyGraphqlRequest(query, { id: product.shopifyGid });
          
          if (response.data?.product) {
            const shopifyProduct = response.data.product;
            
            // 필터링 조건 확인
            const hasBunjangImportTag = shopifyProduct.tags.includes('bunjang_import');
            let hasBunjangWarehouseLocation = false;
            
            // 재고 위치 확인
            for (const variantEdge of shopifyProduct.variants.edges || []) {
              const inventoryLevels = variantEdge.node.inventoryItem?.inventoryLevels?.edges || [];
              for (const levelEdge of inventoryLevels) {
                if (levelEdge.node.location.id === BUNJANG_WAREHOUSE_GID) {
                  hasBunjangWarehouseLocation = true;
                  break;
                }
              }
              if (hasBunjangWarehouseLocation) break;
            }
            
            // 조건에 맞지 않으면 스킵
            if (!hasBunjangImportTag && !hasBunjangWarehouseLocation) {
              console.log(`   ⏭️  스킵: bunjang_import 태그 없음 & BunJang Warehouse 위치 아님`);
              console.log(`      - 태그: ${shopifyProduct.tags.join(', ')}`);
              skippedCount++;
              continue;
            }
            
            console.log(`   ✅ 조건 충족:`);
            console.log(`      - bunjang_import 태그: ${hasBunjangImportTag ? '있음' : '없음'}`);
            console.log(`      - BunJang Warehouse 위치: ${hasBunjangWarehouseLocation ? '있음' : '없음'}`);
            
            // 상품이 조건을 충족하면 DRAFT로 변경
            await inventoryService.markProductAsDraft(
              product.shopifyGid,
              product.bunjangPid,
              'bunjang'
            );
            
            // DB 업데이트
            product.shopifyStatus = 'DRAFT';
            if (!product.bunjangSoldAt && product.soldAt) {
              product.bunjangSoldAt = product.soldAt;
            }
            await product.save();
            
            console.log(`   ✅ DRAFT로 변경 완료`);
            successCount++;
            
          } else {
            console.log(`   ⚠️ Shopify 상품을 찾을 수 없음 (이미 삭제됨)`);
            failCount++;
          }
        } catch (shopifyError) {
          console.log(`   ❌ Shopify 오류: ${shopifyError.message}`);
          failCount++;
        }
        
      } catch (error) {
        console.error(`   ❌ 처리 실패: ${error.message}`);
        failCount++;
      }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 마이그레이션 결과:');
    console.log(`   - 성공: ${successCount}개`);
    console.log(`   - 스킵: ${skippedCount}개 (조건 미충족)`);
    console.log(`   - 실패: ${failCount}개`);
    console.log(`   - 전체: ${bunjangSoldProducts.length}개`);
    console.log('='.repeat(60));
    
    // 3. 현재 상태 요약
    console.log('\n📈 현재 판매 완료 상품 현황:');
    
    const stats = {
      bunjangDraft: await SyncedProduct.countDocuments({ soldFrom: 'bunjang', shopifyStatus: 'DRAFT' }),
      bothSoldOut: await SyncedProduct.countDocuments({ soldFrom: 'both', shopifyStatus: 'SOLD_OUT' }),
      bothDraft: await SyncedProduct.countDocuments({ soldFrom: 'both', shopifyStatus: 'DRAFT' }),
      pendingOrders: await SyncedProduct.countDocuments({ pendingBunjangOrder: true })
    };
    
    console.log(`   - 번개장터 판매 (DRAFT): ${stats.bunjangDraft}개`);
    console.log(`   - 두 플랫폼 판매 (SOLD OUT): ${stats.bothSoldOut}개`);
    console.log(`   - 두 플랫폼 판매 (DRAFT): ${stats.bothDraft}개`);
    console.log(`   - 번개장터 주문 대기 중: ${stats.pendingOrders}개`);
    
    // 4. 추가 정보: 번개장터 연동 상품 통계
    console.log('\n📊 번개장터 연동 상품 통계:');
    
    // 모든 동기화된 상품 중 조건 확인
    const allSyncedProducts = await SyncedProduct.find({
      syncStatus: 'SYNCED',
      shopifyGid: { $exists: true }
    }).limit(100);
    
    let bunjangImportCount = 0;
    let bunjangWarehouseCount = 0;
    
    for (const product of allSyncedProducts) {
      try {
        const response = await shopifyService.shopifyGraphqlRequest(query, { id: product.shopifyGid });
        if (response.data?.product) {
          const shopifyProduct = response.data.product;
          
          if (shopifyProduct.tags.includes('bunjang_import')) {
            bunjangImportCount++;
          }
          
          for (const variantEdge of shopifyProduct.variants.edges || []) {
            const inventoryLevels = variantEdge.node.inventoryItem?.inventoryLevels?.edges || [];
            for (const levelEdge of inventoryLevels) {
              if (levelEdge.node.location.id === BUNJANG_WAREHOUSE_GID) {
                bunjangWarehouseCount++;
                break;
              }
            }
          }
        }
      } catch (e) {
        // 무시
      }
    }
    
    console.log(`   - bunjang_import 태그 있는 상품: ${bunjangImportCount}개`);
    console.log(`   - BunJang Warehouse 위치 상품: ${bunjangWarehouseCount}개`);
    
  } catch (error) {
    console.error('❌ 마이그레이션 실패:', error);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n✅ 데이터베이스 연결 종료');
  }
}

// 실행 확인
async function confirmAndRun() {
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  console.log('⚠️  경고: 이 스크립트는 번개장터 연동 상품의 판매 완료 상품들을 DRAFT 상태로 변경합니다.');
  console.log('⚠️  대상: bunjang_import 태그가 있거나 BunJang Warehouse 위치인 상품만');
  console.log('⚠️  실행 전에 데이터베이스 백업을 권장합니다.\n');
  
  const answer = await new Promise(resolve => {
    readline.question('계속하시겠습니까? (yes/no): ', answer => {
      readline.close();
      resolve(answer.toLowerCase());
    });
  });
  
  if (answer === 'yes' || answer === 'y') {
    await migrateSoldProducts();
  } else {
    console.log('❌ 마이그레이션이 취소되었습니다.');
  }
}

// 실행
if (require.main === module) {
  confirmAndRun().then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('❌ 스크립트 실행 실패:', err);
    process.exit(1);
  });
}