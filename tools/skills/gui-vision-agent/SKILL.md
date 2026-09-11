---
name: gui-vision-agent
description: >-
  Vision-driven desktop GUI automation on Windows: the "screenshot → analyze →
  act → screenshot" perception-action loop. Use when the user wants an agent that
  LOOKS at the screen (pixel + vision model) and decides what to click/type next,
  rather than deterministic element-name lookup. Covers BitBlt screen capture
  (incl. taskbar/layered windows), calling a UI-TARS / OpenAI-compatible vision
  endpoint, parsing normalized 0-1000 coordinates, executing real SendInput
  mouse/keyboard, the iteration loop, and full per-step audit logging
  (before/after screenshots + change caption). Trigger words: 截图分析点击、
  GUI智能体、视觉Agent、screenshot analyze click loop、UI-TARS、perception-action
  loop、让AI自己操作桌面、record every step.
license: MIT
allowed-tools:
---

# GUI Vision Agent — 截图 / 分析 / 点击 迭代循环

一个**纯像素 + 合成输入**的通用桌面 GUI 智能体。它不看任何应用的内部
结构（没有 accessibility tree、不依赖控件名），而是：

```
    ┌──────────────────────────────────────────────────────────┐
    │                                                            │
    │   1. Screen.capture()   ──►  全屏/区域 PNG（BitBlt）        │
    │            │                                               │
    │            ▼                                               │
    │   2. resize + base64  ──►  模型输入                         │
    │            │                                               │
    │            ▼                                               │
    │   3. UITarsClient.complete()  ──►  视觉模型返回              │
    │            │                  "Thought: ...\nAction: ..."   │
    │            ▼                                               │
    │   4. parse_action()   ──►  结构化动作 + 归一化坐标(0-1000)   │
    │            │                                               │
    │            ▼                                               │
    │   5. Executor.run()   ──►  SendInput 真实鼠标/键盘           │
    │            │                                               │
    │            ▼                                               │
    │   6. 等待 + 重新截图 ──► 回到 1（或让模型描述"变了什么"）    │
    │                                                            │
    └──────────────────────────────────────────────────────────┘
```

因为只依赖像素和合成输入，同一个脚本可以驱动：原生 Win32 程序、
安装向导、浏览器、Electron/UWP、游戏启动器 —— 任何屏幕上能看到的东西。

---

## 1. 怎么截图（三种方式）

本 skill 提供 **`capture.py`**，覆盖三种看屏幕的方式，应付不同审计/调试场景：

| 方式 | 命令 | 用途 |
|------|------|------|
| **全屏** | `python capture.py --full out.png` | 抓**整个虚拟桌面**：所有窗口叠加后的样子 + 任务栏状态 |
| **单窗口** | `python capture.py --window "标题" out.png` | 用 `PrintWindow` 抓**某个指定窗口**——即使它被别的窗口挡住，也能看到被遮挡的内容 |
| **列窗口** | `python capture.py --list` | 枚举当前可见顶层窗口（HWND / 标题 / 类 / 矩形 / PID），先知道桌面上有什么再决定抓哪个 |

> 为什么需要单窗口模式？`BitBlt` 全屏抓的是"最上层像素"，被遮挡的部分看不到；
> 而 `PrintWindow(hwnd, hdc, 2)` 让目标窗口**自己把自己画进我们的 DC**，所以
> 哪怕它压在十层窗口底下，抓出来的图也是完整、未被遮挡的。这正是排障重叠窗口的关键。

核心技术（全屏模式）：**BitBlt 从整个"虚拟桌面"的设备上下文拷贝像素**。

```python
src = user32.GetDC(0)                       # 整个虚拟桌面的 DC
dst = gdi32.CreateCompatibleDC(src)
bmp = gdi32.CreateCompatibleBitmap(src, rw, rh)
gdi32.SelectObject(dst, bmp)
gdi32.BitBlt(dst, 0, 0, rw, rh, src, rx, ry, SRCCOPY | CAPTUREBLT)
# 用 GetDIBits 读出 RGB 像素，再用 PIL.Image.frombuffer 包装
```

三个关键点（都是踩出来的坑）：

1. **必须加 `CAPTUREBLT (0x40000000)`**。只写 `SRCCOPY` 抓不到分层窗口
   （任务栏、半透明浮窗、鼠标指针层）。`CAPTUREBLT` 让 BitBlt 包含这些
   layered window —— 否则任务栏浮窗、Toast 之类会是一片黑/透明。
2. **跨多显示器要用"虚拟桌面"坐标系**，不是主屏：
   - `SM_XVIRTUALSCREEN / SM_YVIRTUALSCREEN` 取虚拟桌面左上角
   - `SM_CXVIRTUALSCREEN / SM_CYVIRTUALSCREEN` 取总宽高
   - 单屏时这些值与 `SM_CXSCREEN/SM_CYSCREEN` 一致，多屏时才是拼接后的整体。
3. **必须做 DPI 感知**，否则"截图像素"和"输入坐标"对不上：
   ```python
   ctypes.WinDLL("shcore").SetProcessDpiAwareness(2)   # PROCESS_PER_MONITOR_DPI_AWARE
   ```
   Win11 常见 175% 缩放下，若不设 DPI 感知，`GetDC(0)` 拿到的是逻辑分辨率，
   而 `SendInput` 绝对坐标要的是物理像素 —— 错位会导致"点到空白"。

抓到的图通常会 `fit()` 缩到最长边 ≤ `max_side`(默认 1120) 再发给模型，
省 token。模型看到的坐标也基于这张**缩放后的图**。

---

## 2. 怎么"分析截图内容"（模型推理）

所谓"分析"= 把截图和任务交给一个**视觉语言模型**，让它输出下一步动作。
本项目用字节跳动 **UI-TARS**（经 llama.cpp 的 `llama-server` 在本地
`127.0.0.1:8080` 跑，OpenAI 兼容 `/v1/chat/completions`），任何 OpenAI
兼容视觉端点都能替换。

### 请求构造（`GuiAgent._messages`）
- **system**：UI-TARS 的 Action Space 提示词（`UITARS_PROMPT`），并强制
  "坐标必须归一化到 0..1000，覆盖整张截图"。
- **user content**（多模态数组）：
  1. 历史动作文本（最近 8 步：`Step i: <action>`），给模型"记忆"；
  2. 上一步截图（可配置 `history_images`，默认 1 张）做时序上下文；
  3. **当前截图**（base64 PNG）；
  4. 文字：`What is the next action?`

### 模型返回格式
```
Thought: 我需要右键点击任务栏左侧的 TrafficMonitor 浮窗以打开菜单。
Action: right_single(start_box='(120,950)')
```
- `Thought`：模型的规划/推理（中文，由 `language` 控制）。
- `Action`：动作名 + 参数。**坐标统一写成 `(x,y)`，范围 0..1000**。

### 支持的动作
`click` / `left_double` / `right_single` / `hover` / `drag` /
`scroll`(direction=up/down/left/right) / `hotkey` / `type` /
`wait` / `finished` / `call_user`。

---

## 3. 怎么解析动作（parse_action）

模型输出是自由文本，必须容忍各种写法。本项目用两级正则：

- `_POINT_RE`：匹配 `<point>x y</point>` 或 `<bbox>...`；
- `_PAREN_BOX_RE`：匹配 `(x, y)`（UI-TARS 1.0 的 `start_box` 值）；
- `_split_kwargs`：手写的状态机式解析器，正确处理引号、转义（`\\n`、`\\'`）、
  逗号分隔的多个参数，避免把 `type(content='a,b,c')` 里的逗号误当分隔。

**关键坑：UI-TARS 1.0 与 1.5 坐标键名不同**
- 1.0：`click(start_box='(x,y)')`
- 1.5：`click(point='(x,y)')` 或 `<point>x y</point>`

本项目部署的"1.5"模型**实际吐的是 1.0 格式** `start_box`。所以解析后做一次
键归一化：

```python
if name in ("click","left_double","right_single","hover"):
    for src in ("start_box", "_"):
        if src in args:
            args.setdefault("point", args.pop(src)); break
if name == "scroll" and "start_box" in args:
    args.setdefault("point", args.pop("start_box"))
```

**务必同时兼容两种格式**，否则会出现 `missing coordinate` 导致整轮失败。

---

## 4. 怎么执行动作（Executor + SendInput）

解析出的 `(x,y)` 是**归一化 0..1000**（相对当前截图）。要执行，先映射回
**物理屏幕像素**：

```python
def to_screen(self, pt):
    mx, my = pt
    rx, ry, rw, rh = self.region          # 本次截图对应的屏幕区域
    fx, fy = mx / 1000.0, my / 1000.0     # 归一化 -> 比例
    return (int(rx + fx*(rw-1)), int(ry + fy*(rh-1)))
```

再用 `SendInput` 发**绝对坐标**鼠标事件：

```python
# 屏幕像素 -> 0..65535 虚拟桌面归一化
nx = int((x - vx) * 65535 / (vw - 1))
ny = int((y - vy) * 65535 / (vh - 1))
flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
SendInput([MOUSEINPUT(nx, ny, 0, flags, 0, None)])
```

- `MOUSEEVENTF_VIRTUALDESK`：坐标基准是**整个虚拟桌面**（多屏拼接），
  不是单屏；必须与截图用的虚拟桌面坐标系一致。
- **`hover`/移动要发两次相同事件**：某些 shell 只在第二次 `MOVE` 上才
  真正更新 hover 状态（影响菜单展开）。
- **键盘输入**：
  - 纯 ASCII 短串 → `unicode_text`（逐字符 `KEYEVENTF_UNICODE`）；
  - **中文 / 长文本 → 走剪贴板**（`paste_text`：`SetClipboardData` +
    `Ctrl+V`），远比对每个 CJK 字符发 Unicode 扫描码可靠；
  - 组合键 `hotkey("ctrl v")`：按下全部键、再反向松开，扩展键加
    `KEYEVENTF_EXTENDEDKEY`。

---

## 5. 迭代循环（GuiAgent.run）

```python
for step in range(1, max_steps+1):
    img  = screen.capture(region); img = fit(img, max_side)
    out  = client.complete(messages(img))     # 看截图，想下一步
    act  = parse_action(out)                  # 解析
    if act.name == "finished":  return True   # 任务完成
    if act.name == "call_user": return False  # 需要人介入
    executor.run(act)                         # 真去点/打字
    history.append(act); shots.append(b64)    # 记忆
    time.sleep(0.8)                           # 等界面响应
```

循环直到 `finished()`、`call_user()` 或达到 `max_steps`。

---

## 6. 全量步骤记录（gui_agent_logged.py）

用户要求："每点一下、截图前后变化都要记录下来"。`gui_agent_logged.py`
在每一步都产出：

1. **操作前截图** `stepNN_before.png`（执行动作前抓）；
2. 模型决策（动作 + 归一化坐标 + 原始输出）；
3. 真实执行（SendInput）；
4. **操作后截图** `stepNN_after.png`（执行后抓）；
5. 再调一次模型，对前后两图生成一句**"界面发生了什么变化"**中文描述。

产物（写入 `--run-dir`）：
- `steps.md`：人读流水（每步动作、坐标、变化、图链接）；
- `steps.html`：图廊，before → after 成对展示 + 变化说明；
- `steps.jsonl`：机读逐步记录。

这让"截图分析点击"整个过程**完全可审计**——这正是把循环写成 skill 的
主要价值之一。

---

## 7. 踩坑经验（务必看）

1. **模型只做"看"，点击/反馈都是脚本做的**。视觉模型只产出
   `动作+坐标`；截图、SendInput、前后对比、循环控制全是本机代码。
   别把"用了 UI-TARS 模型的输出格式"误当成"用了 UI-TARS 产品"。
2. **7B 纯 CPU 视觉模型对小目标不可靠**。任务栏浮窗只有 ~30px 高，
   7B CPU 推理点不准，4 次实跑全失败。小目标 + 弱模型 → 需要更大的
   模型、GPU，或把 `--region` 缩小到目标附近再截。
3. **WorkBuddy / agent 自己的窗口会挡住桌面**。不最小化其它窗口时，
   模型会把 agent 窗口当成目标狂点。用 `clear_desktop.py` 先最小化
   无关顶层窗口（保留任务栏、Progman、TrafficMonitor）。
4. **会话隔离**：合成输入落到**交互会话（Session 1）**，不是
   session 0/服务会话——所以能操作真实桌面。
5. **双击菜单项要点两次**：`left_double` 用两次 DOWN/UP，间隔 60ms。
6. **`finished` 才真正结束**：模型有时默默卡住，靠 `max_steps` 兜底。
7. **坐标格式双兼容**（见第 3 节）——这是最常见的解析失败来源。

---

## 8. 使用

```bash
PY="$USERPROFILE/.workbuddy/binaries/python/versions/3.13.12/python.exe"
SKILL="$USERPROFILE/.workbuddy/skills/gui-vision-agent"

# 基础：让模型自己看着屏幕完成任务
"$PY" "$SKILL/gui_agent.py" --task "右键任务栏左侧 TrafficMonitor 浮窗，打开选项设置，只勾选 CPU温度/CPU占用率/内存占用率/显卡占用率/CPU频率，关闭网速，确定" --server http://127.0.0.1:8080 --max-steps 20 --clear

# 记录每一步前后截图+变化说明（审计用）
"$PY" "$SKILL/gui_agent_logged.py" --task "..." --server http://127.0.0.1:8080 --run-dir run1 --clear

# 只看模型决策不真点（dry-run）
"$PY" "$SKILL/gui_agent.py" --task "..." --dry-run

# 只盯某个区域（小目标更准）
"$PY" "$SKILL/gui_agent.py" --task "..." --region 0,1400,300,200

# --- 三种截图方式（capture.py）---
# 看全屏叠加 + 任务栏
"$PY" "$SKILL/capture.py" --full desktop.png
# 列当前有哪些窗口（拿 HWND / 标题）
"$PY" "$SKILL/capture.py" --list
# 抓被遮挡的单个窗口（换成你的窗口标题）
"$PY" "$SKILL/capture.py" --window "TrafficMonitor" tm.png
# 或直接用 HWND
"$PY" "$SKILL/capture.py" --hwnd 12345 tm.png
```

### 依赖
- Python 3.10+，仅依赖 `Pillow`：`pip install pillow`
- 一个 OpenAI 兼容视觉端点（本例 UI-TARS via llama-server）。
  无模型时可用 `--dry-run` 验证截图/解析/坐标映射链路。

### 文件
- `gui_agent.py`：核心循环（截图/解析/执行/迭代），零应用专属逻辑。
- `gui_agent_logged.py`：带全量步骤记录的变体（每步前后截图 + 变化描述）。
- `capture.py`：三种截图方式——全屏 / 单窗口(PrintWindow) / 列窗口。
- `clear_desktop.py`：`--clear` 预处理，最小化无关窗口露出桌面。

---

## 9. 与 windows-desktop-control 的区别

| | windows-desktop-control | gui-vision-agent |
|---|---|---|
| 定位 | 确定性桥接（你知道坐标/控件名） | 感知—动作循环（模型看图决策） |
| 找目标 | 枚举窗口/控件名再点 | 模型从像素里认出该点哪 |
| 适用 | 已知 UI 结构、稳定流程 | 任意陌生界面、无内部结构可用时 |
| 依赖 | 无模型 | 需视觉模型端点 |

两者互补：先用本 skill 的"视觉循环"定位，必要时再用 bridge 做确定性精修。
