# down2.top

个人工具与资源门户，通过 GitHub Pages 部署，自定义域名 `down2.top`。

## 站点结构

| 路径 | 说明 |
|------|------|
| `/` | 首页导航 |
| `/music_visualization/` | 音频可视化 |
| `/midi_player/` | 在线 MIDI 播放器，多种键型钢琴 · 音游模式 · CDN竞速 |
| `/library/` | 资源库，按类型分类：rules / tools / skills / plugins / guides |
| `/links/` | 外部在线工具导航 |

## 目录结构

```
├── index.html              # 首页
├── CNAME                   # 自定义域名配置
├── data/
│   ├── catalog.json        # 资源库数据
│   └── links.json          # 外部链接数据
├── music_visualization/    # 音频可视化页面
├── midi_player/            # MIDI 播放器页面
│   ├── index.html
│   └── midi/               # MIDI 谱子目录
│       ├── list.json       # 谱子列表配置
│       └── *.mid           # MIDI 文件
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

## 技术要点

- 纯静态页面，数据驱动
- 暗色主题，移动端自适应
- GitHub Pages 部署
