// debugBunjangOrder.js
// 특정 상품(PID: 333572111)의 번개장터 주문이 왜 안되는지 분석

const mongoose = require('mongoose');
const config = require('./src/config');
const SyncedProduct = require('./src/models/syncedProduct.model');
const shopifyService = require('./src/services/shopifyService');
const bunjangService = require('./src/services/bunjangService');
const logger = require('./src/config/logger');

const TARGET_PID = '332047857';

async function debugBunjangOrder() {
  console.log(`🔍 번개장터 주문 실패 원인 분석 시작 (PID: ${TARGET_PID})\n`);
  
  try {
    // MongoDB 연결
    await mongoose.connect(config.database.connectionString, config.database.options);
    console.log('✅ MongoDB 연결 성공\n');
    
    // 1. DB에서 상품 정보 확인
    console.log('1️⃣ MongoDB에서 상품 정보 확인');
    const dbProduct = await SyncedProduct.findOne({ bunjangPid: TARGET_PID });
    
    if (!dbProduct) {
      console.log('   ❌ DB에 해당 상품이 없습니다!');
      console.log('   → 상품이 동기화되지 않았습니다. 먼저 동기화가 필요합니다.\n');
      
      // Shopify에서 확인
      console.log('   Shopify에서 상품 검색 중...');
      const shopifyQuery = `
        query searchProduct {
          products(first: 100, query: "tag:bunjang_pid:${TARGET_PID}") {
            edges {
              node {
                id
                title
                status
                tags
              }
            }
          }
        }
      `;
      
      const shopifyResponse = await shopifyService.shopifyGraphqlRequest(shopifyQuery, {});
      if (shopifyResponse.data?.products?.edges?.length > 0) {
        const product = shopifyResponse.data.products.edges[0].node;
        console.log(`   ✅ Shopify에서 발견: ${product.title}`);
        console.log(`      GID: ${product.id}`);
        console.log(`      상태: ${product.status}`);
        console.log('\n   💡 해결방법: 상품 동기화 스크립트를 실행하세요.');
      }
      
      return;
    }
    
    // DB 상품 정보 출력
    console.log('   ✅ DB에서 상품 발견');
    console.log(`   - 상품명: ${dbProduct.bunjangProductName}`);
    console.log(`   - Shopify GID: ${dbProduct.shopifyGid}`);
    console.log(`   - 동기화 상태: ${dbProduct.syncStatus}`);
    console.log(`   - 판매 상태: ${dbProduct.soldFrom || '없음'}`);
    console.log(`   - 번개장터 주문 대기: ${dbProduct.pendingBunjangOrder}`);
    console.log(`   - 번개장터 주문 ID: ${dbProduct.bunjangOrderIds?.join(', ') || '없음'}`);
    
    // 2. Shopify 주문 확인
    console.log('\n2️⃣ Shopify 주문 정보 확인');
    
    if (!dbProduct.shopifyGid) {
      console.log('   ❌ Shopify GID가 없습니다!');
      return;
    }
    
    // Shopify 상품 정보
    const productQuery = `
      query getProduct($id: ID!) {
        product(id: $id) {
          id
          title
          status
          tags
        }
      }
    `;
    
    const productResponse = await shopifyService.shopifyGraphqlRequest(productQuery, { 
      id: dbProduct.shopifyGid 
    });
    
    if (productResponse.data?.product) {
      const product = productResponse.data.product;
      console.log(`   - Shopify 상품 상태: ${product.status}`);
      console.log(`   - 태그: ${product.tags.join(', ')}`);
    }
    
    // 최근 주문 확인
    const ordersQuery = `
      query getRecentOrders {
        orders(first: 50, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              name
              createdAt
              tags
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    title
                    product {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    
    const ordersResponse = await shopifyService.shopifyGraphqlRequest(ordersQuery, {});
    
    let foundOrder = null;
    if (ordersResponse.data?.orders?.edges) {
      for (const { node: order } of ordersResponse.data.orders.edges) {
        for (const { node: item } of order.lineItems.edges) {
          if (item.product?.id === dbProduct.shopifyGid) {
            foundOrder = order;
            break;
          }
        }
        if (foundOrder) break;
      }
    }
    
    if (foundOrder) {
      console.log(`   ✅ Shopify 주문 발견: ${foundOrder.name}`);
      console.log(`   - 주문일: ${foundOrder.createdAt}`);
      console.log(`   - 태그: ${foundOrder.tags.join(', ')}`);
      
      // 번개장터 주문 태그 확인
      const hasBunjangTag = foundOrder.tags.some(tag => tag.startsWith('BunjangOrder-'));
      const hasErrorTag = foundOrder.tags.some(tag => tag.includes('Error'));
      
      if (hasBunjangTag) {
        console.log('   ✅ 번개장터 주문 태그가 있습니다.');
      } else {
        console.log('   ❌ 번개장터 주문 태그가 없습니다!');
      }
      
      if (hasErrorTag) {
        console.log('   ⚠️  에러 태그 발견:');
        foundOrder.tags.filter(tag => tag.includes('Error')).forEach(tag => {
          console.log(`      - ${tag}`);
        });
      }
    } else {
      console.log('   ❌ 최근 주문에서 해당 상품을 찾을 수 없습니다.');
    }
    
    // 3. 번개장터 API 확인
    console.log('\n3️⃣ 번개장터 상품 상태 확인');
    
    try {
      const bunjangProduct = await bunjangService.getBunjangProductDetails(TARGET_PID);
      
      if (bunjangProduct) {
        console.log('   ✅ 번개장터 상품 정보:');
        console.log(`   - 상품명: ${bunjangProduct.name}`);
        console.log(`   - 가격: ${bunjangProduct.price}원`);
        console.log(`   - 상태: ${bunjangProduct.status}`);
        console.log(`   - 재고: ${bunjangProduct.quantity}`);
        
        if (bunjangProduct.status !== 'SELLING') {
          console.log('   ❌ 상품이 판매 중이 아닙니다!');
        }
        
        if (bunjangProduct.quantity === 0) {
          console.log('   ❌ 재고가 없습니다!');
        }
      } else {
        console.log('   ❌ 번개장터에서 상품을 찾을 수 없습니다!');
      }
    } catch (apiError) {
      console.log('   ❌ 번개장터 API 오류:', apiError.message);
    }
    
    // 4. 포인트 잔액 확인
    console.log('\n4️⃣ 번개장터 포인트 잔액 확인');
    
    try {
      const pointBalance = await bunjangService.getBunjangPointBalance();
      if (pointBalance) {
        console.log(`   - 현재 잔액: ${pointBalance.balance?.toLocaleString()}원`);
        
        if (pointBalance.balance < 10000) {
          console.log('   ❌ 포인트 잔액이 부족할 수 있습니다!');
        }
      }
    } catch (pointError) {
      console.log('   ❌ 포인트 잔액 확인 실패:', pointError.message);
    }
    
    // 5. 환경 변수 확인
    console.log('\n5️⃣ 환경 변수 및 설정 확인');
    console.log(`   - BUNJANG_API_ACCESS_KEY: ${config.bunjang.accessKey ? '✅ 설정됨' : '❌ 없음'}`);
    console.log(`   - BUNJANG_API_SECRET_KEY: ${config.bunjang.secretKey ? '✅ 설정됨' : '❌ 없음'}`);
    console.log(`   - CS_TRADING 설정: ${config.bunjang.csTrading?.recipientName1 ? '✅ 설정됨' : '❌ 없음'}`);
    
    // 6. 진단 결과
    console.log('\n📊 진단 결과 및 해결 방법:');
    
    const problems = [];
    
    if (!dbProduct) {
      problems.push('상품이 DB에 동기화되지 않음');
    }
    
    if (dbProduct && !dbProduct.bunjangOrderIds?.length && dbProduct.pendingBunjangOrder) {
      problems.push('Shopify 주문은 있으나 번개장터 주문이 생성되지 않음');
    }
    
    if (problems.length === 0) {
      console.log('   ✅ 특별한 문제를 발견하지 못했습니다.');
    } else {
      console.log('   발견된 문제:');
      problems.forEach((problem, index) => {
        console.log(`   ${index + 1}. ${problem}`);
      });
      
      console.log('\n   💡 해결 방법:');
      console.log('   1. 웹훅이 제대로 설정되어 있는지 확인');
      console.log('   2. orderService.processShopifyOrderForBunjang 로그 확인');
      console.log('   3. 번개장터 API 키와 포인트 잔액 확인');
    }
    
  } catch (error) {
    console.error('❌ 오류 발생:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n✅ 분석 완료');
  }
}

// 실행
if (require.main === module) {
  debugBunjangOrder();
}