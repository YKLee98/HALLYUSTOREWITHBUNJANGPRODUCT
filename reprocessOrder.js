// reprocessOrder.js
const mongoose = require('mongoose');
const config = require('./src/config');
const orderService = require('./src/services/orderService');
const logger = require('./src/config/logger');

async function reprocessOrder(orderId) {
  try {
    // MongoDB 연결
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(config.database.connectionString, config.database.options);
    console.log('✅ MongoDB connected successfully\n');
    
    // 주문 재처리
    console.log(`📦 Reprocessing order ${orderId}...`);
    const result = await orderService.reprocessShopifyOrder(orderId);
    
    console.log('\n✨ Success:', result);
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.stack) {
      console.error('Stack:', error.stack);
    }
  } finally {
    // MongoDB 연결 종료
    await mongoose.disconnect();
    console.log('\n🔌 MongoDB disconnected');
  }
}

// 명령줄 인자 확인
const orderId = process.argv[2] || '6244371464441';

// 실행
reprocessOrder(orderId);