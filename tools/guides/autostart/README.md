# AutoLinux VM Autostart

VM 自启动探索（WIP - Work In Progress）。

## 目标

实现 Android 开机自动启动 AutoLinux VM，并自动拉起所有服务。

## 环境限制

- **chroot 环境**: AutoLinux 使用 chroot，非 proot/VM
- **systemd 不可用**: 无法使用 systemd 服务管理
- **PID 1**: `/system/bin/init second_stage`
- **systemd-detect-virt**: 返回 `vm-other`

## 当前方案

### 方案 1: .bashrc 自启动

在 `~/.bashrc` 中添加启动命令：

```bash
# 启动 watchdog
if ! pgrep -x pidfd-watchdog > /dev/null; then
    nohup /usr/local/bin/pidfd-watchdog > /dev/null 2>&1 &
fi
```

**缺点**: 每次打开终端都会执行，可能导致多实例冲突。

### 方案 2: crontab 自启动

使用 crontab 的 `@reboot` 指令：

```bash
crontab -e
# 添加以下行
@reboot /usr/local/bin/pidfd-watchdog
```

**缺点**: 在 chroot 环境中可能不工作。

### 方案 3: Android init.rc

修改 Android 的 init.rc 文件：

```rc
service autolinux /bin/sh -c "chroot /data/autolinux /bin/bash"
    class main
    user root
    group root
    oneshot
```

**缺点**: 需要 root 权限，可能影响 Android 系统稳定性。

## 已知问题

### 1. systemd 服务不工作

```bash
$ systemctl enable pidfd-watchdog
Running in chroot, ignoring request.
```

**原因**: systemd 检测到在 chroot 环境中运行。

### 2. 多实例冲突

在 `.bashrc` 中启动 watchdog 会导致：
- 每次打开终端都启动新实例
- 多个实例互相杀掉对方的进程
- SSH 登录后立即断开

**解决方案**: 使用 PID 文件检测单实例。

### 3. 进程被 Android init 杀掉

Android 的 init 系统会杀掉某些进程：

```
init: Untracked pid 6450 exited with status 0
```

**原因**: 进程不在 Android 的服务列表中。

## 探索方向

### 1. 使用 Android 的 init 服务

创建 Android init 服务配置：

```rc
# /system/etc/init/autolinux.rc
service autolinux /data/autolinux/start.sh
    class late_start
    user root
    group root
    oneshot
    disabled
```

### 2. 使用 Magisk 模块

创建 Magisk 模块，在开机时执行脚本：

```bash
# /data/adb/modules/autolinux/service.sh
#!/system/bin/sh
chroot /data/autolinux /bin/bash -c "/usr/local/bin/pidfd-watchdog"
```

### 3. 使用 Termux:Boot

使用 Termux:Boot 插件在开机时执行脚本。

## 状态

- [ ] Android 开机自启 VM
- [ ] VM 启动后自动配置
- [x] 服务自启动（使用 pidfd-watchdog）

## 当前工作流程

1. **手动启动 AutoLinux**: 打开 AutoLinux 应用
2. **自动启动 watchdog**: 通过 `.bashrc` 或手动执行
3. **watchdog 保活**: 监控所有服务进程

## 相关文件

- `/root/.bashrc` - 包含自启动命令
- `/usr/local/bin/pidfd-watchdog` - watchdog 二进制
- `/etc/pidfd-watchdog.json` - watchdog 配置

## 参考资料

- [Android init 语言](https://android.googlesource.com/platform/system/core/+/master/init/README.md)
- [Magisk 模块开发](https://topjohnwu.github.io/Magisk/guides.html)
- [Termux:Boot](https://wiki.termux.com/wiki/Termux:Boot)

## 更新日志

### 2026-08-21

- 移除 `.bashrc` 中的 watchdog 自启动
- 添加 systemd 服务文件（可能不工作）
- 更新文档
