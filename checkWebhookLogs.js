// checkWebhookLogs.js
// 최근 웹훅 처리 로그를 확인하는 스크립트

const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function checkWebhookLogs() {
  console.log('📋 웹훅 로그 확인 시작...\n');
  
  // 로그 디렉토리 경로
  const logDir = path.join(__dirname, 'logs');
  
  if (!fs.existsSync(logDir)) {
    console.log('❌ logs 디렉토리가 없습니다.');
    return;
  }
  
  // 오늘 날짜의 로그 파일
  const today = new Date().toISOString().split('T')[0];
  const logFiles = fs.readdirSync(logDir).filter(file => 
    file.includes(today) || file === 'bunjang-shopify-sync.log'
  );
  
  if (logFiles.length === 0) {
    console.log('❌ 오늘 날짜의 로그 파일이 없습니다.');
    return;
  }
  
  console.log(`✅ ${logFiles.length}개의 로그 파일 발견\n`);
  
  for (const logFile of logFiles) {
    console.log(`\n📄 파일: ${logFile}`);
    console.log('=' .repeat(60));
    
    const filePath = path.join(logDir, logFile);
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    const webhookLogs = [];
    const orderLogs = [];
    const errorLogs = [];
    
    for await (const line of rl) {
      // 웹훅 관련 로그
      if (line.includes('[Webhook]')) {
        webhookLogs.push(line);
      }
      
      // 주문 처리 관련 로그
      if (line.includes('[OrderSvc]') || line.includes('333572111')) {
        orderLogs.push(line);
      }
      
      // 에러 로그
      if (line.includes('[error]') || line.includes('Error')) {
        errorLogs.push(line);
      }
    }
    
    // 웹훅 로그 출력
    if (webhookLogs.length > 0) {
      console.log('\n🔔 웹훅 로그:');
      webhookLogs.slice(-10).forEach(log => {
        const simplified = log.replace(/.*\[Webhook\]/, '[Webhook]');
        console.log(`   ${simplified}`);
      });
    }
    
    // 주문 로그 출력
    if (orderLogs.length > 0) {
      console.log('\n📦 주문 처리 로그:');
      orderLogs.slice(-10).forEach(log => {
        const simplified = log.replace(/.*\[OrderSvc[^\]]*\]/, '[OrderSvc]');
        console.log(`   ${simplified}`);
      });
    }
    
    // 에러 로그 출력
    if (errorLogs.length > 0) {
      console.log('\n❌ 에러 로그:');
      errorLogs.slice(-5).forEach(log => {
        console.log(`   ${log.substring(0, 200)}...`);
      });
    }
  }
  
  // PM2 로그 확인 안내
  console.log('\n💡 PM2를 사용 중이라면 다음 명령어로 실시간 로그를 확인하세요:');
  console.log('   pm2 logs bunjang-shopify --lines 100');
  console.log('   pm2 logs bunjang-shopify --err');
}

// 실행
if (require.main === module) {
  checkWebhookLogs();
}