# HALLYUSTOREWITHBUNJANGPRODUCT

번개장터와 Shopify를 연동하는 미들웨어 시스템입니다.

## 번개장터 상품 구매 스크립트

이 프로젝트에는 번개장터 API를 통해 상품을 구매할 수 있는 스크립트들이 포함되어 있습니다.

### 📦 구매 스크립트 목록

1. **`buyBunjangProduct.js`** - 자동 구매 스크립트
2. **`buyBunjangProductWithConfirmation.js`** - 사용자 확인을 받는 구매 스크립트
3. **`testBunjangProductInfo.js`** - 상품 정보 조회 테스트 스크립트
4. **`buyBunjangProductFixed.js`** - 배송비 오류 수정 버전
5. **`buyBunjangProductZeroDelivery.js`** - 배송비 0 설정 버전

### 🚀 사용법

#### 1. 상품 정보 조회 테스트 (안전함)
```bash
node testBunjangProductInfo.js
```
- 실제 구매 없이 상품 정보와 포인트 잔액만 확인
- 구매 가능 여부를 미리 판단할 수 있음

#### 2. 자동 구매 (주의 필요)
```bash
node buyBunjangProduct.js
```
- 사용자 확인 없이 자동으로 구매 진행
- **실제로 번개 포인트가 차감됩니다!**
- 테스트 목적으로만 사용 권장

#### 3. 확인 후 구매 (권장)
```bash
node buyBunjangProductWithConfirmation.js
```
- 각 단계마다 사용자 확인을 받음
- 배송지 정보, 구매 금액 등을 확인 후 진행
- **가장 안전한 방법**

### ⚙️ 설정

구매 스크립트를 사용하기 전에 다음 환경 변수가 설정되어야 합니다:

```env
# 번개장터 API 설정
BUNJANG_API_GENERAL_URL=https://openapi.bunjang.co.kr
BUNJANG_API_ACCESS_KEY=your_access_key
BUNJANG_API_SECRET_KEY=your_secret_key

# 배송지 정보
CS_TRADING_BUNJANG_RECIPIENT_NAME_1=수령인명
CS_TRADING_BUNJANG_SHIPPING_ADDRESS=배송지주소
CS_TRADING_BUNJANG_ZIP_CODE=우편번호
CS_TRADING_BUNJANG_PHONE=연락처
```

### 🔧 스크립트 수정

다른 상품을 구매하려면 스크립트 상단의 `TARGET_PID` 값을 변경하세요:

```javascript
const TARGET_PID = '342351629'; // 원하는 상품 PID로 변경
```

### ⚠️ 주의사항

1. **실제 구매**: 이 스크립트들은 실제로 번개장터에서 상품을 구매합니다
2. **포인트 차감**: 번개 포인트가 실제로 차감됩니다
3. **되돌릴 수 없음**: 주문 확정 후에는 취소할 수 없습니다
4. **API 키 보안**: API 키가 노출되지 않도록 주의하세요

### 📋 구매 프로세스

1. **상품 정보 조회** - 상품의 가격, 상태, 재고 확인
2. **포인트 잔액 확인** - 구매 가능한 포인트가 있는지 확인
3. **배송지 정보 확인** - 배송지 정보가 올바른지 확인
4. **주문 생성** - 번개장터 API로 주문 생성
5. **주문 확정** - 주문을 확정하여 구매 완료
6. **결과 확인** - 주문 상세 정보와 포인트 잔액 확인

### 🐛 문제 해결

#### 포인트 잔액 부족
- 번개장터에서 포인트를 충전하세요
- 충전 후 스크립트를 다시 실행하세요

#### 상품이 판매 중이 아님
- 상품이 이미 판매되었거나 재고가 없을 수 있습니다
- 다른 상품을 찾아보세요

#### API 오류
- API 키가 올바른지 확인하세요
- 네트워크 연결을 확인하세요
- 번개장터 API 서비스 상태를 확인하세요

### 📞 지원

문제가 발생하면 로그를 확인하고 개발팀에 문의하세요.