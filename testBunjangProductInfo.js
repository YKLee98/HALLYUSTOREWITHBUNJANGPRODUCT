// testBunjangProductInfo.js
// 번개장터 상품 정보 조회 테스트 스크립트 (구매 없음)

require('dotenv').config();
const bunjangService = require('./src/services/bunjangService');
const config = require('./src/config');

const TARGET_PID = '342351629';

async function testBunjangProductInfo() {
  console.log('🔍 번개장터 상품 정보 조회 테스트');
  console.log(`📦 대상 상품 PID: ${TARGET_PID}\n`);
  
  try {
    // 1. 상품 정보 조회
    console.log('1️⃣ 상품 정보 조회 중...');
    const product = await bunjangService.getBunjangProductDetails(TARGET_PID);
    
    if (!product) {
      console.log('❌ 상품을 찾을 수 없습니다.');
      return;
    }
    
    console.log('✅ 상품 정보 조회 성공:');
    console.log(`   - 상품명: ${product.name}`);
    console.log(`   - 가격: ${product.price?.toLocaleString()}원`);
    console.log(`   - 상태: ${product.status}`);
    console.log(`   - 재고: ${product.quantity}개`);
    console.log(`   - 판매자: ${product.seller?.name || '알 수 없음'}`);
    console.log(`   - 배송비: ${(product.deliveryPrice || 0).toLocaleString()}원`);
    console.log(`   - 카테고리: ${product.category?.name || '알 수 없음'}`);
    console.log(`   - 브랜드: ${product.brand?.name || '알 수 없음'}`);
    console.log(`   - 등록일: ${product.createdAt || '알 수 없음'}`);
    
    if (product.description) {
      console.log(`   - 설명: ${product.description.substring(0, 100)}...`);
    }
    
    if (product.images && product.images.length > 0) {
      console.log(`   - 이미지 수: ${product.images.length}개`);
    }
    
    // 2. 포인트 잔액 확인
    console.log('\n2️⃣ 포인트 잔액 확인 중...');
    const pointBalance = await bunjangService.getBunjangPointBalance();
    
    if (!pointBalance) {
      console.log('❌ 포인트 잔액을 확인할 수 없습니다.');
      return;
    }
    
    const totalCost = product.price + (product.deliveryPrice || 0);
    console.log(`   - 현재 잔액: ${pointBalance.balance?.toLocaleString()}원`);
    console.log(`   - 상품 가격: ${product.price?.toLocaleString()}원`);
    console.log(`   - 배송비: ${(product.deliveryPrice || 0).toLocaleString()}원`);
    console.log(`   - 총 필요 금액: ${totalCost.toLocaleString()}원`);
    
    if (pointBalance.balance >= totalCost) {
      console.log('✅ 포인트 잔액이 충분합니다.');
      console.log(`   - 남은 잔액: ${(pointBalance.balance - totalCost).toLocaleString()}원`);
    } else {
      console.log('❌ 포인트 잔액이 부족합니다.');
      console.log(`   - 부족한 금액: ${(totalCost - pointBalance.balance).toLocaleString()}원`);
    }
    
    // 3. 배송지 정보 확인
    console.log('\n3️⃣ 배송지 정보 확인...');
    const shippingInfo = config.bunjang.csTrading;
    
    console.log('   배송지 정보:');
    console.log(`   - 수령인: ${shippingInfo.recipientName1}`);
    console.log(`   - 연락처: ${shippingInfo.phone}`);
    console.log(`   - 주소: ${shippingInfo.shippingAddress}`);
    console.log(`   - 우편번호: ${shippingInfo.zipCode}`);
    
    // 4. 구매 가능 여부 판단
    console.log('\n4️⃣ 구매 가능 여부 판단...');
    
    const canBuy = [];
    const cannotBuy = [];
    
    if (product.status === 'SELLING' && product.quantity > 0) {
      canBuy.push('상품이 판매 중입니다');
    } else {
      cannotBuy.push('상품이 판매 중이 아니거나 재고가 없습니다');
    }
    
    if (pointBalance.balance >= totalCost) {
      canBuy.push('포인트 잔액이 충분합니다');
    } else {
      cannotBuy.push('포인트 잔액이 부족합니다');
    }
    
    if (canBuy.length === 2) {
      console.log('✅ 구매 가능합니다!');
      console.log('   - 모든 조건이 충족되었습니다');
    } else {
      console.log('❌ 구매할 수 없습니다:');
      cannotBuy.forEach(reason => {
        console.log(`   - ${reason}`);
      });
    }
    
    // 5. 구매 시 예상 정보
    if (canBuy.length === 2) {
      console.log('\n5️⃣ 구매 시 예상 정보...');
      console.log(`   - 상품명: ${product.name}`);
      console.log(`   - 총 결제액: ${totalCost.toLocaleString()}원`);
      console.log(`   - 수령인: ${shippingInfo.recipientName1}`);
      console.log(`   - 배송지: ${shippingInfo.shippingAddress}`);
      console.log(`   - 구매 후 잔액: ${(pointBalance.balance - totalCost).toLocaleString()}원`);
    }
    
  } catch (error) {
    console.error('❌ 테스트 중 오류 발생:', error.message);
    
    if (error.stack) {
      console.error('스택 트레이스:', error.stack);
    }
  }
}

// 실행
if (require.main === module) {
  testBunjangProductInfo().then(() => {
    console.log('\n✅ 테스트 완료');
    process.exit(0);
  }).catch(err => {
    console.error('❌ 테스트 실패:', err);
    process.exit(1);
  });
}

module.exports = { testBunjangProductInfo }; 