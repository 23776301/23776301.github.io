# 音频可视化工作室 · Music Visualizer

浏览器端实时音频可视化工具。上传一首歌，从 10 种可视化效果里选一个，拖动参数即时看到变化——不需要渲染、不需要等待导出。

单文件、零依赖、零构建：整个应用就是 `music_visualization/index.html`，双击即可运行。

> 本文档描述的是**当前 `index.html` 的实际实现**，包含真实的参数、边界与已知问题，并给出后续深挖方向。

---

## 目录

1. [功能](#一功能)
2. [快速开始](#二快速开始)
3. [架构](#三架构)
4. [音频分析](#四音频分析)
5. [渲染管线](#五渲染管线)
6. [参数系统](#六参数系统)
7. [配色系统](#七配色系统)
8. [背景系统](#八背景系统)
9. [交互](#九交互)
10. [扩展：新增一个可视化效果](#十扩展新增一个可视化效果)
11. [性能与已知问题](#十一性能与已知问题)
12. [路线图（深挖方向）](#十二路线图深挖方向)

---

## 一、功能

### 1.1 可视化效果（10 种）

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

### 1.2 输入与播放

- 音频文件上传（点击顶部区域选择，或拖入）。
- 播放/暂停、进度条拖拽 seek、音量、循环。
- 自动加载演示音频 `demo.ogg`。

### 1.3 其它

- 画布比例预设：16:9（1280×720）、9:16、1:1、4:5、4:3。
- 画布缩放（0.1×–2×）与「适配」按钮（重置为 100%）。
- 画布内点击选中元素、拖动移动。
- 背景：纯色 / 线性渐变 / 径向渐变 / 图片（模糊 + 暗化）。
- 配色：纯色 / 渐变 / 彩虹，渐变支持多色增删排序。

### 1.4 快捷键

| 键 | 作用 |
| --- | --- |
| `空格` | 播放 / 暂停 |

> 说明：当前**没有**麦克风输入、全屏、FPS 显示、暗/亮主题、配置持久化与导出功能（见[路线图](#十二路线图深挖方向)）。

---

## 二、快速开始

### 2.1 本地预览

因为使用了 Cache API 与 `AudioContext`，建议通过 HTTP 访问：

```bash
python -m http.server 8000
# 打开 http://localhost:8000/music_visualization/
```

### 2.2 部署

本工具作为子目录部署在 `teecatt/teecatt.github.io` 仓库的 `music_visualization/` 下，通过 GitHub Pages 发布：

- 线上地址：`https://down2.top/music_visualization/`
- 推送 `master` 后由 `.github/workflows/deploy.yml` 自动构建发布。

### 2.3 文件结构

```
music_visualization/
├── index.html      # 单文件应用（页面骨架 + 样式 + 全部逻辑）
├── demo.ogg        # 自动加载的演示音频
└── README.md       # 本文档
```

---

## 三、架构

单文件内按职责划分为若干区块（均在同一个 `<script>` 中）：

```
index.html
├── <style>                     # 暗色主题、响应式、组件样式
├── AssetCache                  # Cache API 缓存（music-viz-assets-v1）
├── CFG                         # 全局配置（canvas / elements / audio）
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
├── 画布交互                     # mousedown / mousemove / mouseup
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

---

## 四、音频分析

- **节点**：`createMediaElementSource(audio)` → `AnalyserNode(fftSize=2048)` → `destination`。
- **数据**：`getByteFrequencyData`（频域，长度 `frequencyBinCount = 1024`）与 `getByteTimeDomainData`（时域，长度 `fftSize = 2048`）。
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

## 五、渲染管线

`render()` 每个 `requestAnimationFrame` 执行一次：

1. 计算 `dt`（钳制上限 0.1s，避免后台恢复跳变）。
2. `drawBackground(CFG)` 绘制背景（不受缩放影响）。
3. `ctx.save()` + 以画布中心为原点应用 `zoom` 缩放。
4. 按 `y` 排序元素，逐个：
   - `globalAlpha = opacity`；
   - 平移到元素中心、应用 `rotation`、再平移回左上角；
   - 调用 `DRAW[type](ctx, p, ew, eh, el, dt)`，其中 `ew = canvas.width * w/100`。
5. `ctx.restore()`；`updateSeekUI()` 更新进度条。

坐标系统：元素用**百分比**描述（`x/y` 为元素中心，`w/h` 为占画布比例），绘制时换算为像素。

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
| `invert` | false | 垂直翻转 | 仅 `bars` |
| `rounded` | true | 圆角柱 | 仅 `bars` |
| `glow` / `glowBlur` | false / 12 | 发光 | `circle-wave`、`spectrum-line` |
| `innerRadius` | 25 | 内圈半径（%） | 仅 `circle-radial` |
| `mirror` | false | 镜像 | ⚠️ 未实现（占位参数） |

属性面板由 `rangeField` / `toggleField` / `dualRangeField` / `collapsible` / `colorEditorHTML` 生成，`bindPropsFields` 统一绑定事件。

> ⚠️ 部分参数只在个别效果中生效（如 `invert`/`rounded` 仅 `bars`），而 `mirror` 目前是死参数；见[已知问题](#十一性能与已知问题)。

---

## 七、配色系统

- **模式**：`solid`（纯色）、`gradient`（多色渐变）、`rainbow`（彩虹）。
- **多色渐变**：`colors` 数组按停靠点均匀插值（`multiColor`），支持添加、上移、下移、删除，并提供实时预览条。
- **逐柱映射**：多数效果用 `elemColor(p, i/barCount)` 让颜色沿柱子渐变。
- **彩虹**：`hsl((t*300 + performance.now()*0.05) % 360, 100%, 60%)`——基于**墙钟时间**，与播放进度无关。

---

## 八、背景系统

| 类型 | 参数 |
| --- | --- |
| `solid` | `bgColor` |
| `gradient-linear` | `gradColor1`/`gradColor2`、5 个停靠点（首尾固定，25/50/75 可调）、`gradAngle` |
| `gradient-radial` | `gradColor1`/`gradColor2`、停靠点、`gradRadius` |
| `image` | 背景图片、`bgBlur`（0–20）、`bgDarken`（0–1） |

背景绘制在缩放变换之前，因此缩放只影响元素、不影响背景。

---

## 九、交互

- **元素库**：左侧面板按分类列出效果缩略图，点击即创建。
- **属性面板**：右侧（移动端底部抽屉）分组展示参数。
- **画布**：`mousedown` 命中检测 → 选中并拖动；`mousemove` 更新位置；`mouseup` 结束。
- **元素库/背景**：底部「背景」工具页配置画布背景。
- **缩放**：工具栏 `− / + / ⛶ 适配`，标签实时显示百分比。

> ⚠️ 画布拖动仅绑定了鼠标事件，**触摸设备无法拖动元素**。

---

## 十、扩展：新增一个可视化效果

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

## 十一、性能与已知问题

### 11.1 性能

- **拖动元素时每帧重建属性面板**：`mousemove` 里直接调用 `renderProps()`，会反复 `innerHTML` 重建并重绑事件，是当前最大热点。
- **颜色逐帧解析 hex**：`multiColor → lerpColor → hexToRgb` 每柱每帧执行，`barCount` 高时开销显著。
- **每帧重复取频谱**：每个频域效果各自调用 `getByteFrequencyData` 并新建数组。
- **背景图片模糊时重复绘制**：`bgBlur > 0` 时先画清晰图再画模糊图，清晰那次是浪费。
- **`updateSeekUI()` 每帧写 DOM**。

### 11.2 已知问题 / 死代码

- `mirror` 参数暴露在 UI 但没有任何效果使用。
- `rounded`/`invert` 仅 `bars` 生效；`innerRadius` 仅 `circle-radial`；`glow`/`lineWidth` 仅部分效果。
- `circle-pulse` 忽略 `barCount`（写死 32）。
- 选中框代码计算了坐标但未绘制任何内容。
- `addElement()` 每次清空 `CFG.elements`，实际**同时只能存在一个效果**。
- 画布拖动无触摸/指针支持。
- `rainbow` 基于墙钟时间，暂停时仍在变化。
- `smoothing` 是全局 analyser 属性，却放在元素参数中，且初始化未从参数写入。
- 无配置持久化、无导出、无麦克风、无 DPR 适配。

---

## 十二、路线图（深挖方向）

按“价值/成本”排序：

1. **音频特征层**：在 `AnalyserNode` 之上加 `AudioFeatures`——分频段能量（bass/mid/treble）、节拍检测（低频能量滑动平均 + 自适应阈值 + 冷却，输出 beat 脉冲与 BPM）、频谱质心/谱通量，驱动“能量映射”配色与脉冲特效。
2. **渲染性能**：颜色 LUT 预计算、每帧单次取谱、拖动期间只改几何（rAF 节流，`mouseup` 再同步面板）、背景模糊去重。
3. **多元素/图层**：真正的多效果叠加、图层顺序、`globalCompositeOperation` 混合模式。
4. **导出**：`canvas.captureStream()` + `MediaRecorder` 录制 WebM；或逐帧导出 PNG 序列；用 `OfflineAudioContext` 离线渲染保证稳定帧率。
5. **持久化与分享**：配置存 localStorage / 压缩进 URL hash，导入导出 JSON 预设。
6. **响应式与 DPR**：画布按 `devicePixelRatio` 与容器自适应，Pointer Events 统一鼠标/触摸，增加缩放手柄。
7. **麦克风输入**：`getUserMedia` + `createMediaStreamSource`。
8. **性能预算与降级**：监测帧率/丢帧，动态降低 `barCount`、关闭发光/模糊。
9. **可测试性**：拆分为 `audio.js`/`visualizers.js`/`app.js`，对纯函数（`multiColor`、`envStep`、`getFreqBars`）做单元测试，Playwright 做视觉回归。
10. **修正参数语义**：让 `mirror` 真正生效，或从 UI 移除；把 `smoothing` 提到全局设置。

---

## 附：缓存

`AssetCache` 使用 Cache API，缓存名 `music-viz-assets-v1`，以绝对路径为键、`ignoreSearch` 提高命中率；缓存失败时回退到普通 `fetch`。目前仅用于演示音频 `demo.ogg`。
