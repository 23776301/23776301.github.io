# MIDI 播放器 · 88 键可视化

浏览器端 MIDI 播放器：解析 `.mid` 谱面，在 Canvas 上以「88 键钢琴 + 下落音符」形式可视化，支持多音色（Soundfont）、变速播放、顺序/循环播放、自定义配色，并内置一套性能诊断与自动降级机制。

入口页面：`midi_player/index.html`

---

## 目录

- [1. 背景与目标](#1-背景与目标)
- [2. 性能问题复盘](#2-性能问题复盘)
  - [2.1 音频线程过载（声音卡顿/静音）](#21-音频线程过载声音卡顿静音)
  - [2.2 节点 churn 与内存/GC 压力](#22-节点-churn-与内存gc-压力)
  - [2.3 主线程丢帧与渲染过载](#23-主线程丢帧与渲染过载)
  - [2.4 界面在跑但没声音（静音误判）](#24-界面在跑但没声音静音误判)
- [3. 解决方案与机制](#3-解决方案与机制)
  - [3.1 全局复音上限与抢占](#31-全局复音上限与抢占)
  - [3.2 自适应同音重触发下限](#32-自适应同音重触发下限)
  - [3.3 追赶洪峰抑制](#33-追赶洪峰抑制)
  - [3.4 PerfArbiter 性能仲裁与自动降级](#34-perfarbiter-性能仲裁与自动降级)
  - [3.5 渲染 LOD 与抗闪烁](#35-渲染-lod-与抗闪烁)
  - [3.6 AudioDebugMonitor 诊断体系](#36-audiodebugmonitor-诊断体系)
- [4. 代码审查后的优化（2026-09）](#4-代码审查后的优化2026-09)
- [5. 关键参数速查](#5-关键参数速查)
- [6. 调试与验证](#6-调试与验证)

---

## 1. 背景与目标

- 谱面包含大量「黑 MIDI」（极密集的音符事件），普通实现下会出现：
  - 界面卡顿 / 掉帧；
  - 声音断续、延迟、甚至完全静音；
  - 内存与音频节点持续增长。
- 目标：在低端移动设备上也能稳定播放高密度谱面，同时保持逐音符触发的基本忠实度，并在性能不足时平滑降级而不是崩溃。

---

## 2. 性能问题复盘

### 2.1 音频线程过载（声音卡顿/静音）

**现象**

- 界面仍在正常刷新，但声音卡顿、爆音，最终静音。
- 诊断日志显示 `audioCtx.currentTime` 的推进速度只有真实时间的约 20%，即音频时钟被拖慢甚至停摆。
- 触发点是合成钢琴（`__synth__`）回退分支：该分支早期没有复音上限，高密度谱面瞬间创建约 1000 个振荡器 voice，直接把音频渲染线程打满。

**根因**

- 音频线程每帧需要处理的活动 voice 数无上界；
- 同一音高在极短时间内被反复触发，voice 数量成倍叠加；
- 主线程一旦被长任务阻塞，恢复后会在单帧内「追赶」触发海量音符，形成二次洪峰。

### 2.2 节点 churn 与内存/GC 压力

**现象**

- `createBufferSource` / `createOscillator` 创建速率远高于 `onended` 触发速率；
- 存活节点数（`srcCreated - onendedFired`）持续增长，疑似泄漏。

**根因**

- 每个音符都新建节点，短音符与重复音制造大量短命节点；
- 旧的同音节点在淡出完成前仍占用连接，`disconnect` 依赖延时回调，统计上表现为「存活」；
- 高频创建/销毁给主线程与 GC 带来压力。

### 2.3 主线程丢帧与渲染过载

**现象**

- 高密度谱面可见音符数量可达数万，单帧 `drawScene` 耗时飙升；
- 帧间隔出现 >100ms 的跳变，随后一帧堆积触发大量音符。

**根因**

- 每帧对全部可见音符逐个绘制，没有绘制预算；
- 每帧新建大量绘图对象（`Path2D`、数组）；
- 每帧写 DOM（进度条宽度、统计文本）触发样式/布局计算；
- `resize` 事件（尤其移动端地址栏收放）无节流，连续触发完整重排重绘。

### 2.4 界面在跑但没声音（静音误判）

**现象**

- 界面正常、音符在触发，但实际输出为 0，用户以为「播放器坏了」。

**根因**

- 缺少对最终输出信号的采样，无法区分「在调度」与「真的出声」；
- 音色 buffer 未预解码完成时，音符被静默丢弃（`bufferMiss`），表现为开头一段没声音。

---

## 3. 解决方案与机制

### 3.1 全局复音上限与抢占

- `SoundfontLoader.MAX_VOICES`：全局活动 voice 上限（默认 128，降级时 64）。
- `_registerVoice` 在超过上限时调用 `_stealOldest`，对最早开始的 voice 做 5ms 淡出并 `stop`。
- sample 与 synth 两个分支共用同一套 `activeVoices` 注册表，统一抢占。
- 同音新音符触发时打断上一个同音 voice（10ms 淡出），避免同音叠加。

### 3.2 自适应同音重触发下限

- 解析谱面时按「平均密度 = 音符数 / 总时长」计算 `baseRetriggerFloor`：

  | 密度（音符/秒） | 重触发下限 |
  | --- | --- |
  | ≤ 1000 | 0（逐音符忠实） |
  | ≤ 3000 | 8ms |
  | ≤ 6000 | 20ms |
  | ≤ 12000 | 35ms |
  | > 12000 | 50ms |

- `playNote` 中若同一音高距上次触发不足该下限则跳过，从源头限制 BufferSource 创建率。
- 普通密度谱面 floor=0，不牺牲还原度；只有黑 MIDI 才启用聚合。

### 3.3 追赶洪峰抑制

- `playLoop` 中单帧触发上限 `MAX_TRIGGER_PER_FRAME = 256`。
- 超过上限的音符直接快进跳过并计数（`skippedNotes`），避免音频时钟恢复瞬间灌爆音频线程。
- 移除了早期的「30ms 最小发声时长」与「同音去重」，改为按真实时长调度，仅保留 1ms epsilon 防止无效调度。

### 3.4 PerfArbiter 性能仲裁与自动降级

- 以 2 秒为窗口，累计四类性能问题：
  - 丢帧（帧间隔 >100ms 的次数）；
  - 积压（本窗口是否有跳过音符）；
  - 停摆（音频时钟推进显著慢于真实时间）；
  - 时间戳异常（`audioCtx.currentTime` 回退）。
- 窗口内问题总数 ≥ 3 → 进入降级；≤ 1 → 恢复。
- 降级动作 `applyDegradation`：
  - `MAX_VOICES` 128 → 64；
  - `retriggerFloor` 提升到至少 30ms。
- 降级/恢复时可自动弹出/收起调试面板（勾选项「渲染降级自动弹窗」）。

### 3.5 渲染 LOD 与抗闪烁

- 默认完整绘制；仅当 `PerfArbiter.degraded` 且可见音符数超过预算（`DRAW_BUDGET = 4000`）时抽样。
- 抽样步长量化为 2 的幂（`stride = 1 << ceil(log2(visible / budget))`），并以 1.3x 作为进入阈值，避免在边界反复跳变。
- 抽样基于「绝对音符索引取模」，保证同一音符在滚动中始终被画/不画，杜绝逐帧闪烁。

### 3.6 AudioDebugMonitor 诊断体系

| 指标 | 采集方式 | 用途 |
| --- | --- | --- |
| `renderCapacity` | `AudioContext.renderCapacity.onupdate` | 直接反映音频渲染线程负载，判断「UI 不卡但声音卡」 |
| RMS 输出 | `AnalyserNode.getFloatTimeDomainData`（每 200ms） | 探测实际输出静音 |
| 帧耗时 / 触发音符数 | `playLoop` 每帧 | 帧率与调度压力 |
| 绘制耗时 | `drawScene` 计时 | 渲染瓶颈定位 |
| 严重丢帧 | 帧间隔 >100ms | 主线程阻塞信号 |
| 音频时钟停摆 | 真实时间 vs `audioCtx.currentTime` | 音频线程过载 |
| 节点泄漏 | `srcCreated - onendedFired` 持续增长 | 连接/回收异常 |
| 长任务 | `PerformanceObserver('longtask')` >100ms | GC/解析阻塞 |

- 诊断定时器仅在播放时运行，避免暂停时空转。
- 调试终端支持复制、置顶/置底、透明度/模糊调节、降级自动弹窗。

---

## 4. 代码审查后的优化（2026-09）

在功能稳定后进行了一轮系统性代码审查与修复，涉及正确性、性能与死代码清理：

**正确性**

- 修复 `drawScene` 调用签名错位（`doSeek` / `setPalette` / `resizeCanvas` / `stopPlay` / `parseAndPlayMidi`）：统一为 `drawScene(notes, startIdx, endIdx, curTime)`，拖动进度条/切换配色/改变窗口时音符不再消失。
- 修复 `drawScene` 中裁剪区域在 `fill` 前被 `restore` 导致裁剪失效的问题。
- 谱面管理弹窗改用 `createElement` + `textContent` 构建，消除用户文件名带来的 XSS。
- 切换内置谱时 `await` 音色加载/预解码，避免开头丢音。
- `replayPlay` 先初始化 `AudioContext`，避免空指针。
- console 包装器对循环引用对象安全降级，不再抛错。
- 修复 CSS 中多余的右括号。

**性能**

- `drawScene` 移除每帧新建的 10 个 `Path2D`，改为复用矩形桶 + `ctx.beginPath/fill`。
- 进度条与统计合并为 100ms 节流，不再每帧写 DOM。
- `resizeCanvas` 增加 rAF 合并，接入 `resize`/`orientationchange`/`fullscreenchange`/`visualViewport`。
- `findIndex`/`filter` 改为二分 `lowerBound`。
- `isBlackKey` 改为 `Uint8Array(12)` 查表。
- 删除 `AudioDebugMonitor` 中大量只写不读的字段与每帧 `debugReport` 调用。

**清理**

- 删除整套未使用的 IndexedDB 调试日志机制；
- 删除 `activeNotes`、`midiData`、`staticCtx` 等死变量与空事件监听；
- 修正误导性注释。

---

## 5. 关键参数速查

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `SoundfontLoader.MAX_VOICES` | 128（降级 64） | 全局复音上限 |
| `MAX_TRIGGER_PER_FRAME` | 256 | 单帧最大触发音符数 |
| `baseRetriggerFloor` | 0 ~ 0.05s | 按密度自适应 |
| `PerfArbiter.windowSize` | 2s | 仲裁窗口 |
| `PerfArbiter.DEGRADE_AT` | 3 | 降级阈值 |
| `PerfArbiter.RECOVER_AT` | 1 | 恢复阈值 |
| `DRAW_BUDGET` | 4000 | 渲染抽样预算 |
| RMS 采样间隔 | 200ms | 静音探测 |
| 诊断汇总间隔 | 1000ms | 仅在播放时运行 |
| 节点泄漏检测间隔 | 5s | `debugReport` |

---

## 6. 调试与验证

- 页面左下/右下 `DEBUG` 圆形按钮（移动端与菜单按钮同组，可拖动）打开调试终端。
- 调试终端记录 `[AudioDebug]` 前缀日志：
  - `[INFO]` 蓝色：音色下载/缓存、谱面加载、AudioContext 创建；
  - `[OK]` 绿色：性能恢复；
  - `warn`/`error`：音频过载、时钟停摆、静音、泄漏、长任务、降级。
- 复现高负载：加载高密度黑 MIDI（如 `Rush E 3.mid`），观察是否触发「渲染降级」及随后是否「性能问题已缓解」。
- 缓存说明：站点使用 Cache API（`midi-player-assets-v1` 存谱面、`midi-player-soundfont-cache-v1` 存音色）。谱面列表 `midi/list.json` 每次走网络最新，其余谱面与音色走缓存。

---

## 附：文件结构

```
midi_player/
├── index.html                 # 播放器单页应用
├── README.md                  # 本文档
├── midi/
│   ├── list.json              # 内置谱面列表（name / file）
│   └── *.mid                  # 内置 MIDI 谱面
└── soundfonts/
    └── <timbre>-ogg.js        # Soundfont 音色数据
```
