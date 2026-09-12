# 音频可视化工作室 · Music Visualizer

浏览器端实时音频可视化工具。上传一首歌，从 10 种可视化效果里选一个，拖动参数即时看到变化——不需要渲染、不需要等待导出。

零依赖、零构建：入口 `music_visualization/index.html` 只含页面骨架、关键 CSS 与加载器；全部样式与逻辑拆到 `app.css` / `app.js`，由加载器**优先同源加载**（保证与 HTML 同版本、绝不吃 CDN 陈旧缓存），同源失败才回退 jsDelivr，注入后显示。

> 本文档描述的是**当前实现的真实行为**，包含真实的参数、边界与已知问题，并给出后续深挖方向。

---

## 目录

1. [卷首漫笔](#一卷首漫笔)
2. [功能](#二功能)
3. [快速开始](#三快速开始)
4. [配色系统](#四配色系统)
5. [背景系统](#五背景系统)
6. [参数系统](#六参数系统)
7. [架构](#七架构)
8. [音频分析](#八音频分析)
9. [渲染管线](#九渲染管线)
10. [交互](#十交互)
11. [扩展：新增一个可视化效果](#十一扩展新增一个可视化效果)
12. [性能与已知问题](#十二性能与已知问题)
13. [路线图（深挖方向）](#十三路线图深挖方向)
14. [附：缓存](#附缓存)

---

## 一、卷首漫笔

音频可视化是听觉与视觉之间的翻译：把看不见的频率起伏，变成可以被注视的形状与色彩。一个称手的小工具，应当足够轻、足够稳，也留得下自由调整的余地。

技术是手段，感受是目的。参数、波形与配色，最终也只是把一段旋律换一种方式呈现出来。

## 二、功能

### 2.1 可视化效果（10 种）

| id | 名称 | 说明 |
| --- | --- | --- |
| `bars` | 频谱柱 | 频域柱状图，支持圆角、垂直翻转 |
| `bars-mirror` | 镜像柱 | 以中线为轴对称的柱状图 |
| `bars-3d` | 3D 柱 | 带顶面/侧面的伪 3D 柱阵 |
| `waveform-zigzag` | 锯齿波 | 频域值驱动的上下折线 |
| `circle-radial` | 放射圆 | 从内圈向外辐射的柱 |
| `circle-wave` | 圆形波 | 时域波形围成的闭合曲线，支持发光 |
| `circle-pulse` | 脉冲圆 | 分频段均值驱动的同心圆脉冲 |
| `circular-bars` | 圆形柱 | 从圆心向外的柱状环 |
| `spectrum-line` | 频谱线 | 频域折线，支持发光 |
| `spectrum-area` | 频谱面积 | 频域折线下方的渐变填充 |

### 2.2 输入与播放

- 音频文件上传（点击顶部区域选择，或拖入）。
- 播放/暂停、进度条拖拽 seek、音量、循环。
- 自动加载演示音频 `demo.ogg`（多个 jsDelivr 边缘节点**并发完整下载竞速**，最先完成者胜出，其余立即中止并清理不完整分片，全部失败回退本站 Pages；可在终端顶部「完整竞速」开关关闭，改用首字节竞速）。

### 2.3 其它

- **多元素叠加**：可同时添加多个效果，按 `y` 排序绘制，支持选中/删除（位置只能在属性面板用 X/Y 设置，画布上不允许拖动移动）。
- 画布分辨率由性能面板设置（默认 1280×720，范围 100×100 ~ 4320×2160）；绘制区始终按**宽度自动贴合**左右控件边界等比缩放（`fitCanvas()`，高度超出由绘制区滚动）。
- 画布内点击选中元素（**不允许拖动移动**，位置在属性面板 X/Y 设置）；选中时显示虚线框与四角手柄，可拖角自由（非等比）缩放，触摸端支持两指夹捏等比缩放。
- 背景：纯色 / 线性渐变 / 径向渐变 / 图片（模糊 + 暗化）。
- 配色：纯色 / 渐变 / 彩虹，渐变支持多色增删排序。
- **设置持久化**：分辨率、帧率、帧率/分辨率显示开关、元素及其参数、背景、循环/音量/平滑度、左侧面板宽度都写入 `localStorage`（键 `music-viz-config-v1`），刷新后自动恢复；背景图片是 object URL 无法持久化（刷新回退为纯色/渐变）。属性面板默认仍不展开。

### 2.4 快捷键

| 键 | 作用 |
| --- | --- |
| `空格` | 播放 / 暂停 |
| `Delete` | 删除选中元素 |

> 说明：已支持**全屏绘制区**与 canvas 内**实时 FPS / 分辨率**叠加显示；当前**没有**暗/亮主题与导出功能（见[路线图](#十二路线图深挖方向)）。

---

## 三、快速开始

### 3.1 本地预览

因为使用了 Cache API 与 `AudioContext`，建议通过 HTTP 访问：

```bash
python -m http.server 8000
# 打开 http://localhost:8000/music_visualization/
```

### 3.2 部署

本工具作为子目录部署在 `teecatt/teecatt.github.io` 仓库的 `music_visualization/` 下，通过 GitHub Pages 发布：

- 线上地址：`https://down2.top/music_visualization/`
- 推送 `master` 后由 `.github/workflows/deploy.yml` 自动构建发布。

### 3.3 文件结构

```
music_visualization/
├── index.html      # 页面骨架 + 关键 CSS + 加载器（同源优先，CDN 兜底）
├── app.css         # 全部样式
├── app.js          # 全部逻辑
├── demo.ogg        # 自动加载的演示音频
└── README.md       # 本文档
```

---

## 四、配色系统

- **模式**：`solid`（纯色）、`gradient`（多色渐变）、`rainbow`（彩虹）。
- **多色渐变**：`colors` 数组按停靠点均匀插值（`multiColor`），支持添加、上移、下移、删除，并提供实时预览条。
- **逐柱映射**：多数效果用 `elemColor(p, i/barCount)` 让颜色沿柱子渐变。
- **彩虹**：`hsl((t*300 + performance.now()*0.05) % 360, 100%, 60%)`——基于**墙钟时间**，与播放进度无关。

---

## 五、背景系统

| 类型 | 参数 |
| --- | --- |
| `solid` | `bgColor` |
| `gradient-linear` | `gradColor1`/`gradColor2`、5 个停靠点（首尾固定，25/50/75 可调）、`gradAngle` |
| `gradient-radial` | `gradColor1`/`gradColor2`、停靠点、`gradRadius` |
| `image` | 背景图片、`bgBlur`（0–20）、`bgDarken`（0–1） |

背景绘制在缩放变换之前，因此缩放只影响元素、不影响背景。

---

## 六、参数系统

元素默认参数（`defaultElementParams`）与 UI 分组：

| 参数 | 默认 | 含义 | 实际生效范围 |
| --- | --- | --- | --- |
| `x` / `y` | 50 / 50 | 中心位置（%） | 全部 |
| `w` / `h` | 80 / 60 | 尺寸（%） | 全部 |
| `rotation` | 0 | 旋转（°） | 全部 |
| `opacity` | 1 | 不透明度 | 全部 |
| `colorMode` | `gradient` | 纯色/渐变/彩虹 | 全部 |
| `colors` | 3 色数组 | 多色渐变停靠点 | 全部 |
| `useEnvelope` | true | 是否启用包络跟随 | 频域效果 |
| `attack` | 50ms | 包络上升时间 | 频域效果 |
| `release` | 300ms | 包络下降时间 | 频域效果 |
| `smoothing` | 0.8 | Analyser 平滑（**全局**属性） | 全局 |
| `gain` | 1.2 | 灵敏度 | 频域效果 |
| `barCount` | 64 | 柱数/密度 | 除 `circle-pulse` 外 |
| `lineWidth` | 3 | 线宽 | 折线/波形类 |
| `freqMin` / `freqMax` | 20 / 16000 | 频率范围（Hz） | 频域效果 |
| `logScale` | true | 对数频率映射 | 频域效果 |
| `invert` | false | 垂直翻转 | 全部（渲染层变换） |
| `rounded` | true | 圆角柱 | 仅 `bars` |
| `glow` / `glowBlur` | false / 12 | 发光 | `circle-wave`、`spectrum-line` |
| `innerRadius` | 25 | 内圈半径（%） | 仅 `circle-radial` |
| `mirror` | false | 水平镜像 | 全部（渲染层变换） |

属性面板由 `rangeField` / `toggleField` / `dualRangeField` / `collapsible` / `colorEditorHTML` 生成，`bindPropsFields` 统一绑定事件。

> 部分参数只在个别效果中生效（如 `rounded` 仅 `bars`、`innerRadius` 仅 `circle-radial`），属预期设计；`mirror`/`invert` 已改为通用渲染变换。

---

## 七、架构

单文件内按职责划分为若干区块（均在同一个 `<script>` 中）：

```
index.html
├── <style>                     # 暗色主题、响应式、组件样式
├── AssetCache                  # Cache API 缓存（music-viz-assets-v1）
├── CFG                         # 全局配置（canvas / elements / audio）
├── saveConfig / loadConfig     # 持久化到 music-viz-config-v1；resetAllSettings 清除并恢复默认
├── VISUAL_STYLES               # 效果清单（id / name / cat）
├── defaultElementParams()      # 元素默认参数
├── 颜色工具                     # hexToRgb / rgbToHex / lerpColor / multiColor / elemColor
├── envStep()                   # 指数包络跟随器
├── getFreqBars()               # 频域取样 + 范围裁剪 + 对数映射 + 包络
├── DRAW{}                      # 10 个效果的绘制函数
├── drawBackground()            # 背景绘制
├── render()                    # rAF 主循环
├── 音频控制                     # loadAudio / togglePlay / updateSeekUI
├── 元素库渲染                   # renderLibrary / thumbSVG
├── 属性面板                     # renderProps / colorEditorHTML / bindPropsFields
├── 画布交互                     # pointerdown / pointermove / pointerup（鼠标+触摸）
└── 画布缩放                     # applyZoom / fitCanvas
```

**数据流**

```
<audio> → MediaElementSource → AnalyserNode → destination
                                   │
                     getByteFrequencyData / getByteTimeDomainData
                                   │
                        getFreqBars()（裁剪+对数+包络）
                                   │
                     DRAW[type](ctx, p, W, H, el, dt)
                                   │
                              render() 每帧
```

**关键设计**

- `CFG` 是唯一配置源，`window.__CFG` 暴露供调试。
- `DRAW` 是效果注册表：`DRAW[type] = function(ctx, p, W, H, el, dt)`。
- 效果清单 `VISUAL_STYLES` 与 `DRAW` 分离，新增效果需同时登记两处。
- 属性面板由参数声明式生成，不手写每个控件。
- `scheduleSave` 300ms 防抖写盘；`saveConfig` 序列化 `canvas`（剔除 `bgImage`）、`elements`、`fps`、`showFps`/`showRes`、`loop`/`volume`/`smoothing`、`panelW`；`loadConfig` 读回并合并到 `CFG`。性能面板底部「重置所有设置」按钮调用 `resetAllSettings()`：清除存储并恢复出厂默认（1280×720、60fps、单个居中 bars、面板 280px）。

---

## 八、音频分析

- **节点**：`createMediaElementSource(audio)` → `AnalyserNode(fftSize=2048)` → `destination`。
- **数据**：`getByteFrequencyData`（频域，长度 `frequencyBinCount = 1024`）与 `getByteTimeDomainData`（时域，长度 `fftSize = 2048`）。两者**每帧在 `render()` 中只取样一次**，所有元素复用同一份数据。
- **平滑**：`smoothingTimeConstant` 为全局属性，由 `CFG.smoothing` 统一控制（默认 0.8），创建 analyser 时写入。
- **频率范围裁剪**：`freqMin`/`freqMax` 映射到 bin 区间 `[minBin, maxBin]`，只在该区间取样。
- **对数映射**：`logScale` 开启时按 `pow(i/n, 1.5)` 取样，低频分到更多柱子，更贴合听感；关闭则线性。
- **包络跟随**：`getFreqBars` 对每个柱子维护 `el._env[i]`，用 `envStep` 做指数趋近：

  ```
  k = target > cur ? 1 - exp(-dt/attack) : 1 - exp(-dt/release)
  cur += (target - cur) * k
  ```

  时间常数以秒计，与帧率无关；`attack` 控制激发速度，`release` 控制回落速度。关闭 `useEnvelope` 则直接使用瞬时值。

> 注意：当前**没有**分频段能量（bass/mid/treble）、节拍检测或频谱质心分析；所有效果都直接消费频域/时域数组。

---

## 九、渲染管线

`render()` 每个 `requestAnimationFrame` 执行一次：

1. 计算 `dt`（钳制上限 0.1s，避免后台恢复跳变）。
2. `drawBackground(CFG)` 绘制背景（不受缩放影响）。
3. 若存在 `AnalyserNode`，取样一次频域/时域数据到 `CFG.freq`/`CFG.wave`。
4. `ctx.save()` + 以画布中心为原点应用 `zoom` 缩放。
5. 按 `y` 排序元素，逐个：
   - `globalAlpha = opacity`；
   - 平移到元素中心，按需 `scale(-1,1)`（`mirror` 水平镜像）与 `scale(1,-1)`（`invert` 垂直翻转），再应用 `rotation`，最后平移回左上角；
   - 调用 `DRAW[type](ctx, p, ew, eh, el, dt)`，其中 `ew = canvas.width * w/100`。
6. 绘制选中元素的虚线框与四角手柄（与元素同一坐标系）。
7. `ctx.restore()`；`updateSeekUI()` 更新进度条。

> `mirror` 与 `invert` 在渲染层统一处理，对**所有**效果生效，不再由单个效果各自实现。

坐标系统：元素用**百分比**描述（`x/y` 为元素中心，`w/h` 为占画布比例），绘制时换算为像素。

---

## 十、交互

- **元素库**：左侧面板按分类列出效果缩略图，点击即追加一个新元素。
- **属性面板**：**左侧**（与元素/背景面板一致，PC 端同占左侧槽位、打开时隐藏元素面板），移动端与其它面板一样**从左侧滑出**；分组展示参数。
- **画布**：Pointer Events 统一鼠标/触摸——`pointerdown` 命中检测并 `setPointerCapture`，`pointermove` 更新，`pointerup`/`pointercancel` 结束；画布设置 `touch-action:none` 防止触摸滚动。
- **移动**：**已禁用画布拖动移动**；`pointerdown` 命中元素只做选中，位置必须通过属性面板的「位置 X / 位置 Y」滑条设置（按百分比、以元素中心计）。
- **四角缩放**：悬停四角显示 `nwse/nesw-resize` 光标，拖动对应角可**自由非等比**改变宽高（对角固定，宽高限制 2%–100%），类似 Windows 窗口缩放。
- **两指夹捏**：触摸端双指按距离比**等比**缩放选中元素（长宽同比）。
- **选中反馈**：选中元素绘制虚线框与四角手柄；点击空白处取消选中。
- **元素库/背景**：底部「背景」工具页配置画布背景。
- **性能面板**：图标栏「属性」右侧的「性能」按钮，设置画布**分辨率**（宽/高，范围 100×100 ~ 4320×2160）与**帧率**（FPS，范围 30 ~ 240），并预置 360p/480p/720p/1080p/2K/4K 分辨率与 30/60/90/120/144/240 帧率；超出范围时面板内报错且不生效。帧率超过浏览器实测上限时自动取上限：`_detectMaxFps()` 采样 45 帧 rAF 间隔、取最快 25% 的均值并**保留非标刷新率**（165/185/240 等，不再归一到常见档），打开性能面板时会重新检测。`render()` 按 `CFG.fps` 节流。
- **叠加信息开关**：性能面板有**两个独立开关**——「显示帧率」(`CFG.showFps`) 与「显示分辨率」(`CFG.showRes`)，默认都开；打开后在 canvas 左上角用 `ctx.fillText` 分别叠加**实际渲染 FPS** 与**当前渲染分辨率**（`W×H`，两行，关掉其中一个就只画另一个）。`_updateFps()` 每 500ms 统计一次实际绘制帧数。Canvas 本身没有帧率 API，只能这样用 rAF 时间戳自行测量。
- **为什么没有 CPU / GPU 占用率**：浏览器**没有**任何标准 Web API 能读取 CPU / GPU 占用率（`navigator.hardwareConcurrency` 只是核心数、`performance.memory` 只是 JS 堆、WebGPU timestamp 只是 GPU 耗时，都不是占用率），因此**不添加** CPU/GPU 开关，只提供 FPS 与分辨率两个能真实取值的开关。
- **缩放**：已移除比例下拉与 `− / + / ⛶ 适配` 按钮；`fitCanvas()` 改为**宽高同时贴合**（`zoom = min(可用宽/画布宽, 可用高/画布高)`），保证整个绘制区完整可见、不出现滚动条，终端紧随缩放后的下边界；属性/性能面板开合、窗口尺寸变化、进入全屏都会重新适配。
- **面板宽度拖拽**：PC 端在左侧面板与绘制区之间有一条 `.panel-resizer` 拖拽条（移动端隐藏），拖动实时改 `--panel-w`（180–600px），画布随之**等比缩放**且始终完整可见。
- **全屏**：图标栏最右「全屏」按钮（`fsToggleBtn`，在性能按钮右侧）把 `.canvas-area` 全屏；全屏时**只保留绘制区**（隐藏进度条与终端，`fitCanvas()` 也不再为终端预留高度），并按 `zoom = min(屏宽/画布宽, 屏高/画布高)` **缩小到完整显示**（21:9 屏看 16:9 画布会缩到上下留黑边，不滚动）；全屏 CSS 用 `--canvas-zoom/--canvas-w/--canvas-h` 覆盖移动端「强制宽度 100%」的规则，绘制区 `overflow:hidden` 不再出现滚动条。`pointerdown` 直接返回并清空选中，**画布内元素不可选中/点击**；**双击任意位置**或 Esc 退出全屏。

---

## 十一、扩展：新增一个可视化效果

只需两步：

**1. 在 `VISUAL_STYLES` 登记**

```js
{ id: 'my-viz', name: '我的效果', cat: 'visualizer' }
```

**2. 在 `DRAW` 注册绘制函数**

```js
DRAW['my-viz'] = function(ctx, p, W, H, el, dt){
  // ctx: 已平移到元素左上角、已设置 globalAlpha 的 2D 上下文
  // p:   参数对象（见第六节）
  // W/H: 元素像素宽高
  // el:  元素对象，可用 el._env 保存每元素持久状态
  // dt:  距上一帧的秒数
  const bars = getFreqBars(p, el, p.barCount, dt); // 频域+包络
  // ... 用 ctx 绘制 ...
};
```

需要时域波形可直接读 `CFG.wave`（先用 `CFG.analyser.getByteTimeDomainData(CFG.wave)`）。

可选：在 `thumbSVG(id)` 里为该 id 增加缩略图，否则使用默认矩形图标。

---

## 十二、性能与已知问题

### 12.1 性能

- **每帧只取样一次频谱**：`getByteFrequencyData`/`getByteTimeDomainData` 移入 `render()`，所有元素复用。
- **拖角缩放不重建面板**：`pointermove` 只同步 X/Y/W/H 控件，`pointerup` 才调用 `renderProps()`，避免逐帧 `innerHTML` 重建与事件重绑。
- **帧率节流**：`render()` 以 `CFG.fps` 为目标节流（受浏览器刷新率上限约束），降低高刷屏下的无谓绘制。
- **实测帧率**：rAF 的实际回调频率由浏览器合成器 / 显示器刷新率决定，部分浏览器（尤其移动端）会把 rAF 限制在 120Hz，即使屏幕是 185/240Hz；这不是 canvas 本身的限制，代码只能如实测量、无法突破。
- **颜色 LUT**：渐变模式按颜色数组缓存 256 级查表（`gradientLUT`），避免逐柱逐帧解析 hex。
- **背景模糊去重**：`bgBlur > 0` 时只绘制一次模糊图。
- **进度条节流**：`updateSeekUI()` 100ms 节流，不再每帧写 DOM。
- **彩虹模式**基于播放进度（`audio.currentTime`），暂停时冻结。
- **`smoothing` 全局化**：由 `CFG.smoothing` 统一控制，创建 analyser 时写入。

### 12.2 已知问题

- `rounded` 仅 `bars`、`innerRadius` 仅 `circle-radial`、`glow`/`lineWidth` 仅部分效果（属预期设计）。
- 无导出（WebM/PNG 序列）、无 `devicePixelRatio` 适配。
- 背景图片为 object URL，刷新后不恢复（自动回退为纯色）。
- 多元素可叠加，但暂无图层顺序/混合模式的 UI。

---

## 十三、路线图（深挖方向）

按“价值/成本”排序：

1. **音频特征层**：在 `AnalyserNode` 之上加 `AudioFeatures`——分频段能量（bass/mid/treble）、节拍检测（低频能量滑动平均 + 自适应阈值 + 冷却，输出 beat 脉冲与 BPM）、频谱质心/谱通量，驱动“能量映射”配色与脉冲特效。
2. **渲染性能（进阶）**：离屏分层（背景/元素/UI 只重绘变化层），大量粒子/瀑布类可引入 WebGL 后端。
3. **图层与混合**：图层顺序 UI、`globalCompositeOperation` 混合模式、元素成组。
4. **导出**：`canvas.captureStream()` + `MediaRecorder` 录制 WebM；或逐帧导出 PNG 序列；用 `OfflineAudioContext` 离线渲染保证稳定帧率。
5. **预设分享**：导入/导出 JSON 预设，压缩进 URL hash 分享。
6. **响应式与 DPR**：画布按 `devicePixelRatio` 与容器自适应。
7. **性能预算与降级**：监测帧率/丢帧，动态降低 `barCount`、关闭发光/模糊。
8. **可测试性**：拆分为 `audio.js`/`visualizers.js`/`app.js`，对纯函数（`multiColor`、`envStep`、`getFreqBars`）做单元测试，Playwright 做视觉回归。
9. **无障碍与键盘**：ARIA 标注、更多快捷键（删除/复制/切换元素）。

---

## 附：缓存

`AssetCache` 使用 Cache API，缓存名 `music-viz-assets-v1`，以绝对路径为键、`ignoreSearch` 提高命中率；缓存失败时回退到普通 `fetch`。目前仅用于演示音频 `demo.ogg`：`fetchDemo()` 先查缓存；未命中时按终端顶部「完整竞速」开关选择：开（默认）走 `_raceDownloadDemo()`，关则走 `_raceFirstByteDemo()`（同时请求、首个响应头胜出后再读 Blob）。`_raceDownloadDemo()` 同时向 4 个 jsDelivr 边缘节点（`cdn` / `fastly` / `gcore` / `testingcf`，均 `gh/teecatt/teecatt.github.io@master/music_visualization/demo.ogg`）+ 本地 `demo.ogg` 发起**完整下载**，`Promise.any` 取最先完整下载完成者，随后 `AbortController.abort()` 中止其余镜像并丢弃其不完整分片（`_downloadBlobDemo` 中止时把分片数组置 null）；终端日志实时显示竞速进度（领先镜像 + 速度）、胜出镜像（大小/耗时/平均速度）与清理信息。命中后写回缓存（CORS 可用且不消耗 Pages 带宽）。

### 布局：绘制区 / 进度条 / 终端

- `.canvas-area` 为纵向 flex：`.canvas-stage`（绘制区，宽高同时贴合）→ `.player-bar`（进度条，紧挨绘制区下方）→ `.log-toolbar` → `.log-bar`（终端，`flex:1` 向下延伸到浏览器底部）。原 `.canvas-toolbar`（缩放/比例控件）已移除。
- `.canvas-stage` 为 `flex:0 1 auto; overflow:hidden`（PC）：高度=缩放后画布高度，因此进度条/终端始终紧贴画布下边界（终端跟随画布缩放）；不再出现纵向滚动条。移动端仍为 `overflow:auto`。
- `.library` 与 `.props` 宽度用 `var(--panel-w,280px)`，PC 端由 `.panel-resizer` 拖拽调整。
- `.canvas-stage` 为 `flex:0 1 auto; min-height:0; overflow:auto`：空间足够时高度贴合缩放后的画布，空间不足时收缩并滚动，保证进度条与终端始终可见、终端到底。
- 属性面板 `.props` 与性能面板 `.props.perf` 默认 `display:none`（PC 与移动端一致），点「属性」/「性能」按钮加 `.open` 展开，再点收起；PC 端在**左侧**占宽（`.props{border-right; order:1}`，画布区 `order:2`），打开时给元素面板加 `.hidden` 隐藏之，`fitCanvas()` 会重新按新宽度适配。
- **移动端所有面板从左侧滑出，最多占浏览器宽度 2/3**：`.library,.props` 统一 `position:fixed; top:40px; bottom:0; left:0; width:66.6667vw; transform:translateX(-100%); transition:transform .3s`，`.mobile-open`/`.open` 时 `translateX(0)`。
- **已移除「收起面板」按钮**：移动端面板展开时，右侧 1/3 为透明遮罩 `.panel-backdrop.show`（`left:66.6667vw`），点击遮罩只收起面板、不做任何其它响应。
