# skills-grinder CLI（sg）

AI 第一用户的 skills 市场检索工具。遇到难解问题时，搜索外部 skills 获取「思路」与「方法」——这些内容藏在他人 SKILL.md 中，联网搜索学不到。

**当前版本: 0.9.0**（单一事实源 = `sg.js` 的 `VERSION` 常量；README 声明必须与其一致，门禁强制校验）

**核心安全设计：所有外部内容在进入 AI 上下文前必过清洗管道**（URL 抹除 / 注入中和 / 敏感擦除），并包裹 `UNTRUSTED-DATA` 隔离标记，声明为数据而非指令。详见 [SECURITY.md](SECURITY.md)。

**设计约束（硬性）**：审核机制完全由「CLI 程序 + 主对话」配合完成——程序做确定性清洗，主对话做语义判断。**零外部依赖：不要求用户接入独立审核模型、不要求 API key、无任何额外配置与成本。**

## 快速开始

```bash
node sg.js help                    # 帮助（紧凑命令索引；sg <命令> --help 查看单命令帮助）
node sg.js latest --limit 10       # 最新上架
node sg.js hot --limit 10          # 最热（真实使用次数）
node sg.js search 表格              # 搜索（默认多信号加权：相关/可用/热度/新近，同名多版本自动去重保最新）
node sg.js search 表格 --rank off  # 显式退回纯相关排序
node sg.js search 文档 --rank mixed    # 多信号加权排行（--rank mixed 为默认，可省略）
node sg.js search 文档 --rank mixed --weights match=0.4,avail=0.4,usage=0.1,recency=0.1  # 自定义权重
node sg.js latest --rank mixed      # 榜单也支持加权（hot 默认热度 0.8+新近 0.2；latest 反之）
node sg.js web deep-research        # 检索外部 web 直读源（5 站，跨源去重+三级分层，默认全量拉取，缓存 6h）
node sg.js web 表格 --shallow       # --shallow 快速浅拉（首屏少量条目，适合快速尝鲜）
node sg.js web 表格 --force         # 强制刷新缓存
node sg.js preview sheetagent       # 安全预览（推荐）
node sg.js fetch sheetagent         # 获取正文（清洗后，默认截断）
node sg.js fetch sheetagent --skill excel-handler   # 只取插件内指定 skill 的正文
node sg.js fetch sheetagent --full  # 完整正文（插件全部 skills）
node sg.js fetch sheetagent --output-path out.md    # 大正文落盘，返回路径+摘要（不内联）
node sg.js sources                  # 数据源状态
node sg.js sync --url <URL>         # 爬取远程 skills 网站（marketplace.json；node 原生拉取优先，curl/powershell 回退）
node sg.js schema [命令]            # 机器可读命令契约（内省；--text 人类可读）
node sg.js report                   # 生成迭代素材包（版本/数据源统计/测试结果/覆盖盲区/与上次自动对比）
node sg.js selftest                 # 安全层自检
```

## 命令契约（v0.9.0，对齐 agent-first CLI 最佳实践）

CLI 面向 AI 第一用户，命令本身即"模型与环境之间的可验证协议"。核心约定：

- **每个子命令独立** **`--help`**（`sg <命令> --help` 或 `sg help <命令>`），只给"决策所需最小信息 + 下一跳"（USAGE / INPUT / OUTPUT / SIDE EFFECTS / EXAMPLES / NEXT）；主帮助只给紧凑命令索引，不展开全文（L0/L1 渐进披露，控制发现阶段 token）。

- **机器可读契约：`sg schema [命令]`** —— 运行时暴露命令清单、参数 schema（必填/类型/默认）、副作用、幂等性、退出码、下一跳。agent 可据此生成工具描述，无需猜字段。帮助与 schema 共用 `lib/contracts.js` 同一份数据（单一事实源，杜绝"文档与 --help 分叉"）。

- **退出码契约**（固定映射，`sg schema` 与 `sg help` 中公开，改动须同步）：

| 退出码 | 语义               | agent 默认策略         |
| --- | ---------------- | ------------------ |
| 0   | 成功               | 按 schema 解析 stdout |
| 1   | 内部/未知错误          | 上报后按次重试            |
| 2   | 用法或输入错误          | 修订参数，不盲目重试         |
| 4   | 可重试瞬时错误（网络/外部服务） | 遵守退避重试             |
| 5   | 资源不存在            | 检查名称/拼写后重试         |
| 10  | 危险操作未确认（预留）      | 显式确认               |

- **结构化错误**：人类模式错误信息含 `code / message / next_actions`（可直接复制执行的下一步），诊断进 stderr、stdout 只承载数据；`--json` 模式错误走结构化封套（`type=error / ok=false / errors[].{code,retryable,message,next_actions}`），退出码仍非零。

- **大输出落盘**：`fetch --output-path <文件>` 把清洗后正文写入文件并返回 `{path,count,bytes,truncated,sanitized}`（含 UNTRUSTED 隔离标记），避免大正文内联放大上下文。

- **查询输入加固**：搜索/检索关键词拒绝控制字符、上限 100 字——明确拒绝（退出码 2）而非静默返回空结果。

## 数据源（5 路）

| 源          | 位置                                         | 内容                                      |
| ---------- | ------------------------------------------ | --------------------------------------- |
| S1 官方市场    | `~/.workbuddy/skills-marketplace/`         | \~227 个 skill 索引                        |
| S2 插件市场×3  | `~/.workbuddy/plugins/marketplaces/<mkt>/` | 内置市场（33）/ 团队市场（29）/ 官方插件市场（206）索引       |
| S3 本地缓存×3  | `~/.workbuddy/plugins/cache/<mkt>/`        | 完整 SKILL.md 镜像 + 真实使用热度（与 S2 三市场一一对应）   |
| S4 远程同步    | `cli/data/synced/*.json`                   | `sg sync` 爬取的任意市场                       |
| S5 web 直读源 | 在线（缓存 `cli/data/web-cache/`）               | `sg web` 检索的外部 skills 目录站，5 站可用 / 9 站收录 |

**热度信号**：本地缓存 `.in_use/<pid>` 文件计数（真实会话使用痕迹）。
**新近信号**：版本内嵌 unix 时间戳 + semver 版本号比较 + 文件 mtime（三者优先级递减，保证同名多版本去重时保留最新版）。

## web 直读源（S5，v0.8.1）

本地六路源之外，接入"打开就能读到具体技能条目"的外部 skills 目录站——只接直读源（不接需登录 / 客户端渲染逆向 / 专用 CLI 的站）：

| 源             | 读取方式                       | 快速浅拉  | 全量（默认）                |
| ------------- | -------------------------- | ----- | --------------------- |
| SkillsMP      | JSON API（limit≤48，封顶 1200） | 48 条  | 1200 条                |
| ClaudeSkills  | JSON API（需浏览器 UA）          | 50 条  | \~383 条（API 暴露上限）     |
| Skills.sh     | 首页 SSR 排行榜                 | 189 条 | +2 万 URL 索引（sitemap）  |
| Skills.rest   | explore 首屏 SSR             | 12 条  | +20 万 URL 索引（sitemap） |
| SkillHub Club | 首页 SSR 卡片                  | 12 条  | 翻页 10 页（\~113 条）      |

暂不可直读（`sg sources` 会标注原因）：ClawHub（CSR）、SkillHub 腾讯（CSR）、AgentSkill.sh（503）、LobeHub（需官方 CLI `npx @lobehub/market-cli`）。

- **默认全量（v0.8.1）**：`sg web <词>` 默认拉全量（有 deep 缓存直接复用），`--shallow` 切回快速浅拉。bench 实测：浅拉候选仅 299 条、8 个查询词命中 34；全量候选 20.9 万条、命中 80——全量召回翻倍多。

- **三级分层排序（v0.8.1，bench 实测定稿）**：全量候选 99.4% 是 sitemap URL 空壳（名称即 URL 末段，天然命中词根，旧评分下空壳霸榜：搜 "pdf" Top10 有 6 个空壳、"pdf-extractor" Top10 全空壳）。按层级加权：**真描述实体×1 > 模板伪实体×0.55 > 空壳×0.2**（哈希后缀名再降 0.8）。实测 TopN 有信息率 54% → 86%，召回不损失、多源多样性最高。

- **跨源去重**：按名称归一化（小写去非字母数字）合并，同一 skill 多源命中时聚合来源标签、保留描述最长者——20 万条合流去重 <1s。

- **缓存**：拉取结果落 `cli/data/web-cache/<源>.json`（浅拉/全量分开缓存），TTL 6h；`--force` 强制刷新。

- **清洗**：命中条目的简介输出前过 sanitize 管道（URL 抹除/注入中和/敏感擦除），链接为结构化字段单独展示。

- 大数组合流使用循环 push（曾因 `push(...items)` spread 20 万条爆调用栈，已修复并有回归断言）。

## 搜索行为

- **默认多信号加权（v0.8.1）**：`sg search` 默认按 相关度/可用/热度/新近 加权融合（`--rank off` 显式退回纯相关）。bench 实测：纯相关 Top8 可用率仅 11%（搜"图片"Top8 有 7 个装不上的市场索引条目）；加权后 19% 且 Top3 全为可用条目。本地候选池信号稀疏（24 个有真实使用记录的镜像），含 avail 的权重组合间排名不敏感——默认值即为实测最优，不必微调。

- **相关性排序**：名称精确 > 名称前缀 > 名称包含 > 标签 > 简介 > 示例 > 来源。搜"文档"时「腾讯文档」这类精确命中会排最前，而非按索引顺序。

- **自动去重**：同名多版本只保留最新版（hot/latest/search/preview/fetch 一致，同一名称在任何命令下都解析到同一最新版本）。本地六源实测有 30+ 组同名多版本（如 welcomemode-code 三个版本条目），去重是刚需。

- **镜像元数据**：本地缓存镜像会解析 SKILL.md frontmatter 的 description + tags + examples，让"搜标签"也能命中。镜像条目在 preview/fetch 中显示真实简介。

## 加权排行（--rank，可选）

单信号排序有盲区（hot 只看次数、latest 只看时间）。`--rank` 把多个信号**归一化后按权重融合**，输出可解释的综合分：

```
综合分: 0.72（相关 0.3 / 可用 ✓ / 热度 1 / 新近 1）
```

- **量纲归一化**：相关度（0~~1）/ 热度（榜内 min-max）/ 新近（榜内 min-max）统一到 0~~1 才可加权，禁止直接相加（时间戳是 10 位数会吞掉其他信号）。

- **缺失兜底**：信号缺失给 0 分（索引条目 usage/新近为 0 是诚实的，不给中性分伪装）——包括**整个候选集都缺某信号**的场景（如搜到的全是索引条目，`usage` 与 `recency` 全为 0，此时分量一律为 0，不虚构"热度 0.5 / 新近 0.5"）。

- **可用性（avail）信号**：有本地镜像（能读 SKILL.md 正文、能真用）=1，纯市场索引条目=0。为什么必须有——本地候选池 489 个索引条目中仅 38 个有镜像（7.8%），纯按相关度排 Top10 平均只有 1.1 条可用。availability 是「能不能用」，relevance 是「像不像」，前者是硬约束。

- **场景默认权重**（可用 `--weights` 覆盖，权重自动归一化到总和 1；数值来自 test/bench.js 实测）：

| 场景                    | 默认权重                                              | 说明                    |
| --------------------- | ------------------------------------------------- | --------------------- |
| search `--rank mixed` | match 0.45 / avail 0.3 / usage 0.15 / recency 0.1 | 相关主导，可用破平，热度/新近微调     |
| hot `--rank mixed`    | avail 0.35 / usage 0.5 / recency 0.15             | 热度主导，可用破平（空描述内部件不再霸榜） |
| latest `--rank mixed` | avail 0.35 / recency 0.5 / usage 0.15             | 新近主导，可用破平             |

权重示例：`--weights match=0.4,usage=0.4,recency=0.2`（让真实使用量占更大权重）。

## 配套 skill

skill-search skill 的**单一事实源（SSOT）**：`~/.ai-skills/skill-search/SKILL.md`（中立目录，不归属任何 IDE/载体）。本 README **不复制** skill 文档内容——skill 的能力说明、命令用法、审核铁律一律以真源文件为准。

> **保持最新**：本 README 只维护 CLI 侧文档（命令/数据源/测试/结构）；skill 侧内容统一读真源 `~/.ai-skills/skill-search/SKILL.md`。改真源一处即可全入口同步，杜绝双份漂移——检查"skill 侧是否最新"时直接看真源文件即可。

分发入口（全部为 junction/symlink 指向真源，五路径内容一致，禁止另建副本）：

| 入口                                   | 用途             |
| ------------------------------------ | -------------- |
| `~/.ai-skills/skill-search/`         | **真源（唯一维护点）**  |
| `~/.workbuddy/skills/skill-search/`  | WorkBuddy 私有入口 |
| `~/.agents/skills/skill-search/`     | 全局互操作入口        |
| `<工作区>/.agents/skills/skill-search/` | 项目级互操作入口       |
| `<工作区>/.skills/skill-search/`        | 项目入口           |

AI 遇到难解问题时自动加载该 skill，三步流程：
`sg search <关键词>` → `sg preview <名称>` → `sg fetch <名称> [--full]`

## 迭代素材包（sg report）

自迭代场景下，报告素材（版本号、数据源统计、测试结果、覆盖盲区清单）由工具自动收集，AI 只填分析、决策与分工结论：

```bash
node sg.js report                      # 素材包输出到 stdout（markdown）
node sg.js report --to <文件.md>       # 写入文件（输出解析后的绝对路径）
node sg.js report --json               # 结构化 JSON（含 diff 字段，供脚本消费）
```

**自动 diff（v0.7.0）**：每次 report 会把统计留存到 `cli/data/.report-state.json`，下次运行自动输出"与上次对比"段（版本变化 / 六源数量增减 / 候选与 hot 候选增减 / 盲区条数增减）——"本轮市场多了什么、什么变热了"无需人肉对比，直接进报告。

> 提示：`--to` 请使用绝对路径或相对路径。Windows 上 `/tmp/xxx` 会被 Node 解析到 `C:\tmp\xxx`（与 Git Bash 的 /tmp 不同一位置）。

覆盖盲区清单单一事实源为 `lib/coverage.js`——门禁末尾 WARN 与 report 输出同一份；补了断言就从清单删除该条目（删除即宣告覆盖）。**v0.7.0 起清单为空**：sync 远程拉取已改用本地 http server 端到端断言（同步→落盘→可检索→清洗 全链路，不依赖外部网络）。

## 测试

```bash
node test/run-tests.js   # 集成测试（含边界输入回归组，用例数以输出为准）
node sg.js selftest      # 安全层自检（含注入样本）
node test/release-check.js  # 迭代质量门禁（集成测试 + 自检 + 回归断言，一票否决；断言数以 release-check 输出为准，不在此写死；末尾输出"覆盖盲区提示"，列出暂无断言的功能面）
```

门禁包含 **sync 端到端断言**（v0.7.0）：本地起 http server 服务 fixture，跑 `sg sync` 验证 同步→落盘→可检索→清洗 全链路，不依赖外部网络、可稳定复现。

## 项目结构

```
cli/
├── sg.js              # 主入口（零依赖）
├── lib/
│   ├── sanitize.js    # 安全清洗层（URL/注入/敏感 + 隔离包装）
│   ├── sources.js     # 数据源发现（S1-S4）+ 热度/新近信号
│   ├── web-sources.js # S5 web 直读源（5 源适配器 + 缓存 + 跨源去重）
│   ├── rank.js        # 多信号加权排行（归一化 + 权重融合 + clamp）
│   ├── errors.js      # 统一错误契约（退出码映射 + 结构化错误封套）
│   ├── contracts.js   # 命令契约单一事实源（帮助 --help 与 sg schema 共用）
│   └── coverage.js    # 覆盖盲区清单（单一事实源，门禁 WARN 与 sg report 共用）
├── SECURITY.md        # 恶意指令处理方案
├── test/
│   ├── run-tests.js
│   ├── release-check.js          # 迭代质量门禁（一票否决）
│   ├── fixture-remote-market.json  # 远程源测试样本（含恶意内容）
│   └── fixtures/web/             # S5 web 源解析器 fixture（自包含，不依赖网络）
└── data/
    ├── synced/       # sg sync 产物
    └── web-cache/    # sg web 缓存（浅拉/深拉分开，TTL 6h）
```

