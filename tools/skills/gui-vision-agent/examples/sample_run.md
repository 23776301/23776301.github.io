# 示例运行记录（steps.md 节选）

> 说明：以下为 `gui_agent_logged.py` 对 TrafficMonitor 任务产出的**示意性**
> 片段，用于展示"每步：动作 + 归一化坐标 + 前后截图 + 界面变化"的记录格式。
> 真实运行会因模型/坐标精度而异。

- 任务: 在任务栏左侧 TrafficMonitor 浮窗配置只显示 5 项硬件监控并关闭网速
- 区域: (0, 0, 2560, 1600)
- 模型: http://127.0.0.1:8080

## Step 1: right_single （归一化0-1000 = 60,948）
- 原始输出: `Thought: 需要右键点击任务栏左侧的 TrafficMonitor 浮窗以打开菜单。\nAction: right_single(start_box='(60,948)')`
- 执行结果: right_single(154,1517)
- 界面变化: 任务栏浮窗上方弹出了右键上下文菜单，包含"选项设置"等项。
- 截图: [操作前](step01_before.png) -> [操作后](step01_after.png)

## Step 2: click （归一化0-1000 = 318,812）
- 原始输出: `Thought: 在弹出的菜单中点击"选项设置"打开设置对话框。\nAction: click(start_box='(318,812)')`
- 执行结果: click(814,1299)
- 界面变化: 打开了"选项设置"对话框，显示多个可勾选的监控项。
- 截图: [操作前](step02_before.png) -> [操作后](step02_after.png)

## Step 3: click （归一化0-1000 = 502,640）
- 原始输出: `Thought: 勾选"CPU温度"复选框。\nAction: click(start_box='(502,640)')`
- 执行结果: click(1285,1024)
- 界面变化: "CPU温度"复选框变为已勾选状态（出现对勾）。
- 截图: [操作前](step03_before.png) -> [操作后](step03_after.png)

## Step N: finished
- 原始输出: `Thought: 已勾选 5 项硬件监控并取消网速，点击确定生效。\nAction: finished(content='已完成 TrafficMonitor 配置')`

---

## 三种截图方式示例输出

```
$ python capture.py --list
   PID    HWND      x     y     r     b  title [class]
  18732  262610  100   100   332   140  'TrafficMonitor' [TrafficMonitor_Main]
  4321   131184    0  1512  2560  1600 '任务栏' [Shell_TrayWnd]

$ python capture.py --full desktop.png
full -> desktop.png          # 全屏叠加 + 任务栏

$ python capture.py --window "TrafficMonitor" tm.png
window 'TrafficMonitor' (hwnd=262610) -> tm.png   # 即使被遮挡也能抓全
```
