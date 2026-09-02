# skills-grinder（sg）

AI 第一用户的 skills 市场检索 CLI 工具。搜索外部 skills 获取「思路」与「方法」，所有外部内容进入 AI 上下文前必过安全清洗管道（URL 抹除 / 注入中和 / 敏感擦除）。

**完整文档（单一事实源）见 [`cli/README.md`](cli/README.md)** —— 命令用法、数据源、安全设计、测试门禁均以该文件为准，本文件只是入口指针，不复制内容。

## 快速上手

```bash
node cli/sg.js help              # 帮助（紧凑索引；sg <命令> --help 看单命令帮助）
node cli/sg.js schema            # 机器可读命令契约（退出码/参数 schema/下一跳）
node cli/sg.js search 表格        # 搜索（默认多信号加权 + 自动去重）
node cli/sg.js web deep-research # 检索外部 web 直读源（5 站）
node cli/sg.js preview sheetagent # 安全预览（清洗后摘要）
node cli/sg.js fetch sheetagent  # 获取正文（清洗后，默认截断）
```

## 目录

| 路径 | 内容 |
|------|------|
| `cli/` | sg 主程序 + 安全清洗层 + 数据源 + 测试门禁（详见 cli/README.md） |
| `研磨报告/` | 研磨报告沉淀库（思路提取 / 方法提取 / 自迭代记录） |
