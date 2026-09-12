# 音频可视化工作室 · Music Visualizer

浏览器端实时音频可视化工具。上传一首歌，从 10 种可视化效果里选一个，拖动参数即时看到变化——不需要渲染、不需要等待导出。

单文件、零依赖、零构建：整个应用就是 `music_visualization/index.html`，双击即可运行。

> 本文档描述的是**当前 `index.html` 的实际实现**，包含真实的参数、边界与已知问题，并给出后续深挖方向。

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
- 自动加载演示音频 `demo.ogg`（多个 jsDelivr 边缘节点**并发完整下载竞速**，最先完成者胜出，其余立即中止并清理不完整分片，全部失败回退本站 Pages）。

### 2.3 其它

- **多元素叠加**：可同时添加多个效果，按 `y` 排序绘制，支持选中/拖动/删除。
- 画布比例预设：16:9（1280×720）、9:16、1:1、4:5、4:3。
- 画布缩放（0.1×–2×）与「适配」按钮（`fitCanvas()` 优先按**宽度贴合左右控件边界**等比缩放，高度超出由绘制区滚动）。
- 画布内点击选中元素、拖动移动；选中时显示虚线框与四角手柄，可拖角自由（非等比）缩放，触摸端支持两指夹捏等比缩放。
- 背景：纯色 / 线性渐变 / 径向渐变 / 图片（模糊 + 暗化）。
- 配色：纯色 / 渐变 / 彩虹，渐变支持多色增删排序。
- **刷新即恢复默认**：不做配置持久化（`saveConfig` 为空实现，`loadConfig` 会清除历史键），每次刷新元素回到默认居中（x/y=50）、画板比例回到 16:9，属性面板默认不展开。

### 2.4 快捷键

| 键 | 作用 |
| --- | --- |
| `空格` | 播放 / 暂停 |
| `Delete` | 删除选中元素 |

> 说明：当前**没有**全屏、FPS 显示、暗/亮主题与导出功能（见[路线图](#十二路线图深挖方向)）。

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
├── index.html      # 单文件应用（页面骨架 + 样式 + 全部逻辑）
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
├── saveConfig / loadConfig     # 不做持久化：刷新恢复默认（清除 music-viz-config-v1）
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
└── 画布比例与缩放               # setAspect / applyZoom
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
- `saveConfig` 为空实现、`loadConfig` 每次刷新清除 `music-viz-config-v1` 并返回 false，因此刷新后画布/元素/比例都恢复默认（元素居中、16:9）；`scheduleSave` 仍保留调用点但不再写盘。

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
- **移动**：拖动元素本体，按 `worldPoint()` 逆缩放换算，缩放下位置依然准确。
- **四角缩放**：悬停四角显示 `nwse/nesw-resize` 光标，拖动对应角可**自由非等比**改变宽高（对角固定，宽高限制 2%–100%），类似 Windows 窗口缩放。
- **两指夹捏**：触摸端双指按距离比**等比**缩放选中元素（长宽同比）。
- **选中反馈**：选中元素绘制虚线框与四角手柄；点击空白处取消选中。
- **元素库/背景**：底部「背景」工具页配置画布背景。
- **缩放**：工具栏 `− / + / ⛶ 适配`，标签实时显示百分比；`fitCanvas()` 以「宽度贴合左右控件边界」为优先（`zoom = 可用宽度 / 画布宽度`），不再被高度限制；属性面板开合会重新适配。

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
- **拖动元素不重建面板**：`pointermove` 只同步 X/Y 控件，`pointerup` 才调用 `renderProps()`，避免逐帧 `innerHTML` 重建与事件重绑。
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

`AssetCache` 使用 Cache API，缓存名 `music-viz-assets-v1`，以绝对路径为键、`ignoreSearch` 提高命中率；缓存失败时回退到普通 `fetch`。目前仅用于演示音频 `demo.ogg`：`fetchDemo()` 先查缓存；未命中则由 `_raceDownloadDemo()` 同时向 4 个 jsDelivr 边缘节点（`cdn` / `fastly` / `gcore` / `testingcf`，均 `gh/teecatt/teecatt.github.io@master/music_visualization/demo.ogg`）+ 本地 `demo.ogg` 发起**完整下载**，`Promise.any` 取最先完整下载完成者，随后 `AbortController.abort()` 中止其余镜像并丢弃其不完整分片（`_downloadBlobDemo` 中止时把分片数组置 null）；终端日志实时显示竞速进度（领先镜像 + 速度）、胜出镜像（大小/耗时/平均速度）与清理信息。命中后写回缓存（CORS 可用且不消耗 Pages 带宽）。

### 布局：绘制区 / 进度条 / 终端

- `.canvas-area` 为纵向 flex：`.canvas-toolbar` → `.canvas-stage`（绘制区，按宽度等比缩放）→ `.player-bar`（进度条，紧挨绘制区下方）→ `.log-toolbar` → `.log-bar`（终端，`flex:1` 向下延伸到浏览器底部）。
- `.canvas-stage` 为 `flex:0 1 auto; min-height:0; overflow:auto`：空间足够时高度贴合缩放后的画布，空间不足时收缩并滚动，保证进度条与终端始终可见、终端到底。
- 属性面板 `.props` 默认 `display:none`（PC 与移动端一致），点「属性」按钮加 `.open` 展开，再点收起；PC 端在**左侧**占宽（`.props{border-right; order:1}`，画布区 `order:2`），打开时给元素面板加 `.hidden` 隐藏之，`fitCanvas()` 会重新按新宽度适配。
- **移动端所有面板从左侧滑出**（不再从底部弹出）：`.library,.props` 统一 `position:fixed; top:40px; bottom:0; left:0; width:82vw; transform:translateX(-100%); transition:transform .3s`，`.mobile-open`/`.open` 时 `translateX(0)`；`#mobilePreview`「收起面板」总是收起所有面板（不再有再点还原逻辑）。
