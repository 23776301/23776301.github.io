# MIDI 播放器 · 88 键可视化

浏览器端 MIDI 播放器：解析 `.mid` 谱面，在 Canvas 上以「88 键钢琴 + 下落音符」形式可视化，支持多音色（Soundfont）、变速播放、顺序/循环播放、自定义配色，并内置一套性能诊断与自动降级机制。

入口页面：`midi_player/index.html`

本文档按**主题分章**：性能、部署与流量、音频引擎、可视化、配色、播放控制、UI/交互、数据与存储、调试可观测性、测试验证、性能基准、兼容性、路线图、安全、变更记录。各章相互独立，可按需查阅。

---

## 目录

1. [一、性能优化](#一性能优化)
2. [二、部署、流量与缓存策略（GitHub Pages）](#二部署流量与缓存策略github-pages)
3. [三、音频引擎与合成](#三音频引擎与合成)
4. [四、Canvas 可视化与渲染](#四canvas-可视化与渲染)
5. [五、配色系统](#五配色系统)
6. [六、播放控制与状态机](#六播放控制与状态机)
7. [七、UI/交互与响应式](#七ui交互与响应式)
8. [八、数据、存储与谱面管理](#八数据存储与谱面管理)
9. [九、调试与可观测性](#九调试与可观测性)
10. [十、测试与验证方法](#十测试与验证方法)
11. [十一、性能基准与压测数据](#十一性能基准与压测数据)
12. [十二、兼容性与已知限制](#十二兼容性与已知限制)
13. [十三、已知问题与路线图](#十三已知问题与路线图)
14. [十四、安全](#十四安全)
15. [附录 A：关键参数速查](#附录-a关键参数速查)
16. [附录 B：文件结构与部署清单](#附录-b文件结构与部署清单)
17. [附录 C：版本与变更记录（CHANGELOG）](#附录-c版本与变更记录changelog)

---

# 一、性能优化

## 1.1 背景与目标

- 谱面包含大量「黑 MIDI」（极密集的音符事件），普通实现下会出现：
  - 界面卡顿 / 掉帧；
  - 声音断续、延迟、甚至完全静音；
  - 内存与音频节点持续增长。
- 目标：在低端移动设备上也能稳定播放高密度谱面，同时保持逐音符触发的基本忠实度，并在性能不足时平滑降级而不是崩溃。

## 1.2 性能问题复盘

### 1.2.1 音频线程过载（声音卡顿/静音）

**现象**

- 界面仍在正常刷新，但声音卡顿、爆音，最终静音。
- 诊断日志显示 `audioCtx.currentTime` 的推进速度只有真实时间的约 20%，即音频时钟被拖慢甚至停摆。
- 触发点是合成钢琴（`__synth__`）回退分支：该分支早期没有复音上限，高密度谱面瞬间创建约 1000 个振荡器 voice，直接把音频渲染线程打满。

**根因**

- 音频线程每帧需要处理的活动 voice 数无上界；
- 同一音高在极短时间内被反复触发，voice 数量成倍叠加；
- 主线程一旦被长任务阻塞，恢复后会在单帧内「追赶」触发海量音符，形成二次洪峰。

### 1.2.2 节点 churn 与内存/GC 压力

**现象**

- `createBufferSource` / `createOscillator` 创建速率远高于 `onended` 触发速率；
- 存活节点数（`srcCreated - onendedFired`）持续增长，疑似泄漏。

**根因**

- 每个音符都新建节点，短音符与重复音制造大量短命节点；
- 旧的同音节点在淡出完成前仍占用连接，`disconnect` 依赖延时回调，统计上表现为「存活」；
- 高频创建/销毁给主线程与 GC 带来压力。

### 1.2.3 主线程丢帧与渲染过载

**现象**

- 高密度谱面可见音符数量可达数万，单帧 `drawScene` 耗时飙升；
- 帧间隔出现 >100ms 的跳变，随后一帧堆积触发大量音符。

**根因**

- 每帧对全部可见音符逐个绘制，没有绘制预算；
- 每帧新建大量绘图对象（`Path2D`、数组）；
- 每帧写 DOM（进度条宽度、统计文本）触发样式/布局计算；
- `resize` 事件（尤其移动端地址栏收放）无节流，连续触发完整重排重绘。

### 1.2.4 界面在跑但没声音（静音误判）

**现象**

- 界面正常、音符在触发，但实际输出为 0，用户以为「播放器坏了」。

**根因**

- 缺少对最终输出信号的采样，无法区分「在调度」与「真的出声」；
- 音色 buffer 未预解码完成时，音符被静默丢弃（`bufferMiss`），表现为开头一段没声音。

## 1.3 解决方案与机制

### 1.3.1 全局复音上限与抢占

- `SoundfontLoader.MAX_VOICES`：全局活动 voice 上限（默认 128，降级时 64）。
- `_registerVoice` 在超过上限时调用 `_stealOldest`，对最早开始的 voice 做 5ms 淡出并 `stop`。
- sample 与 synth 两个分支共用同一套 `activeVoices` 注册表，统一抢占。
- 同音新音符触发时打断上一个同音 voice（10ms 淡出），避免同音叠加。

### 1.3.2 自适应同音重触发下限

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

### 1.3.3 前瞻调度与后台播放

- 音符触发从 `requestAnimationFrame` 的 `playLoop` 中解耦，改由 `scheduleAhead()` 前瞻调度器负责：每 50ms 把未来 `SCHED_LOOKAHEAD = 1.5s` 内的音符按 `audioCtx.currentTime` 排程（`playNote(..., when)`）。
- 这样即使后台标签页的 rAF 被挂起，音频仍按**音频时钟**持续播放；`playLoop` 只负责渲染与进度更新。
- 单次调度上限 `MAX_SCHEDULE_PER_TICK = 20000`；落后超过 0.2s 的过旧音符丢弃并计入 `skippedNotes`。
- 复音上限改为只统计「已开始发声」的 voice（`_activeVoiceCount`），避免前瞻排程的 future voice 被误抢占。
- 结束/循环检测也移入调度器，后台挂起时仍能循环或切歌。
- 移除了早期的「30ms 最小发声时长」与「同音去重」，改为按真实时长调度，仅保留 1ms epsilon 防止无效调度。

### 1.3.4 PerfArbiter 性能仲裁与自动降级

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

### 1.3.5 渲染 LOD 与抗闪烁

- 默认完整绘制；仅当 `PerfArbiter.degraded` 且可见音符数超过预算（`DRAW_BUDGET = 4000`）时抽样。
- 抽样步长量化为 2 的幂（`stride = 1 << ceil(log2(visible / budget))`），并以 1.3x 作为进入阈值，避免在边界反复跳变。
- 抽样基于「绝对音符索引取模」，保证同一音符在滚动中始终被画/不画，杜绝逐帧闪烁。

### 1.3.6 代码审查后的性能修复（2026-09）

- `drawScene` 移除每帧新建的 10 个 `Path2D`，改为复用矩形桶 + `ctx.beginPath/fill`。
- 进度条与统计合并为 100ms 节流，不再每帧写 DOM。
- `resizeCanvas` 增加 rAF 合并，接入 `resize`/`orientationchange`/`fullscreenchange`/`visualViewport`。
- `findIndex`/`filter` 改为二分 `lowerBound`。
- `isBlackKey` 改为 `Uint8Array(12)` 查表。
- 删除 `AudioDebugMonitor` 中大量只写不读的字段与每帧 `debugReport` 调用。

---

# 二、部署、流量与缓存策略（GitHub Pages）

> 本章与「性能」分离：性能关注**运行时的帧率与音频延迟**，本章关注**网络流量、加载速度、存储与托管成本**。

## 2.1 部署形态

- 仓库：`teecatt/teecatt.github.io`，分支 `master`，通过 GitHub Pages 静态托管。
- 工作流：`.github/workflows/deploy.yml`（`Deploy to GitHub Pages`），每次推送到 `master` 触发构建与发布。
- 访问域名：自定义域名 `down2.top`，播放器路径 `/midi_player/`。
- 无服务端运行时：所有逻辑在浏览器执行；谱面与音色均为静态文件。

## 2.2 仓库体积与流量现状

| 目录 | 文件数 | 体积 |
| --- | --- | --- |
| `midi_player/soundfonts/` | 56 个 `*-ogg.js` | **≈ 132.6 MB** |
| `midi_player/midi/` | 9 个（含 `list.json`） | ≈ 2.9 MB |
| `midi_player/index.html` | 1 | ≈ 105 KB |

- 单个音色文件约 2–4.5 MB（如 `lead_7_fifths-ogg.js` 4.5 MB、`violin-ogg.js` 3.6 MB）。
- 默认加载：`Rush E 3.mid`（2.6 MB）+ 默认音色 `clavinet`（2.6 MB）≈ **5.2 MB**；若再后台预加载 `acoustic_grand_piano`（2.6 MB）与 `electric_piano_2`（2.3 MB），首次会话网络开销约 **10 MB**。

## 2.3 客户端缓存策略

本项目**未使用 Service Worker**，而是直接用 **Cache API** 做资源缓存：

| 缓存名 | 内容 | 策略 |
| --- | --- | --- |
| `midi-player-soundfont-cache-v1` | Soundfont `*-ogg.js` | 缓存优先（cache-first），首次下载后写入，后续离线命中 |
| `midi-player-assets-v1` | MIDI 谱面 | 缓存优先，`ignoreSearch` 忽略查询串 |
| IndexedDB `midi-player-db` / `user-songs` | 用户上传的 MIDI | 仅本地存储，**从不回传服务器** |
| `localStorage` | 配色、面板位置、失焦暂停等偏好 | 轻量键值 |

关键实现点：

- **统一绝对路径做缓存键**（`new URL(url, location.href).href`），避免相对路径在不同页面下解析不一致导致缓存失效。
- **`ignoreSearch: true`**：允许用 `?v=xxx` 做版本/刷新控制而不会产生重复缓存条目。
- **`fetchFresh` 仅用于 `midi/list.json`**：`cache: 'no-store'` 始终走网络拿最新列表，再回写缓存；其余资源走缓存，避免每次加载都重新下载。
- **缓存版本化**：缓存名带 `-v1` 后缀；需要整体失效时提升版本号即可。
- **旧缓存清理**：启动时遍历 `caches.keys()`，删除 `midi-player-assets-*` 中非当前版本，避免历史残留占用空间。
- **配额兜底**：Soundfont 写入缓存失败（存储不足）时，删除一半旧条目后重试一次。

## 2.4 已实现的流量节省

- **重复访问零流量**：音色与谱面命中 Cache API，回访用户不再下载（列表除外）。
- **列表极小**：`list.json` 仅约 1 KB，且是唯一每次走网络的资源。
- **按需加载音色**：只下载当前选中的音色，不同时拉取全部 56 个；后台仅预加载 2 个常用音色。
- **用户上传不上云**：上传的 MIDI 存本地 IndexedDB，服务端零带宽。
- **诊断不上网**：所有性能指标在本地采集，不发送遥测。

## 2.5 可进一步优化的方向

1. **精简仓库音色集**：只保留实际用到的音色，或提供「钢琴精简包」；132 MB 中大部分是长尾音色。
2. **按需预加载 + 省流量模式**：读取 `navigator.connection.saveData` / `effectiveType`，在移动网络或省流量模式下跳过后台预加载。
3. **音色外置**：把 Soundfont 放到 jsDelivr / 对象存储 / 独立 CDN，减轻 GitHub Pages 带宽压力，并利用其更强的边缘缓存。
4. **缓存已解码的 AudioBuffer**：把 `decodeAudioData` 结果存入 IndexedDB，跳过每次会话的 base64 解码与解码等待（当前解码在 `predecodeAll` 中完成）。
5. **文件名哈希 + 长缓存**：对静态资源使用内容哈希命名并配合 `immutable` 语义，配合 `ignoreSearch` 精确失效。
6. **资源提示**：对 CDN/音色目录加 `preconnect`/`prefetch`，缩短首字节时间。
7. **Service Worker（可选）**：若需要更精细的离线策略、后台更新与版本迁移，可引入 SW 统一管理缓存。
8. **压缩与格式**：确认 Pages 已启用 gzip/brotli；音色可评估更小的采样率/编码。

## 2.6 GitHub Pages 限制与注意事项

- **带宽软上限**：GitHub Pages 建议约 **100 GB/月**；仓库体积建议 **< 1 GB**（当前音色约 132 MB，尚可但应关注）。
- **不可自定义响应头**：Pages 无法设置 `Cache-Control`/`_headers`（除非前置 Cloudflare 等代理）；因此缓存控制主要由浏览器默认行为 + Cache API 承担。
- **构建并发**：同一分支连续推送时，旧的工作流运行会被取消（`cancelled`），最终以最后一次运行为准，属正常现象。
- **自定义域名**：`down2.top` 通过仓库 `CNAME` 配置；换域时需同步缓存键的绝对路径基准。
- **`.nojekyll`**：若引入以下划线开头的资源目录，需要 `.nojekyll` 防止 Jekyll 处理。

---

# 三、音频引擎与合成

- **音频图**：`AudioContext → masterGain → outputAnalyser → destination`，`masterGain` 负责总音量，`outputAnalyser`（FFT 2048）用于静音探测。
- **音色加载**：Soundfont 以 `*-ogg.js` 形式提供，内部是 base64 音频；`_doLoad` 下载/读缓存后用 `new Function` 求值取数据，再经 `atob → Uint8Array → decodeAudioData` 得到 `AudioBuffer`。
- **预解码**：`predecodeAll` 按每批 8 个解码 88 个音，避免一次性解码阻塞主线程与音频时间线。
- **合成回退**：`__synth__` 分支用 3 个振荡器（triangle + 2×sine）叠加，指数包络收尾；仅在音色加载失败或 buffer 缺失时使用。
- **增益**：`timbreGain` 对个别音色（三角钢琴、古钢琴）单独设增益，其余默认 3.0。
- **包络**：短音符按比例缩短 attack/release，避免事件时间倒挂。
- **采样缓存**：每个音色按 midi 缓存已解码 `AudioBuffer`（`entry.buffers[midi]`），超出 88 键范围的音会映射到最近有效键。
- **排程**：`playNote(midi, velocity, duration, when)` 支持指定音频时钟起始时间，供前瞻调度器提前排程；`src.start(when)`、包络与 `stop` 均以 `when` 为基准。

# 四、Canvas 可视化与渲染

- **88 键布局**：`getKeyLayout` 先排白键再插黑键，`keyByMidi` 建立 midi→键位 O(1) 映射。
- **静态层**：背景、轨道线、琴键、音名预渲染到离屏 `staticCanvas`，每帧只 `drawImage` 一次。
- **下落音符**：按 `time / duration` 映射为屏幕坐标，颜色由「黑白键 × 力度 5 级」决定；使用 `roundRect` 圆角，并在琴键上方裁剪。
- **LOD**：高负载时按绝对索引抽样（见性能章）。
- **按键高亮**：直接读 `activeSources`/`activeSynth` 注册表，与绘制抽样解耦。
- **高分屏**：所有尺寸乘以 `devicePixelRatio`，`resize` 时重建布局与静态层。

# 五、配色系统

配色采用**双维度**：**色相**区分黑白键，**明度**区分力度（5 级，轻 → 重）。

## 5.1 内置方案

| 方案 | 白键（轻→重） | 黑键（轻→重） |
| --- | --- | --- |
| A 纯紫 | 全部 `#8b5cf6`（无力度变化） | 全部 `#8b5cf6` |
| B 青蓝 × 琥珀红 | `#22d3ee → #8b5cf6` | `#fde68a → #ef4444` |
| C 青绿 × 品红 | `#5eead4 → #3b82f6` | `#f9a8d4 → #be185d` |

- 力度分级：`ci = Math.min(4, Math.floor(velocity * 5))`，共 5 档。
- 默认方案为 B，选择保存在 `localStorage.paletteV2`。

## 5.2 自定义方案（四端插值）

- 自定义色由四个端点构成：`paletteEditColors = { wl, wh, bl, bh }`（白键最轻/最重、黑键最轻/最重）。
- `buildCustomPalette(wl, wh, bl, bh)` 对每个端点做线性插值（`ramp` + `lerp`），生成 5 级色阶。
- `PALETTE_TARGET_LABELS` 提供四个目标按钮：白键最轻 / 白键最重 / 黑键最轻 / 黑键最重。
- 自定义结果保存为 `localStorage.paletteCustom`（四端颜色 JSON），启动时 `loadCustomPalette()` 恢复并注册 `PALETTES.custom`。

## 5.3 全彩取色板

- `drawColorBoard()` 用 `createImageData` 逐像素绘制 HSL 色板：**x 轴 = 色相 0–360°，y 轴 = 明度 1 → 0**，饱和度为 1。
- `_pickColorAt(e)` 通过 Pointer Events + `setPointerCapture` 把点击位置映射回色相/明度，写入当前选中的端点。
- `hslToRgb` / `hslToHex` 负责色彩空间转换。

## 5.4 色带 Swatch

- `updatePaletteSwatch()` 用内联 SVG 绘制**两个横向直角梯形**：右端竖直边为长底，左端竖直边为短底（短底 = 长底一半），左轻右重。
- 上梯形为白键色阶、下梯形为黑键色阶，各用 `linearGradient` 按 5 级色标填充；中间叠加「力度」文字。
- 该形状直观表达「同一色相下、随力度递进」的映射。

## 5.5 持久化与高亮

- 当前方案、自定义色、面板位置等均存 `localStorage`，无服务端。
- 按键高亮固定为 `rgba(139,92,246,0.7)`，不随配色方案改变。

# 六、播放控制与状态机

- **状态**：`isPlaying`、`currentTime`、`nextNoteIndex`、`playStartTime`、`playSpeed`、`loopEnabled`。
- **时钟**：以 `audioCtx.currentTime` 为准推进 `currentTime`，避免 `performance.now` 与音频时钟漂移。
- **控制**：播放/暂停/停止/重播、进度条拖拽 seek、0.2x–2x 变速、顺序播放/单曲循环。
- **定位**：seek 与开始播放都用二分 `lowerBound(allNotes, time)` 找起始音符，避免线性扫描。
- **自动播放**：默认谱面与音色就绪后尝试自动播放；若 AudioContext 处于 suspended，则挂到首次点击/触摸后恢复。
- **后台持续播放**：音符由前瞻调度器按音频时钟排程，切到后台/锁屏后音频继续播放；回到前台画面自动跳到当前进度。
- **失焦暂停（可选，默认关闭）**：开启后 `visibilitychange` 隐藏时暂停并显示遮罩，需手动点「继续播放」。开启会禁用后台播放。
- **顺序播放**：非循环时自动切下一首，`await` 音色加载后再开始，避免开头丢音。
- **进度节流**：进度条与统计文本合并为 100ms 更新一次，避免每帧写 DOM。

# 七、UI/交互与响应式

## 7.1 可拖拽 FAB 按钮组

- 组内包含**菜单按钮**（仅移动端显示）与 **DEBUG 按钮**，纵向排列、尺寸一致（44px 圆形）。
- 整组可拖动：拖动阈值 3px 用于区分「点击」与「拖动」；拖动时禁用过渡保持跟手，松手后自动吸附到屏幕左/右侧。
- 位置持久化到 `localStorage.menuBtnPos`；`clampFabGroup` 把纵向限制在视口 **10%–90%**，并在 `resize`/`orientationchange`/`visualViewport` 变化时校正。
- 空闲 2s 淡出（透明度 0.5），任意交互时恢复；PC 端由 CSS 固定在右下角。

## 7.2 移动端抽屉与遮罩

- `.control-panel` 在 `max-width:800px` 下变为从左侧滑入的抽屉（`transform: translateX(-105%) → 0`）。
- `.overlay-mask` 半透明遮罩，点击调用 `toggleMenu()` 关闭；打开菜单时隐藏 FAB 组。

## 7.3 弹窗与 Toast

- **自定义配色弹窗** `paletteModal`：目标选择 + 全彩取色板 + 预览 + 保存/取消。
- **谱面管理弹窗** `manageModal`：列出用户上传与内置谱面；全部用 `createElement` + `textContent` 构建，避免文件名 XSS。
- **Toast**：`window.showToast(msg)` 顶部居中提示，4s 自动消失；用于谱面加载/解析失败与音色回退提示。

## 7.4 响应式与视口

- `@media(max-width:800px)`：单列布局、隐藏标题、`height:100dvh`、Canvas 全屏、控制面板抽屉化。
- PC 端：FAB 固定右下角，控制面板常驻左侧。
- 高分屏：所有绘制尺寸乘以 `devicePixelRatio`。
- 视口变化：`resize`（rAF 合并）、`orientationchange`、`fullscreenchange`、`visualViewport` 均触发重算布局，确保钢琴键盘始终可见。
- **安全区**：目前仅使用 `100dvh` 处理移动端视口，尚未适配 `env(safe-area-inset-*)`（见路线图）。

# 八、数据、存储与谱面管理

- **解析**：使用 `@tonejs/midi` 解析，汇总所有轨道的音符为 `{midi, time, duration, velocity}` 并按时间排序，计算总时长与密度。
- **内置谱**：`midi/list.json` 描述 `name`/`file`，通过 `fetchFresh` 获取最新列表。
- **默认音色映射**：`songDefaultTimbre` 将谱面文件名映射到默认音色（如 `Rush E 3.mid → clavinet`）。
- **用户上传**：文件读取后立即解析播放，同时写入 IndexedDB `user-songs`，支持在「谱面管理」弹窗中删除；全部本地，不涉及服务器。
- **偏好持久化**：配色（`paletteV2`/`paletteCustom`）、面板位置（`menuBtnPos`）、失焦暂停（`blurPauseEnabled`）、降级弹窗（`dbgAutoOpen`）。

# 九、调试与可观测性

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

- 诊断定时器仅在播放时运行；`debugReport` 每 5s 检查节点泄漏。
- 调试终端：`DEBUG` 圆形按钮（与菜单按钮同组、可拖动），支持复制、置顶/置底、透明度/模糊、清空、降级自动弹窗。
- 日志分级配色：`[INFO]` 蓝（下载/加载）、`[OK]` 绿（恢复）、黄 warn、红 error；同类告警 1.5s 折叠，DOM 行数上限 300。
- 降级/恢复文案：`最近 2s出现N次性能问题，分别是丢帧、积压、停摆、时间戳，触发渲染降级` / `性能问题已缓解，恢复完整渲染。`

# 十、测试与验证方法

## 10.1 静态校验

- **JS 语法**：抽取 `<script>` 内联块，逐个 `node --check`。
- **CSS 配平**：统计 `<style>` 内 `{` 与 `}` 数量是否相等（曾借此发现一个多余的 `}`）。
- **HTML 结构**：检查关键交互元素（卡片、按钮）是否存在标签嵌套冲突。

## 10.2 功能回归清单

- 默认谱面自动加载并播放；上传本地 MIDI 后自动播放并进入「我的上传」。
- 切换谱面、切换音色、变速、循环/顺序播放、进度条拖拽 seek。
- 失焦暂停遮罩与恢复；移动端抽屉、FAB 拖动与吸附、弹窗、Toast。
- 配色 A/B/C 切换、自定义四端颜色并保存、刷新后恢复。

## 10.3 高密度复现用例

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

## 10.4 指标阈值判定

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

## 10.5 验证流程

1. 打开 DEBUG 面板。
2. 加载高密度谱面（如 `concurrent_88_10ms.mid` 或 `Rush E 3.mid`）并播放 30s 以上。
3. 观察是否出现「触发渲染降级」、随后是否「性能问题已缓解」。
4. 检查有无「输出静音」「音频时钟停摆」「节点泄漏」「主线程长任务」告警。
5. 记录第十一章基准数据。

# 十一、性能基准与压测数据

> 播放器**不发送遥测**，所有数据来自页面 DEBUG 面板。下表为**采集模板**，需在目标设备上实测填入；`待测` 表示尚未采集。

## 11.1 采集方法

1. 选定设备与浏览器；分别测试「首次（空缓存）」与「缓存命中」。
2. 加载指定谱面，播放 ≥ 30s，取稳定期数据。
3. 记录：平均 fps、`drawMs`、峰值 voice（`srcCreated - onendedFired` + `synthVoices`）、`renderCapacity` avg/peak、跳过音符数、是否触发降级。

## 11.2 对照表（模板）

| 设备 | 谱面 | 缓存 | 平均 fps | drawMs | 峰值 voice | rcAvg | rcPeak | 跳过音符 | 是否降级 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 待测 | `concurrent_88_10ms.mid` | 首次 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 待测 | `concurrent_88_50ms.mid` | 首次 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 待测 | `concurrent_88_100ms.mid` | 首次 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 待测 | `concurrent_88_250ms.mid` | 首次 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 待测 | `Rush E 3.mid` | 首次 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 待测 | `Rush E 3.mid` | 命中 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |

## 11.3 预期趋势（定性）

- 密度越高，voice 峰值与跳过音符越多，`drawMs` 越大。
- 超过 `PerfArbiter` 阈值后触发降级，帧率与音频负载应回升。
- `renderCapacity.peak` 是判断音频线程过载最敏感的指标；`fps` 只反映主线程。

# 十二、兼容性与已知限制

- `AudioContext.renderCapacity` 需要较新的 Chrome（约 116+），不支持时静默降级为其他指标。
- `CanvasRenderingContext2D.roundRect` 需要 Chrome 99+/Safari 16+；更旧浏览器圆角会缺失。
- Cache API / IndexedDB 在隐私模式或存储受限时可能不可用，代码走网络/内存回退。
- `devicePixelRatio` 变化（拖到不同缩放屏幕）只在 `resize` 时重算。
- 极长持续音（duration 大于下落窗口）在当前可见区间二分下可能被提前裁剪。
- 音色全部为压缩采样，首次解码仍有一定延迟；预加载策略会占用额外流量。
- 后台标签页定时器会被节流（Chrome 约 ≥1s）；前瞻调度器以 1.5s 窗口覆盖，但极端省电/深度冻结策略下仍可能出现间隙。
- 移动端未适配 `env(safe-area-inset-*)`，刘海屏/手势条区域可能遮挡底部控件。

# 十三、已知问题与路线图

## 13.1 已知问题

1. **长音裁剪**：`leftIdx = lowerBound(allNotes, currentTime - fallDuration)` 只按起始时间取左界，持续时间超过下落窗口的持续音可能被提前裁掉。
2. **旧浏览器圆角缺失**：无 `roundRect` 时音符为直角。
3. **音色体积偏大**：仓库约 132 MB，长尾音色多，首次会话流量约 10 MB。
4. **解码未持久化**：每次会话都要重新 `decodeAudioData`，首次切换音色有可感延迟。
5. **安全区未适配**：仅 `100dvh`，未使用 `env(safe-area-inset-*)`。
6. **`renderCapacity` 兼容性**：旧浏览器无该指标，过载判断灵敏度下降。

## 13.2 路线图（Roadmap）

1. **长音渲染修正**：可见区间上界改为按 `time + duration` 取值。
2. **音色精简 / 外置 + 省流量模式**：`navigator.connection.saveData` 跳过后台预加载；音色迁移到独立 CDN。
3. **已解码 AudioBuffer 持久化**：存入 IndexedDB，跳过重复解码。
4. **Service Worker（可选）**：统一离线策略、后台更新与版本迁移。
5. **安全区适配**：引入 `env(safe-area-inset-*)` 与 `viewport-fit=cover`。
6. **自动化回归**：无头浏览器截图 + 性能采样，纳入 CI。
7. **配色预设导入/导出**：分享自定义配色。
8. **无障碍与快捷键**：ARIA 标注、键盘操作。

# 十四、安全

- **XSS**：谱面管理弹窗已改为 `createElement` + `textContent` 构建，用户文件名不再拼入 `innerHTML`。
- **动态求值**：Soundfont 通过 `new Function` 执行同源静态脚本，属格式要求；应确保音色来源可信，不要引入第三方未校验文件。
- **本地数据**：用户上传仅存于本机 IndexedDB，不上传。
- **部署凭证**：发布使用 GitHub Token，务必使用最小权限、定期轮换，切勿写入代码或日志。

---

# 附录 A：关键参数速查

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `SoundfontLoader.MAX_VOICES` | 128（降级 64） | 全局复音上限 |
| `SCHED_LOOKAHEAD` | 1.5s | 前瞻排程窗口 |
| `SCHED_INTERVAL` | 50ms | 调度器轮询间隔 |
| `MAX_SCHEDULE_PER_TICK` | 20000 | 单次调度上限 |
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
| 文档 | 性能复盘与优化笔记；部署/流量/缓存章节；主题拆分 | `476b6812`、`a9429e31` |
