#!/bin/bash
# run-background.sh - 백그라운드 실행 스크립트

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 설정
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$SCRIPT_DIR"  # run-background.sh가 프로젝트 루트에 있으므로

# 로그 디렉토리를 홈 디렉토리로 변경
LOG_DIR="$HOME/logs"
LOG_FILE="$LOG_DIR/bunjang-check-loop.log"
PID_FILE="/tmp/bunjang-check-loop.pid"

# 로그 디렉토리 생성
mkdir -p "$LOG_DIR"

# 함수: 실행 중인지 확인
is_running() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p "$PID" > /dev/null; then
            return 0
        fi
    fi
    return 1
}

# 함수: 시작
start() {
    if is_running; then
        echo -e "${YELLOW}이미 실행 중입니다. PID: $(cat "$PID_FILE")${NC}"
        return 1
    fi
    
    echo -e "${GREEN}번개장터 체크 루프를 시작합니다...${NC}"
    
    # 로그 파일 생성 (홈 디렉토리에)
    touch "$LOG_FILE"
    chmod 644 "$LOG_FILE"
    
    # nohup으로 백그라운드 실행
    cd "$PROJECT_DIR"
    nohup node src/scripts/bunjangCheckLoop.js >> "$LOG_FILE" 2>&1 &
    
    # PID 저장
    echo $! > "$PID_FILE"
    
    sleep 2
    
    if is_running; then
        echo -e "${GREEN}✅ 성공적으로 시작되었습니다. PID: $(cat "$PID_FILE")${NC}"
        echo -e "${GREEN}로그 파일: $LOG_FILE${NC}"
        echo -e "${GREEN}로그 확인: tail -f $LOG_FILE${NC}"
        return 0
    else
        echo -e "${RED}❌ 시작에 실패했습니다. 로그를 확인하세요.${NC}"
        echo -e "${RED}로그 확인: tail -n 50 $LOG_FILE${NC}"
        return 1
    fi
}

# 함수: 중지
stop() {
    if ! is_running; then
        echo -e "${YELLOW}실행 중이 아닙니다.${NC}"
        return 1
    fi
    
    PID=$(cat "$PID_FILE")
    echo -e "${YELLOW}프로세스를 중지합니다... PID: $PID${NC}"
    
    kill "$PID"
    sleep 2
    
    if is_running; then
        echo -e "${YELLOW}강제 종료합니다...${NC}"
        kill -9 "$PID"
    fi
    
    rm -f "$PID_FILE"
    echo -e "${GREEN}✅ 중지되었습니다.${NC}"
}

# 함수: 상태 확인
status() {
    if is_running; then
        PID=$(cat "$PID_FILE")
        echo -e "${GREEN}● 실행 중 - PID: $PID${NC}"
        echo ""
        echo "프로세스 정보:"
        ps -p "$PID" -o pid,user,cmd,etime,pcpu,pmem
        echo ""
        echo "로그 파일: $LOG_FILE"
        echo ""
        echo "최근 로그:"
        tail -n 10 "$LOG_FILE"
    else
        echo -e "${RED}● 중지됨${NC}"
        echo ""
        echo "로그 파일: $LOG_FILE"
    fi
}

# 함수: 재시작
restart() {
    stop
    sleep 1
    start
}

# 함수: 로그 보기
logs() {
    if [ -f "$LOG_FILE" ]; then
        echo "로그 파일: $LOG_FILE"
        echo "실시간 로그 (Ctrl+C로 종료):"
        echo ""
        tail -f "$LOG_FILE"
    else
        echo -e "${RED}로그 파일이 없습니다: $LOG_FILE${NC}"
    fi
}

# 메인 명령 처리
case "$1" in
    start)
        start
        ;;
    stop)
        stop
        ;;
    restart)
        restart
        ;;
    status)
        status
        ;;
    logs)
        logs
        ;;
    *)
        echo "사용법: $0 {start|stop|restart|status|logs}"
        echo ""
        echo "명령어:"
        echo "  start    - 백그라운드에서 시작"
        echo "  stop     - 중지"
        echo "  restart  - 재시작"
        echo "  status   - 상태 확인"
        echo "  logs     - 실시간 로그 보기"
        exit 1
        ;;
esac
