/// src/models/syncedProduct.model.js
const mongoose = require('mongoose');

const syncedProductSchema = new mongoose.Schema({
  bunjangPid: {
    type: String, 
    required: true, 
    unique: true, 
    index: true, 
    trim: true,
  },
  shopifyGid: {
    type: String, 
    unique: true, 
    sparse: true, 
    index: true, 
    trim: true,
  },
  shopifyProductId: {
    type: String, 
    index: true, 
    sparse: true, 
    trim: true,
  },
  shopifyHandle: {
    type: String, 
    index: true, 
    sparse: true, 
    trim: true,
  },
  
  // Shopify 데이터 저장 (태그 포함)
  shopifyData: {
    id: String,
    title: String,
    handle: String,
    status: String,
    sku: String,
    tags: [String]
  },
  
  // 번개장터 원본 정보
  bunjangProductName: { type: String, trim: true },
  bunjangCategoryId: { type: String, index: true, trim: true },
  bunjangBrandId: { type: String, index: true, trim: true },
  bunjangSellerUid: { type: String, index: true, trim: true },
  bunjangCondition: { type: String, trim: true },
  bunjangOriginalPriceKrw: { type: Number },
  bunjangOriginalShippingFeeKrw: { type: Number },
  bunjangQuantity: { type: Number, default: 1 },
  bunjangOptionsJson: { type: String },
  bunjangImagesJson: { type: String },
  bunjangKeywordsJson: { type: String },
  bunjangCreatedAt: { type: Date },
  bunjangUpdatedAt: { type: Date, index: true },

  // Shopify 연동 정보
  shopifyProductType: { type: String, index: true, trim: true },
  shopifyListedPriceUsd: { type: String },
  shopifyStatus: { 
    type: String, 
    enum: ['ACTIVE', 'DRAFT', 'ARCHIVED', 'SOLD_OUT'],
    index: true 
  },

  // 동기화 상태 및 이력
  lastSyncAttemptAt: { type: Date, default: Date.now, index: true },
  lastSuccessfulSyncAt: { type: Date, index: true },
  lastSyncedAt: { type: Date, index: true },
  lastInventorySyncAt: { type: Date },
  syncStatus: {
    type: String,
    enum: ['SYNCED', 'ERROR', 'PENDING', 'PARTIAL_ERROR', 'SKIPPED_NO_CHANGE', 'SKIPPED_FILTER', 'PROCESSING'],
    default: 'PENDING',
    index: true,
  },
  syncErrorMessage: { type: String, maxlength: 1000 },
  syncErrorStackSample: { type: String, maxlength: 2000 },
  syncAttemptCount: { type: Number, default: 0 },
  syncSuccessCount: { type: Number, default: 0 },
  syncRetryCount: { type: Number, default: 0, index: true },
  
  // 동시성 제어 필드 (신규)
  processingStatus: {
    type: String,
    enum: ['idle', 'processing', 'completed', 'failed'],
    default: 'idle',
    index: true
  },
  processingStartedAt: { type: Date },
  processingJobId: { type: String },
  processingLockExpiry: { type: Date }, // 락 만료 시간
  
  // 판매 상태 관리 필드
  soldFrom: {
    type: String,
    enum: ['shopify', 'bunjang', 'both', null],
    default: null,
    index: true
  },
  soldAt: { type: Date, index: true },
  shopifySoldAt: { type: Date },
  bunjangSoldAt: { type: Date },
  pendingBunjangOrder: { type: Boolean, default: false, index: true },
  
  // 번개장터 주문 정보
  bunjangOrderIds: [String],
  lastBunjangOrderId: String,
  
  // 추가 관리 필드
  isFilteredOut: { type: Boolean, default: false, index: true },
  notes: { type: String, maxlength: 500 },
  tags: [String], // 추가 태그 저장

}, {
  timestamps: true, // createdAt, updatedAt
  versionKey: false,
  minimize: false,
});

// 복합 인덱스
syncedProductSchema.index({ syncStatus: 1, lastSyncAttemptAt: -1 });
syncedProductSchema.index({ shopifyProductType: 1, shopifyListedPriceUsd: 1 });
syncedProductSchema.index({ soldFrom: 1, soldAt: -1 });
syncedProductSchema.index({ pendingBunjangOrder: 1, shopifySoldAt: -1 });
syncedProductSchema.index({ processingStatus: 1, processingStartedAt: 1 }); // 동시성 제어용

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

syncedProductSchema.methods.isLocked = function() {
  if (this.processingStatus !== 'processing') return false;
  if (!this.processingLockExpiry) return false;
  return new Date() < this.processingLockExpiry;
};

// 가상 필드
syncedProductSchema.virtual('displayStatus').get(function() {
  if (this.soldFrom === 'both') return 'SOLD OUT (Both Platforms)';
  if (this.soldFrom === 'shopify') return 'Sold on Shopify';
  if (this.soldFrom === 'bunjang') return 'Sold on Bunjang';
  if (this.shopifyStatus === 'SOLD_OUT') return 'SOLD OUT';
  return this.shopifyStatus || 'UNKNOWN';
});

// 정적 메서드: 동시성 제어
syncedProductSchema.statics.acquireLock = async function(bunjangPid, jobId, lockDurationMs = 60000) {
  const lockExpiry = new Date(Date.now() + lockDurationMs);
  
  const result = await this.findOneAndUpdate(
    { 
      bunjangPid,
      $or: [
        { processingStatus: { $ne: 'processing' } },
        { processingLockExpiry: { $lt: new Date() } }
      ]
    },
    {
      $set: {
        processingStatus: 'processing',
        processingStartedAt: new Date(),
        processingJobId: jobId,
        processingLockExpiry: lockExpiry
      }
    },
    { new: true }
  );
  
  return result; // null이면 락 획득 실패
};

syncedProductSchema.statics.releaseLock = async function(bunjangPid, status = 'idle') {
  return await this.findOneAndUpdate(
    { bunjangPid },
    {
      $set: {
        processingStatus: status,
        processingLockExpiry: null
      }
    }
  );
};

// 정적 메서드: 중복 체크
syncedProductSchema.statics.findDuplicates = async function() {
  return await this.aggregate([
    {
      $group: {
        _id: '$bunjangPid',
        count: { $sum: 1 },
        docs: { $push: { _id: '$_id', createdAt: '$createdAt' } }
      }
    },
    {
      $match: {
        count: { $gt: 1 }
      }
    },
    {
      $sort: {
        count: -1
      }
    }
  ]);
};

// 정적 메서드: 오래된 처리 중 상태 정리
syncedProductSchema.statics.cleanupStuckProcessing = async function(timeoutMs = 30 * 60 * 1000) {
  const timeout = new Date(Date.now() - timeoutMs);
  
  return await this.updateMany(
    {
      processingStatus: 'processing',
      processingStartedAt: { $lt: timeout }
    },
    {
      $set: {
        processingStatus: 'failed',
        syncErrorMessage: 'Processing timeout - cleaned up by system'
      }
    }
  );
};

const SyncedProduct = mongoose.model('SyncedProduct', syncedProductSchema);

module.exports = SyncedProduct;