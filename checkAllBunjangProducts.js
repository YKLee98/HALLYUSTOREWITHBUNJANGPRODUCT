// checkAllBunjangProducts.js
// Shopify에 올라간 번개장터 상품들이 MongoDB에 제대로 저장되어 있는지 확인

const mongoose = require('mongoose');
const config = require('./src/config');
const SyncedProduct = require('./src/models/syncedProduct.model');
const shopifyService = require('./src/services/shopifyService');
const logger = require('./src/config/logger');

async function checkAllBunjangProducts() {
  console.log('🔍 전체 번개장터 상품 상태 확인 시작...\n');
  
  try {
    // MongoDB 연결
    await mongoose.connect(config.database.connectionString, config.database.options);
    console.log('✅ MongoDB 연결 성공\n');
    
    // 1. Shopify에서 번개장터 태그가 있는 상품 조회
    console.log('1️⃣ Shopify에서 번개장터 태그가 있는 상품 조회 중...');
    
    let hasNextPage = true;
    let cursor = null;
    let shopifyProducts = [];
    
    while (hasNextPage) {
      const query = `
        query getTaggedProducts($cursor: String) {
          products(first: 50, after: $cursor, query: "tag_prefix:bunjang_pid") {
            edges {
              node {
                id
                title
                handle
                status
                tags
                variants(first: 5) {
                  edges {
                    node {
                      id
                      inventoryQuantity
                    }
                  }
                }
              }
              cursor
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      `;
      
      const response = await shopifyService.shopifyGraphqlRequest(query, { cursor });
      
      if (!response.data || !response.data.products) break;
      
      const products = response.data.products.edges || [];
      hasNextPage = response.data.products.pageInfo?.hasNextPage || false;
      
      for (const { node: product, cursor: productCursor } of products) {
        cursor = productCursor;
        
        // bunjang_pid 태그 찾기
        const bunjangPidTag = product.tags.find(tag => tag.startsWith('bunjang_pid:'));
        if (!bunjangPidTag) continue;
        
        const bunjangPid = bunjangPidTag.split(':')[1].trim();
        shopifyProducts.push({
          shopifyGid: product.id,
          bunjangPid: bunjangPid,
          title: product.title,
          status: product.status,
          tags: product.tags,
          inventory: product.variants.edges[0]?.node?.inventoryQuantity || 0
        });
      }
    }
    
    console.log(`   Shopify에서 ${shopifyProducts.length}개의 번개장터 상품 발견\n`);
    
    // 2. MongoDB와 대조
    console.log('2️⃣ MongoDB 데이터와 대조 중...');
    
    const stats = {
      total: shopifyProducts.length,
      synced: 0,
      notInDb: 0,
      statusMismatch: 0,
      soldProducts: 0,
      pendingOrders: 0
    };
    
    const issues = [];
    
    for (const shopifyProduct of shopifyProducts) {
      const dbProduct = await SyncedProduct.findOne({ bunjangPid: shopifyProduct.bunjangPid });
      
      if (!dbProduct) {
        stats.notInDb++;
        issues.push({
          type: 'NOT_IN_DB',
          bunjangPid: shopifyProduct.bunjangPid,
          title: shopifyProduct.title,
          shopifyGid: shopifyProduct.shopifyGid
        });
      } else {
        stats.synced++;
        
        // 상태 확인
        if (dbProduct.soldFrom) {
          stats.soldProducts++;
        }
        
        if (dbProduct.pendingBunjangOrder) {
          stats.pendingOrders++;
        }
        
        // Shopify 상태와 DB 상태 비교
        if (shopifyProduct.status !== dbProduct.shopifyStatus) {
          stats.statusMismatch++;
          issues.push({
            type: 'STATUS_MISMATCH',
            bunjangPid: shopifyProduct.bunjangPid,
            title: shopifyProduct.title,
            shopifyStatus: shopifyProduct.status,
            dbStatus: dbProduct.shopifyStatus
          });
        }
      }
    }
    
    // 3. 결과 출력
    console.log('\n📊 분석 결과:');
    console.log(`   - 전체 상품: ${stats.total}개`);
    console.log(`   - DB에 동기화됨: ${stats.synced}개`);
    console.log(`   - DB에 없음: ${stats.notInDb}개`);
    console.log(`   - 상태 불일치: ${stats.statusMismatch}개`);
    console.log(`   - 판매된 상품: ${stats.soldProducts}개`);
    console.log(`   - 번개장터 주문 대기: ${stats.pendingOrders}개`);
    
    // 4. 문제 상품 상세 정보
    if (issues.length > 0) {
      console.log('\n⚠️  문제 발견:');
      
      // DB에 없는 상품
      const notInDb = issues.filter(i => i.type === 'NOT_IN_DB');
      if (notInDb.length > 0) {
        console.log('\n   [DB에 없는 상품]');
        notInDb.forEach(issue => {
          console.log(`   - PID: ${issue.bunjangPid} - ${issue.title}`);
          console.log(`     Shopify GID: ${issue.shopifyGid}`);
        });
      }
      
      // 상태 불일치
      const statusMismatch = issues.filter(i => i.type === 'STATUS_MISMATCH');
      if (statusMismatch.length > 0) {
        console.log('\n   [상태 불일치]');
        statusMismatch.forEach(issue => {
          console.log(`   - PID: ${issue.bunjangPid} - ${issue.title}`);
          console.log(`     Shopify: ${issue.shopifyStatus}, DB: ${issue.dbStatus}`);
        });
      }
    }
    
    // 5. 판매 대기 상품 상세 정보
    console.log('\n📌 번개장터 주문 대기 중인 상품:');
    const pendingProducts = await SyncedProduct.find({ pendingBunjangOrder: true });
    
    if (pendingProducts.length === 0) {
      console.log('   없음');
    } else {
      for (const product of pendingProducts) {
        console.log(`   - PID: ${product.bunjangPid} - ${product.bunjangProductName}`);
        console.log(`     Shopify 판매일: ${product.shopifySoldAt}`);
        console.log(`     주문 ID: ${product.bunjangOrderIds?.join(', ') || '없음'}`);
      }
    }
    
    // 6. 최근 판매된 상품
    console.log('\n📌 최근 판매된 상품 (최근 10개):');
    const recentSold = await SyncedProduct.find({ 
      soldFrom: { $ne: null } 
    }).sort({ soldAt: -1 }).limit(10);
    
    if (recentSold.length === 0) {
      console.log('   없음');
    } else {
      recentSold.forEach(product => {
        console.log(`   - PID: ${product.bunjangPid} - ${product.bunjangProductName}`);
        console.log(`     판매처: ${product.soldFrom}`);
        console.log(`     판매일: ${product.soldAt}`);
        console.log('');
      });
    }
    
  } catch (error) {
    console.error('❌ 오류 발생:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n✅ 확인 완료');
  }
}

// 실행
if (require.main === module) {
  checkAllBunjangProducts();
}