#!/bin/bash
# fix-screen-off-lag.sh: 解决锁屏后服务卡顿/冻结问题
# 根本原因: Android cgroup freezer 在锁屏时冻结 top-app 进程
# 用法: bash fix-screen-off-lag.sh

set -e

echo "=========================================="
echo "  Fix Screen Off Lag (Anti-Freeze)"
echo "=========================================="
echo ""

LOW_POWER_CORES="0,1,2"

echo "[1/4] Binding services to low-power cores ($LOW_POWER_CORES)..."
for svc in sshd smbd nmbd vsftpd; do
    for pid in $(pgrep -x $svc 2>/dev/null); do
        taskset -cp $LOW_POWER_CORES $pid 2>/dev/null && \
            echo "  ✓ $svc (PID $pid) bound to cores $LOW_POWER_CORES"
    done
done

echo ""
echo "[2/4] Setting OOM score to -1000 (prevent kill)..."
for svc in sshd smbd nmbd vsftpd pidfd-watchdog; do
    for pid in $(pgrep -x $svc 2>/dev/null); do
        echo -1000 > /proc/$pid/oom_score_adj 2>/dev/null && \
            echo "  ✓ $svc (PID $pid) OOM protected"
    done
done

echo ""
echo "[3/4] Creating partial wake lock (prevent CPU sleep)..."
if [ -f /sys/power/wake_lock ]; then
    echo "services_keepalive" > /sys/power/wake_lock 2>/dev/null && \
        echo "  ✓ WakeLock 'services_keepalive' acquired"
else
    echo "  ⚠ /sys/power/wake_lock not available"
fi

echo ""
echo "[4/4] Setting low-power cores minimum frequency..."
for cpu in 0 1 2; do
    min_freq=$(cat /sys/devices/system/cpu/cpu$cpu/cpufreq/cpuinfo_min_freq 2>/dev/null)
    if [ -n "$min_freq" ]; then
        echo $min_freq > /sys/devices/system/cpu/cpu$cpu/cpufreq/scaling_max_freq 2>/dev/null && \
            echo "  ✓ cpu$cpu max freq: $min_freq kHz"
    fi
done

echo ""
echo "=========================================="
echo "  IMPORTANT: Additional steps needed"
echo "=========================================="
echo ""
echo "  Android cgroup freezer is the root cause."
echo "  The above fixes help, but for full solution:"
echo ""
echo "  1. In AutoLinux app settings:"
echo "     - Enable 'Keep screen on' or 'Wake lock'"
echo "     - Enable 'Run in background'"
echo ""
echo "  2. In Android Settings:"
echo "     - Battery -> AutoLinux -> Unrestricted"
echo "     - Disable battery optimization for AutoLinux"
echo ""
echo "  3. If using Magisk:"
echo "     - Install 'Disable Flag Secure' module"
echo "     - Or use 'Wake Lock' Magisk module"
echo ""
echo "  4. Alternative: Use Termux + termux-services"
echo "     - Termux has better background support"
echo "     - Install: pkg install termux-services"
echo ""
