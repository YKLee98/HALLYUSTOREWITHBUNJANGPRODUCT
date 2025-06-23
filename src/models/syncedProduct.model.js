// src/models/syncedProduct.model.js
const mongoose = require('mongoose');

const syncedProductSchema = new mongoose.Schema({
  bunjangPid: {
    type: String, required: true, unique: true, index: true, trim: true,
  },
  shopifyGid: { // 예: "gid://shopify/Product/1234567890"
    type: String, unique: true, sparse: true, index: true, trim: true,
  },
  shopifyProductId: { // 예: "1234567890" (숫자 ID)
    type: String, index: true, sparse: true, trim: true,
  },
  shopifyHandle: {
    type: String, index: true, sparse: true, trim: true,
  },
  
  // Shopify 데이터 저장 (태그 포함)
  shopifyData: {
    id: String,
    title: String,
    handle: String,
    tags: [String] // 태그 배열 추가
  },
  
  // 번개장터 원본 정보 (참고 및 동기화 비교용)
  bunjangProductName: { type: String, trim: true },
  bunjangCategoryId: { type: String, index: true, trim: true },
  bunjangBrandId: { type: String, index: true, trim: true },
  bunjangSellerUid: { type: String, index: true, trim: true },
  bunjangCondition: { type: String, trim: true },
  bunjangOriginalPriceKrw: { type: Number },
  bunjangOriginalShippingFeeKrw: { type: Number },
  bunjangQuantity: { type: Number }, // 카탈로그 기준 재고
  bunjangOptionsJson: { type: String }, // 번개장터 옵션 원본 JSON 문자열
  bunjangImagesJson: { type: String }, // 번개장터 이미지 URL 목록 원본 JSON 문자열
  bunjangKeywordsJson: { type: String }, // 번개장터 키워드 목록 원본 JSON 문자열
  bunjangCreatedAt: { type: Date }, // 번개장터 상품 생성 시간 (KST)
  bunjangUpdatedAt: { type: Date, index: true }, // 번개장터 상품 수정 시간 (KST, 카탈로그 기준)

  // Shopify 연동 정보
  shopifyProductType: { type: String, index: true, trim: true }, // 매핑된 Shopify 상품 유형
  shopifyListedPriceUsd: { type: String }, // Shopify에 리스팅된 USD 가격 문자열 (예: "25.99")
  shopifyStatus: { 
    type: String, 
    enum: ['ACTIVE', 'DRAFT', 'ARCHIVED', 'SOLD_OUT'], // SOLD_OUT 추가
    index: true 
  },

  // 동기화 상태 및 이력
  lastSyncAttemptAt: { type: Date, default: Date.now, index: true },
  lastSuccessfulSyncAt: { type: Date, index: true },
  lastSyncedAt: { type: Date, index: true }, // 추가 (호환성)
  syncStatus: {
    type: String,
    enum: ['SYNCED', 'ERROR', 'PENDING', 'PARTIAL_ERROR', 'SKIPPED_NO_CHANGE'],
    default: 'PENDING',
    index: true,
  },
  syncErrorMessage: { type: String, maxlength: 1000 },
  syncErrorStackSample: { type: String, maxlength: 2000 },
  syncRetryCount: { type: Number, default: 0, index: true },
  
  // 판매 상태 관리 필드 (신규 추가)
  soldFrom: {
    type: String,
    enum: ['shopify', 'bunjang', 'both', null],
    default: null,
    index: true
  },
  soldAt: { type: Date, index: true }, // 판매 완료 시간
  shopifySoldAt: { type: Date }, // Shopify에서 판매된 시간
  bunjangSoldAt: { type: Date }, // 번개장터에서 판매된 시간
  pendingBunjangOrder: { type: Boolean, default: false, index: true }, // 번개장터 주문 대기 중
  
  // 번개장터 주문 정보
  bunjangOrderIds: [String], // 관련 번개장터 주문 ID들
  lastBunjangOrderId: String, // 마지막 번개장터 주문 ID
  
  // 추가적인 내부 관리 필드
  isFilteredOut: { type: Boolean, default: false, index: true }, // 카테고리 등으로 필터링 아웃된 상품 표시
  notes: { type: String, maxlength: 500 }, // 관리자 메모

}, {
  timestamps: true, // createdAt, updatedAt (Mongoose 문서 자체의 생성/수정 시간)
  versionKey: false,
  minimize: false, // 빈 객체도 저장 (bunjangOptions 등)
});

// 복합 인덱스
syncedProductSchema.index({ syncStatus: 1, lastSyncAttemptAt: -1 }); // 특정 상태의 오래된 시도 찾기
syncedProductSchema.index({ shopifyProductType: 1, shopifyListedPriceUsd: 1 }); // App Proxy 검색용
syncedProductSchema.index({ soldFrom: 1, soldAt: -1 }); // 판매 상태별 검색
syncedProductSchema.index({ pendingBunjangOrder: 1, shopifySoldAt: -1 }); // 번개장터 주문 대기 중인 상품

// 텍스트 인덱스 (검색용)
syncedProductSchema.index({ 
  bunjangProductName: 'text', 
  'shopifyData.title': 'text', 
  bunjangKeywordsJson: 'text' 
});

// 메서드 추가
syncedProductSchema.methods.isSoldOut = function() {
  return this.shopifyStatus === 'SOLD_OUT' || this.soldFrom === 'both';
};

syncedProductSchema.methods.needsBunjangOrder = function() {
  return this.pendingBunjangOrder && !this.bunjangOrderIds?.length;
};

// 가상 필드
syncedProductSchema.virtual('displayStatus').get(function() {
  if (this.soldFrom === 'both') return 'SOLD OUT (Both Platforms)';
  if (this.soldFrom === 'shopify') return 'Sold on Shopify';
  if (this.soldFrom === 'bunjang') return 'Sold on Bunjang';
  if (this.shopifyStatus === 'SOLD_OUT') return 'SOLD OUT';
  return this.shopifyStatus || 'UNKNOWN';
});

const SyncedProduct = mongoose.model('SyncedProduct', syncedProductSchema);

module.exports = SyncedProduct;