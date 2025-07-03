// checkDuplicateBunjangSKUs.js
// 'BJ-'로 시작하는 SKU 중 중복된 상품만 찾는 스크립트

const mongoose = require('mongoose');
const config = require('./src/config');
const SyncedProduct = require('./src/models/syncedProduct.model');
const shopifyService = require('./src/services/shopifyService');
const bunjangService = require('./src/services/bunjangService');

// 색상 코드
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}
async function checkDuplicateBunjangSKUs() {
  try {
    log('\n🔍 번개장터 연동 상품(BJ-) SKU 중복 확인', 'bright');
    log('='.repeat(60), 'blue');
    
    // MongoDB 연결
    await mongoose.connect(config.database.connectionString, config.database.options);
    log('✅ MongoDB 연결 성공\n', 'green');
    
    // 1. Shopify에서 BJ-로 시작하는 SKU만 조회
    log('1️⃣ 번개장터 연동 상품 SKU 조회 중...', 'cyan');
    
    let hasNextPage = true;
    let cursor = null;
    const bunjangProducts = [];
    const skuMap = new Map(); // SKU -> 상품 배열
    
    while (hasNextPage) {
      const query = `
        query getBunjangProducts($cursor: String) {
          products(first: 50, after: $cursor) {
            edges {
              node {
                id
                title
                handle
                status
                tags
                createdAt
                updatedAt
                totalInventory
                variants(first: 10) {
                  edges {
                    node {
                      id
                      sku
                      title
                      price
                      inventoryQuantity
                      inventoryItem {
                        id
                      }
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
      const products = response.data?.products;

      if (!products) break;

      products.edges.forEach(({ node: product }) => {
        product.variants.edges.forEach(({ node: variant }) => {
          // BJ-로 시작하는 SKU만 처리
          if (variant.sku && variant.sku.startsWith('BJ-')) {
            const bunjangPid = variant.sku.substring(3);

            const productInfo = {
              productId: product.id,
              productTitle: product.title,
              productHandle: product.handle,
              productStatus: product.status,
              createdAt: product.createdAt,
              updatedAt: product.updatedAt,
              variantId: variant.id,
              sku: variant.sku,
              bunjangPid: bunjangPid,
              price: variant.price,
              inventory: variant.inventoryQuantity,
              totalInventory: product.totalInventory,
              tags: product.tags,
              hasBunjangTag: product.tags.some(tag => tag.startsWith('bunjang_pid:')),
              tagBunjangPid: product.tags.find(tag => tag.startsWith('bunjang_pid:'))?.split(':')[1]
            };

            bunjangProducts.push(productInfo);

            // SKU 맵에 추가
            if (!skuMap.has(variant.sku)) {
              skuMap.set(variant.sku, []);
            }
            skuMap.get(variant.sku).push(productInfo);
          }
        });
      });

      hasNextPage = products.pageInfo.hasNextPage;
      if (hasNextPage && products.edges.length > 0) {
        cursor = products.edges[products.edges.length - 1].cursor;
      }

      log(`   조회된 번개장터 상품: ${bunjangProducts.length}개...`);
    }
    
    log(`\n✅ 총 ${bunjangProducts.length}개 번개장터 연동 상품 조회 완료`, 'green');
    log(`   고유 번개장터 SKU 수: ${skuMap.size}개`, 'cyan');
    
    // 2. 중복 SKU 찾기
    log('\n2️⃣ 중복 SKU 분석', 'cyan');
    log('-'.repeat(60));
    
    const duplicateSKUs = Array.from(skuMap.entries())
      .filter(([sku, products]) => products.length > 1)
      .sort((a, b) => b[1].length - a[1].length); // 중복 수가 많은 순으로 정렬
    
    if (duplicateSKUs.length === 0) {
      log('\n✅ 중복된 번개장터 SKU가 없습니다!', 'green');
      return;
    }
    
    log(`\n⚠️  ${duplicateSKUs.length}개의 중복 번개장터 SKU 발견!`, 'red');
    
    // 3. 중복 상세 정보
    log('\n3️⃣ 중복 번개장터 상품 상세 정보', 'cyan');
    log('='.repeat(60), 'blue');
    
    const totalDuplicateProducts = duplicateSKUs.reduce((sum, [sku, products]) => sum + products.length, 0);
    
    log(`\n📊 통계:`, 'yellow');
    log(`   - 중복 SKU 수: ${duplicateSKUs.length}개`);
    log(`   - 영향받는 상품 수: ${totalDuplicateProducts}개`);
    log(`   - 평균 중복 수: ${(totalDuplicateProducts / duplicateSKUs.length).toFixed(1)}개`);
    
    // 각 중복 SKU 상세 정보
    for (const [sku, products] of duplicateSKUs) {
      const bunjangPid = sku.substring(3);

      log(`\n${'='.repeat(60)}`, 'blue');
      log(`SKU: "${sku}" (번개장터 PID: ${bunjangPid}) - ${products.length}개 중복`, 'magenta');
      log('='.repeat(60), 'blue');
      // 번개장터 상품 현재 상태 확인
      try {
        const bunjangProduct = await bunjangService.getBunjangProductDetails(bunjangPid);

        if (bunjangProduct) {
          log(`\n📱 번개장터 상품 현재 상태:`, 'cyan');
          log(`   - 상품명: ${bunjangProduct.name}`);
          log(`   - 상태: ${bunjangProduct.status || bunjangProduct.saleStatus}`);
          log(`   - 가격: ${bunjangProduct.price}원`);
          log(`   - 재고: ${bunjangProduct.quantity}`);
        } else {
          log(`\n❌ 번개장터에서 상품을 찾을 수 없음 (삭제됨 또는 404)`, 'red');
        }
      } catch (error) {
        log(`\n❌ 번개장터 조회 실패: ${error.message}`, 'red');
      }

      // Shopify 상품들 정보
      log(`\n📦 Shopify 중복 상품들:`, 'yellow');

      products.forEach((product, index) => {
        log(`\n   ${index + 1}) ${product.productTitle}`, 'yellow');
        log(`      - 상품 ID: ${product.productId}`);
        log(`      - Handle: ${product.productHandle}`);
        log(`      - 상태: ${product.productStatus}`);
        log(`      - 가격: $${product.price}`);
        log(`      - 재고: ${product.inventory} (전체: ${product.totalInventory})`);
        log(`      - 생성일: ${new Date(product.createdAt).toLocaleString('ko-KR')}`);
        log(`      - 수정일: ${new Date(product.updatedAt).toLocaleString('ko-KR')}`);

        // 태그 불일치 확인
        if (product.tagBunjangPid && product.tagBunjangPid !== bunjangPid) {
          log(`      - ⚠️  태그 PID 불일치! 태그: ${product.tagBunjangPid}, SKU: ${bunjangPid}`, 'red');
        }
      });

      // DB 연결 확인
      const dbConnections = await SyncedProduct.find({ bunjangPid });

      if (dbConnections.length > 0) {
        log(`\n💾 DB 연결 상태:`, 'cyan');
        log(`   - 연결 수: ${dbConnections.length}개`);

        dbConnections.forEach((conn, index) => {
          log(`   ${index + 1}) ${conn.shopifyGid}`);
          log(`      동기화: ${conn.lastSyncedAt?.toLocaleString('ko-KR') || 'N/A'}`);
        });

        if (dbConnections.length !== products.length) {
          log(`   - ⚠️  DB 연결 수(${dbConnections.length})와 Shopify 상품 수(${products.length})가 불일치!`, 'red');
        }
      }
    }
    
    // 4. 해결 방안
    log('\n\n4️⃣ 권장 조치사항', 'cyan');
    log('='.repeat(60));
    
    log('\n🔧 중복 정리 방법:', 'yellow');
    log('   1. 각 중복 그룹에서 가장 최신 상품 하나만 남기기');
    log('   2. 나머지 상품들은 DRAFT로 변경 또는 삭제');
    log('   3. DB 연결도 함께 정리');
    
    // 5. 자동 정리 옵션
    if (process.argv.includes('--auto-fix')) {
      log('\n\n5️⃣ 자동 정리 시작...', 'red');

      for (const [sku, products] of duplicateSKUs) {
        // 가장 최신 상품 찾기 (updatedAt 기준)
        const sorted = products.sort((a, b) => 
          new Date(b.updatedAt) - new Date(a.updatedAt)
        );

        const keepProduct = sorted[0];
        const removeProducts = sorted.slice(1);

        log(`\n${sku}: ${keepProduct.productTitle} 유지, ${removeProducts.length}개 DRAFT 처리`);

        // 나머지 상품들을 DRAFT로 변경
        for (const product of removeProducts) {
          try {
            await shopifyService.updateProduct({
              id: product.productId,
              status: 'DRAFT'
            });
            log(`   ✅ ${product.productTitle} → DRAFT`, 'green');
          } catch (error) {
            log(`   ❌ 실패: ${error.message}`, 'red');
          }
        }
      }
    } else {
      log('\n💡 자동 정리를 원하시면 --auto-fix 옵션을 추가하세요', 'yellow');
      log('   (가장 최근 수정된 상품만 남기고 나머지는 DRAFT 처리)', 'yellow');
    }
    
    // 6. CSV 내보내기
    if (process.argv.includes('--export-csv')) {
      const fs = require('fs');
      const csv = ['SKU,Bunjang PID,Duplicate Count,Product Titles,Product IDs,Status,Created Dates'];

      duplicateSKUs.forEach(([sku, products]) => {
        const pid = sku.substring(3);
        const titles = products.map(p => p.productTitle).join(' | ');
        const ids = products.map(p => p.productId).join(' | ');
        const statuses = products.map(p => p.productStatus).join(' | ');
        const dates = products.map(p => new Date(p.createdAt).toISOString().split('T')[0]).join(' | ');
        csv.push(`"${sku}","${pid}",${products.length},"${titles}","${ids}","${statuses}","${dates}"`);
      });

      const filename = `duplicate_bunjang_skus_${new Date().toISOString().split('T')[0]}.csv`;
      fs.writeFileSync(filename, csv.join('\n'));
      log(`\n📄 CSV 파일 생성됨: ${filename}`, 'green');
    }
    
  } catch (error) {
    log(`\n❌ 오류 발생: ${error.message}`, 'red');
    console.error(error);
  } finally {
    await mongoose.disconnect();
    log('\n✅ 작업 완료\n', 'green');
  }
}

// 실행
if (require.main === module) {
  checkDuplicateBunjangSKUs();
}

module.exports = { checkDuplicateBunjangSKUs };
