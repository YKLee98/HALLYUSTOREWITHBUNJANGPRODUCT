// src/jobs/cleanupJob.js (새 파일)
const { Worker } = require('bullmq');
const SyncedProduct = require('../models/syncedProduct.model');
const logger = require('../config/logger');
// src/jobs/cleanupJob.js
const cron = require('node-cron');

// 30분마다 실행
cron.schedule('*/30 * * * *', async () => {
  await SyncedProduct.cleanupStuckProcessing();
  const duplicates = await SyncedProduct.findDuplicates();
  // 중복 처리 로직
});
// 오래된 처리 중 상태 정리
async function cleanupStuckProcessing() {
  const timeout = 30 * 60 * 1000; // 30분
  const stuckProducts = await SyncedProduct.updateMany(
    {
      processingStatus: 'processing',
      processingStartedAt: { $lt: new Date(Date.now() - timeout) }
    },
    {
      $set: {
        processingStatus: 'failed',
        syncErrorMessage: 'Processing timeout'
      }
    }
  );
  
  logger.info(`[Cleanup] Reset ${stuckProducts.modifiedCount} stuck products`);
}

// 중복 상품 확인 및 정리
async function findAndRemoveDuplicates() {
  const duplicates = await SyncedProduct.aggregate([
    {
      $group: {
        _id: '$bunjangPid',
        count: { $sum: 1 },
        ids: { $push: '$_id' }
      }
    },
    {
      $match: {
        count: { $gt: 1 }
      }
    }
  ]);
  
  for (const dup of duplicates) {
    logger.warn(`[Cleanup] Found ${dup.count} duplicates for bunjangPid: ${dup._id}`);
    // 가장 최근 것만 남기고 삭제
    const [keep, ...remove] = dup.ids;
    await SyncedProduct.deleteMany({ _id: { $in: remove } });
  }
}