#!/bin/bash
# pidfd-watchdog: Build -> Deploy -> Test -> Report

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="pidfd-watchdog"
SOURCE="${BINARY}.c"
OUTPUT="$BINARY"
CONFIG="pidfd-watchdog.json"
CTL_SCRIPT="pidfd-watchdog-ctl.sh"
SERVICE_FILE="pidfd-watchdog.service"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=========================================="
echo "  pidfd-watchdog Pipeline"
echo "=========================================="
echo ""

# 1. 编译
echo -e "${YELLOW}[1/6] Compiling...${NC}"
cd "$SCRIPT_DIR"
gcc -o "$OUTPUT" "$SOURCE" 2>&1
if [ $? -eq 0 ]; then
    echo -e "${GREEN}  ✓ Compiled successfully${NC}"
else
    echo -e "${RED}  ✗ Compilation failed${NC}"
    exit 1
fi

# 2. 停掉旧进程
echo -e "${YELLOW}[2/6] Stopping old process...${NC}"
pkill -9 -f "$BINARY" 2>/dev/null || true
sleep 1
if pgrep -f "$BINARY" > /dev/null; then
    echo -e "${RED}  ✗ Failed to stop old process${NC}"
    exit 1
else
    echo -e "${GREEN}  ✓ Old process stopped${NC}"
fi

# 3. 部署
echo -e "${YELLOW}[3/6] Deploying...${NC}"
cp "$OUTPUT" /usr/local/bin/
cp "$CTL_SCRIPT" /usr/local/bin/pidfd-watchdog-ctl
cp "$CONFIG" /etc/
cp "$SERVICE_FILE" /etc/systemd/system/
chmod +x /usr/local/bin/"$OUTPUT"
chmod +x /usr/local/bin/pidfd-watchdog-ctl
echo -e "${GREEN}  ✓ Deployed to /usr/local/bin/${NC}"

# 4. 启用systemd服务
echo -e "${YELLOW}[4/6] Enabling systemd service...${NC}"
systemctl daemon-reload 2>/dev/null || true
systemctl enable pidfd-watchdog 2>/dev/null || true
systemctl start pidfd-watchdog 2>/dev/null || true
echo -e "${GREEN}  ✓ Service enabled${NC}"

# 5. 启动
echo -e "${YELLOW}[5/6] Starting...${NC}"
/usr/local/bin/pidfd-watchdog-ctl start
sleep 5

if /usr/local/bin/pidfd-watchdog-ctl status | grep -q "Running"; then
    echo -e "${GREEN}  ✓ Process started${NC}"
else
    echo -e "${RED}  ✗ Failed to start${NC}"
    exit 1
fi

# 6. 自验证
echo -e "${YELLOW}[6/6] Running self-test...${NC}"
/usr/local/bin/pidfd-watchdog-ctl test > /tmp/watchdog-test.log 2>&1

echo ""
echo "=========================================="
echo "  Test Results"
echo "=========================================="
cat /tmp/watchdog-test.log

echo ""
echo "=========================================="
echo "  Recent Logs"
echo "=========================================="
/usr/local/bin/pidfd-watchdog-ctl log 20

echo ""
echo "=========================================="
if grep -q "FAILED" /tmp/watchdog-test.log; then
    echo -e "${RED}  PIPELINE FAILED${NC}"
    exit 1
else
    echo -e "${GREEN}  PIPELINE PASSED${NC}"
    echo ""
    echo "  Source:  $SCRIPT_DIR"
    echo "  Binary:  /usr/local/bin/$BINARY"
    echo "  Config:  /etc/$CONFIG"
    echo "  Service: /etc/systemd/system/$SERVICE_FILE"
    echo "  Logs:    $SCRIPT_DIR/logs/"
    echo ""
    echo "  Commands:"
    echo "    pidfd-watchdog-ctl status"
    echo "    pidfd-watchdog-ctl test"
    echo "    pidfd-watchdog-ctl log"
fi
echo "=========================================="
