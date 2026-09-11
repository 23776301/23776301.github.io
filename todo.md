# 个人门户站点 · 项目全景与任务交接

> 本文档供任务迁移/交接使用。接手 agent 读完即可了解项目全貌、当前状态、未完成任务、技术机制与用户偏好。
> 生成时间:2026-09-09(用户本地,UTC+8)

---

## 一、项目概述

用户(`teecatt`)把自己的 GitHub Pages 个人站从"仓库文件浏览器"重构为**个人门户**:三大板块(音频可视化 / 个人实用工具 / 外部实用小工具),工具内容由私有 tools 仓通过 GitHub Actions 自动同步到公开 pages 仓,页面数据驱动、链接自动重写、CI 体检防断链。

**核心目标**:
- 个人门户优雅美观(桌面+移动端适配,emoji 图标丰富)
- tools 仓私有化,仅公开内容由 workflow 自动同步,支持可配置随时增删
- 音频可视化链接(`https://down2.top/music_visualization/`)作为参赛作品**必须始终可访问**(红线)
- 链接治理:目录重构后链接仍正确,不硬编码

---

## 二、关键身份与凭据

| 项 | 值 |
|---|---|
| GitHub 用户名 | `teecatt` |
| Pages 公开仓 | `teecatt/teecatt.github.io`(分支 `master`) |
| Tools 私有仓 | `teecatt/tools`(分支 `main`,**已私有**) |
| 自定义域名 | `https://down2.top/`(CNAME 已配) |
| PAT(用户提供,敏感) | `<PAT 已从公开版移除,请从私密交接文档获取>` |
| tools 仓已有 secret | `PAGES_TOKEN`(同步 workflow 复用,**未新建 secret**) |
| API 头 | `Authorization: token <pat>` · `User-Agent: doubao-agent` · `Accept: application/vnd.github+json` |

> ⚠️ PAT 已在对话中明文出现。建议用户用后回收/轮换。文档保留完整 PAT 是为了接手 agent 能直接操作 GitHub API。

---

## 三、线上资产现状(2026-09-09)

### 3.1 Pages 仓完整文件树

```
.github/workflows/build.yml        # 纯部署 workflow(已简化,不再生成 repos-data.json)
.gitignore
404.html                           # 新版 404 页(渐变404+12秒倒计时+4引导按钮+meta refresh)
CNAME                              # down2.top
README.md                          # 空(待写站点导览)
index.html                         # 门户主页(三卡片;音频卡片→/music_visualization/)
data/links.json                    # 外部链接数据(itab 已改 https://go.itab.link/)
data/tools.json                    # 工具库元数据(由 sync 从 public-sync.json 生成)
links/index.html                   # 外部链接页(links.json 驱动)
music_visualization/
  ├─ index.html                    # 71313B 参赛版可视化(未改动,红线)
  └─ README.md
old/a.html                         # WebRTC 局域网互传(遗留,待优化)
tools/
  ├─ index.html                    # 工具库页(已用 abs() 绝对路径修复)
  ├─ rules/keep-my-commit-clean/README.md
  ├─ tools/opencode-session-viewer/(README+install.sh+sss.py+opencode_audit.py)
  ├─ guides/autostart/README.md
  ├─ tools/pidfd-watchdog/(README+build-deploy.sh+fix-screen-off-lag.sh+pidfd-watchdog-ctl.sh+pidfd-watchdog.c+pidfd-watchdog.json+pidfd-watchdog.service)
  ├─ skills/gui-vision-agent/(README+SKILL.md+LICENSE+capture.py+clear_desktop.py+gui_agent.py+gui_agent_logged.py+examples/sample_run.md)
  └─ plugins/tm-plugins/(README+battery-current/BatteryCurrentPlugin.dll 820643B)
```

### 3.2 关键入口 URL

| 入口 | URL | 状态 |
|---|---|---|
| 门户主页 | https://down2.top/ | ✅ |
| 音频可视化(参赛) | https://down2.top/music_visualization/ | ✅ 71313B,红线不可动 |
| 工具库 | https://down2.top/tools/ | ✅ 链接已修复 |
| 外部链接 | https://down2.top/links/ | ✅ |
| 404 页 | 任意不存在路径 | ✅ 状态码404+新内容 |

### 3.3 同步链路(tools 仓 → pages 仓)

```
tools 仓 push(main 的 public-sync.json / sync-public.py / 各 OS-* 目录)
  → .github/workflows/sync-public.yml
  → python3 sync-public.py
  → 按 public-sync.json 的 files/removed_files/tools 段同步 pages 仓
  → 写入 data/tools.json
  → 链接体检(全部 GET 200,否则 exit 1)
```

- 成功样本:run `34318214997`(head_sha `4121203`)
- 失败样本(已弃用):run `34317809587`(YAML 内嵌脚本版,jobs 为空)
- 第一次失败原因:脚本引用 `PAGES_PAT` 而 env 是 `PAGES_TOKEN`,`set -u` 报 unbound → 已修复

---

## 四、已完成工作(时间线)

1. **门户重构上线**:废弃文件浏览器;上传新 `index.html`(三卡片)、`tools/index.html`、`links/index.html`、`data/links.json`、`data/tools.json`;`build.yml` 简化为纯部署。
2. **tools 仓私有化 + 自动同步**:新建 `.github/workflows/sync-public.yml` + `public-sync.json`,复用 secret `PAGES_TOKEN`;tools 转私有(PATCH private=true),旧 raw 链接 404 已验证。
3. **断链修复**:
   - `tools/index.html` 加 `abs()` 函数,docs/files 一律转站点根绝对路径
   - `public-sync.json` 补 `base_url` 字段,把所有被 README/脚本引用的依赖文件纳入 `files` 映射(pidfd-watchdog.c、gui-vision-agent 全套、BatteryCurrentPlugin.dll 等)
   - 同步时自动重写:`{{PUBLIC}}`→base_url;tools raw URL→`https://down2.top/tools/`;tools.git→pages.git;Markdown 相对链接按 src2dst 映射补全为站点绝对 URL
4. **workflow 重构为脚本版**:YAML 内嵌脚本两次失败(jobs 为空),抽出 `sync-public.py`(纯标准库 urllib,文本按扩展名/文件名判别走 rewrite,二进制原样),workflow 只剩 `python3 sync-public.py` 一行。
5. **同步结果验证**:gui-vision README 的 `[SKILL.md](https://down2.top/tools/skills/gui-vision-agent/SKILL.md)`、`[LICENSE](...)` 重写正确;23 个文件全部 PUT + 链接体检通过。
6. **404 页重设计**:渐变 404 大数字 + 飘浮动效 + 12 秒倒计时自动跳首页 + 四个导航按钮 + 网格底纹,移动端适配,状态码 404。
7. **itab 链接**:`data/links.json` 改为 `https://go.itab.link/`。
8. **全量验证**:12 个同步文件 200、文档链接点击正常、404 渲染、itab 跳转、390px 移动端布局正常。

---

## 五、"优雅引用机制"(已落地,核心技术资产)

用户痛点:仓库互相依赖的跳转链接,目录重构后失效、硬编码不行。解决方案四层:

1. **页面数据驱动 + 站点根绝对路径**:工具库/外部页不写相对路径,链接来自 `data/tools.json`,渲染时统一转 `/tools/...` 绝对路径。
2. **文档内链接同步时自动重写(路径字典)**:`sync-public.py` 以 `files[]` 的 src→dst 映射为路径字典,同步时自动重写 `{{PUBLIC}}`、旧 tools raw URL、README 相对链接。
3. **脚本依赖自包含 + 清单完备**:脚本用 `SCRIPT_DIR` 跟随自身位置;依赖文件全部进同步清单、与脚本同目录放置。
4. **CI 体检防回归**:同步后自动校验所有公开引用真实存在于 pages 仓,404 即 workflow 标红。

> 以后目录重构:只需改 `public-sync.json` 的 `dst` 映射并 push,链接自动跟随;新增工具加 `files` + `tools` 条目即可。

---

## 六、当前存在的问题 / 待修复

| # | 问题 | 影响 |
|---|---|---|
| 1 | `tools` 顶层目录名失真:6 个组件实质是 4 种交付物(规范/工具/插件/技能包)+1 篇方案,都叫"tools" | 分类不清晰,用户已要求重构 |
| 2 | 主页 hero 文案仍是"个人工具与作品集",用户要求改"个人门户" | 文案不符 |
| 3 | 主页缺社交账号区(GitHub + Bilibili 主页,logo+用户名) | 用户明确要求 |
| 4 | links 页布局是简单列表,用户要求改为卡片按钮块(左上角图标+下方简介+箭头跳转),顶部文案"站在巨人的肩膀上,避免重复造轮子" | 布局不符 |
| 5 | 全站 emoji 图标不足,用户喜欢参考图中左侧 emoji 小图标形式,要求尽可能多出现 | 阅读体验 |
| 6 | `old/a.html`(WebRTC 局域网互传)性能差,用户要求保留并优化;用户追问 web 端局域网互传最高速率技术栈 + Linux CLI 与浏览器双向互传方案 | 待技术调研后优化 |
| 7 | 根 `README.md` 为空 | 缺站点导览 |
| 8 | `data/tools.json` 命名随分类重构应改 `data/catalog.json` | 命名 |

---

## 七、未完成任务清单(按阶段编排)

### 阶段 0:前置(可并行)
- [ ] **查看两张参考图**:`ref-mobile.png`(1272x2800 移动端布局)、`ref-tree.png`(目录树+emoji 布局),提取设计要点
- [ ] **技术调研**:web 端局域网互传最高速率技术栈(WebRTC vs HTTP/QUIC/WebTransport)、Linux CLI 与浏览器双向互传方案、是否只能 GUI 开 FTP、双向跨平台+浏览器+终端都支持的形式

### 阶段 1:设计(依赖阶段0)
- [ ] 分类迁移映射表(旧路径 → 新路径)

### 阶段 2:构建(部分可并行)
- [ ] **A. 分类重构**(用户已拍板:①类型为主 ②工具库页改名 /library/ ③old/a.html 保留并优化)
  - 新顶层:`rules/` `tools/` `skills/` `plugins/` `guides/` + `music_visualization/`(URL 固定不迁移)+ `links/` + `data/`
  - 映射:`keep-my-commit-clean`→rules/;`opencode-session-viewer`+`pidfd-watchdog`→tools/;`gui-vision-agent`→skills/;`battery-current`→plugins/;`autostart`→guides/
  - tools 私有仓移文件 + `public-sync.json` dst 映射更新 + `sync-public.py` 适配(tools.json→catalog.json,tools 数组→items)
  - 触发同步
- [ ] **B. 资源库页 /library/**:按类型分区展示,平台变标签,emoji 图标丰富,替代 /tools/ 页
- [ ] **C. 主页升级**:hero 改"个人门户";社交账号区(GitHub+Bilibili logo+用户名);emoji 丰富化
- [ ] **D. links 页升级**:顶部"站在巨人的肩膀上,避免重复造轮子";卡片按钮块(左上角图标+下方简介+箭头跳转)

### 阶段 3:验证(依赖阶段2)
- [ ] 全链接体检(旧 URL 404 引导 + 新 URL 200)
- [ ] 浏览器双端验证(桌面 + 390px 移动端)
- [ ] 音频可视化链接仍可访问(红线)

### 阶段 4:收尾(串行)
- [ ] 基于技术调研结论优化 `old/a.html` 并纳入新分类(可能移到 tools/)
- [ ] 根 `README.md` 写站点导览
- [ ] 清理临时文件
- [ ] 最终交付

### 依赖关系
- 阶段0 → 阶段1 → 阶段2(A/B/C/D 可并行开发,但都改 pages 仓,上传时合并)
- 阶段2 → 阶段3 → 阶段4
- `old/a.html` 优化(阶段4)依赖阶段0的技术调研结论

---

## 八、本地制品路径(主项目目录)

主目录:`C:\Users\nm\Doubao\chats\2026-09-04\new-chat-1\`

| 路径 | 内容 |
|---|---|
| `pages_rework/index.html` | 门户主页(本地参考,已上传) |
| `pages_rework/tools/index.html` | 工具库页(abs 绝对路径版,已上传) |
| `pages_rework/links/index.html` | 外部链接页(已上传) |
| `pages_rework/data/links.json` | itab 已改 go.itab.link(已上传) |
| `pages_rework/data/tools.json` | 本地参考(线上由 sync 生成覆盖) |
| `pages_rework/build.yml` | 简化部署 workflow(已上传) |
| `pages_rework/404.html` | 新 404 页(已上传) |
| `tools_rework/public-sync.json` | 同步配置(含 base_url、files 23 项、removed_files、tools 元数据;已上传 tools 仓) |
| `tools_rework/sync-public.py` | 同步+重写+体检脚本(PAGES_TOKEN env;已上传 tools 仓) |
| `tools_rework/sync-public.yml` | 简化 workflow(一行 python3 调用;已上传 tools 仓) |
| `music-visualizer.html` | 参赛版可视化源码(71313B,未改动) |
| `ref-mobile.png` | 用户参考图1(移动端布局,1272x2800) |
| `ref-tree.png` | 用户参考图2(目录树+emoji 布局) |

---

## 九、用户偏好(硬约束)

| 维度 | 偏好 |
|---|---|
| 语言 | 中文交流 |
| 视觉风格 | GitHub 暗黑风(`--bg:#0d1117`, `--accent:#58a6ff`, `--accent2:#3fb950`) |
| 图标 | **喜欢 emoji 小图标**,要求门户网页尽可能多出现,左侧图标形式 |
| 响应式 | 同时适配桌面端和移动端(390px 验证过) |
| 红线 | 音频可视化链接 `https://down2.top/music_visualization/` **始终可访问**(参赛作品),不可改动/迁移 |
| 自动化 | 不想要手动拷贝 tools 内容,要 workflow 自动同步且"支持可配置和随时增删" |
| 链接治理 | 不接受硬编码,要目录重构后链接仍正确的优雅机制 |
| 提交规范 | tools 仓有 `keep-my-commit-clean` 规范:单模块+完整功能+可编译+有意义;commit 信息按主题合并(用户曾要求把音频可视化+workflow 相关 commit 各合并为一笔) |
| 执行模式 | 用户选择"完全访问",命令行直接执行,无需请求确认 |

---

## 十、交接注意事项

1. **PAT 安全**:本公开版已移除 PAT;接手 agent 请从私密交接文档获取完整 PAT。不要把 PAT 写入任何会公开的文件(如 pages 仓的 HTML/JS)。
2. **不要动音频可视化**:`music_visualization/index.html` 是 71313B 参赛版,任何重构都不得迁移/修改该路径。
3. **同步是单向的**:tools 仓(私有)→ pages 仓(公开)。改公开内容应改 tools 仓源文件 + 触发同步,不要直接改 pages 仓的 tools/ 内容(会被下次同步覆盖)。页面文件(index.html/404.html/links/index.html 等)直接改 pages 仓。
4. **分类重构会改 URL**:旧 `/tools/...` 链接会 404,靠新 404 页引导;README 内部相对链接由重写机制自动跟随。重构后必须跑全链接体检。
5. **workflow 失败排查**:YAML 内嵌脚本曾因 jobs 为空失败;现在是脚本版(`sync-public.py`),失败看 run 日志。`PAGES_TOKEN` 是唯一 secret,不要改名。
6. **浏览器验证**:用 `computer_use_tool`(plane=`bu`,import `seed_browser_use as bu`);移动端用 `bu.cdp("Emulation.setDeviceMetricsOverride", width=390, ..., mobile=True)`(不是 `bu.set_viewport`)。
7. **用户上传的 `ref-extra` 文件**是豆包开学季活动页文本,与本项目无关,忽略。
8. **未决的技术调研**(web 端局域网互传最佳方案)是 `old/a.html` 优化的前置,需先搜索调研再动手。

---

## 附录:快速操作速查

```bash
# 查看 pages 仓完整树
curl -H "Authorization: token <pat>" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/teecatt/teecatt.github.io/git/trees/master?recursive=1

# 查看 tools 仓最近 workflow runs
curl -H "Authorization: token <pat>" \
  https://api.github.com/repos/teecatt/tools/actions/runs?per_page=5

# 手动触发同步(tools 仓)
curl -X POST -H "Authorization: token <pat>" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/teecatt/tools/actions/workflows/sync-public.yml/dispatches \
  -d '{"ref":"main"}'

# 上传文件到 pages 仓(PUT /contents)
# body: {"message":"...","content":"<base64>","sha":"<现有文件sha,更新时必填>"}
```

---

*文档结束。接手 agent 可从"七、未完成任务清单"的阶段0开始。*
