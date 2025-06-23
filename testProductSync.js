// testProductSync.js
// 상품 동기화 시스템 테스트 스크립트

const mongoose = require('mongoose');
const config = require('./src/config');
const SyncedProduct = require('./src/models/syncedProduct.model');
const inventoryService = require('./src/services/inventoryService');
const logger = require('./src/config/logger');

// 테스트할 상품 정보
const TEST_BUNJANG_PID = '337497237'; // 실제 테스트할 번개장터 상품 ID
const TEST_SHOPIFY_GID = 'gid://shopify/Product/8837903155449'; // 실제 Shopify 상품 GID

async function testProductSync() {
  try {
    console.log('🧪 상품 동기화 시스템 테스트 시작...\n');
    
    // MongoDB 연결
    await mongoose.connect(config.database.connectionString, config.database.options);
    console.log('✅ MongoDB 연결 성공\n');
    
    // 1. 현재 상품 상태 확인
    console.log('1️⃣ 현재 상품 상태 확인');
    let product = await SyncedProduct.findOne({ bunjangPid: TEST_BUNJANG_PID });
    
    if (!product) {
      console.log('❌ 테스트 상품을 찾을 수 없습니다. 먼저 상품을 동기화하세요.');
      return;
    }
    
    console.log(`   - 상품명: ${product.bunjangProductName}`);
    console.log(`   - 현재 상태: ${product.displayStatus}`);
    console.log(`   - 판매 출처: ${product.soldFrom || 'none'}`);
    console.log(`   - Shopify 상태: ${product.shopifyStatus}`);
    console.log();
    
    // 테스트 시나리오 선택
    console.log('2️⃣ 테스트 시나리오 선택:');
    console.log('   1) Shopify에서만 판매');
    console.log('   2) 번개장터에서만 판매');
    console.log('   3) 두 플랫폼 모두에서 판매');
    console.log('   4) 상태 초기화');
    
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    const scenario = await new Promise(resolve => {
      readline.question('\n시나리오 번호를 입력하세요 (1-4): ', answer => {
        readline.close();
        resolve(answer);
      });
    });
    
    console.log();
    
    // 시나리오 실행
    switch (scenario) {
      case '1':
        console.log('3️⃣ Shopify 단독 판매 시뮬레이션');
        await testShopifyOnlySale(product);
        break;
        
      case '2':
        console.log('3️⃣ 번개장터 단독 판매 시뮬레이션');
        await testBunjangOnlySale(product);
        break;
        
      case '3':
        console.log('3️⃣ 두 플랫폼 판매 시뮬레이션');
        await testBothPlatformsSale(product);
        break;
        
      case '4':
        console.log('3️⃣ 상품 상태 초기화');
        await resetProductStatus(product);
        break;
        
      default:
        console.log('❌ 잘못된 선택입니다.');
    }
    
  } catch (error) {
    console.error('❌ 테스트 중 오류 발생:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n✅ 테스트 완료');
  }
}

// Shopify 단독 판매 테스트
async function testShopifyOnlySale(product) {
  console.log('   - Shopify에서 판매 처리 중...');
  
  const result = await inventoryService.handleProductSoldStatus(
    product.bunjangPid,
    product.shopifyGid,
    'shopify'
  );
  
  console.log(`   - 처리 결과: ${result.message}`);
  console.log(`   - 액션: ${result.action}`);
  
  // DB 상태 확인
  const updated = await SyncedProduct.findOne({ bunjangPid: product.bunjangPid });
  console.log(`   - 대기 상태: ${updated.pendingBunjangOrder ? '번개장터 주문 대기 중' : '정상'}`);
}

// 번개장터 단독 판매 테스트
async function testBunjangOnlySale(product) {
  console.log('   - 번개장터에서 판매 처리 중...');
  
  const result = await inventoryService.handleProductSoldStatus(
    product.bunjangPid,
    product.shopifyGid,
    'bunjang'
  );
  
  console.log(`   - 처리 결과: ${result.message}`);
  console.log(`   - 액션: ${result.action}`);
  console.log('   - 상품이 [번개장터 판매완료]로 표시되고 DRAFT 상태가 됩니다.');
}

// 두 플랫폼 판매 테스트
async function testBothPlatformsSale(product) {
  console.log('   - 두 플랫폼에서 판매 처리 중...');
  
  const result = await inventoryService.handleProductSoldStatus(
    product.bunjangPid,
    product.shopifyGid,
    'both'
  );
  
  console.log(`   - 처리 결과: ${result.message}`);
  console.log(`   - 액션: ${result.action}`);
  console.log('   - 상품이 SOLD OUT으로 표시됩니다.');
}

// 상품 상태 초기화
async function resetProductStatus(product) {
  console.log('   - 상품 상태 초기화 중...');
  
  // 재고를 1로 복구
  await inventoryService.syncBunjangInventoryToShopify(product.bunjangPid, 1);
  
  // DB 상태 초기화
  product.soldFrom = null;
  product.soldAt = null;
  product.shopifySoldAt = null;
  product.bunjangSoldAt = null;
  product.pendingBunjangOrder = false;
  product.shopifyStatus = 'ACTIVE';
  product.bunjangOrderIds = [];
  
  await product.save();
  
  console.log('   ✅ 상품 상태가 초기화되었습니다.');
  console.log('   - 재고: 1');
  console.log('   - 상태: ACTIVE');
  console.log('   - 판매 정보: 모두 삭제');
}

// 실행
if (require.main === module) {
  testProductSync();
}