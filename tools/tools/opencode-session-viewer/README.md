# opencode-session-viewer

快速查看、进入 opencode 历史会话的命令行工具，并可将任意会话导出为交互式 HTML 审计报告。

## 安装

```bash
curl -fsSL https://down2.top/tools/tools/opencode-session-viewer/install.sh | bash
source ~/.bashrc
```

## 使用

```bash
sss              # 列出最近10个会话
sss -c 3         # 列出3个会话
sss -n 10        # 每个会话显示10次交互
sss in 0         # 进入最新会话
sss 0            # 为最新会话生成 HTML 审计报告
sss audit 1      # 为第二新的会话生成 HTML 审计报告
sss -d 2         # 删除索引为 2 的会话（交互确认）
sss -d 2 -y      # 删除索引为 2 的会话（跳过确认）
```

## HTML 审计报告

`sss <索引>` / `sss audit <索引>` 会把对应会话从 `opencode.db` 解析并导出为一份
Material 风格（mkdocs-material 视觉语言）的交互式 HTML 审计报告，采用渐进式披露：

- 默认只显示回合摘要；思考过程、工具调用、命令输出等细节逐层展开
- 思考过程默认展开；每个命令的输出默认折叠在对应命令之下
- 结构化输出（如 curl 返回的 JSON）自动渲染为可逐层展开的字段树
- 生成文件位于 `~/opencode-audit/<session_id>.html`，并自动生成 `index.html` 索引

### 脚本

| 文件 | 说明 |
|------|------|
| `sss.py` | 会话列表 / 进入会话 / 审计命令分发 |
| `opencode_audit.py` | 解析 `opencode.db` 并生成 HTML 审计报告 |

## 颜色说明

| 元素 | 颜色 |
|------|------|
| 序号+标题 | 亮黄色 |
| Session ID | 绿色 |
| 用户问题 [Q] | 浅灰色 |
| Agent回复 [A] | 暗灰色 |
| 时间戳 | 浅蓝色 |

## 依赖

- Python 3
- opencode
