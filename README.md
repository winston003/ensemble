# Ensemble

**多 Agent 协作的设计模式与跨平台脚手架**

---

## 来由

当你第一次设计多 Agent 并行搜索、交叉验证、流水线处理同一批文件时，你会发现：

- "并行之后怎么汇总？"
- "怎么保证 A Agent 的输出能正确传给 B Agent？"
- "5 个 Lens 评审同一结论，阈值多少才算过？"
- "如果还没找完，怎么让 Agent 继续但不死循环？"

这些问题没有标准答案。每做一次新项目，就从零推导一次。

**Ensemble** 来自真实项目的踩坑积累，把"多 Agent 协作"的常见模式整理成可直接复用的 Workflow 模板和设计规范，适用于 Claude Code、Cursor、WindSurf、Coze 等任意 AI 编程平台。

---

## 解决什么问题

| 痛点 | 解决 |
|------|------|
| 每次新项目都要设计 Agent 协作逻辑 | 提供 5 种经过验证的协作模式 |
| Schema 传递靠字符串解析，容易烂掉 | Schema 契约规范，确保结构化输出 |
| 评审结论不知道该信哪个 Agent | judge-panel 模式，对抗性验证消除单点误判 |
| 不确定该并行还是串行 | 决策树帮你快速判断 |
| 担心 Agent 无限跑下去 | loop-until-dry 配合 dry counter + token budget |

---

## 核心概念

### 5 种协作模式

```
fan-out      ────  并行发散：各自独立探索，全完成后汇总
pipeline     ────  流水线：每个 item 独立走完全流程，无跨 item 等待
judge-panel  ────  评审团：N 个 Lens 对抗性验证同一结论
loop-until-dry ──  穷尽搜索：迭代发现直到连续 K 轮无新结果
hybrid       ────  混合编排：以上模式的组合
```

### Schema 契约

Agent 之间的数据交换必须经 Schema 验证，不允许裸字符串解析：

```javascript
// ✅ 正确
const result = await agent('Find bugs', {schema: BUGS_SCHEMA})
result.bugs.forEach(b => process(b))

// ❌ 脆弱
const raw = await agent('Find bugs')
const bugs = JSON.parse(raw)  // 随时可能失败
```

---

## 快速开始

### 1. 选择协作模式

参考 [patterns/README.md](patterns/README.md) 的决策树：

```
任务类型
├── 独立调查（搜索、文件扫描）         → fan-out
├── 严格顺序依赖                      → pipeline
├── 需要对抗性验证（安全、架构、bug）  → judge-panel
├── 规模未知（bug 列表、issue 发现）   → loop-until-dry
└── 复合场景                          → hybrid
```

### 2. 复制 Workflow 模板

从 [workflow-templates/](workflow-templates/) 选择最接近你场景的模板：

| 模板 | 模式 | 适用场景 |
|------|------|----------|
| `research.js` | hybrid | 深度调研、多源验证、综合报告 |
| `code-review.js` | judge-panel | PR 审查、安全扫描、关键代码质量 |
| `audit.js` | loop + panel | 代码库全面审计、穷尽发现问题 |
| `migration.js` | pipeline | 批量迁移、API 升级、框架迁移 |

```javascript
// 使用方式：在你的 AI 平台 Workflow 中引用
Workflow({
  scriptPath: '/path/to/ensemble/workflow-templates/research.js',
  args: { query: '你的调研主题', dimensions: 3 }
})

// 或直接在项目中使用模式定义
import { pipeline, judgePanel } from '@ensemble/core'
```

### 3. 自定义参数

每个模板都接受参数：

```javascript
// research.js 参数
{ query: '调研主题', dimensions: 3 }

// code-review.js 参数
{ files: ['src/a.ts'], verdictThreshold: 2, lensCount: 3 }

// audit.js 参数
{ scope: '/src', categories: ['security', 'performance'], dryRounds: 2 }

// migration.js 参数
{ scope: '/src', migrationType: 'api-upgrade', dryRun: true }
```

### 4. 从单 Agent 扩展

如果只有一个 Agent，先跑通，再按模式扩展：

```javascript
// Step 1: 单 Agent 验证
const result = await agent('...', {schema: RESULT_SCHEMA})

// Step 2: 按模式扩展（pipeline 示例）
const results = await pipeline(items,
  item => agent(`Transform ${item}`, {schema: TRANSFORM_SCHEMA}),
  prev => agent(`Verify ${prev.originalItem}`, {schema: VERIFY_SCHEMA})
)
```

---

## 项目结构

```
ensemble/
├── README.md                    # 本文件
├── CLAUDE.md                    # 项目规范（Agent 必读）
├── patterns/                    # 核心协作模式
│   ├── README.md                # 模式总览 + 决策树
│   ├── fan-out.md               # 并行发散
│   ├── pipeline.md              # 流水线
│   ├── judge-panel.md           # 评审团
│   ├── loop-until-dry.md        # 穷尽搜索
│   └── hybrid.md                # 混合编排
├── workflow-templates/          # 可复用 Workflow 模板
│   ├── research.js              # 深度调研（hybrid）
│   ├── code-review.js           # 代码审查（judge-panel）
│   ├── audit.js                 # 全面审计（loop+panel）
│   └── migration.js             # 批量迁移（pipeline）
├── agent-protocols/             # Schema 契约 + 结果传递约定
├── prompts/                     # 代理提示词模板索引
└── best-practices.md            # 最佳实践与反模式
```

---

## 设计原则

1. **Schema 先行于 Prompt** — 先定义输出格式，再写 agent 指令
2. **模式而非框架** — 不引入运行时，只提供可复制的模式
3. **Token 预算意识** — 循环必须有退出条件，配合 budget 保护
4. **对抗性验证** — 关键结论必须经独立质疑方可信赖
