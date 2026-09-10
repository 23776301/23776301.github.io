# MIDI 播放器 · 88 键可视化

浏览器端 MIDI 播放器：解析 `.mid` 谱面，在 Canvas 上以「88 键钢琴 + 下落音符」形式可视化，支持多音色（Soundfont）、变速播放、顺序/循环播放、自定义配色，并内置一套性能诊断与自动降级机制。

入口页面：`midi_player/index.html`

本文档按**主题分章**：性能、部署与流量、音频引擎、可视化、播放控制、数据与存储、调试可观测性、兼容性、安全。各章相互独立，可按需查阅。

---

## 目录

1. [一、性能优化](#一性能优化)
2. [二、部署、流量与缓存策略（GitHub Pages）](#二部署流量与缓存策略github-pages)
3. [三、音频引擎与合成](#三音频引擎与合成)
4. [四、Canvas 可视化与渲染](#四canvas-可视化与渲染)
5. [五、播放控制与状态机](#五播放控制与状态机)
6. [六、数据、存储与谱面管理](#六数据存储与谱面管理)
7. [七、调试与可观测性](#七调试与可观测性)
8. [八、兼容性与已知限制](#八兼容性与已知限制)
9. [九、安全](#九安全)
10. [附录 A：关键参数速查](#附录-a关键参数速查)
11. [附录 B：文件结构与部署清单](#附录-b文件结构与部署清单)

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

### 1.3.3 追赶洪峰抑制

- `playLoop` 中单帧触发上限 `MAX_TRIGGER_PER_FRAME = 256`。
- 超过上限的音符直接快进跳过并计数（`skippedNotes`），避免音频时钟恢复瞬间灌爆音频线程。
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

# 四、Canvas 可视化与渲染

- **88 键布局**：`getKeyLayout` 先排白键再插黑键，`keyByMidi` 建立 midi→键位 O(1) 映射。
- **静态层**：背景、轨道线、琴键、音名预渲染到离屏 `staticCanvas`，每帧只 `drawImage` 一次。
- **下落音符**：按 `time / duration` 映射为屏幕坐标，颜色由「黑白键 × 力度 5 级」决定；使用 `roundRect` 圆角。
- **LOD**：高负载时按绝对索引抽样（见性能章）。
- **按键高亮**：直接读 `activeSources`/`activeSynth` 注册表，与绘制抽样解耦。
- **高分屏**：所有尺寸乘以 `devicePixelRatio`，`resize` 时重建布局与静态层。
- **配色**：内置 A/B/C 三套（色相区分黑白键、明度区分力度），另支持全彩 HSL 取色板自定义四端颜色并插值出 5 级渐变。

# 五、播放控制与状态机

- **状态**：`isPlaying`、`currentTime`、`nextNoteIndex`、`playStartTime`、`playSpeed`、`loopEnabled`。
- **时钟**：以 `audioCtx.currentTime` 为准推进 `currentTime`，避免 `performance.now` 与音频时钟漂移。
- **控制**：播放/暂停/停止/重播、进度条拖拽 seek、0.2x–2x 变速、顺序播放/单曲循环。
- **自动播放**：默认谱面与音色就绪后尝试自动播放；若 AudioContext 处于 suspended，则挂到首次点击/触摸后恢复。
- **失焦暂停**：`visibilitychange` 时按用户设置（移动端默认开、PC 默认关）暂停并显示遮罩，可手动继续。
- **顺序播放**：非循环时自动切下一首，`await` 音色加载后再开始，避免开头丢音。

# 六、数据、存储与谱面管理

- **解析**：使用 `@tonejs/midi` 解析，汇总所有轨道的音符为 `{midi, time, duration, velocity}` 并按时间排序，计算总时长与密度。
- **内置谱**：`midi/list.json` 描述 `name`/`file`，通过 `fetchFresh` 获取最新列表。
- **默认音色映射**：`songDefaultTimbre` 将谱面文件名映射到默认音色。
- **用户上传**：文件读取后立即解析播放，同时写入 IndexedDB `user-songs`，支持在「谱面管理」弹窗中删除；全部本地，不涉及服务器。
- **偏好持久化**：配色（`paletteV2`/`paletteCustom`）、面板位置（`menuBtnPos`）、失焦暂停（`blurPauseEnabled`）、降级弹窗（`dbgAutoOpen`）。

# 七、调试与可观测性

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

# 八、兼容性与已知限制

- `AudioContext.renderCapacity` 需要较新的 Chrome（约 116+），不支持时静默降级为其他指标。
- `CanvasRenderingContext2D.roundRect` 需要 Chrome 99+/Safari 16+；更旧浏览器圆角会缺失。
- Cache API / IndexedDB 在隐私模式或存储受限时可能不可用，代码走网络/内存回退。
- `devicePixelRatio` 变化（拖到不同缩放屏幕）只在 `resize` 时重算。
- 极长持续音（duration 大于下落窗口）在当前可见区间二分下可能被提前裁剪。
- 音色全部为压缩采样，首次解码仍有一定延迟；预加载策略会占用额外流量。

# 九、安全

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
