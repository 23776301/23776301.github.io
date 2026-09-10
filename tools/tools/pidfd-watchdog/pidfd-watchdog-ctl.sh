#!/bin/bash
# pidfd-watchdog 管理脚本

CONFIG="/etc/pidfd-watchdog.json"
PIDFILE="/tmp/pidfd-watchdog.pid"
BINARY="/usr/local/bin/pidfd-watchdog"
LOG_DIR="/sdcard/gt5_nas/tools/watchdog/logs"

case "$1" in
    start)
        if [ -f "$PIDFILE" ] && kill -0 $(cat "$PIDFILE") 2>/dev/null; then
            echo "Already running"
            exit 1
        fi
        mkdir -p "$LOG_DIR"
        nohup "$BINARY" > /dev/null 2>&1 &
        echo "Started"
        ;;
    stop)
        if [ -f "$PIDFILE" ]; then
            kill $(cat "$PIDFILE") 2>/dev/null
            rm -f "$PIDFILE"
            echo "Stopped"
        else
            echo "Not running"
        fi
        ;;
    restart)
        $0 stop
        sleep 1
        $0 start
        ;;
    status)
        if [ -f "$PIDFILE" ] && kill -0 $(cat "$PIDFILE") 2>/dev/null; then
            echo "Running (PID: $(cat $PIDFILE))"
            kill -USR1 $(cat "$PIDFILE")
            echo "Status logged to: $(ls -t $LOG_DIR/*.log 2>/dev/null | head -1)"
        else
            echo "Not running"
        fi
        ;;
    enable)
        if [ -z "$2" ]; then
            echo "Usage: $0 enable <service>"
            exit 1
        fi
        sed -i "s/\"name\": \"$2\".*\"enabled\": false/\"name\": \"$2\", \"enabled\": true/" "$CONFIG"
        echo "Enabled $2 (restart required)"
        ;;
    disable)
        if [ -z "$2" ]; then
            echo "Usage: $0 disable <service>"
            exit 1
        fi
        sed -i "s/\"name\": \"$2\".*\"enabled\": true/\"name\": \"$2\", \"enabled\": false/" "$CONFIG"
        echo "Disabled $2 (restart required)"
        ;;
    add)
        if [ -z "$2" ] || [ -z "$3" ]; then
            echo "Usage: $0 add <name> <command>"
            exit 1
        fi
        # 在最后一个service后面添加新条目
        sed -i '/]/i\    { "name": "'$2'", "cmd": "'$3'", "enabled": true },' "$CONFIG"
        # 删除多余的逗号
        sed -i '/^    },$/N;s/},\n]/}\n]/' "$CONFIG"
        echo "Added $2 (restart required)"
        ;;
    remove)
        if [ -z "$2" ]; then
            echo "Usage: $0 remove <service>"
            exit 1
        fi
        sed -i '/"name": "'$2'"/d' "$CONFIG"
        echo "Removed $2 (restart required)"
        ;;
    list)
        echo "=== Configured Services ==="
        grep -E "\"name\"|\"enabled\"" "$CONFIG" | paste - - | sed 's/.*"name": "\([^"]*\)".*"enabled": \([a-z]*\).*/[\1] enabled=\2/'
        ;;
    logs)
        echo "=== Recent Logs ==="
        ls -lh "$LOG_DIR"/*.log 2>/dev/null || echo "No logs"
        ;;
    log)
        if [ -z "$2" ]; then
            tail -50 "$(ls -t $LOG_DIR/*.log 2>/dev/null | head -1)"
        else
            tail -n "$2" "$(ls -t $LOG_DIR/*.log 2>/dev/null | head -1)"
        fi
        ;;
    test)
        echo "=== Auto Test ==="
        if [ -f "$PIDFILE" ] && kill -0 $(cat "$PIDFILE") 2>/dev/null; then
            echo "Watchdog running, testing all services..."
            # 获取配置中的服务列表
            for svc in $(grep '"name"' "$CONFIG" | sed 's/.*"name": "\([^"]*\)".*/\1/'); do
                if pgrep -x "$svc" > /dev/null; then
                    echo "Killing $svc..."
                    pkill -x "$svc"
                fi
            done
            sleep 2
            # 检查恢复情况
            for svc in $(grep '"name"' "$CONFIG" | sed 's/.*"name": "\([^"]*\)".*/\1/'); do
                if pgrep -x "$svc" > /dev/null; then
                    echo "[$svc] recovered OK"
                else
                    echo "[$svc] FAILED to recover"
                fi
            done
            echo "=== Test Complete ==="
            tail -20 "$(ls -t $LOG_DIR/*.log 2>/dev/null | head -1)"
        else
            echo "Watchdog not running"
        fi
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|enable|disable|add|remove|list|logs|log [lines]|test}"
        echo ""
        echo "  start          Start watchdog"
        echo "  stop           Stop watchdog"
        echo "  restart        Restart watchdog"
        echo "  status         Show status"
        echo "  enable <svc>   Enable service"
        echo "  disable <svc>  Disable service"
        echo "  add <n> <cmd>  Add service"
        echo "  remove <svc>   Remove service"
        echo "  list           List services"
        echo "  logs           List log files"
        echo "  log [n]        Show last n lines (default 50)"
        exit 1
        ;;
esac
