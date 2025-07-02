// buyBunjangProductWithConfirmation.js
// 사용자 확인을 받는 번개장터 상품 구매 스크립트

require('dotenv').config();
const readline = require('readline');
const bunjangService = require('./src/services/bunjangService');
const config = require('./src/config');
const logger = require('./src/config/logger');

const TARGET_PID = '342351629';

// readline 인터페이스 생성
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// 사용자 입력을 받는 함수
function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function buyBunjangProductWithConfirmation() {
  console.log('🛒 번개장터 상품 구매 스크립트 (확인 버전)');
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
    
    // 상품 상태 확인
    if (product.status === 'SOLD' || product.quantity === 0) {
      console.log('❌ 상품이 이미 판매되었거나 재고가 없습니다.');
      return;
    }
    
    if (product.status !== 'SELLING') {
      console.log(`⚠️  상품 상태가 판매 중이 아닙니다: ${product.status}`);
      const continueAnswer = await askQuestion('계속 진행하시겠습니까? (y/N): ');
      if (continueAnswer !== 'y' && continueAnswer !== 'yes') {
        console.log('❌ 구매가 취소되었습니다.');
        return;
      }
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
    
    if (pointBalance.balance < totalCost) {
      console.log('❌ 포인트 잔액이 부족합니다.');
      console.log(`   필요: ${totalCost.toLocaleString()}원`);
      console.log(`   보유: ${pointBalance.balance?.toLocaleString()}원`);
      console.log(`   부족: ${(totalCost - pointBalance.balance).toLocaleString()}원`);
      return;
    }
    
    console.log('✅ 포인트 잔액 충분');
    
    // 3. 배송지 정보 확인
    console.log('\n3️⃣ 배송지 정보 확인...');
    const shippingInfo = config.bunjang.csTrading;
    
    console.log('   배송지 정보:');
    console.log(`   - 수령인: ${shippingInfo.recipientName1}`);
    console.log(`   - 연락처: ${shippingInfo.phone}`);
    console.log(`   - 주소: ${shippingInfo.shippingAddress}`);
    console.log(`   - 우편번호: ${shippingInfo.zipCode}`);
    
    const addressConfirm = await askQuestion('배송지 정보가 맞습니까? (y/N): ');
    if (addressConfirm !== 'y' && addressConfirm !== 'yes') {
      console.log('❌ 배송지 정보를 확인 후 다시 실행해주세요.');
      return;
    }
    
    // 4. 최종 구매 확인
    console.log('\n4️⃣ 최종 구매 확인...');
    console.log('📋 구매 정보 요약:');
    console.log(`   - 상품명: ${product.name}`);
    console.log(`   - 상품 ID: ${TARGET_PID}`);
    console.log(`   - 상품 가격: ${product.price?.toLocaleString()}원`);
    console.log(`   - 배송비: ${(product.deliveryPrice || 0).toLocaleString()}원`);
    console.log(`   - 총 결제액: ${totalCost.toLocaleString()}원`);
    console.log(`   - 수령인: ${shippingInfo.recipientName1}`);
    console.log(`   - 배송지: ${shippingInfo.shippingAddress}`);
    console.log('');
    console.log('⚠️  주의: 이 작업은 되돌릴 수 없습니다!');
    console.log('💰 번개 포인트가 차감됩니다.');
    console.log('📋 주문이 생성되고 확정됩니다.');
    
    const finalConfirm = await askQuestion('\n정말로 구매하시겠습니까? (yes를 입력하세요): ');
    if (finalConfirm !== 'yes') {
      console.log('❌ 구매가 취소되었습니다.');
      return;
    }
    
    // 5. 주문 생성
    console.log('\n5️⃣ 주문 생성 중...');
    
    const orderPayload = {
      product: {
        id: parseInt(TARGET_PID),
        price: product.price
      },
      deliveryPrice: product.deliveryPrice || 0,
      recipient: {
        name: shippingInfo.recipientName1,
        phone: shippingInfo.phone,
        address: {
          zipCode: shippingInfo.zipCode,
          address: shippingInfo.shippingAddress
        }
      },
      message: "API를 통한 자동 구매",
      agreeToTerms: true
    };
    
    const orderResult = await bunjangService.createBunjangOrderV2(orderPayload);
    
    if (!orderResult || !orderResult.id) {
      console.log('❌ 주문 생성에 실패했습니다.');
      return;
    }
    
    console.log('✅ 주문 생성 성공!');
    console.log(`   - 주문 ID: ${orderResult.id}`);
    
    // 6. 주문 확정 확인
    console.log('\n6️⃣ 주문 확정...');
    console.log('⚠️  주문 확정은 되돌릴 수 없습니다!');
    
    const confirmOrder = await askQuestion('주문을 확정하시겠습니까? (yes를 입력하세요): ');
    if (confirmOrder !== 'yes') {
      console.log('⚠️  주문이 생성되었지만 확정되지 않았습니다.');
      console.log(`   주문 ID: ${orderResult.id}`);
      console.log('   수동으로 번개장터에서 확인 후 확정해주세요.');
      return;
    }
    
    const confirmResult = await bunjangService.confirmBunjangOrder(orderResult.id);
    
    if (confirmResult) {
      console.log('✅ 주문 확정 성공!');
      console.log(`   - 확정된 주문 ID: ${orderResult.id}`);
    } else {
      console.log('⚠️  주문 확정에 실패했습니다. 수동으로 확인해주세요.');
    }
    
    // 7. 주문 상세 정보 확인
    console.log('\n7️⃣ 주문 상세 정보 확인 중...');
    const orderDetails = await bunjangService.getBunjangOrderDetails(orderResult.id);
    
    if (orderDetails) {
      console.log('✅ 주문 상세 정보:');
      console.log(`   - 주문 ID: ${orderDetails.id}`);
      console.log(`   - 주문 상태: ${orderDetails.status}`);
      console.log(`   - 주문일: ${orderDetails.createdAt}`);
      console.log(`   - 총 금액: ${orderDetails.totalAmount?.toLocaleString()}원`);
      
      if (orderDetails.trackingNumber) {
        console.log(`   - 운송장번호: ${orderDetails.trackingNumber}`);
        console.log(`   - 배송업체: ${orderDetails.deliveryCompany}`);
      }
    }
    
    // 8. 최종 포인트 잔액 확인
    console.log('\n8️⃣ 구매 후 포인트 잔액 확인...');
    const finalBalance = await bunjangService.getBunjangPointBalance();
    
    if (finalBalance) {
      console.log(`   - 구매 후 잔액: ${finalBalance.balance?.toLocaleString()}원`);
      console.log(`   - 사용된 포인트: ${(pointBalance.balance - finalBalance.balance).toLocaleString()}원`);
    }
    
    console.log('\n🎉 구매 프로세스 완료!');
    console.log(`📦 상품: ${product.name}`);
    console.log(`💰 총 결제액: ${totalCost.toLocaleString()}원`);
    console.log(`📋 주문 ID: ${orderResult.id}`);
    console.log('📧 배송 관련 정보는 번개장터에서 확인하세요.');
    
  } catch (error) {
    console.error('❌ 구매 프로세스 중 오류 발생:', error.message);
    
    if (error.stack) {
      console.error('스택 트레이스:', error.stack);
    }
    
    // 에러 코드별 상세 메시지
    if (error.errorCode) {
      console.error(`에러 코드: ${error.errorCode}`);
      
      switch (error.errorCode) {
        case 'BUNJANG_ORDER_CREATE_V2_ERROR':
          console.error('번개장터 주문 생성 API 오류');
          break;
        case 'BUNJANG_ORDER_CONFIRM_ERROR':
          console.error('번개장터 주문 확정 API 오류');
          break;
        case 'EXTERNAL_SERVICE_FAILURE':
          console.error('번개장터 API 서비스 오류');
          break;
        default:
          console.error('알 수 없는 오류');
      }
    }
  } finally {
    rl.close();
  }
}

// 실행
if (require.main === module) {
  buyBunjangProductWithConfirmation().then(() => {
    console.log('\n✅ 스크립트 실행 완료');
    process.exit(0);
  }).catch(err => {
    console.error('❌ 스크립트 실행 실패:', err);
    process.exit(1);
  });
}

module.exports = { buyBunjangProductWithConfirmation }; 