#!/bin/bash

# 색상 코드 정의
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 스크립트 이름
SCRIPT_NAME=$(basename "$0")

# 로그 함수
log() {
    echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# ngrok 설치 확인
check_ngrok() {
    if ! command -v ngrok &> /dev/null; then
        error "ngrok이 설치되어 있지 않습니다. 먼저 ngrok을 설치해주세요."
        exit 1
    fi
}

# 기존 ngrok 프로세스 종료
kill_existing_ngrok() {
    log "기존 ngrok 프로세스 확인 중..."
    
    # pgrep으로 ngrok 프로세스 찾기
    local pids=$(pgrep -f "ngrok http")
    
    if [ -n "$pids" ]; then
        warning "기존 ngrok 프로세스를 종료합니다: PID $pids"
        kill -9 $pids 2>/dev/null
        sleep 2
    else
        log "실행 중인 ngrok 프로세스가 없습니다."
    fi
}

# ngrok 백그라운드 실행
start_ngrok() {
    local port=${1:-3000}
    
    log "ngrok을 포트 $port에서 백그라운드로 시작합니다..."
    
    # ngrok을 백그라운드에서 실행하고 로그를 파일로 저장
    nohup ngrok http $port > /tmp/ngrok.log 2>&1 &
    
    local ngrok_pid=$!
    
    # ngrok이 시작될 때까지 대기
    log "ngrok 시작 대기 중..."
    sleep 3
    
    # 프로세스가 실행 중인지 확인
    if ! ps -p $ngrok_pid > /dev/null; then
        error "ngrok 시작 실패. 로그를 확인하세요: /tmp/ngrok.log"
        cat /tmp/ngrok.log
        exit 1
    fi
    
    log "ngrok PID: $ngrok_pid"
    echo $ngrok_pid > /tmp/ngrok.pid
}

# ngrok API를 통해 터널 정보 가져오기
get_tunnel_info() {
    local max_attempts=10
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        # ngrok의 로컬 API 엔드포인트 확인
        local tunnel_info=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null)
        
        if [ -n "$tunnel_info" ] && [ "$tunnel_info" != "null" ]; then
            # JSON에서 public_url 추출 (https URL 우선)
            local https_url=$(echo "$tunnel_info" | grep -o '"public_url":"https://[^"]*' | cut -d'"' -f4 | head -1)
            local http_url=$(echo "$tunnel_info" | grep -o '"public_url":"http://[^"]*' | cut -d'"' -f4 | head -1)
            
            if [ -n "$https_url" ]; then
                echo "$https_url"
                return 0
            elif [ -n "$http_url" ]; then
                echo "$http_url"
                return 0
            fi
        fi
        
        log "터널 정보 대기 중... (시도 $attempt/$max_attempts)"
        sleep 1
        ((attempt++))
    done
    
    return 1
}

# 메인 함수
main() {
    local port=${1:-3000}
    
    log "ngrok 백그라운드 실행 스크립트 시작"
    
    # ngrok 설치 확인
    check_ngrok
    
    # 기존 프로세스 종료
    kill_existing_ngrok
    
    # ngrok 시작
    start_ngrok $port
    
    # 터널 정보 가져오기
    log "터널 정보를 가져오는 중..."
    local forwarding_url=$(get_tunnel_info)
    
    if [ -n "$forwarding_url" ]; then
        log "ngrok이 성공적으로 시작되었습니다!"
        echo ""
        echo "=========================================="
        echo -e "${GREEN}Forwarding URL:${NC} $forwarding_url"
        echo -e "${GREEN}Local Port:${NC} $port"
        echo -e "${GREEN}Process ID:${NC} $(cat /tmp/ngrok.pid)"
        echo "=========================================="
        echo ""
        
        # URL을 파일에 저장 (다른 스크립트에서 사용할 수 있도록)
        echo "$forwarding_url" > /tmp/ngrok_url.txt
        
        # 클립보드에 복사 (xclip이 설치되어 있는 경우)
        if command -v xclip &> /dev/null; then
            echo -n "$forwarding_url" | xclip -selection clipboard
            log "URL이 클립보드에 복사되었습니다."
        fi
        
        # 환경 변수로 export (현재 셸에서는 작동하지 않음)
        echo "export NGROK_URL=$forwarding_url" > /tmp/ngrok_env.sh
        log "환경 변수 설정: source /tmp/ngrok_env.sh"
        
    else
        error "터널 정보를 가져올 수 없습니다."
        error "로그 확인: /tmp/ngrok.log"
        cat /tmp/ngrok.log
        exit 1
    fi
}

# 종료 스크립트
stop_ngrok() {
    log "ngrok 프로세스를 종료합니다..."
    
    if [ -f /tmp/ngrok.pid ]; then
        local pid=$(cat /tmp/ngrok.pid)
        if ps -p $pid > /dev/null 2>&1; then
            kill -9 $pid
            log "ngrok 프로세스(PID: $pid)가 종료되었습니다."
        fi
        rm -f /tmp/ngrok.pid
    fi
    
    # 추가로 모든 ngrok 프로세스 종료
    pkill -f "ngrok http" 2>/dev/null
    
    # 임시 파일 정리
    rm -f /tmp/ngrok_url.txt /tmp/ngrok_env.sh /tmp/ngrok.log
    
    log "정리 완료"
}

# 사용법 표시
usage() {
    echo "사용법: $SCRIPT_NAME [명령] [포트]"
    echo ""
    echo "명령:"
    echo "  start [포트]  - ngrok을 백그라운드에서 시작 (기본: 3000)"
    echo "  stop         - ngrok 프로세스 종료"
    echo "  status       - 현재 상태 확인"
    echo "  url          - 현재 Forwarding URL 표시"
    echo ""
    echo "예제:"
    echo "  $SCRIPT_NAME start 3000"
    echo "  $SCRIPT_NAME stop"
    echo "  $SCRIPT_NAME status"
}

# 상태 확인
check_status() {
    if [ -f /tmp/ngrok.pid ]; then
        local pid=$(cat /tmp/ngrok.pid)
        if ps -p $pid > /dev/null 2>&1; then
            log "ngrok이 실행 중입니다 (PID: $pid)"
            if [ -f /tmp/ngrok_url.txt ]; then
                local url=$(cat /tmp/ngrok_url.txt)
                echo -e "${GREEN}Forwarding URL:${NC} $url"
            fi
        else
            warning "ngrok PID 파일은 있지만 프로세스가 실행 중이지 않습니다."
        fi
    else
        log "ngrok이 실행 중이지 않습니다."
    fi
}

# 현재 URL 표시
show_url() {
    if [ -f /tmp/ngrok_url.txt ]; then
        cat /tmp/ngrok_url.txt
    else
        error "저장된 URL이 없습니다. ngrok이 실행 중인지 확인하세요."
        exit 1
    fi
}

# 스크립트 실행
case "${1}" in
    start)
        main "${2:-3000}"
        ;;
    stop)
        stop_ngrok
        ;;
    status)
        check_status
        ;;
    url)
        show_url
        ;;
    *)
        if [ -n "$1" ] && [[ "$1" =~ ^[0-9]+$ ]]; then
            # 첫 번째 인자가 숫자인 경우 포트로 간주
            main "$1"
        else
            usage
            exit 1
        fi
        ;;
esac
