const axios = require('axios');
const readline = require('readline');

// Shopify API 설정
const SHOPIFY_API_KEY = "67711a5b6f337db6676fb45dc69bf5b0";
const SHOPIFY_API_SECRET = "346f168440d662806ab7198f8e11d264";
const SHOPIFY_SHOP_DOMAIN = "hallyusuperstore19.myshopify.com";
const SHOPIFY_ADMIN_ACCESS_TOKEN = "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";
const SHOPIFY_API_VERSION = "2025-04";

// 대상 컬렉션과 위치
const COLLECTION_ID = "445888299257";  // bunjang_k-pop collection
const LOCATION_ID = "70693355769";     // Main warehouse

// API 엔드포인트
const BASE_URL = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;
const HEADERS = {
    "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
    "Content-Type": "application/json"
};

// readline 인터페이스 설정
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// 병렬 처리를 위한 함수
async function processInBatches(items, batchSize, processFn) {
    const results = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(processFn));
        results.push(...batchResults);
        console.log(`처리 완료: ${Math.min(i + batchSize, items.length)}/${items.length}`);
    }
    return results;
}

// GraphQL로 제품과 inventory 정보를 한 번에 가져오기 (최적화된 쿼리)
async function getAllProductsWithInventory() {
    console.log(`컬렉션의 제품과 inventory 정보를 가져오는 중...`);
    
    const products = [];
    let cursor = null;
    
    while (true) {
        // 최적화된 쿼리 - 필요한 정보만 가져옴
        const query = `
        {
            collection(id: "gid://shopify/Collection/${COLLECTION_ID}") {
                products(first: 50${cursor ? `, after: "${cursor}"` : ''}) {
                    edges {
                        node {
                            id
                            title
                            handle
                            variants(first: 10) {
                                edges {
                                    node {
                                        id
                                        inventoryItem {
                                            id
                                            inventoryLevel(locationId: "gid://shopify/Location/${LOCATION_ID}") {
                                                id
                                                location {
                                                    id
                                                    name
                                                }
                                            }
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
        }
        `;
        
        try {
            const response = await axios.post(
                `${BASE_URL}/graphql.json`,
                { query },
                { headers: HEADERS }
            );
            
            const data = response.data;
            
            if (data.errors) {
                console.error('GraphQL 오류, 대체 방법 사용...');
                return await getAllProductsREST();
            }
            
            const productsData = data.data?.collection?.products;
            
            if (!productsData) {
                break;
            }
            
            // Main warehouse에 있는 제품만 필터링
            for (const edge of productsData.edges || []) {
                const product = edge.node;
                let hasInventoryAtLocation = false;
                
                // variant 중 하나라도 Main warehouse에 있는지 확인
                for (const variantEdge of product.variants?.edges || []) {
                    const inventoryLevel = variantEdge.node.inventoryItem?.inventoryLevel;
                    if (inventoryLevel) {
                        hasInventoryAtLocation = true;
                        break;
                    }
                }
                
                if (hasInventoryAtLocation) {
                    products.push({
                        id: product.id,
                        title: product.title,
                        handle: product.handle
                    });
                }
            }
            
            console.log(`현재까지 찾은 제품: ${products.length}`);
            
            if (!productsData.pageInfo?.hasNextPage) {
                break;
            }
            
            const edges = productsData.edges || [];
            if (edges.length > 0) {
                cursor = edges[edges.length - 1].cursor;
            } else {
                break;
            }
            
        } catch (error) {
            console.error('GraphQL 오류:', error.message);
            return await getAllProductsREST();
        }
    }
    
    return products;
}

// REST API 대체 방법 (더 빠른 버전)
async function getAllProductsREST() {
    console.log('REST API로 제품 정보를 가져오는 중...');
    
    // 1. 먼저 모든 inventory levels를 한 번에 가져옴
    console.log('Main warehouse의 inventory 정보를 가져오는 중...');
    const allInventoryItems = new Set();
    let inventoryPage = null;
    
    do {
        const url = inventoryPage 
            ? `${BASE_URL}/inventory_levels.json?location_ids=${LOCATION_ID}&limit=250&page_info=${inventoryPage}`
            : `${BASE_URL}/inventory_levels.json?location_ids=${LOCATION_ID}&limit=250`;
            
        const response = await axios.get(url, { headers: HEADERS });
        
        for (const level of response.data.inventory_levels) {
            allInventoryItems.add(level.inventory_item_id);
        }
        
        // 다음 페이지 확인
        const linkHeader = response.headers.link;
        if (linkHeader && linkHeader.includes('rel="next"')) {
            const match = linkHeader.match(/page_info=([^>;&]+)/);
            inventoryPage = match ? match[1] : null;
        } else {
            inventoryPage = null;
        }
    } while (inventoryPage);
    
    console.log(`Main warehouse에 ${allInventoryItems.size}개의 inventory item을 찾았습니다.`);
    
    // 2. 컬렉션의 제품들을 가져와서 필터링
    const products = [];
    let page = 1;
    
    while (true) {
        try {
            // Collect API 사용
            const response = await axios.get(
                `${BASE_URL}/collects.json?collection_id=${COLLECTION_ID}&limit=250&page=${page}`,
                { headers: HEADERS }
            );
            
            const collects = response.data.collects;
            if (!collects || collects.length === 0) break;
            
            // 제품 ID들을 배치로 가져오기
            const productIds = collects.map(c => c.product_id);
            const productIdsString = productIds.join(',');
            
            const productsResponse = await axios.get(
                `${BASE_URL}/products.json?ids=${productIdsString}&limit=250`,
                { headers: HEADERS }
            );
            
            // Main warehouse에 있는 제품만 필터링
            for (const product of productsResponse.data.products) {
                let hasInventoryAtLocation = false;
                
                for (const variant of product.variants) {
                    if (allInventoryItems.has(variant.inventory_item_id)) {
                        hasInventoryAtLocation = true;
                        break;
                    }
                }
                
                if (hasInventoryAtLocation) {
                    products.push({
                        id: `gid://shopify/Product/${product.id}`,
                        numericId: product.id,
                        title: product.title,
                        handle: product.handle
                    });
                }
            }
            
            console.log(`페이지 ${page} 처리 완료. 현재까지 찾은 제품: ${products.length}`);
            
            if (collects.length < 250) break;
            page++;
            
        } catch (error) {
            console.error('REST API 오류:', error.message);
            break;
        }
    }
    
    return products;
}

// 병렬로 제품 삭제
async function deleteProductBatch(product) {
    const numericId = product.numericId || product.id.split('/').pop();
    
    try {
        const response = await axios.delete(
            `${BASE_URL}/products/${numericId}.json`,
            { headers: HEADERS }
        );
        
        return { success: true, product };
    } catch (error) {
        return { success: false, product, error: error.message };
    }
}

function askQuestion(question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer);
        });
    });
}

async function saveProductList(products, filename) {
    const fs = require('fs');
    fs.writeFileSync(filename, JSON.stringify(products, null, 2));
    console.log(`제품 목록이 ${filename}에 저장되었습니다.`);
}

async function main() {
    try {
        console.log('=== Shopify 빠른 제품 삭제 스크립트 ===');
        console.log(`Shop: ${SHOPIFY_SHOP_DOMAIN}`);
        console.log(`API Version: ${SHOPIFY_API_VERSION}`);
        console.log(`Collection ID: ${COLLECTION_ID}`);
        console.log(`Location ID: ${LOCATION_ID} (Main warehouse)\n`);
        
        const startTime = Date.now();
        
        // 제품 정보 가져오기
        const productsToDelete = await getAllProductsWithInventory();
        
        if (productsToDelete.length === 0) {
            console.log("\nMain warehouse에 제품이 없습니다.");
            rl.close();
            return;
        }
        
        const fetchTime = (Date.now() - startTime) / 1000;
        console.log(`\n✓ ${fetchTime.toFixed(1)}초 만에 ${productsToDelete.length}개의 제품을 찾았습니다!\n`);
        
        // 제품 목록 표시 (처음 10개만)
        console.log('삭제할 제품:');
        productsToDelete.slice(0, 10).forEach((product, index) => {
            console.log(`${index + 1}. ${product.title}`);
        });
        if (productsToDelete.length > 10) {
            console.log(`... 그리고 ${productsToDelete.length - 10}개 더\n`);
        }
        
        // 백업
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        await saveProductList(productsToDelete, `main_warehouse_products_${timestamp}.json`);
        
        // 삭제 옵션
        console.log('\n삭제 옵션:');
        console.log('1. 빠른 삭제 (병렬 처리, 위험할 수 있음)');
        console.log('2. 안전한 삭제 (순차 처리, 느림)');
        console.log('3. 취소');
        
        const option = await askQuestion('\n옵션을 선택하세요 (1/2/3): ');
        
        if (option === '3') {
            console.log('\n삭제가 취소되었습니다.');
            rl.close();
            return;
        }
        
        console.log('\n제품 삭제를 시작합니다...\n');
        const deleteStartTime = Date.now();
        
        let deletedCount = 0;
        let failedCount = 0;
        const failedProducts = [];
        
        if (option === '1') {
            // 빠른 삭제 (병렬 처리)
            console.log('병렬 처리로 삭제 중... (한 번에 5개씩)\n');
            
            const results = await processInBatches(productsToDelete, 5, deleteProductBatch);
            
            results.forEach(result => {
                if (result.success) {
                    deletedCount++;
                } else {
                    failedCount++;
                    failedProducts.push(result.product);
                }
            });
            
        } else {
            // 안전한 삭제 (순차 처리)
            for (let i = 0; i < productsToDelete.length; i++) {
                const product = productsToDelete[i];
                process.stdout.write(`[${i+1}/${productsToDelete.length}] ${product.title} 삭제 중...`);
                
                const result = await deleteProductBatch(product);
                
                if (result.success) {
                    deletedCount++;
                    console.log(' ✓');
                } else {
                    failedCount++;
                    failedProducts.push(product);
                    console.log(' ✗');
                }
                
                // 안전을 위한 짧은 대기
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
        
        const deleteTime = (Date.now() - deleteStartTime) / 1000;
        
        console.log(`\n=== 삭제 완료 ===`);
        console.log(`✓ 성공: ${deletedCount}개`);
        console.log(`✗ 실패: ${failedCount}개`);
        console.log(`총 소요 시간: ${deleteTime.toFixed(1)}초`);
        console.log(`평균 삭제 속도: ${(deletedCount / deleteTime).toFixed(1)}개/초`);
        
        if (failedProducts.length > 0) {
            await saveProductList(failedProducts, `failed_products_${timestamp}.json`);
        }
        
    } catch (error) {
        console.error('\n오류:', error);
    } finally {
        rl.close();
    }
}

// 패키지 설치 확인
try {
    require('axios');
} catch (e) {
    console.log('=== 필수 패키지 설치 필요 ===');
    console.log('npm install axios');
    process.exit(1);
}

// 스크립트 실행
main();