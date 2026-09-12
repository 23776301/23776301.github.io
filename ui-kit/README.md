# UI Kit —— 圆形按钮 / 配色面板 / 调试面板

从 `midi_player` 抽取的一套**纯 CSS、零依赖**的界面组件，便于在其它静态页里直接复用。
可运行示例见同目录 [`index.html`](./index.html)（线上：<https://down2.top/ui-kit/>）。

- `ui-kit.css` —— 全部样式（约 12KB），用 CSS 变量换肤
- `index.html` —— 演示页，同时是最完整的用法参考
- 本文件 —— 设计说明 + 复用指南

---

## 1. 包含什么

| 组件 | 选择器 | 说明 |
| --- | --- | --- |
| 圆形控制按钮 | `.ctl-btn` / `.control-row` / `.ctl-group` / `.ctl-spacer` | 10 钮系统，桌面固定 32px、移动端等比网格 |
| 下拉浮层 | `.drop-panel` | 配色/调试/设置共用的浮层容器 |
| 配色面板 | `.pal-btn` `.palette-*` `.pe-*` `.pp-*` `.hsl-*` `.color-board-marker` | A/B/C + 自定义取色 |
| 调试面板 | `.debug-panel` `.dbg-*` | 工具条 / 动作行 / 日志区 / 开关 |
| 滑动开关 | `.switch` | 纯 CSS 复选框替代 |
| 浮动圆钮 | `.fab-group` `.menu-btn` `.debug-fab` | 移动端可拖拽、自动淡出 |
| 全屏悬浮圆钮 | `.fs-float-btn` | 活跃内缩 / 空闲吸附半露 |
| 图标按钮 | `.icon-btn` | 列表/管理面板用的小图标钮 |

---

## 2. 快速开始

```html
<link rel="stylesheet" href="ui-kit.css">
```

```html
<!-- 10 个圆钮：第一行 2 个 + 选谱，第二行 8 个（左 4 + 撑开 + 右 4） -->
<div class="top-bar">
  <div class="top-bar-row">
    <button class="ctl-btn primary"><svg>…</svg></button>
    <select><option>…</option></select>
    <button class="ctl-btn primary"><svg>…</svg></button>
  </div>
  <div class="control-row">
    <div class="ctl-group">
      <button class="ctl-btn primary"><svg>…</svg></button>
      <!-- …共 4 个 -->
    </div>
    <div class="ctl-spacer"></div>
    <div class="ctl-group">
      <button class="ctl-btn primary drop-trigger"><svg>…</svg></button>
      <!-- …共 4 个 -->
    </div>

    <!-- 下拉浮层挂在 .control-row 里（父级已是 position:relative） -->
    <div class="debug-panel drop-panel" id="debugPanel">…</div>
  </div>
</div>
```

最小 JS（只做面板开关）：

```js
document.querySelectorAll('[data-panel]').forEach(function(btn){
  btn.addEventListener('click', function(){
    var p = document.getElementById(btn.dataset.panel);
    var open = !p.classList.contains('open');
    document.querySelectorAll('.drop-panel.open').forEach(x => x.classList.remove('open'));
    if (open) p.classList.add('open');
  });
});
```

---

## 3. 圆形按钮系统（重点）

### 3.1 为什么观感统一

- **一律正圆**：`border-radius:50%`，尺寸由 `--ctl-size`（默认 32px）统一控制。
- **图标按比例缩放**：行内图标 `width:52%;height:52%`（不是固定 px），
  所以按钮变大变小、DPI 变化时图标始终居中且比例一致，不会「图标顶到边」。
  个别图标（设置/配色/上传）用 58% 微调视觉重量。
- **间距一处定义**：`--ctl-gap: clamp(3px, 1.2vw, 8px)`。
  视口越窄间距越小，但有 3px 下限，避免按钮黏在一起；同时用于 `gap:inherit` 的子组，
  保证组内/组间间距完全一致。

### 3.2 桌面布局：左右分组 + 中间撑开

```
[重播] [选谱........] [全屏]
[▶][⏭][↻][⬆]        [☰][⚙][🎨][🐞]
 └─ .ctl-group ─┘  └.ctl-spacer┘ └─ .ctl-group ─┘
```

`.ctl-spacer{flex:1 1 0}` 把左右两组推到两端，中间自然留白。

### 3.3 移动端 / 低 DPI：等比网格（关键技巧）

`@media(max-width:600px)` 下：

```css
.control-row > .ctl-group{flex:1 1 0;gap:6px}                 /* 两组各占一半 */
.control-row > .ctl-group > .ctl-btn{flex:1 1 0;aspect-ratio:1} /* 钮宽=分到的宽，高=宽 */
.top-bar-row > .ctl-btn{flex:0 0 calc((100% - 42px)/8);aspect-ratio:1}
```

- 第二行 8 钮用 `flex:1 1 0` **平分整行宽度**，`aspect-ratio:1` 保证是正圆（不是椭圆）。
- 第一行两个钮取 `calc((100% - 42px)/8)`，与第二行每个钮**同宽**，
  于是第一行最左/最右与第二行最左/最右**严格对齐**（42px = 8 钮之间 7 个 6px 间隙）。
- 用 `aspect-ratio` 而不是 JS 计算像素：**任何 DPI、任何视口都不会拉伸变形**，也不需要监听 resize。

### 3.4 控件响应模式

| 状态 | 样式 |
| --- | --- |
| hover | 半透明白底 `rgba(255,255,255,.1)`；主色钮用 `inset` 阴影压暗 |
| active | 更亮底 + `opacity:1`；全局 `button:active{opacity:.78}` 兜底 |
| disabled | `opacity:.4;cursor:not-allowed` |
| focus-visible | 仅键盘触发，2px 白/主题色外圈（触屏不显示） |
| 移动端点按 | `-webkit-tap-highlight-color:transparent` 去掉矩形高亮，改用圆角内的按下反馈 |

---

## 4. 配色面板特性

- **A/B/C 三个圆钮 + 编辑钮**：`.pal-btn` 27px 正圆，选中用 `.active`（实心主题色）。
- **面板纯黑不透明**：`.palette-editor{background:#000}`，避免半透明干扰取色；
  它挂在 `#paletteRow` 下方，`#paletteRow{overflow:visible}` 允许溢出显示。
- **色板 + HSL**：左侧 `<canvas>` 2D 色板（横轴色相、纵轴明度），右侧 4 条 HSL/透明度滑块，
  `.hsl-handle` 定位手柄，`.color-board-marker` 显示当前点。
- **端点 / 预设**：`.pe-*` 每个可调颜色端点一行（左侧色块 + 色带），`.pp-*` 常用色板。
- **主题联动**：改色时只需写 3 个变量，全站主色（按钮/按键/开关/滑块）一起变：

```js
root.style.setProperty('--accent', color);
root.style.setProperty('--accent-a18', 'rgba(r,g,b,.18)');  // 悬停底
root.style.setProperty('--accent-a28', 'rgba(r,g,b,.28)');  // 选中底
```

---

## 5. 调试面板特性

- **下拉浮层**：`.debug-panel.drop-panel.open` 从控制行下方展开，`flex-direction:column`。
- **工具条**：左侧 `.switch` 开关，右侧 `.dbg-reset-btn`（红色重置钮，`margin-left:auto` 顶到右边）。
- **动作行**：`.dbg-actions` 内的小圆钮（26px）用于复制/下载/滚动到顶/底。
- **日志区**：`.dbg-log` 等宽字体、`overflow-y:auto`、深色底。
- **启用/关闭态**：给面板加 `.dbg-off`，`.dbg-body` 隐藏、`.dbg-off-hint` 显示，无需 JS 改 DOM。

```html
<div class="debug-panel drop-panel" id="debugPanel">
  <div class="dbg-header">
    <div class="dbg-toolbar">
      <label class="switch"><input type="checkbox" checked><span class="track"><span class="knob"></span></span>启用调试</label>
      <button class="dbg-reset-btn">重置</button>
    </div>
    <div class="dbg-off-hint">调试已关闭。</div>
    <div class="dbg-body"><div class="dbg-actions">…</div></div>
  </div>
  <div class="dbg-log" id="debugLog"></div>
</div>
```

---

## 6. 如何复用（三步）

1. **复制 `ui-kit.css`** 到你的项目，`<link>` 引入。
2. **换肤**：在 `:root` 覆盖变量即可，其余不用动。

   | 变量 | 作用 | 默认 |
   | --- | --- | --- |
   | `--accent` | 主题色 | `#c20c0c` |
   | `--accent-a18` / `--accent-a28` | 主题色 18% / 28% 透明 | 红 |
   | `--border` / `--panel` / `--text` / `--dim` / `--bg` | 基础色 | 深色 |
   | `--ctl-size` | 圆钮基准尺寸 | `32px` |
   | `--ctl-gap` | 圆钮间距 | `clamp(3px,1.2vw,8px)` |

3. **照抄 HTML 结构**（见第 2 节与演示页），浮层记得挂在 `position:relative` 的父级里。

> 类名刻意保留原样（`.ctl-btn` 等），方便和 `midi_player` 相互对照；若你的项目已有同名类，
> 可用构建工具加前缀，或把 `ui-kit.css` 放进 Shadow DOM / `@scope` 隔离。

---

## 7. 注意

- 无外部字体、无框架、无图片；图标全部内联 `<svg>`，便于换色（`fill/stroke:currentColor`）。
- `.ctl-btn` 的图标比例依赖「内联 svg」，请勿给 svg 写死 `width/height` 之外的尺寸。
- `.fab-group` / `.fs-float-btn` 的拖拽、吸附是 JS 行为，本 Kit 只提供样式；
  演示页仅展示静态外观，交互逻辑可参考 `midi_player/app.js`。
- 移动端网格断点是 `max-width:600px`，如需适配大屏手机可自行调整。
