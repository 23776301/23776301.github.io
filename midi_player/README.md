# MIDI 播放器 · 88 键可视化

浏览器端 MIDI 播放器：解析 `.mid` 谱面，在 Canvas 上以「88 键钢琴 + 下落音符」形式可视化，支持多音色（Soundfont）、变速播放、列表/单曲循环、自定义配色，并内置一套性能诊断与自动降级机制。

---

## 目录

1. [一、卷首漫笔](#一卷首漫笔)
2. [二、性能优化](#二性能优化)
3. [三、配色系统](#三配色系统)
4. [四、图标系统与视觉设计（Feather 线性图标）](#四图标系统与视觉设计feather-线性图标)
5. [五、音频引擎与合成](#五音频引擎与合成)
6. [六、播放控制与状态机](#六播放控制与状态机)
7. [七、数据、存储与谱面管理](#七数据存储与谱面管理)
8. [八、Canvas 可视化与渲染](#八canvas-可视化与渲染)
9. [九、UI/交互与响应式](#九ui交互与响应式)
10. [十、部署、流量与缓存策略（GitHub Pages）](#十部署流量与缓存策略github-pages)
11. [十一、调试与可观测性](#十一调试与可观测性)
12. [十二、测试与验证方法](#十二测试与验证方法)
13. [十三、性能基准与压测数据](#十三性能基准与压测数据)
14. [十四、兼容性与已知限制](#十四兼容性与已知限制)
15. [十五、已知问题与路线图](#十五已知问题与路线图)
16. [十六、安全](#十六安全)
17. [附录 A：关键参数速查](#附录-a关键参数速查)
18. [附录 B：文件结构与部署清单](#附录-b文件结构与部署清单)
19. [附录 C：版本与变更记录（CHANGELOG）](#附录-c版本与变更记录changelog)

---

# 一、卷首漫笔

SVG内联图标，
以代码绘形，以矢量为骨。
体至轻，色随心，
扁平通透，无惧缩放，
与任意主题色浑然一体，是emoji与传统icon的绝佳上位。

MIDI不载声响，是二进制的乐思底稿。
任换万千音色，都能生长出恰如其分的声响。

# 二、性能优化

## 2.1 背景与目标

- 谱面包含大量「黑 MIDI」（极密集的音符事件），普通实现下会出现：
  - 界面卡顿 / 掉帧；
  - 声音断续、延迟、甚至完全静音；
  - 内存与音频节点持续增长。
- 目标：在低端移动设备上也能稳定播放高密度谱面，同时保持逐音符触发的基本忠实度，并在性能不足时平滑降级而不是崩溃。

## 2.2 性能问题复盘

### 2.2.1 音频线程过载（声音卡顿/静音）

**现象**

- 界面仍在正常刷新，但声音卡顿、爆音，最终静音。
- 诊断日志显示 `audioCtx.currentTime` 的推进速度只有真实时间的约 20%，即音频时钟被拖慢甚至停摆。
- 触发点是合成钢琴（`__synth__`）回退分支：该分支早期没有复音上限，高密度谱面瞬间创建约 1000 个振荡器 voice，直接把音频渲染线程打满。

**根因**

- 音频线程每帧需要处理的活动 voice 数无上界；
- 同一音高在极短时间内被反复触发，voice 数量成倍叠加；
- 主线程一旦被长任务阻塞，恢复后会在单帧内「追赶」触发海量音符，形成二次洪峰。

### 2.2.2 节点 churn 与内存/GC 压力

**现象**

- `createBufferSource` / `createOscillator` 创建速率远高于 `onended` 触发速率；
- 存活节点数（`srcCreated - onendedFired`）持续增长，疑似泄漏。

**根因**

- 每个音符都新建节点，短音符与重复音制造大量短命节点；
- 旧的同音节点在淡出完成前仍占用连接，`disconnect` 依赖延时回调，统计上表现为「存活」；
- 高频创建/销毁给主线程与 GC 带来压力。

### 2.2.3 主线程丢帧与渲染过载

**现象**

- 高密度谱面可见音符数量可达数万，单帧 `drawScene` 耗时飙升；
- 帧间隔出现 >100ms 的跳变，随后一帧堆积触发大量音符。

**根因**

- 每帧对全部可见音符逐个绘制，没有绘制预算；
- 每帧新建大量绘图对象（`Path2D`、数组）；
- 每帧写 DOM（进度条宽度、统计文本）触发样式/布局计算；
- `resize` 事件（尤其移动端地址栏收放）无节流，连续触发完整重排重绘。

### 2.2.4 界面在跑但没声音（静音误判）

**现象**

- 界面正常、音符在触发，但实际输出为 0，用户以为「播放器坏了」。

**根因**

- 缺少对最终输出信号的采样，无法区分「在调度」与「真的出声」；
- 注意：该静音探测**只在欣赏模式生效**（`_autoSoundingMode()`）。音游模式由用户按键决定发声、音符间隔静音属正常，不做监测，避免刷屏误报。
- 音色 buffer 未预解码完成时，音符被静默丢弃（`bufferMiss`），表现为开头一段没声音。

## 2.3 解决方案与机制

### 2.3.1 全局复音上限与抢占

- `SoundfontLoader.MAX_VOICES`：全局活动 voice 上限（默认 128，降级时 64）。
- `_registerVoice` 在超过上限时调用 `_stealOldest`，对最早开始的 voice 做 5ms 淡出并 `stop`。
- sample 与 synth 两个分支共用同一套 `activeVoices` 注册表，统一抢占。
- 同音新音符触发时打断上一个同音 voice（10ms 淡出），避免同音叠加。

### 2.3.2 自适应同音重触发下限

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

### 2.3.3 追赶洪峰抑制

- `playLoop` 中单帧触发上限 `MAX_TRIGGER_PER_FRAME = 256`。
- 超过上限的音符直接快进跳过并计数（`skippedNotes`），避免音频时钟恢复瞬间灌爆音频线程。
- 移除了早期的「30ms 最小发声时长」与「同音去重」，改为按真实时长调度，仅保留 1ms epsilon 防止无效调度。

### 2.3.4 PerfArbiter 性能仲裁与自动降级

- 以 2 秒为窗口，累计四类性能问题：
  - 丢帧（帧间隔 >100ms 的次数）；
  - 积压（本窗口是否有跳过音符）；
  - 停摆（音频时钟推进显著慢于真实时间）；
  - 时间戳异常（`audioCtx.currentTime` 回退）。
- 窗口内问题总数 ≥ 3 → 进入降级；≤ 1 → 恢复。
- 降级动作 `applyDegradation`：
  - `MAX_VOICES` 128 → 64；
  - `retriggerFloor` 提升到至少 30ms。
- 降级时可自动展开调试区并滚到最新日志（勾选项「降级自动展开」）；恢复时不自动收起。

### 2.3.5 渲染 LOD 与抗闪烁

- 默认完整绘制；仅当 `PerfArbiter.degraded` 且可见音符数超过预算（`DRAW_BUDGET = 4000`）时抽样。
- 抽样步长量化为 2 的幂（`stride = 1 << ceil(log2(visible / budget))`），并以 1.3x 作为进入阈值，避免在边界反复跳变。
- 抽样基于「绝对音符索引取模」，保证同一音符在滚动中始终被画/不画，杜绝逐帧闪烁。

### 2.3.6 代码审查后的性能修复（2026-09）

- `drawScene` 移除每帧新建的 10 个 `Path2D`，改为复用矩形桶 + `ctx.beginPath/fill`。
- 进度条与统计合并为 100ms 节流，不再每帧写 DOM。
- `resizeCanvas` 增加 rAF 合并，接入 `resize`/`orientationchange`/`fullscreenchange`/`visualViewport`。
- `findIndex`/`filter` 改为二分 `lowerBound`。
- `isBlackKey` 改为 `Uint8Array(12)` 查表。
- 删除 `AudioDebugMonitor` 中大量只写不读的字段与每帧 `debugReport` 调用。

---

# 三、配色系统

配色采用**双维度**：**色相**区分黑白键，**明度**区分力度（5 级，轻 → 重）。

## 3.1 内置方案

| 方案 | 白键（轻→重） | 黑键（轻→重） |
| --- | --- | --- |
| A 纯紫 | 全部 `#8b5cf6`（无力度变化） | 全部 `#8b5cf6` |
| B 青蓝 × 琥珀红 | `#22d3ee → #8b5cf6` | `#fde68a → #ef4444` |
| C 青绿 × 品红 | `#5eead4 → #3b82f6` | `#f9a8d4 → #be185d` |

- 力度分级：`ci = Math.min(4, Math.floor(velocity * 5))`，共 5 档。
- 默认方案为 B，选择保存在 `localStorage.paletteV2`。

## 3.2 自定义方案（四端插值）

- 自定义色由四个端点构成：`paletteEditColors = { wl, wh, bl, bh }`（白键最轻/最重、黑键最轻/最重）。
- `buildCustomPalette(wl, wh, bl, bh)` 对每个端点做线性插值（`ramp` + `lerp`），生成 5 级色阶。
- `PALETTE_TARGET_LABELS` 提供四个目标按钮：白键最轻 / 白键最重 / 黑键最轻 / 黑键最重。
- 自定义结果保存为 `localStorage.paletteCustom`（四端颜色 JSON），启动时 `loadCustomPalette()` 恢复并注册 `PALETTES.custom`。

## 3.3 全彩取色板

- `drawColorBoard()` 用 `createImageData` 逐像素绘制 HSL 色板：**x 轴 = 色相 0–360°，y 轴 = 明度 1 → 0**，饱和度为 1。
- `_pickColorAt(e)` 通过 Pointer Events + `setPointerCapture` 把点击位置映射回色相/明度，写入当前选中的端点。
- `hslToRgb` / `hslToHex` 负责色彩空间转换。

## 3.4 色带 Swatch

- `updatePaletteSwatch()` 用内联 SVG 绘制**两个横向直角梯形**：右端竖直边为长底，左端竖直边为短底（短底 = 长底一半），左轻右重。
- 上梯形为白键色阶、下梯形为黑键色阶，各用 `linearGradient` 按 5 级色标填充；中间叠加「力度」文字。
- 该形状直观表达「同一色相下、随力度递进」的映射。

## 3.5 持久化与高亮

- 当前方案、自定义色、面板位置等均存 `localStorage`，无服务端。
- 按键高亮固定为 `rgba(139,92,246,0.7)`，不随配色方案改变。

# 四、图标系统与视觉设计（Feather 线性图标）

## 4.1 为什么用内联 SVG 而非 emoji

早期版本用 emoji（`📁` / `▶` / `⏸` / `↻` / `🔁` / `✏️`）表示按钮图标，有两个问题：

- **不可着色**：emoji 是彩色字形（字体/位图），不响应 CSS `color`，无法随主题配色变化，在深色或彩色主题里显得突兀。
- **风格不统一**：不同平台/系统的 emoji 字形差异大，且自带立体感，与页面的扁平风格不协调。

改用**内联 SVG 线性图标**后：

- **更扁平、更美观**：单色描边，无填充、无渐变、无阴影，视觉干净统一。
- **能与各种主题色融为一体**：`stroke="currentColor"` 直接继承按钮文字色，换主题/换配色时图标自动跟随，**无需为每种主题单独准备图标**。
- **矢量无损、零额外请求**：任意尺寸清晰，直接内联在 HTML 中，不需要图标字体或图片资源。

> 这属于**前端的美学设计**：用「单一视觉语言 + 语义化配色继承」，让界面在不同主题下保持一致的高级感，而不是把彩色 emoji 硬贴在按钮上。

## 4.2 图标风格与规格

采用 **Feather Icons**（线性 / outline 图标）风格，统一规格如下：

| 属性 | 值 | 作用 |
| --- | --- | --- |
| `viewBox` | `0 0 24 24` | 统一坐标系 |
| `fill` | `none` | 只描边、不填充，保持扁平 |
| `stroke` | `currentColor` | 继承当前文字色，自动适配主题 |
| `stroke-width` | `2` | 统一线宽 |
| `stroke-linecap` / `stroke-linejoin` | `round` | 圆角端点/连接，更柔和 |
| `width` / `height` | `14`（配色铅笔 `12`） | 与按钮字号协调 |
| `style` | `flex-shrink:0` | 在 flex 按钮内不被压缩 |

## 4.3 已使用的图标一览

图标混用**线性**（Feather / Solar linear）与**实心**（Bootstrap / Material）两种风格，均以 `currentColor` 取色，随主题配色自适应。

| 图标 | 图标集 | 含义 | 使用位置 |
| --- | --- | --- | --- |
| `folder-upload` | Arcticons（48 网格） | 上传 | 顶栏「上传MIDI」（纯图标） |
| `play`（polygon） | 自定义（Feather 风格） | 播放 | 播放/暂停按钮（暂停态） |
| `pause`（rect×2） | 自定义（Feather 风格） | 暂停 | 播放/暂停按钮（播放态） |
| `rotate-cw` | Feather | 重播（顺时针回转） | 「重播」 |
| `repeat` | Bootstrap Icons（`bi`，16 网格） | 列表循环 | 循环按钮（列表态） |
| `repeat-1` | Bootstrap Icons（`bi`，16 网格） | 单曲循环 | 循环按钮（单曲态） |
| `settings-minimalistic-bold` | Solar | 设置 / 菜单 | 控制行「设置」 |
| `text-bullet-list-edit-20-filled` | Fluent（20 网格） | 编辑谱面 | 顶栏「管理谱面」 |
| `round-color-lens` | Material Symbols（`ic`） | 配色面板展开/收起 | 控制行「配色」 |
| `color-bucket` | GG | 自定义配色 | 配色「自定义」 |
| `debug` | Carbon（32 网格） | 调试面板 | 控制行「调试」（配色左侧） |
| `maximize-linear` / `minimize-linear` | Solar | 全屏 / 退出全屏 | 控制行「全屏」（最右） |

## 4.4 代码写法

静态按钮（直接内联）：

```html
<button class="btn primary" onclick="...">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
    <polygon points="5 3 19 12 5 21 5 3"/>
  </svg>播放
</button>
```

动态按钮（播放/暂停、列表/单曲循环）：把图标抽成常量，切换时用 `innerHTML` 注入，避免在 JS 里重复大段 SVG。线性图标用 `_svgIcon`，实心图标用 `_fillIcon`（可指定 viewBox 边长，Bootstrap Icons 为 16）：

```js
const _svgIcon = (inner, size) => '<svg width="' + (size || 14) + '" height="' + (size || 14) +
  '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">' + inner + '</svg>';
const _fillIcon = (inner, size, vb) => '<svg width="' + (size || 14) + '" height="' + (size || 14) +
  '" viewBox="0 0 ' + (vb || 24) + ' ' + (vb || 24) + '" fill="currentColor" style="flex-shrink:0">' + inner + '</svg>';
const PLAY_ICON      = _svgIcon('<polygon points="5 3 19 12 5 21 5 3"/>');
const PAUSE_ICON     = _svgIcon('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>');
const LIST_LOOP_ICON = _fillIcon('<path d="...bi:repeat..."/>', 14, 16);
const ONE_LOOP_ICON  = _fillIcon('<path d="...bi:repeat-1..."/>', 14, 16);

document.getElementById('playBtn').innerHTML = PAUSE_ICON; // 播放中
document.getElementById('playBtn').innerHTML = PLAY_ICON;  // 暂停
document.getElementById('loopBtn').innerHTML = loopMode === 'one' ? ONE_LOOP_ICON : LIST_LOOP_ICON;
```

## 4.5 约定

- 线性图标沿用 Feather 规格（`fill:none / currentColor / round`）；实心图标用 `fill="currentColor"`。viewBox 按来源：Feather / Solar / Material（`ic`）/ GG 为 24，Bootstrap Icons 为 16，Fluent 为 20，Arcticons 为 48。
- 语义优先：上传用 `folder`、编辑用 `edit-3`、播放控制用 `play` / `pause` / `rotate-cw`、循环用 `bi:repeat`（列表）/ `bi:repeat-1`（单曲）。
- 图标颜色不写死，交给 `currentColor`；这样新增主题/配色时零成本适配。

---

# 五、音频引擎与合成

- **音频图**：`AudioContext → masterGain → outputAnalyser → destination`，`masterGain` 负责总音量，`outputAnalyser`（FFT 2048）用于静音探测。
- **音色加载**：Soundfont 以 `*-ogg.js` 形式提供，内部是 base64 音频；`_doLoad` 下载/读缓存后用 `new Function` 求值取数据，再经 `atob → Uint8Array → decodeAudioData` 得到 `AudioBuffer`。
- **媒体源（jsDelivr → Pages 回退）**：音色、内置谱面、可视化示例音频优先从 `cdn.jsdelivr.net/gh/teecatt/teecatt.github.io@master/...` 获取（CORS 可用、不消耗 GitHub Pages 流量），失败再回退本站相对路径。GitHub Release 资产不发送 CORS 头，浏览器 `fetch` 无法读取，故未采用。
- **预解码**：`predecodeAll` 按每批 8 个解码 88 个音，避免一次性解码阻塞主线程与音频时间线。
- **合成回退**：`__synth__` 分支用 3 个振荡器（triangle + 2×sine）叠加，指数包络收尾；仅在音色加载失败或 buffer 缺失时使用。
- **增益**：`timbreGain` 对个别音色（三角钢琴、古钢琴）单独设增益，其余默认 3.0。
- **包络**：短音符按比例缩短 attack/release，避免事件时间倒挂。
- **采样缓存**：每个音色按 midi 缓存已解码 `AudioBuffer`（`entry.buffers[midi]`），超出 88 键范围的音会映射到最近有效键。

# 六、播放控制与状态机

- **状态**：`isPlaying`、`currentTime`、`nextNoteIndex`、`playStartTime`、`playSpeed`、`loopEnabled`。
- **时钟**：以 `audioCtx.currentTime` 为准推进 `currentTime`，避免 `performance.now` 与音频时钟漂移。
- **控制**：播放/暂停/停止/重播、进度条拖拽 seek、0.2x–2x 变速、列表循环/单曲循环。
- **定位**：seek 与开始播放都用二分 `lowerBound(allNotes, time)` 找起始音符，避免线性扫描。
- **并行加载与自动播放**：进入页面即**并行**下载默认谱面与默认音色（早期版本为串行）。谱面解析完成即可起播：若音色尚未就绪，先用**合成钢琴**抢跑，待音色下载并**预解码完成后无缝切回**——只切换 `current`，不打断正在发声的 voice，避免解码期间丢音；音色加载失败则保持合成钢琴。若 AudioContext 处于 suspended，则挂到首次点击/触摸后恢复。
- **回到前台自动续播**：不因失焦暂停。`visibilitychange` 回到前台时，若仍在播放且音频上下文被浏览器挂起，则自动 `resume()` 并确保渲染循环运行。注：后台期间 rAF 被浏览器挂起，音频不会持续输出，此机制保证切回后接上。
- **列表循环 / 单曲循环**：循环按钮为两态。**列表循环**（默认）一首播完自动切下一首，播到列表末尾回到第一首继续；**单曲循环**重复当前一首。切歌时 `await` 音色加载后再开始，避免开头丢音。
- **进度节流**：进度条与统计文本合并为 100ms 更新一次，避免每帧写 DOM。

# 七、数据、存储与谱面管理

- **解析**：使用 `@tonejs/midi` 解析，汇总所有轨道的音符为 `{midi, time, duration, velocity}` 并按时间排序，计算总时长与密度。
- **内置谱**：`midi/list.json` 描述 `name`/`file`，通过 `fetchFresh` 获取最新列表。
- **默认音色映射**：`songDefaultTimbre` 将谱面文件名映射到默认音色（如 `Rush E 3.mid → clavinet`）。
- **用户上传**：文件读取后立即解析播放，同时写入 IndexedDB `user-songs`，支持在「谱面管理」弹窗中删除；全部本地，不涉及服务器。
- **偏好持久化**：配色（`paletteV2`/`paletteCustom`）、面板位置（`menuBtnPos`）、降级弹窗（`dbgAutoOpen`）。

# 八、Canvas 可视化与渲染

- **88 键布局**：`getKeyLayout` 先排白键再插黑键，`keyByMidi` 建立 midi→键位 O(1) 映射。
- **静态层**：背景、轨道线、琴键、音名预渲染到离屏 `staticCanvas`，每帧只 `drawImage` 一次。
- **下落音符**：按 `time / duration` 映射为屏幕坐标，颜色由「黑白键 × 力度 5 级」决定；使用 `roundRect` 圆角，并在琴键上方裁剪。
- **LOD**：高负载时按绝对索引抽样（见性能章）。
- **按键高亮**：直接读 `activeSources`/`activeSynth` 注册表，与绘制抽样解耦。
- **高分屏**：所有尺寸乘以 `devicePixelRatio`，`resize` 时重建布局与静态层。

# 九、UI/交互与响应式

## 9.1 设置按钮（控制行内）

- 菜单 / 设置按钮已并入**控制行**，位于「循环」右侧，圆形 `.ctl-btn.primary`（主题紫底 + 白图标，与播放控制一致），图标为 **`solar:settings-minimalistic-bold`**（实心内联 SVG）；点击调用 `toggleMenu()` 展开 / 收起菜单面板。
- 原移动端可拖拽 FAB 与 PC 顶栏菜单按钮已移除（`.fab-group` 不再存在），`toggleMenu` 对 `#fabGroup` 为 null 的情况做了保护。
- 遮罩 `.overlay-mask` 仍在，点击可关闭菜单面板。

## 9.2 菜单面板（渐隐渐显，PC 与移动端统一）

- `.control-panel` 为**居中浮层**（`top/left:50%` + `translate(-50%,-50%)`）：**高度占 2/3 屏**（`height:66.67vh`），用 `opacity` + `visibility` **渐隐渐显**展开/收起（无左右抽屉滑动）。宽度：移动端 `100vw`，PC `50vw`（上限 560px）。
- `.overlay-mask` 半透明遮罩，点击调用 `toggleMenu()` 关闭；打开菜单时隐藏 FAB 组。
- 面板采用**半透明 + 背景模糊**风格，面板内的「透明 / 模糊」滑块可实时调节（见 9.7）。**默认透明 100%（全透明）、模糊 25%**。

## 9.3 弹窗与 Toast

- **自定义配色弹窗** `paletteModal`：目标选择 + 全彩取色板 + 预览 + 保存/取消。
- **谱面管理弹窗** `manageModal`：列出用户上传与内置谱面；全部用 `createElement` + `textContent` 构建，避免文件名 XSS。
- **Toast**：`window.showToast(msg)` 顶部居中提示，4s 自动消失；用于谱面加载/解析失败与音色回退提示。

## 9.4 响应式与视口

- `@media(max-width:800px)`：单列布局、隐藏标题、`height:100dvh`、Canvas 全屏。
- PC 端：整页锁定视口高度（`100dvh` + `overflow:hidden`），绘制区 `flex:1` 占满，钢琴键始终位于屏幕底部、无需滚动页面（见 9.6）。
- 高分屏：所有绘制尺寸乘以 `devicePixelRatio`。
- 视口变化：`resize`（rAF 合并）、`orientationchange`、`fullscreenchange`、`visualViewport` 均触发重算布局，确保钢琴键盘始终可见。
- **安全区**：目前仅使用 `100dvh` 处理移动端视口，尚未适配 `env(safe-area-inset-*)`（见路线图）。

## 9.5 自定义下拉（音色 / 谱面）

原生 `<select>` 的 `<option>` 由操作系统绘制，深色主题下在桌面端常出现**白底白字**、无法用 CSS 可靠着色的问题。为此用自定义下拉替换：

- **原生 select 保留为数据源**：`.value` / `.selectedIndex` / `.options` / `.innerHTML` / `.appendChild` 等接口照常可用，仅在视觉上隐藏，其余业务代码零改动。
- **双向同步**：覆写实例上的 `value` / `selectedIndex` setter，并监听子节点变化（`MutationObserver`），程序化改值或动态重建选项时自动刷新触发按钮文案；用户在下拉中选择时回写原生 select 并派发 `change`。
- **弹层 portal 到 `document.body`**：使用 `position:fixed`，避免浮层的 `transform` 使 fixed 相对面板定位，以及面板 `overflow` 裁剪。
- **交互**：分组标题、选中高亮、**搜索过滤**（55 种音色快速定位）、方向键 / 回车 / Esc 键盘操作、点击外部或滚动时自动关闭 / 重新定位。

## 9.6 PC 布局与全屏

- **视口自适应**：PC 端整页锁定视口高度（`height:100dvh` + `overflow:hidden`），`.layout` 用 `flex:1` 撑满，`.visual-panel` 与 Canvas 以 `flex:1` 占满——**钢琴键始终贴在屏幕底部，无需滚动页面**；菜单面板为浮层，不再挤压绘制区。
- **顶栏两行**：第一行 `重播 / 选谱列表 / 全屏`（重播在左、全屏在右）；第二行 `播放·暂停 / 下一首 / 循环 / 上传谱面 /（靠右）谱面管理 / 设置 / 配色 / 调试`。进度条与统计信息仍单独置底。
- **下一首**：`nextSong()` 切到列表下一首，到底回到第一首；`#nextBtn` 在谱面加载后启用。
- **按钮**：全部为圆形 `.ctl-btn.primary`；上传 `arcticons:folder-upload`、管理 `fluent:text-bullet-list-edit-20-filled`、设置 `solar:settings-minimalistic-bold`、配色 `ic:round-color-lens`、调试 `carbon:debug`、重播 `hugeicons:replay`、全屏 `solar:maximize/minimize-linear`；循环为**列表（`bi:repeat`）/ 单曲（`bi:repeat-1`）/ 不循环（`mdi:repeat-off`）三态**。谱面管理/设置/配色/调试**靠右对齐**（管理按钮 `margin-left:auto`）。
- **全屏按钮**：第一行最右，对 `.visual-panel` 调用 `requestFullscreen()`，仅放大绘制区（Esc 退出）；进入 / 退出时图标切换为向内箭头。全屏内另有悬浮控件（见 9.11）。
- **统一下拉面板 + 互斥**：设置 / 谱面管理 / 配色 / 调试四个面板风格一致（打开其一自动关闭其余及选谱/音色下拉），均从各自触发按钮**向下展开**（四个面板均作为 `.control-row` 子元素，`position:absolute; top:100%; right:0`，即控制行下方），最大高度约视口 2/3（≈渲染区 2/3），点击面板/触发按钮以外区域关闭（`closeAllDropPanels`）。

## 9.7 菜单面板、调试面板与滑动开关

菜单面板（`.control-panel.drop-panel`，即「设置」）是**播放设置与音色**的统一容器，从设置按钮向下展开、内容可滚动；面板内所有开关均为**滑动开关**（`.switch`）而非勾选框。已删除「设置 / 音色」两个分组大标题；音色行与其它设置行一致：左侧 `音色选择` 标签、右侧下拉列表：

- **透明度 / 模糊（仅设置面板）**：面板顶部保留「透明 / 模糊」滑块，背景为 `rgba(0,0,0,alpha)` + `backdrop-filter: blur()`；透明 100 = 全透明（alpha 0）、0 = 全黑，默认 **100**；模糊默认 **25%**；通过 `_applyAllAppearance()` 应用到设置/调试/配色/选谱/管理面板并持久化（`panelTransparency` / `panelBlur`）。调试面板与管理面板已**移除各自的滑块**。
- **音乐倍速**：`speedSlider`（0.1–3.0×，步进 0.1，与下落流速一致的滑块）；**音量滑块已移除**，主增益固定 100%，由系统音量控制。
- **钢琴高度**：`pianoHeightSlider`（5%–50%，默认 16%）调节键盘区占绘制区的高度，`renderStatic` / `drawScene` 用 `C.h * pianoHeightPct/100`。
- **音游? 开关**：位于设置面板右上角（透明度/模糊滑块右侧）；开 = 「欣赏模式」（音符自动发声），关 = 「音游模式」（音符只下落、需点击琴键）。
- **降级自动展开**：开启时，性能降级会展开**调试面板**并滚到日志底部；恢复时不自动收起。

## 9.8 钢琴键盘交互

- **点击 / 触摸琴键发声**：`#visualCanvas` 上的 Pointer Events 命中键盘区（黑键优先）→ `SoundfontLoader.playNote(midi, 0.9, 0.7)`；支持多指（`_keyPointers` 按 pointerId 记录）。
- **抬起即停 + 高亮即时消失**：`pointerup` / `pointercancel` 时调用 `SoundfontLoader.stopNote(midi)` 立即停止该键 voice（同一键仍被其它手指按住则不停），紫色高亮随 `activeSources`/`activeSynth` 清除，不再残留到固定 0.7s 时长结束。
- **暂停时也有按下反馈**：暂停（`isPlaying=false`）时没有 rAF 播放循环，敲键/松键通过 `requestStaticRedraw()` 用 rAF 补一次静态重绘，因此暂停状态触屏点键同样能看到紫色按下遮罩；`pausePlay()` 也会补一次重绘清掉残留高亮。
- **两种模式都可用**：欣赏模式下自动发声的同时，用户敲击琴键可叠加额外声音；演奏模式则完全依赖用户敲击。
- **双击渲染区播放 / 暂停**：非钢琴键的渲染区域（下落音符区）内，300ms 内的第二次按下（鼠标双击或触摸双触）等价于播放/暂停（`togglePlay()`）；命中后计数归零，避免三连击重复触发。琴键区仍只负责发声。
- **坐标换算**：`_canvasPointToKey` 用 `getBoundingClientRect` 把客户端坐标映射到画布像素，再按 `keyAreaH` 判定是否落在键盘区。
- **已移除**：上边缘拖动调高度、两指捏合缩放、锁定按钮 / 总锁——改为菜单面板滑块（见 9.7）。

## 9.8.1 钢琴宽度缩放与版型

- 菜单面板新增两个滑块：**宽度缩放** `pianoWidthSlider`（1.0×–4.0×）与**水平偏移** `pianoOffsetSlider`（0%–100%，0 最左、100 最右），分别控制 `pianoWidthScale` 与 `viewOffsetX`；缩放后 `getKeyLayout` 重算键宽，渲染区与音符轨道同步，`drawScene` 跳过水平不可见音符（`key.x+w<0 || key.x>C.w`）省性能，播放不受影响。
- **标准钢琴版型**：`keyboardPresetSlider` 为 **0–5 六档固定档位**（`step=1`），对应 88 / 76 / 61 / 49 / 37 / 25 键。每种版型带独立音域与默认缩放/偏移，选档后**该音域第一个键正好对齐渲染区最左侧**；缩放 = `52 / 音域白键数`（使音域白键恰好铺满画布宽），偏移 = `白键序号 × 缩放 / (52 × (缩放−1)) × 100%`：

| 档位 | 键数 | 音域（科学音高 / MIDI） | 白键数 | 默认缩放 | 默认偏移 |
| --- | --- | --- | --- | --- | --- |
| 0 | 88 | A0–C8（21–108） | 52 | 1.000× | 0% |
| 1 | 76 | E1–G7（28–103） | 45 | 1.156× | 57.14% |
| 2 | 61 | C2–C7（36–96） | 36 | 1.444× | 56.25% |
| 3 | 49 | C2–C6（36–84） | 29 | 1.793× | 39.13% |
| 4 | 37 | C3–C6（48–84） | 22 | 2.364× | 53.33% |
| 5 | 25 | C3–C5（48–72） | 15 | 3.467× | 43.24% |

- 水平偏移滑块改为 `step=0.1`，以便精确落在版型默认偏移；缩放上限 4× 覆盖 25 键版型，仍可再调偏移平移可见音域。

## 9.9 配色面板（下拉浮层）

- 控制行内的配色按钮（`paletteToggleBtn`，圆形紫色 `.ctl-btn.primary`，图标 `ic:round-color-lens`，收起时旋转 180°）切换 `paletteRow`；**默认收起**，点击从按钮下方展开。
- **下拉浮层**：`paletteRow` 使用统一 `.drop-panel` 样式（绝对定位在控制行下方），浮在渲染区之上，**不改变渲染区高度，也不影响进度条 / 统计信息位置**；背景与设置/调试/选谱/管理面板共享同一透明度与模糊（`_panelTargets` 含 `paletteRow`）。
- **按钮**：A/B/C/自定义四个 `.pal-btn` 为 **27px** 圆形；A/B/C 使用 **Google Sans 常规字重**（`@font-face` 来自 `fonts.googleapis.com`，`font-weight:400`，回退 Product Sans / 系统字体）；**始终为不透明主题紫底白字**（无白圈/半透明）。已删除「配色方案」竖排文字标签。
- **力度图不换行 + 标签叠加**：`paletteRow` 改为 `flex-wrap:nowrap`，`#paletteSwatch` 用 `flex:1 1 0;min-width:0` 自适应收缩，两张力度图不再被挤到下一行；原左侧「白键 / 黑键」独立列已删除，改为把 `白键`/`黑键`/`力度` 用 `_swatchLabel()` **叠加**在梯形渐变图上（白字 + 黑色描边阴影），节省横向空间。
- **自动收起**：播放中若 2s 内未操作配色面板（点按面板或切换配色会重置计时），自动收起（`schedulePaletteAutoCollapse`，仅在 `isPlaying` 且面板展开时生效）；暂停时取消计时。

## 9.10 谱面管理面板（下拉浮层）

- **统一样式**：`manageModal` 为 `.drop-panel.manage-panel`，从「管理谱面」按钮向下展开、最大高度约视口 2/3；背景与设置/调试/配色/选谱面板共享同一透明度与模糊（`_panelTargets` 含 `manageModal`）。已移除独立卡片与「透明 / 模糊」滑块。
- **点击外部收起**：统一由 `closeAllDropPanels()`（document 捕获 pointerdown，排除 `.drop-panel` 与 `.drop-trigger`）处理。
- **就地删除 / 重下**：行内只有名称 + 右侧垃圾桶/下载图标（无「内置 / 已删除 / 上传」文字标签）。点击后图标就地变为**加载中**（下载时若服务端给出 `content-length` 则显示百分比），完成后原地切换为另一图标，**不再重建并重新弹出整个面板**；`deleteBuiltinSong` / `redownloadBuiltinSong` 仅做操作并刷新选谱下拉。
- **内置谱列表缓存**：`_getBuiltinList()` 用内存 + Cache API（cache-first），选谱下拉与管理面板打开不再每次联网拉 `list.json`。
- **默认预取**：启动仅并行加载 `Rush E 3`（默认播放）并后台预取 `The Sound of Silence`；并发测试谱不默认下载，选到时才按需加载。
- **音色列表按需下载**：音色下拉每一项右侧有垃圾桶 / 下载按钮（复用 `.icon-btn`，与谱面管理一致）。已缓存显示垃圾桶（正在使用的音色不可删），未缓存显示下载按钮、点击后就地显示百分比；**未完成下载的音色不允许切换**（`canChoose` 拦截并提示）。`SoundfontLoader.cachedNames` 由 `refreshCachedNames()` 扫描缓存重建，删除用 `deleteCached()`。已删除「当前音色：xx 已就绪」文字提示。

## 9.11 全屏悬浮控件

- **按钮**：`.fs-overlay` 仅全屏显示，含**设置**（左上，`fsSettingsBtn`）、**退出全屏**（右上，`fsExitBtn`）两个 42px 紫色圆形按钮；均无模糊（`backdrop-filter:none`）。**活跃状态 `opacity:.5`，空闲 2s 后 `opacity:.2` 并吸附到左右边界（`translateX(∓50%)`），只露出半边圆**，`.faded` 移除后滑回内缩 14px 的完整位置。
- **点击即暂停**：全屏时任一悬浮按钮 click 先 `_fsPauseIfPlaying()`（正在播放则 `pausePlay()`），再执行自身动作。
- **2s 淡出 + 吸附**：仅**点击悬浮按钮**会重置 2s 计时（点琴键 / 音符区不算）；超时后加 `.faded`：`opacity:.2`、设置按钮左移半圆、退出按钮右移半圆（`transition:opacity .3s, transform .3s`）。
- **菜单可用**：由于浏览器全屏只渲染全屏元素，进入全屏时把 `.control-panel` 与 `.overlay-mask` 临时移入 `.visual-panel`（`_syncFsLayout`），退出时移回原位，从而左上角设置按钮能在全屏内打开菜单。
- **已移除**：锁定悬浮按钮与总锁（连同拖动 / 捏合手势）。

## 9.12 调试面板（独立浮层）

- 控制行内新增圆形 `.ctl-btn.primary` 调试按钮（`debugToggleBtn`，图标 `carbon:debug`），位于**配色按钮左侧**；点击 `toggleDebugPanel()` 切换 `.debug-panel.open`，面板从控制行**向下展开**（统一 `.drop-panel`，绝对定位），浮在渲染区之上，**不改变渲染区高度**。
- 面板顶部工具行为：**启用调试开关（左）……重置所有选项按钮（右上角，红色警示样式，含文字「重置所有选项」+ `fluent:arrow-reset-20-regular` 图标，`resetAllSettings()` 清除 `panelTransparency` / `panelBlur` / `dbgAutoOpen` / `deletedBuiltin` 后刷新）**。第二行为日志操作按钮：**降级自动展开开关（最左，每次开启调试默认打开）→ 复制 → 下载日志 → 清空 → 置顶 → 置底**（圆形 SVG 图标）；日志区 200px 可滚动。面板底边通过 `_syncDebugPanelHeight()` 与设置面板实际高度对齐。**透明 / 模糊滑块已移除**（只在设置面板保留）。
- **开启调试即降耗**：每次勾选「启用调试」自动把透明度设为 **20%**（较暗）、模糊 **0%** 并提示。
- 调试总开关默认开启；关闭后 `body.dbg-off` 隐藏 `.dbg-body`、停止采集与监控。
- 面板背景与设置 / 配色 / 选谱 / 管理面板共享同一透明度与模糊（见 9.7、9.9）。

## 9.13 选谱与软键盘

- 自定义下拉（音色 / 谱面）弹层 `.csel-pop` 为 `position:fixed` 且挂到 `body`，直接遮挡渲染区；其背景/模糊同样纳入统一面板外观（`_panelTargets`）。
- **不自动聚焦搜索框**：`open()` 不再调用 `search.focus()`，点击音色 / 谱面列表不会唤醒输入法；用户可手动点搜索框。
- **状态区**：进度条上方的 `.time-row` 中间新增 `#statusText`。调试面板关闭时，日志镜像到此处会**去掉时间戳与 `[AudioDebug]` 前缀**，只保留精确信息，名称用中括号包裹，如 `音色[古钢琴]从jsDelivr下载成功!`、`谱面[Rush E 3.mid]从jsDelivr下载失败，尝试从Pages直取…`、`音色[古钢琴]下载 42%`。原顶部浮层 Toast 已移除（不再遮挡点击）。
- `viewport` 设 `interactive-widget=overlays-content`，并在 `visualViewport.resize` 中判断键盘高度差（`height < innerHeight-120`）时**跳过画布重算**，使软键盘 / 选谱弹层弹出时渲染区高度不变、由弹层直接遮挡。

# 十、部署、流量与缓存策略（GitHub Pages）

> 本章与「性能」分离：性能关注**运行时的帧率与音频延迟**，本章关注**网络流量、加载速度、存储与托管成本**。

## 10.1 部署形态

- 仓库：`teecatt/teecatt.github.io`，分支 `master`，通过 GitHub Pages 静态托管。
- 工作流：`.github/workflows/deploy.yml`（`Deploy to GitHub Pages`），每次推送到 `master` 触发构建与发布。
- 访问域名：自定义域名 `down2.top`，播放器路径 `/midi_player/`。
- 无服务端运行时：所有逻辑在浏览器执行；谱面与音色均为静态文件。

## 10.2 仓库体积与流量现状

| 目录 | 文件数 | 体积 |
| --- | --- | --- |
| `midi_player/soundfonts/` | 56 个 `*-ogg.js` | **≈ 132.6 MB** |
| `midi_player/midi/` | 9 个（含 `list.json`） | ≈ 2.9 MB |
| `midi_player/index.html` | 1 | ≈ 105 KB |

- 单个音色文件约 2–4.5 MB（如 `lead_7_fifths-ogg.js` 4.5 MB、`violin-ogg.js` 3.6 MB）。
- 默认加载：`Rush E 3.mid`（2.6 MB）+ 默认音色 `clavinet`（2.6 MB）≈ **5.2 MB**；若再后台预加载 `acoustic_grand_piano`（2.6 MB）与 `electric_piano_2`（2.3 MB），首次会话网络开销约 **10 MB**。

**传输压缩实测（GitHub Pages / Fastly）**

| 资源 | 原始 | gzip 传输 | 说明 |
| --- | --- | --- | --- |
| `index.html` | 111 KB | **34 KB** | 文本，压缩 3.3× |
| `soundfonts/clavinet-ogg.js` | 2.67 MB | **1.73 MB** | base64 文本，压缩约 1.35× |
| `midi/Rush E 3.mid` | 2.70 MB | 2.70 MB | 二进制，几乎不可压 |
| `*.ogg` | 1.58 MB | 1.58 MB | 二进制，几乎不可压 |

- **HTML 快只是因为小且压得狠**，音色慢的根因是体积（2.67 MB），默认谱面本身也有 2.7 MB，二者量级相同。
- GitHub Pages 支持 **gzip 但不支持 brotli**（请求 `br` 会回落到 identity）。
- 把音色后缀从 `.js` 改成 `.html` **无收益**：压缩由内容/内容类型决定，与扩展名无关。
- 若把 base64 还原成裸 OGG 二进制，虽省去 33% base64 膨胀，但 OGG 不可再压，反而比「gzip 后的 base64」（1.73 MB）更大，故当前方案在传输上并不吃亏。

## 10.3 客户端缓存策略

本项目**未使用 Service Worker**，而是直接用 **Cache API** 做资源缓存：

| 缓存名 | 内容 | 策略 |
| --- | --- | --- |
| `midi-player-soundfont-cache-v1` | Soundfont `*-ogg.js` | 缓存优先（cache-first），首次下载后写入，后续离线命中 |
| `midi-player-assets-v1` | MIDI 谱面 | 缓存优先，`ignoreSearch` 忽略查询串 |
| IndexedDB `midi-player-db` / `user-songs` | 用户上传的 MIDI | 仅本地存储，**从不回传服务器** |
| `localStorage` | 配色、面板位置等偏好 | 轻量键值 |

关键实现点：

- **统一绝对路径做缓存键**（`new URL(url, location.href).href`），避免相对路径在不同页面下解析不一致导致缓存失效。
- **`ignoreSearch: true`**：允许用 `?v=xxx` 做版本/刷新控制而不会产生重复缓存条目。
- **`fetchFresh` 仅用于 `midi/list.json`**：`cache: 'no-store'` 始终走网络拿最新列表，再回写缓存；其余资源走缓存，避免每次加载都重新下载。
- **缓存版本化**：缓存名带 `-v1` 后缀；需要整体失效时提升版本号即可。
- **旧缓存清理**：启动时遍历 `caches.keys()`，删除 `midi-player-assets-*` 中非当前版本，避免历史残留占用空间。
- **配额兜底**：Soundfont 写入缓存失败（存储不足）时，删除一半旧条目后重试一次。

## 10.4 已实现的流量节省

- **重复访问零流量**：音色与谱面命中 Cache API，回访用户不再下载（列表除外）。
- **列表极小**：`list.json` 仅约 1 KB，且是唯一每次走网络的资源。
- **按需加载音色**：默认只下载 **古钢琴（默认曲目）+ 三角钢琴 + 电钢琴2** 三个；其余音色仅在用户主动点下拉里的下载按钮、或切到 `songDefaultTimbre` 配置了该音色的谱面时（`onTimbreChange({auto:true})`）才下载，绝不拉取全部 56 个。
- **用户上传不上云**：上传的 MIDI 存本地 IndexedDB，服务端零带宽。
- **诊断不上网**：所有性能指标在本地采集，不发送遥测。

## 10.5 可进一步优化的方向

1. **精简仓库音色集**：只保留实际用到的音色，或提供「钢琴精简包」；132 MB 中大部分是长尾音色。
2. **按需预加载 + 省流量模式**：读取 `navigator.connection.saveData` / `effectiveType`，在移动网络或省流量模式下跳过后台预加载。
3. **音色外置（已实现）**：Soundfont / 内置谱面 / 示例音频改由 **jsDelivr CDN** 提供（`_mediaUrls` 生成候选源，`_fetchBlobWithProgress` 逐个回退），失败时回退本站 Pages；缓存 key 仍用本站绝对路径以兼容旧缓存。
4. **缓存已解码的 AudioBuffer**：把 `decodeAudioData` 结果存入 IndexedDB，跳过每次会话的 base64 解码与解码等待（当前解码在 `predecodeAll` 中完成）。
5. **文件名哈希 + 长缓存**：对静态资源使用内容哈希命名并配合 `immutable` 语义，配合 `ignoreSearch` 精确失效。
6. **资源提示**：对 CDN/音色目录加 `preconnect`/`prefetch`，缩短首字节时间。
7. **Service Worker（可选）**：若需要更精细的离线策略、后台更新与版本迁移，可引入 SW 统一管理缓存。
8. **压缩与格式**：确认 Pages 已启用 gzip/brotli；音色可评估更小的采样率/编码。

## 10.6 GitHub Pages 限制与注意事项

- **带宽软上限**：GitHub Pages 建议约 **100 GB/月**；仓库体积建议 **< 1 GB**（当前音色约 132 MB，尚可但应关注）。
- **不可自定义响应头**：Pages 无法设置 `Cache-Control`/`_headers`（除非前置 Cloudflare 等代理）；因此缓存控制主要由浏览器默认行为 + Cache API 承担。
- **构建并发**：同一分支连续推送时，旧的工作流运行会被取消（`cancelled`），最终以最后一次运行为准，属正常现象。
- **自定义域名**：`down2.top` 通过仓库 `CNAME` 配置；换域时需同步缓存键的绝对路径基准。
- **`.nojekyll`**：若引入以下划线开头的资源目录，需要 `.nojekyll` 防止 Jekyll 处理。

---

# 十一、调试与可观测性

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

- 诊断定时器仅在播放时运行；`debugReport` 每 5s 检查节点泄漏；仅在**调试开启**时采集。
- 调试面板**独立于菜单面板**（见 9.12），支持复制、**下载日志**、清空、置顶/置底；面板支持透明度/模糊调节（与菜单等绑定）；降级可自动展开。
- 调试总开关默认开启，关闭后停止全部调试采集、监控与降级自动展开。
- 日志分级配色：`[INFO]` 蓝（下载/加载）、`[OK]` 绿（恢复）、黄 warn、红 error；同类告警 1.5s 折叠，DOM 行数上限 300。
- 降级/恢复文案：`最近 2s出现N次性能问题，分别是丢帧、积压、停摆、时间戳，触发渲染降级` / `性能问题已缓解，恢复完整渲染。`

# 十二、测试与验证方法

## 12.1 静态校验

- **JS 语法**：抽取 `<script>` 内联块，逐个 `node --check`。
- **CSS 配平**：统计 `<style>` 内 `{` 与 `}` 数量是否相等（曾借此发现一个多余的 `}`）。
- **HTML 结构**：检查关键交互元素（卡片、按钮）是否存在标签嵌套冲突。

## 12.2 功能回归清单

- 默认谱面自动加载并播放；上传本地 MIDI 后自动播放并进入「我的上传」。
- 切换谱面、切换音色、变速、循环模式（列表/单曲）、进度条拖拽 seek。
- 回到前台自动续播；移动端抽屉、FAB 拖动与吸附、弹窗、Toast。
- 配色 A/B/C 切换、自定义四端颜色并保存、刷新后恢复。

## 12.3 高密度复现用例

仓库 `midi_player/midi/` 内置了一组并发压力谱面：

| 文件 | 特征 |
| --- | --- |
| `concurrent_44_500ms.mid` | 44 键，每 500ms |
| `concurrent_88_500ms.mid` | 88 键，每 500ms |
| `concurrent_88_250ms.mid` | 88 键，每 250ms |
| `concurrent_88_100ms.mid` | 88 键，每 100ms |
| `concurrent_88_50ms.mid` | 88 键，每 50ms |
| `concurrent_88_10ms.mid` | 88 键，每 10ms（极限） |
| `Rush E 3.mid` | 真实高密度曲目 |

## 12.4 指标阈值判定

| 指标 | 阈值 | 含义 |
| --- | --- | --- |
| 帧间隔 | >100ms 计一次严重丢帧 | 主线程阻塞 |
| 帧间隔 | >80ms 告警并追赶 | 瞬时卡顿 |
| 帧率 | <30fps 告警（预期 60fps） | 渲染压力 |
| `renderCapacity` | peak > 0.9 或 underrun > 0.02 | 音频线程过载 |
| 音频时钟 | wall > 1200ms 且 audio < 30% | 时钟停摆 |
| RMS | 播放中且触发过音符但静音 > 1.5s | 输出静音 |
| 节点 | `created - ended > 500` 且增长 > 200 | 节点泄漏 |
| 存活节点 | 较上次 +50 连续 3 次 | 泄漏趋势 |
| 跳过音符 | > 0 | 音符积压 |
| PerfArbiter | 2s 内问题 ≥ 3 降级 / ≤ 1 恢复 | 自动降级 |

## 12.5 验证流程

1. 打开 DEBUG 面板。
2. 加载高密度谱面（如 `concurrent_88_10ms.mid` 或 `Rush E 3.mid`）并播放 30s 以上。
3. 观察是否出现「触发渲染降级」、随后是否「性能问题已缓解」。
4. 检查有无「输出静音」「音频时钟停摆」「节点泄漏」「主线程长任务」告警。
5. 记录第十三章基准数据。

# 十三、性能基准与压测数据

> 播放器**不发送遥测**，所有数据来自页面 DEBUG 面板。下表为**采集模板**，需在目标设备上实测填入；`待测` 表示尚未采集。

## 13.1 采集方法

1. 选定设备与浏览器；分别测试「首次（空缓存）」与「缓存命中」。
2. 加载指定谱面，播放 ≥ 30s，取稳定期数据。
3. 记录：平均 fps、`drawMs`、峰值 voice（`srcCreated - onendedFired` + `synthVoices`）、`renderCapacity` avg/peak、跳过音符数、是否触发降级。

## 13.2 对照表（模板）

| 设备 | 谱面 | 缓存 | 平均 fps | drawMs | 峰值 voice | rcAvg | rcPeak | 跳过音符 | 是否降级 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 待测 | `concurrent_88_10ms.mid` | 首次 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 待测 | `concurrent_88_50ms.mid` | 首次 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 待测 | `concurrent_88_100ms.mid` | 首次 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 待测 | `concurrent_88_250ms.mid` | 首次 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 待测 | `Rush E 3.mid` | 首次 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 待测 | `Rush E 3.mid` | 命中 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |

## 13.3 预期趋势（定性）

- 密度越高，voice 峰值与跳过音符越多，`drawMs` 越大。
- 超过 `PerfArbiter` 阈值后触发降级，帧率与音频负载应回升。
- `renderCapacity.peak` 是判断音频线程过载最敏感的指标；`fps` 只反映主线程。

# 十四、兼容性与已知限制

- `AudioContext.renderCapacity` 需要较新的 Chrome（约 116+），不支持时静默降级为其他指标。
- `CanvasRenderingContext2D.roundRect` 需要 Chrome 99+/Safari 16+；更旧浏览器圆角会缺失。
- Cache API / IndexedDB 在隐私模式或存储受限时可能不可用，代码走网络/内存回退。
- `devicePixelRatio` 变化（拖到不同缩放屏幕）只在 `resize` 时重算。
- 极长持续音（duration 大于下落窗口）在当前可见区间二分下可能被提前裁剪。
- 音色全部为压缩采样，首次解码仍有一定延迟；预加载策略会占用额外流量。
- 移动端未适配 `env(safe-area-inset-*)`，刘海屏/手势条区域可能遮挡底部控件。

# 十五、已知问题与路线图

## 15.1 已知问题

1. **长音裁剪**：`leftIdx = lowerBound(allNotes, currentTime - fallDuration)` 只按起始时间取左界，持续时间超过下落窗口的持续音可能被提前裁掉。
2. **旧浏览器圆角缺失**：无 `roundRect` 时音符为直角。
3. **音色体积偏大**：仓库约 132 MB，长尾音色多，首次会话流量约 10 MB。
4. **解码未持久化**：每次会话都要重新 `decodeAudioData`，首次切换音色有可感延迟。
5. **安全区未适配**：仅 `100dvh`，未使用 `env(safe-area-inset-*)`。
6. **`renderCapacity` 兼容性**：旧浏览器无该指标，过载判断灵敏度下降。

## 15.2 路线图（Roadmap）

1. **长音渲染修正**：可见区间上界改为按 `time + duration` 取值。
2. **音色精简 / 外置 + 省流量模式**：`navigator.connection.saveData` 跳过后台预加载；音色迁移到独立 CDN。
3. **已解码 AudioBuffer 持久化**：存入 IndexedDB，跳过重复解码。
4. **Service Worker（可选）**：统一离线策略、后台更新与版本迁移。
5. **安全区适配**：引入 `env(safe-area-inset-*)` 与 `viewport-fit=cover`。
6. **自动化回归**：无头浏览器截图 + 性能采样，纳入 CI。
7. **配色预设导入/导出**：分享自定义配色。
8. **无障碍与快捷键**：ARIA 标注、键盘操作。

# 十六、安全

- **XSS**：谱面管理弹窗已改为 `createElement` + `textContent` 构建，用户文件名不再拼入 `innerHTML`。
- **动态求值**：Soundfont 通过 `new Function` 执行同源静态脚本，属格式要求；应确保音色来源可信，不要引入第三方未校验文件。
- **本地数据**：用户上传仅存于本机 IndexedDB，不上传。
- **部署凭证**：发布使用 GitHub Token，务必使用最小权限、定期轮换，切勿写入代码或日志。

---

# 附录 A：关键参数速查

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
| Soundfont 预解码批大小 | 8 | `predecodeAll` |
| 默认谱面 | `Rush E 3.mid` | `DEFAULT_SONG` |
| 缓存名 | `midi-player-soundfont-cache-v1` / `midi-player-assets-v1` | 版本化 |
| FAB 纵向范围 | 视口 10%–90% | `clampFabGroup` |
| 力度分级 | 5 级 | `min(4, floor(velocity*5))` |

# 附录 B：文件结构与部署清单

```
midi_player/
├── index.html                 # 播放器单页应用
├── README.md                  # 本文档
├── midi/
│   ├── list.json              # 内置谱面列表（name / file）
│   └── *.mid                  # 内置 MIDI 谱面
└── soundfonts/
    └── <timbre>-ogg.js        # Soundfont 音色数据（56 个，约 132 MB）
```

**部署流程**

1. 修改 `midi_player/index.html` 等文件。
2. 推送到 `master`（或经 GitHub Contents API 提交）。
3. `.github/workflows/deploy.yml` 自动构建并发布到 GitHub Pages。
4. 在 Actions 中确认最新 run 为 `success`；访问 `https://down2.top/midi_player/` 验证。

# 附录 C：版本与变更记录（CHANGELOG）

> 按主题归档，commit 为短 SHA。完整历史见仓库提交记录。

## 2026-09 首版与性能攻坚

| 主题 | 摘要 | 代表 commit |
| --- | --- | --- |
| 初版 | down2.top 更新；谱面说明与文件名规整 | `f0d9e2f9`、`4ffcba02` |
| 资源与缓存 | Cache API 缓存静态资源；全面优化缓存策略；音色迁移到本仓库；默认只预加载常用音色 | `7d17feb9`、`e6599729`、`e7536751`、`e62adf4c` |
| 音频稳定性 | 移除 30ms 时长下限；移除同音去重；复音上限 + 抢占；暂停停止已排程 voice；节流 IndexedDB 写入并折叠告警 | `f28d99f9`、`5f0aab9d`、`334272c4`、`a130edcd`、`2e19506f` |
| 性能降级 | 渲染 LOD + 密度自适应；抗闪烁 stride；PerfArbiter 2s 仲裁 | `5a744580`、`eb2065d7`、`7c5b8fcc` |
| 调试 | 页面内调试终端；日志分级；复制/置顶按钮；AudioDebug 日志定位无声 | `0de4e8b0`、`771269c1`、`6acf2357`、`e7865b85` |
| UI/配色 | 配色栏与全彩取色板；直角梯形色带；FAB 组与边界钳制；移动端全屏键盘可见 | `14de350d`、`4a30ea72`、`5fe0a7a8`、`d941dac8`、`d681b35c` |
| 谱面 | `Rush E3.mid` → `Rush E 3.mid` 重命名与默认音色映射 | `eab13838`、`052ccd20`、`238c2366`、`8decacb3` |
| 代码审查 | 修复 `drawScene` 签名、XSS、Path2D 分配、DOM/resize 节流；清理死代码 | `4bd17281` |

## 2026-09 交互与加载体验

| 主题 | 摘要 | 代表 commit |
| --- | --- | --- |
| 加载体验 | 默认谱面与音色改为**并行**下载；谱面就绪即用合成钢琴抢跑，音色下载并预解码完成后**无缝切回**（只切 `current`，不打断发声 voice） | `8044a72` |
| UI | 音色 / 谱面下拉改为**自定义深色弹层**（分组、搜索、键盘操作、portal 定位），修复桌面端原生 `option` 白底白字不可读 | `5132b4a` |
| 文档 | 性能复盘与优化笔记；部署/流量/缓存章节；主题拆分 | `476b6812`、`a9429e31` |

## 2026-09 PC 布局与全屏

| 主题 | 摘要 | 代表 commit |
| --- | --- | --- |
| PC 布局 | 整页锁定视口高度，绘制区自适应剩余高度，钢琴键始终贴底、无需滚动；配色栏压缩为单行 | `ab28210`、`8b80671` |
| 菜单 | PC 端显示菜单按钮，点击折叠 / 展开左侧控制面板；FAB 在 PC 端取消左右吸附 | `ab28210`、`777debb` |
| 全屏 | 配色栏右侧新增全屏按钮，仅放大绘制区 | `e52c80f` |

## 2026-09 菜单面板与调试整合

| 主题 | 摘要 | 代表 commit |
| --- | --- | --- |
| 调试整合 | debug 面板并入菜单面板「音色」下方，固定尺寸可滚动，新增「下载日志」；面板统一为半透明 + 模糊风格，可调透明度 / 模糊度 | `5e089bf` |
| 调试开关 | 菜单面板新增调试总开关（默认开启），关闭后无任何调试采集 / 监控 / 自动展开 | `5e089bf` |
| 移动端 | 菜单面板改为全宽、上方 2/3 高，渐隐渐显（去掉左右抽屉动画）；配色按钮恢复 2×2 | `1aaceae` |
| PC 顶栏 | 菜单按钮固定到上传 MIDI 左侧；进度条单列置底，其余控制移至其上方；全屏按钮改为方形双箭头图标 | `82c1887` |

## 2026-09 演奏模式与面板统一

| 主题 | 摘要 | 代表 commit |
| --- | --- | --- |
| 面板统一 | PC 与移动端菜单面板统一为浮层：渐隐渐显、半透明 + 模糊、高 2/3；PC 宽 50vw，不再挤压绘制区 | `f8ecfd7` |
| 透明默认 | 「透明」滑块语义反转为 100 = 全透明，默认 100%、模糊 25% | `bed56c7` |
| 演奏模式 | 新增欣赏 / 演奏模式滑动开关（默认欣赏）；演奏模式下音符只下落、需点击琴键发声 | `cc9591e` |
| 键盘交互 | 点击 / 触摸琴键发声，两种模式均可用（欣赏模式可叠加敲击声） | `51f103f` |
| 钢琴高度 | 新增 5%–50% 钢琴高度滑块 | `cc9591e` |
| 滑动开关 | 面板内勾选框全部替换为滑动开关 | `bed56c7` |
| 自动播放 | 修复 PC 端加载完成前已交互导致不再自动起播的问题（记录 `userGestureSeen`） | `b2dd1cf` |

## 2026-09 控制栏与谱面管理

| 主题 | 摘要 | 代表 commit |
| --- | --- | --- |
| 控制栏 | 播放 / 重播 / 循环 / 管理改为圆形图标按钮并移入配色行；顺序播放图标改为双右箭头 | `3639a8e` |
| 菜单居中 | 菜单面板由左上角改为居中显示 | `9a4985b` |
| 谱面管理 | 管理弹窗改为半透明 + 模糊、共享透明/模糊滑块、点击外部收起；支持内置谱删除与重新下载 | `4101b10` |
| 控制栏布局 | 管理按钮移到上传 MIDI 右侧并引用主题色；顺序播放改两个平行右箭头；全屏按钮无背景、带框箭头矢量图标；展开按钮移到最右侧；桌面端配色栏内联并隐藏展开按钮 | `bf7e455` |
| 设置按钮 | 菜单按钮改为 `arcticons:set-edit` 圆形设置按钮，移入控制行（循环右侧）；移除浮动 FAB 与顶栏菜单按钮；管理/全屏统一主题强调色 | `dcd17b7` |
| 图标与循环 | 全屏改用 `solar:maximize/minimize-linear`、设置改用 `solar:settings-minimalistic-bold`、配色编辑改用 `ic:round-color-lens`；循环按钮改为列表循环（`bi:repeat`）/ 单曲循环（`bi:repeat-1`）两态，列表循环播到底回到第一首 | `f6d0e80` |
| 按钮统一 | 上传改为纯图标圆形按钮（`arcticons:folder-upload`），管理改用 `fluent:text-bullet-list-edit-20-filled`；设置/全屏改为圆形紫底按钮，全屏移到最右；展开按钮改用 `ic:round-color-lens`（收起旋转 180°），自定义配色改用 `gg:color-bucket` | `759207a` |
| 双击播放 | 双击（双触）非钢琴键的渲染区等价于播放/暂停 | `8d38638` |
| 手势与全屏 | 上边缘拖动调钢琴高度（5%–50%）、两指捏合缩放钢琴宽度（1x–5x，渲染区同步、不可见音符跳过渲染、播放不受影响）；全屏新增设置/退出/双锁定悬浮按钮（总锁，锁定时手势视为敲键），2s 淡出、点击即暂停，菜单面板移入全屏元素 | `9f30fd7` |
| 浮动控件重构 | 锁定按钮普通+全屏常驻（左右、顶部2/5、默认锁定、黑底50%、Toast）；所有悬浮按钮 2s 未点击淡到 10%、锁按钮吸附边缘露一半，仅点按钮才重置；调试面板独立（`carbon:debug` 按钮，配色左侧）；菜单/调试/配色/选谱/管理面板共享透明度；配色面板独立浮层、按钮 32px、播放中 2s 自动收起；软键盘/配色展开不改变渲染区高度 | `244c1dc` |
| 面板与版型交互 | 谱面管理二次点击收起；删除设置/音色大标题、音色行加「音色选择」标签；键数版型改 6 档滑块并为六种标准音域配置默认缩放/偏移（首键对齐最左）；音色列表加垃圾桶/下载按钮+百分比、未下载不可切换、删除「已就绪」提示；调试面板自动展开开关移最左、最右加重置所有设置按钮、底边对齐设置面板；重播改 `hugeicons:replay` | `cbe84ee` |
| 全屏按钮与重播图标 | 全屏设置/退出按钮活跃 `opacity:.5`、空闲 `opacity:.2` 且吸附左右边界只露半圆、均无模糊；重播图标放大到 30px 让外圈贴近按钮边界 | `_pending_` |
| 调试工具行与音色策略 | 「重置所有选项」按钮移到右上角（启用调试右侧，带文字警示）；暂停/恢复时 `resetClocks()` 重置音频时钟基线，避免误报「长时间停摆」；状态区日志去掉时间戳与 `[AudioDebug]` 前缀、名称加中括号；音色默认只下载古钢琴/三角钢琴/电钢琴2，其余按需下载或谱面配置时自动下载 | `_pending_` |
| 配色面板 | A/B/C 按钮缩到 27px、改用 Google Sans 常规字重；力度图 `flex-wrap:nowrap` + swatch 自适应收缩保证不换行；删除白键/黑键独立列，标签叠加到力度图上 | `bab754b` |
| 暂停高亮与静音监测 | 暂停状态敲键/松键用 `requestStaticRedraw()` 补静态重绘，触屏点键恢复紫色按下反馈；输出静音探测加 `_autoSoundingMode()` 门控，仅欣赏模式监测，音游模式不再误报「连续静音」 | `ded0f3e` |
| 媒体外置 | 音色/内置谱面/可视化 demo.ogg 优先走 jsDelivr CDN、回退本站 Pages（GitHub Release 无 CORS 不可用） | `48edf1f` |
| 状态区与设置 | 管理移到设置左侧并靠右对齐；重播改 `fluent:replay-20-regular`；调试开启自动设透明20%/模糊0%、自动展开默认开、按钮改圆形 SVG、开关左对齐；设置「音游?」开关移到右上角（关闭=音游模式）；音乐倍速改 0.1–3.0 滑块；删除音量滑块（主增益100%）；修复音色下拉（不再关掉所在设置面板导致左上角小输入框/黑条）；新增进度条上方状态区显示下载百分比/完成/调试日志，移除遮挡点击的顶部 Toast | `4180f6a` |
| 谱库与操作 | 内置谱列表内存+Cache 缓存（选谱/管理面板打开不再联网）；管理面板删除/重下改为行内图标加载中（下载显示百分比）、不再整表刷新重弹；去掉行内文字标签；默认仅预取 Rush E 3 与 The Sound of Silence；循环按钮增加「不循环」（`mdi:repeat-off`，播完暂停）三态；配色按钮去白圈保持实心紫；设置/配色/debug 靠右对齐 | `74db97e` |
| 配色面板修正 | `.palette-row` 不再强制 `display:flex`（此前覆盖了 `.drop-panel` 的隐藏，导致 A/B/C 与力度色带常显）；配色面板改为默认收起、点击后在控制行下方展开；debug/配色/设置/管理/选谱互斥；配色按钮恒为实心主题紫、选中加白框 | `58b1a97` |
| 面板定位修正 | 配色/调试/设置/管理四个面板统一移入控制行、绝对定位在控制行下方展开，修复配色面板遮挡按钮的问题；全屏设置面板加 `.in-fs` 固定到左上角 | `24a4e50` |
| 顶栏两行 | 第一行 重播/选谱/全屏，第二行 播放/下一首/循环/管理/上传/设置/配色/调试；新增下一首（到底回第一首）；设置与管理改为统一下拉面板（从触发按钮向下展开、最大 2/3 视口、点外部关闭）；透明度/模糊滑块仅保留在设置面板顶部 | `a636720` |
| 手势改滑块 | 移除上边缘拖动/两指捏合/锁定交互；菜单新增宽度缩放（1–4×）与水平偏移滑块及 88/76/61/49/37/25 键预设；抬起琴键即 `stopNote` 清除高亮；点音色/谱面列表不再自动聚焦搜索框 | `95c5873` |
