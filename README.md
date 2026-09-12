# down2.top

个人工具与资源门户，同时部署到 GitHub Pages 与 Cloudflare Pages，自定义域名 `down2.top`。

## 站点结构

| 路径 | 说明 |
|------|------|
| `/` | 首页导航 |
| `/music_visualization/` | 音频可视化 |
| `/midi_player/` | 在线 MIDI 播放器，多种键型钢琴 · 音游模式 · CDN竞速 |
| `/library/` | 资源库，按类型分类：rules / tools / skills / plugins / guides |
| `/links/` | 外部在线工具导航 |
| `/ui-kit/` | 可复用 UI 组件归档：圆形按钮 / 配色面板 / 调试面板（纯 CSS + 演示） |

## 目录结构

```
├── index.html              # 首页
├── CNAME                   # 自定义域名配置
├── data/
│   ├── catalog.json        # 资源库数据
│   └── links.json          # 外部链接数据
├── music_visualization/    # 音频可视化页面（index.html + app.css + app.js）
├── midi_player/            # MIDI 播放器页面（样式内联于 index.html + app.js）
│   ├── index.html          #   含内联 <style id="appCss">
│   └── midi/               # MIDI 谱子目录
│       ├── list.json       # 谱子列表配置
│       └── *.mid           # MIDI 文件
├── ui-kit/                 # UI 组件归档（ui-kit.css + index.html 演示 + README）
├── library/                # 资源库页面
├── links/                  # 外部链接页面
├── tools/                  # 工具源文件
└── .github/workflows/      # 自动部署配置
```

## 添加外部链接

编辑 `data/links.json`，按现有格式添加条目，推送即生效。

## 关键 URL

- 站点：<https://down2.top>
- MIDI 播放器：<https://down2.top/midi_player/>
- 音频可视化：<https://down2.top/music_visualization/>
- 资源库：<https://down2.top/library/>
- 外部链接：<https://down2.top/links/>
- UI Kit：<https://down2.top/ui-kit/>

## 部署

push `master` 后，`.github/workflows/deploy.yml` 会自动：

1. `deploy`：发布到 GitHub Pages（`teecatt.github.io`）
2. `cloudflare`：将站点快照同步到 Cloudflare Pages 项目 `d2p`（生产分支 `master`，对应自定义域 `down2.top`）
3. `cleanup`：清理旧的 push 触发 run / deployment

`cloudflare` job 依赖仓库 Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。

## 技术要点

- 纯静态页面，数据驱动
- 暗色主题，移动端自适应
- GitHub Pages + Cloudflare Pages 双端部署
