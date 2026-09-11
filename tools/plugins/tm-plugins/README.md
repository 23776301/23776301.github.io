# TM 的插件

TrafficMonitor 插件归档目录。后续开发的各类 TrafficMonitor 插件都放在这里，按子文件夹分类。

## 目录结构

- `battery-current/` — 电池放电电流 / 充电功率显示插件（v1.5：支持任务栏历史占用曲线，单文件零依赖，已附编译好的 `BatteryCurrentPlugin.dll`）

## 编译说明（battery-current）

使用 MinGW-w64（WinLibs UCRT）编译。关键：**必须 `-static` 静态链接运行时**，否则生成的 DLL 依赖
`libgcc_s_seh-1.dll` / `libstdc++-6.dll`，而 TrafficMonitor 进程加载时找不到这两个文件，会静默跳过插件。

```bash
windres -O coff BatteryCurrentPlugin.rc -o BatteryCurrentPlugin.res
g++ -shared -std=c++17 -O2 -static -DBUILDING_DLL \
    BatteryCurrentPlugin.cpp BatteryCurrentPlugin.res -o BatteryCurrentPlugin.dll \
    -Wl,--subsystem,windows -Wl,--kill-at \
    -lole32 -loleaut32 -luuid -lwbemuuid
```

## 部署

将 `BatteryCurrentPlugin.dll` 与 `BatteryCurrentPlugin.ini` 复制到 TrafficMonitor 的插件目录
（如 `C://Program Files\TrafficMonitor\TrafficMonitor\plugins\`），重启 TrafficMonitor 即可。

## 配置（BatteryCurrentPlugin.ini）

所有显示参数均由磁盘 INI 文件控制，支持热加载（修改后下次读取自动生效）：

| 键 | 说明 | 取值 |
|----|------|------|
| `Quantity`   | 显示电流或功率 | 0=电流, 1=功率 |
| `CurrentUnit`| 电流单位 | 0=mA, 1=A |
| `PowerUnit`  | 功率单位 | 0=W, 1=mW |
| `Decimals`   | 小数位 | 0-3 |
| `Label`      | 任务栏标签文本 | 任意字符串 |
| `RefreshMs`  | 应用层读取间隔(ms) | 默认 500 |
| `VoltageSource` | 电压来源 | 见源码注释 |
| `FixedVoltage`  | 固定电压(mV) | 默认 12000 |
| `GraphMax`   | 历史曲线满量程(mW) | 默认 50000（=50W），把电流/功率归一化到 0.0~1.0 绘制任务栏曲线，可调小让起伏更明显 |
| `DebugLog`   | 诊断日志开关 | 0/1 |

## 历史占用曲线（任务栏悬浮窗）

v1.5 起重写了插件接口的 `IsDrawResourceUsageGraph()`（返回 1）与 `GetResourceUsageGraphValue()`
（返回 0.0~1.0 的归一化值，按 `|功率(mW)| / GraphMax` 计算，零功率稳态归零），由 TrafficMonitor
主程序负责维护环形缓冲并绘制最近使用率曲线，与 CPU 占用率曲线行为一致。

在 TrafficMonitor 的「显示设置 → 任务栏窗口」中勾选该插件的「绘制历史曲线」即可。
