# Keep My Commit Clean

Git 提交规范：每个提交 = 单个模块 + 一项完整功能。

## 提交原则

### 核心规则

1. **单模块**: 一个提交只涉及一个模块
2. **完整功能**: 一个提交包含该功能的所有代码、配置、文档
3. **可编译**: 每个提交后代码应能正常编译运行
4. **有意义**: 提交消息描述"做了什么"和"为什么"

### 好的提交

```
Add pidfd-watchdog: event-driven process watchdog

- pidfd + epoll architecture
- JSON config management
- Log rotation with zstd compression
- Exit reason tracking
- systemd service file
- Build/deploy pipeline
```

这个提交包含了 watchdog 模块的完整功能，包括源码、配置、部署脚本、文档。

### 坏的提交

```
Add watchdog.c                  # 只有源码，没有配置和部署
Update config.json              # 碎片化更新
Fix typo in README              # 可以合并到功能提交
Add build script                # 应该和主程序一起提交
```

## 提交格式

```
<type> <module>: <中文描述> | <English description>

- <要点1>
- <要点2>
```

### 语言要求

**必须使用中英文双语描述：**
- **标题行**：中文在前，英文在后，用 ` | ` 分隔（GitHub 列表只能看到第一行）
- **要点**：英文，列出关键改动

### 类型

| 类型 | 用途 |
|------|------|
| `Add` | 新增模块或大功能 |
| `Update` | 更新现有功能（行为变化） |
| `Fix` | 修复 bug |
| `Refactor` | 重构（不改变行为） |
| `Docs` | 仅文档更新 |

### 示例

```
Add sss: OpenCode 会话历史查看器 | opencode session history viewer

- View session history with color-coded output
- Enter session by index
- SQLite database integration
- Bash function with tab completion
```

```
Update watchdog: 改进退出原因检测 | improve exit reason detection

- Add Android init log parsing
- Add OOM killer detection
- Add cgroup kill detection
- Add zombie process state detection
```

```
Reorganize repository: 按平台重组目录结构 | split tools by platform

- Create android/, linux/, windows/ directories
- Move platform-specific tools to corresponding directories
- Keep cross-platform tools at root level
- Update root README.md with new structure
```

## 历史清理指南

### 何时清理

- 提交历史过于琐碎（如：Add file1, Add file2, Fix file1）
- 同一功能的代码分散在多个提交
- 存在无意义的提交（如：Update README, Fix typo）

### 如何清理

**步骤 1: 分析提交历史**

```bash
git log --oneline -20
```

**步骤 2: 识别可合并的提交**

找出属于同一模块、同一功能的提交序列。

**步骤 3: 使用交互式 rebase**

```bash
git rebase -i HEAD~N
```

在编辑器中：
- `pick`: 保留该提交
- `squash` 或 `s`: 合并到前一个提交
- `reword` 或 `r`: 修改提交消息

**步骤 4: 编辑合并后的提交消息**

按照提交格式重写消息，描述完整的功能。

**步骤 5: 验证**

```bash
git log --oneline
# 确认提交数量和消息符合预期
```

**步骤 6: 推送**

```bash
git push --force-with-lease origin main
```

### 清理示例

**清理前（12 个琐碎提交）：**
```
244b878 Add comprehensive documentation for all modules
24f04f6 Improve exit reason detection with Android init logs
340f860 Improve exit reason detection with system logs
9ec168d Add exit reason logging and systemd service
99266ad Add instance detection: kill old watchdog on start
ab2b87b Add startup banner with config info
8d2b4a4 Update build-deploy.sh: remove clone, add docs
1a6819e Rename build.sh to build-deploy.sh with full pipeline
10d4f5d Add pidfd-watchdog: event-driven process watchdog
87dc19e Add autostart: VM autostart exploration (WIP)
82d0c5e Add sss: opencode session history viewer
```

**清理后（4 个干净提交）：**
```
Add sss: opencode session history viewer
Add autostart: VM autostart exploration (WIP)
Add pidfd-watchdog: event-driven process watchdog
Docs: comprehensive documentation and git workflow
```

**分析过程：**

1. `82d0c5e` 是 sss 模块的完整提交，保留
2. `87dc19e` 是 autostart 模块的完整提交，保留
3. `10d4f5d` 到 `24f04f6` 都是 watchdog 模块的增量更新，合并为一个提交
4. `244b878` 是文档更新，可以保留或合并

## 分支策略

```
main (稳定)
├── feature/watchdog (新功能)
├── feature/sss (新功能)
└── fix/zombie-bug (bug 修复)
```

### 工作流程

1. 从 main 创建功能分支
2. 在功能分支上开发
3. 完成后合并回 main
4. 删除功能分支

## 注意事项

1. **不要提交临时文件**: 使用 `.gitignore` 排除
2. **不要提交敏感信息**: 密码、密钥、token
3. **不要提交编译产物**: .o 文件、二进制文件
4. **提交前检查**: 代码是否能编译？功能是否正常？
5. **提交消息清晰**: 描述做了什么，而不是怎么做的

## 相关资源

- [Conventional Commits](https://www.conventionalcommits.org/)
- [Git Rebase](https://git-scm.com/docs/git-rebase)
- [How to Write a Git Commit Message](https://cbea.ms/git-commit/)
