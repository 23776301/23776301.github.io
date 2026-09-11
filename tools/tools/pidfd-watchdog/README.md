# pidfd-watchdog

基于 pidfd + epoll 的事件驱动进程保活守护进程。

## 特性

- **事件驱动**: 使用 pidfd + epoll，无轮询开销
- **毫秒级响应**: ~570ms 检测 + 恢复
- **配置化管理**: JSON 配置文件
- **日志轮转**: 10MB 自动轮转 + zstd 压缩
- **退出原因追踪**: 集成 Android init 日志分析

## 环境要求

- Linux 5.3+ (支持 pidfd_open)
- Android AutoLinux 环境
- gcc 编译器

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/teecatt/tools.git
cd tools/tools/pidfd-watchdog

# 一键编译部署验证
bash build-deploy.sh
```

## 架构

```
┌─────────────────┐
│  pidfd-watchdog │
│   (主进程)      │
└────────┬────────┘
         │ epoll_wait
         ▼
┌─────────────────┐
│   pidfd_open    │
│   (每个服务)    │
└────────┬────────┘
         │ 进程退出
         ▼
┌─────────────────┐
│  退出原因分析   │
│  (waitpid +     │
│   dmesg + init) │
└────────┬────────┘
         │ 自动重启
         ▼
┌─────────────────┐
│  服务恢复      │
└─────────────────┘
```

## 配置

配置文件: `/etc/pidfd-watchdog.json`

```json
{
  "services": [
    {
      "name": "smbd",
      "cmd": "/usr/sbin/smbd --daemon",
      "enabled": true
    },
    {
      "name": "nmbd",
      "cmd": "/usr/sbin/nmbd --daemon",
      "enabled": true
    },
    {
      "name": "vsftpd",
      "cmd": "/usr/sbin/vsftpd /etc/vsftpd.conf",
      "enabled": true
    },
    {
      "name": "sshd",
      "cmd": "/usr/sbin/sshd",
      "enabled": true
    }
  ]
}
```

## 管理命令

```bash
# 基本操作
pidfd-watchdog-ctl start    # 启动
pidfd-watchdog-ctl stop     # 停止
pidfd-watchdog-ctl status   # 状态
pidfd-watchdog-ctl restart  # 重启

# 服务管理
pidfd-watchdog-ctl test     # 自测试（杀掉所有服务验证恢复）
pidfd-watchdog-ctl list     # 列出服务
pidfd-watchdog-ctl enable <svc>   # 启用服务
pidfd-watchdog-ctl disable <svc>  # 禁用服务

# 日志查看
pidfd-watchdog-ctl logs     # 查看日志文件列表
pidfd-watchdog-ctl log      # 查看最新日志
pidfd-watchdog-ctl log 50   # 查看最新 50 行
```

## 退出原因追踪

日志会记录进程退出的详细原因：

```
[smbd] Process [16974] exited, reason: process state: Z (zombie)
[nmbd] Process [10229] exited, reason: killed by external signal (SIGKILL)
[sshd] Process [6450] exited, reason: [26524.764880] init: Untracked pid 6450 exited with status 0
```

### 退出原因分类

| 原因 | 说明 |
|------|------|
| `normal exit (code 0)` | 进程正常退出 |
| `abnormal exit (code X)` | 进程异常退出 |
| `killed by SIGKILL` | 被强制杀掉（kill -9、OOM、cgroup） |
| `killed by SIGTERM` | 被终止（kill、systemctl stop） |
| `crashed by SIGSEGV` | 段错误崩溃 |
| `process state: Z (zombie)` | 僵尸进程 |
| `init: Untracked pid` | 被 Android init 系统杀掉 |

### 分析流程

1. **waitpid**: 获取进程退出状态
2. **/proc/pid/status**: 检查进程状态（如果还在）
3. **dmesg**: 检查 Android init 日志
4. **dmesg**: 检查 OOM killer 日志
5. **dmesg**: 检查 cgroup 日志
6. **journalctl**: 检查 systemd 日志
7. **auth.log**: 检查认证日志

## 日志

路径: `/sdcard/gt5_nas/tools/watchdog/logs/`

格式:
```
[2026-08-21 03:03:05.143] [PID:12942] [smbd] Process [7237] exited, reason: killed by SIGKILL
[2026-08-21 03:03:05.143] [PID:12942] [smbd] Attempting restart with "/usr/sbin/smbd --daemon"...
[2026-08-21 03:03:05.711] [PID:12942] [smbd] Process [13204] recovered (took 569 ms)
```

### 启动横幅

每次启动会记录：
```
================================================================
[2026-08-21 03:03:05.143] [PID:12942] pidfd-watchdog started
================================================================
  Config: /etc/pidfd-watchdog.json
  Log: /sdcard/gt5_nas/tools/watchdog/logs/pidfd-watchdog.log

  Services (4):
    smbd    | enabled | /usr/sbin/smbd --daemon
    nmbd    | enabled | /usr/sbin/nmbd --daemon
    vsftpd  | enabled | /usr/sbin/vsftpd /etc/vsftpd.conf
    sshd    | enabled | /usr/sbin/sshd
================================================================
```

## systemd 服务

虽然 systemd 在 chroot 环境中不完全可用，但服务文件已配置：

```bash
# 安装服务
cp pidfd-watchdog.service /etc/systemd/system/
systemctl daemon-reload

# 启用服务（可能不工作）
systemctl enable pidfd-watchdog
systemctl start pidfd-watchdog
```

## 性能

| 指标 | 值 |
|------|-----|
| 检测延迟 | ~570ms |
| 恢复时间 | ~570ms |
| 内存占用 | < 1MB |
| CPU 占用 | 0% (事件驱动) |

## 文件结构

```
watchdog/
├── pidfd-watchdog.c          # 主程序源码
├── pidfd-watchdog-ctl.sh     # 管理脚本
├── pidfd-watchdog.json       # 配置文件
├── pidfd-watchdog.service    # systemd 服务文件
├── build-deploy.sh           # 编译部署脚本
├── README.md                 # 本文档
├── .gitignore                # Git 忽略规则
└── logs/                     # 日志目录（自动创建）
```

## 编译

```bash
gcc -o pidfd-watchdog pidfd-watchdog.c
```

## 注意事项

1. **不要在 .bashrc 中启动 watchdog**，会导致多实例冲突
2. **使用 build-deploy.sh 部署**，会自动停掉旧进程
3. **日志路径**: `/sdcard/gt5_nas/tools/watchdog/logs/`
4. **配置路径**: `/etc/pidfd-watchdog.json`
5. **PID 文件**: `/tmp/pidfd-watchdog.pid`

## 故障排除

### watchdog 无法启动

```bash
# 检查是否有旧进程
ps aux | grep pidfd-watchdog

# 强制杀掉旧进程
pkill -9 -f pidfd-watchdog

# 重新启动
pidfd-watchdog-ctl start
```

### 服务无法恢复

```bash
# 检查服务命令是否正确
cat /etc/pidfd-watchdog.json

# 手动测试服务命令
/usr/sbin/smbd --daemon

# 查看日志
pidfd-watchdog-ctl log
```

### 日志文件过大

```bash
# 手动轮转日志
pidfd-watchdog-ctl stop
mv /sdcard/gt5_nas/tools/watchdog/logs/pidfd-watchdog.log \
   /sdcard/gt5_nas/tools/watchdog/logs/pidfd-watchdog.log.old
pidfd-watchdog-ctl start
```
