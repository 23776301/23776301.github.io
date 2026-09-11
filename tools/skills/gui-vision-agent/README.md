# gui-vision-agent

> 用 WorkBuddy 自动化控制 Windows 桌面的「视觉智能体」skill。
> 核心是一条 **截图 → 分析 → 点击 → 再截图** 的感知—动作循环。

本项目不依赖任何应用程序的内部结构（没有 accessibility tree、不查控件名），
而是让一个**视觉语言模型**看着屏幕像素，自己决定下一步该点哪里、打什么字，
再用真实的 `SendInput` 鼠标/键盘把动作落实下去。同一个脚本能驱动原生
Win32 程序、安装向导、浏览器、Electron/UWP、游戏启动器——任何屏幕上
能看到的东西。

---

## 它解决什么问题

你希望 WorkBuddy 能像人一样"看"桌面并操作它：

1. **看屏幕**：用三种方式截图（见下）。
2. **想下一步**：把截图 + 任务交给 UI-TARS（或任意 OpenAI 兼容视觉端点），
   模型返回 `Thought: ... \n Action: click(start_box='(x,y)')`。
3. **真去做**：把模型给的归一化坐标(0..1000)映射回物理像素，发 `SendInput`。
4. **看结果**：重新截图，可让模型描述"界面变了什么"，形成可审计的迭代。

---

## 三种截图方式（`capture.py`）

| 方式 | 命令 | 用途 |
|------|------|------|
| **全屏** | `python capture.py --full out.png` | 抓整个虚拟桌面：所有窗口叠加后的样子 + 任务栏状态 |
| **单窗口** | `python capture.py --window "标题" out.png` | 用 `PrintWindow` 抓指定窗口，**即使被遮挡也能看到完整内容** |
| **列窗口** | `python capture.py --list` | 枚举可见顶层窗口（HWND/标题/类/矩形/PID），先看清楚桌面上有什么 |

> 为什么需要单窗口？`BitBlt` 全屏只抓"最上层像素"，被挡住的部分看不到；
> `PrintWindow` 让目标窗口自己画进我们的 DC，所以压在十层窗口底下也能抓全。

---

## 文件

| 文件 | 说明 |
|------|------|
| `gui_agent.py` | 核心循环：截图 / 解析动作 / 执行 / 迭代。零应用专属逻辑。 |
| `gui_agent_logged.py` | 带全量步骤记录的变体：每步操作前/后截图 + 一句"界面变化"描述。 |
| `capture.py` | 三种截图方式：全屏 / 单窗口(PrintWindow) / 列窗口。 |
| `clear_desktop.py` | 运行前最小化无关窗口，露出干净桌面（避免 agent 点到自己窗口）。 |
| `SKILL.md` | WorkBuddy skill 定义 + 完整机制说明 + 踩坑经验。 |
| `examples/` | 示例运行记录。 |

---

## 快速开始

```bash
# 依赖
pip install pillow

PY=python            # 或 WorkBuddy 托管的 Python
SKILL=.              # 本目录

# 1) 先看清楚桌面（任选）
python capture.py --list
python capture.py --full desktop.png
python capture.py --window "记事本" notepad.png

# 2) 让模型自己看着屏幕完成任务
python gui_agent.py --task "右键任务栏左侧 TrafficMonitor 浮窗，打开选项设置，\
只勾选 CPU温度/CPU占用率/内存占用率/显卡占用率/CPU频率，关闭网速，确定" \
    --server http://127.0.0.1:8080 --max-steps 20 --clear

# 3) 记录每一步前后截图 + 变化说明（审计用）
python gui_agent_logged.py --task "..." --server http://127.0.0.1:8080 \
    --run-dir run1 --clear
```

- `--server`：任意 OpenAI 兼容视觉端点。本例用本地 `llama-server`
  （UI-TARS-1.5 经 llama.cpp 部署在 `127.0.0.1:8080`）。
- 无模型时加 `--dry-run` 验证截图 / 解析 / 坐标映射链路。

---

## 更多

完整机制、坐标格式兼容（UI-TARS 1.0 `start_box` vs 1.5 `point`）、DPI 感知、
`CAPTUREBLT`、多显示器虚拟桌面、会话隔离等细节，见 [`SKILL.md`](SKILL.md)。

## License

MIT — see [LICENSE](LICENSE).
