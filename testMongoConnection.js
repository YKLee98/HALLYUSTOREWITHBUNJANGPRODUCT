// testMongoConnection.js
// MongoDB 연동이 제대로 되어있는지 테스트하는 스크립트

const mongoose = require('mongoose');
const config = require('./src/config');
const logger = require('./src/config/logger');

async function testMongoConnection() {
  console.log('🔍 MongoDB 연동 테스트 시작...\n');
  
  try {
    // 1. 연결 문자열 확인
    console.log('1️⃣ MongoDB 연결 문자열 확인');
    console.log(`   연결 문자열: ${config.database.connectionString}`);
    console.log(`   환경: ${process.env.NODE_ENV || 'development'}\n`);
    
    // 2. 연결 시도
    console.log('2️⃣ MongoDB 연결 시도...');
    await mongoose.connect(config.database.connectionString, config.database.options);
    console.log('   ✅ MongoDB 연결 성공!\n');
    
    // 3. 데이터베이스 정보 확인
    console.log('3️⃣ 데이터베이스 정보');
    const db = mongoose.connection.db;
    console.log(`   데이터베이스명: ${db.databaseName}`);
    
    // 4. 컬렉션 목록 확인
    console.log('\n4️⃣ 컬렉션 목록');
    const collections = await db.listCollections().toArray();
    
    if (collections.length === 0) {
      console.log('   ⚠️  컬렉션이 없습니다.');
    } else {
      for (const collection of collections) {
        const count = await db.collection(collection.name).countDocuments();
        console.log(`   - ${collection.name}: ${count}개 문서`);
      }
    }
    
    // 5. SyncedProduct 모델 테스트
    console.log('\n5️⃣ SyncedProduct 모델 테스트');
    const SyncedProduct = require('./src/models/syncedProduct.model');
    
    // 전체 문서 수
    const totalCount = await SyncedProduct.countDocuments();
    console.log(`   전체 동기화된 상품 수: ${totalCount}개`);
    
    // 상태별 통계
    const statusStats = await SyncedProduct.aggregate([
      { $group: { _id: '$syncStatus', count: { $sum: 1 } } }
    ]);
    
    console.log('   상태별 통계:');
    statusStats.forEach(stat => {
      console.log(`     - ${stat._id || 'NULL'}: ${stat.count}개`);
    });
    
    // 판매 상태 통계
    const soldStats = await SyncedProduct.aggregate([
      { $match: { soldFrom: { $ne: null } } },
      { $group: { _id: '$soldFrom', count: { $sum: 1 } } }
    ]);
    
    if (soldStats.length > 0) {
      console.log('   판매 상태 통계:');
      soldStats.forEach(stat => {
        console.log(`     - ${stat._id}: ${stat.count}개`);
      });
    }
    
    // 6. 연결 상태 확인
    console.log('\n6️⃣ 연결 상태 확인');
    console.log(`   ReadyState: ${mongoose.connection.readyState}`);
    console.log(`   - 0: disconnected`);
    console.log(`   - 1: connected ✅`);
    console.log(`   - 2: connecting`);
    console.log(`   - 3: disconnecting`);
    
    // 7. 최근 동기화된 상품 확인
    console.log('\n7️⃣ 최근 동기화된 상품 (최근 5개)');
    const recentProducts = await SyncedProduct.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select('bunjangPid shopifyGid bunjangProductName createdAt syncStatus');
    
    if (recentProducts.length === 0) {
      console.log('   ⚠️  최근 동기화된 상품이 없습니다.');
    } else {
      recentProducts.forEach((product, index) => {
        console.log(`   ${index + 1}. PID: ${product.bunjangPid}`);
        console.log(`      이름: ${product.bunjangProductName}`);
        console.log(`      상태: ${product.syncStatus}`);
        console.log(`      생성일: ${product.createdAt}`);
        console.log('');
      });
    }
    
    console.log('✅ MongoDB 연동 테스트 완료!');
    
  } catch (error) {
    console.error('❌ MongoDB 연동 테스트 실패:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 MongoDB 연결 종료');
  }
}

// 실행
if (require.main === module) {
  testMongoConnection();
}