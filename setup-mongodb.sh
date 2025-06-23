#!/bin/bash

# MongoDB 설치 및 연결 확인 스크립트
# 실행 방법: chmod +x setup-mongodb.sh && ./setup-mongodb.sh

echo "============================================"
echo "MongoDB 설치 및 연결 확인 스크립트"
echo "============================================"
echo ""

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 환경변수 로드
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
    echo -e "${GREEN}✓ .env 파일을 로드했습니다.${NC}"
else
    echo -e "${RED}✗ .env 파일을 찾을 수 없습니다!${NC}"
    exit 1
fi

# MongoDB 연결 문자열 확인
if [ -z "$DB_CONNECTION_STRING" ]; then
    echo -e "${YELLOW}⚠ DB_CONNECTION_STRING이 설정되지 않았습니다. 기본값을 사용합니다.${NC}"
    DB_CONNECTION_STRING="mongodb://localhost:27017/bunjangShopifyIntegrationDB_dev"

echo "MongoDB 연결 문자열: $DB_CONNECTION_STRING"
echo ""

# 운영 체제 확인
OS="$(uname -s)"
case "${OS}" in
    Linux*)     SYSTEM=Linux;;
    Darwin*)    SYSTEM=Mac;;
    CYGWIN*)    SYSTEM=Windows;;
    MINGW*)     SYSTEM=Windows;;
    *)          SYSTEM="UNKNOWN:${OS}"
esac

echo "운영 체제: $SYSTEM"
echo ""

# MongoDB 설치 확인
echo "1. MongoDB 설치 확인..."
if command -v mongod &> /dev/null; then
    echo -e "${GREEN}✓ MongoDB가 이미 설치되어 있습니다.${NC}"
    mongod --version | head -n 1
else
    echo -e "${RED}✗ MongoDB가 설치되어 있지 않습니다.${NC}"
    echo ""
    echo "MongoDB 설치 방법:"
    
    case "${SYSTEM}" in
        Mac)
            echo "  brew tap mongodb/brew"
            echo "  brew install mongodb-community"
            echo "  brew services start mongodb-community"
            ;;
        Linux)
            echo "Ubuntu/Debian:"
            echo "  wget -qO - https://www.mongodb.org/static/pgp/server-6.0.asc | sudo apt-key add -"
            echo "  echo \"deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu focal/mongodb-org/6.0 multiverse\" | sudo tee /etc/apt/sources.list.d/mongodb-org-6.0.list"
            echo "  sudo apt-get update"
            echo "  sudo apt-get install -y mongodb-org"
            echo "  sudo systemctl start mongod"
            echo "  sudo systemctl enable mongod"
            ;;
        Windows)
            echo "Windows에서는 MongoDB 공식 웹사이트에서 설치 프로그램을 다운로드하세요:"
            echo "https://www.mongodb.com/try/download/community"
            ;;
    esac
    
    echo ""
    read -p "MongoDB를 설치한 후 Enter를 누르세요..."
fi

echo ""

# MongoDB 서비스 상태 확인
echo "2. MongoDB 서비스 상태 확인..."
case "${SYSTEM}" in
    Mac)
        if brew services list | grep mongodb-community | grep started &> /dev/null; then
            echo -e "${GREEN}✓ MongoDB 서비스가 실행 중입니다.${NC}"
        else
            echo -e "${YELLOW}⚠ MongoDB 서비스가 실행되지 않고 있습니다.${NC}"
            echo "실행 명령: brew services start mongodb-community"
            brew services start mongodb-community
        fi
        ;;
    Linux)
        if systemctl is-active --quiet mongod; then
            echo -e "${GREEN}✓ MongoDB 서비스가 실행 중입니다.${NC}"
        else
            echo -e "${YELLOW}⚠ MongoDB 서비스가 실행되지 않고 있습니다.${NC}"
            echo "실행 명령: sudo systemctl start mongod"
            sudo systemctl start mongod
        fi
        ;;
    Windows)
        echo "Windows에서는 서비스 관리자에서 MongoDB 서비스 상태를 확인하세요."
        ;;
esac

echo ""

# MongoDB 연결 테스트
echo "3. MongoDB 연결 테스트..."
echo "연결 중..."

# Node.js 스크립트로 연결 테스트
cat > test-connection.js << 'EOF'
const mongoose = require('mongoose');

const connectionString = process.env.DB_CONNECTION_STRING || 'mongodb://localhost:27017/bunjangShopifyIntegrationDB_dev';

async function testConnection() {
    try {
        console.log('MongoDB에 연결 중...');
        await mongoose.connect(connectionString, {
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS: 10000
        });
        
        console.log('\x1b[32m✓ MongoDB 연결 성공!\x1b[0m');
        
        // 데이터베이스 정보 확인
        const db = mongoose.connection.db;
        const admin = db.admin();
        const dbInfo = await admin.listDatabases();
        
        console.log('\n데이터베이스 목록:');
        dbInfo.databases.forEach(db => {
            console.log(`  - ${db.name} (${(db.sizeOnDisk / 1024 / 1024).toFixed(2)} MB)`);
        });
        
        // 현재 데이터베이스의 컬렉션 확인
        const collections = await db.listCollections().toArray();
        console.log(`\n현재 데이터베이스 (${db.databaseName}) 컬렉션:`);
        if (collections.length === 0) {
            console.log('  - (아직 컬렉션이 없습니다)');
        } else {
            for (const collection of collections) {
                const count = await db.collection(collection.name).countDocuments();
                console.log(`  - ${collection.name}: ${count} 문서`);
            }
        }
        
        await mongoose.disconnect();
        console.log('\n\x1b[32m✓ 연결 테스트 완료!\x1b[0m');
        process.exit(0);
        
    } catch (error) {
        console.error('\x1b[31m✗ MongoDB 연결 실패:\x1b[0m', error.message);
        process.exit(1);
    }
}

testConnection();
EOF

# npm 패키지 확인
if ! npm list mongoose &> /dev/null; then
    echo "mongoose 패키지 설치 중..."
    npm install mongoose
fi

# 연결 테스트 실행
node test-connection.js
TEST_RESULT=$?

# 임시 파일 삭제
rm -f test-connection.js

echo ""

if [ $TEST_RESULT -eq 0 ]; then
    echo -e "${GREEN}============================================${NC}"
    echo -e "${GREEN}✓ MongoDB 설정이 완료되었습니다!${NC}"
    echo -e "${GREEN}============================================${NC}"
else
    echo -e "${RED}============================================${NC}"
    echo -e "${RED}✗ MongoDB 연결에 실패했습니다.${NC}"
    echo -e "${RED}============================================${NC}"
    echo ""
    echo "확인 사항:"
    echo "1. MongoDB 서비스가 실행 중인지 확인하세요"
    echo "2. .env 파일의 DB_CONNECTION_STRING이 올바른지 확인하세요"
    echo "3. 방화벽이 MongoDB 포트(27017)를 차단하고 있지 않은지 확인하세요"
fi

echo ""
echo "서버 실행: npm start"
echo ""
