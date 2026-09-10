# Audio Visualizer Studio

浏览器端的实时音频可视化工具。上传一首歌（或开麦克风），从 30 种可视化效果里挑一个，拖动参数即时看到变化——不需要渲染、不需要等待导出。

纯静态文件，无构建步骤、无后端、无依赖，双击 `index.html` 就能跑。

## 功能

**30 种可视化效果**

| 分类 | 效果 |
|------|------|
| 柱状（4） | 柱状图、镜像柱、3D 柱阵、LED 均衡 |
| 圆形（11） | 圆形频谱、径向块、双层环、圆点环、圆形波、螺旋、莲花、同心圆、花瓣、环带频谱、声波带 |
| 波形（7） | 波形线、平滑波、镜像波、山脉、心电图、极光、声波带 |
| 点阵粒子（5） | 点阵、粒子、烟花、星际穿梭、星云 |
| 空间（3） | 立方场、网格脉冲、频谱瀑布 |

**参数**：34 种可调参数，每个效果暴露其中 12–16 个，合计 417 个参数项。

- **全局**：背景色、分析平滑、FFT 精度（1024–8192）、画面拖尾、画布比例（自适应 / 16:9 / 9:16 / 1:1 / 4:3）、FPS 显示
- **配色**：单色 / 渐变 / 彩虹 / 能量映射四种模式，主色副色、色相偏移、饱和度
- **形态**：数量、间距、粗细、圆角、半径、层数、展开角度、谐波瓣数、生长方向
- **动态**：灵敏度、自转速度、扭曲、透视、振幅、速度、大小、拖尾残留
- **特效**：发光强度、不透明度、镜像对称、峰值帽、填充

音频输入支持本地文件（拖到画布即可）和麦克风实时输入。配置自动存 localStorage，刷新不丢。

## 快捷键

| 键 | 作用 |
|----|------|
| `空格` | 播放 / 暂停 |
| `F` | 全屏 |
| `M` | 切换麦克风 |

## 本地预览

因为用到了 `getUserMedia`，麦克风功能需要通过 HTTP 访问（`file://` 下浏览器会拦截）。本地起个服务：

```bash
python -m http.server 8000
# 打开 http://localhost:8000
```

不用麦克风的话，直接双击 `index.html` 就行。

## 部署到 GitHub Pages

### 方式一：独立仓库（推荐）

```bash
cd audio-visualizer
git init
git add .
git commit -m "Add audio visualizer studio"
git branch -M main
git remote add origin https://github.com/<你的用户名>/audio-visualizer.git
git push -u origin main
```

然后在仓库页面 **Settings → Pages → Source**，选择 `main` 分支、根目录 `/`，保存。等一两分钟，访问 `https://<用户名>.github.io/audio-visualizer/`。

### 方式二：放进已有仓库的子目录

如果像 `tools` 那样已有仓库，把它作为一个子目录放进去，Pages 的 Source 选 `/docs` 就把目录改名成 `docs`，选根目录就把文件放在仓库根下。

> 注意：如果仓库里已经有别的内容（比如 TrafficMonitor 插件），建议用子目录，别覆盖原有的 `index.html`。

### 方式三：gh-pages 分支

```bash
git checkout -b gh-pages
git add . && git commit -m "Deploy visualizer"
git push origin gh-pages
```

Pages Source 选 `gh-pages` 分支即可。

## 麦克风在 HTTPS 下才可用

GitHub Pages 默认走 HTTPS，麦克风功能正常。本地 `http://localhost` 也算安全上下文，同样可用。但如果部署到自建的 HTTP 站点，`getUserMedia` 会被浏览器拦截——这是浏览器安全策略，不是代码问题。

## 文件结构

```
├── index.html        # 页面骨架
├── style.css         # 样式（暗色 / 亮色双主题）
├── visualizers.js    # 30 种可视化的渲染实现 + 参数池
└── app.js            # 音频引擎、渲染循环、UI 交互
```

### 加一个新可视化

在 `visualizers.js` 的 `V` 数组里追加一项即可，参数面板会自动生成：

```js
V.push({
  id: 'myViz',
  name: '我的效果',
  cat: 'circle',
  params: [...BASE, 'radius', 'spin', 'amplitude'],  // 从参数池挑选
  icon: '<svg viewBox="0 0 48 48">...</svg>',        // 选择器里的预览图标
  draw(ctx, s) {
    // s.freq  频域数据 Uint8Array
    // s.wave  时域数据 Uint8Array
    // s.W/s.H 画布尺寸   s.c 参数对象   s.t 时间(秒)
    // s.energy/bass/mid/treble 分频段能量   s.beat 节拍   s.rot 累积旋转
    // s.state 该效果独有的持久状态对象
  }
});
```

## 技术说明

音频分析走 Web Audio API 的 `AnalyserNode`，和 EchoWave 是同一套 FFT 机制；区别在于渲染位置——EchoWave 把分析结果传到云端渲染成 MP4，这里直接在 Canvas 2D 上画，所以没有导出等待，参数改动下一帧就能看到。

频率采样用对数映射而非线性，低频分到更多柱子，视觉上更贴合听感。节拍检测基于低频能量的滑动平均突变。

渲染按 `devicePixelRatio` 缩放（上限 2×），高分屏下不会发虚。
