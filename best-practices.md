# 最佳实践与反模式

## 目录

- [Workflow 编写](#workflow-编写)
- [Agent Prompt 设计](#agent-prompt-设计)
- [Schema 设计](#schema-设计)
- [性能优化](#性能-优化)
- [常见错误](#常见错误)

---

## Workflow 编写

### ✅ 应该

```javascript
// 1. meta 必须包含 name、description、phases
export const meta = {
  name: 'workflow-name',
  description: '简短描述（用于日志和调试）',
  phases: ['Phase1', 'Phase2', 'Phase3'],
}

// 2. 每个阶段有明确的边界
phase('Scan')
const results = await agent(...)
log(`扫描完成: ${results.length} 项`)

// 3. 错误处理显式化
const processed = await pipeline(items,
  item => agent(...).catch(e => null),  // 显式处理
)
const valid = processed.filter(Boolean)  // 显式过滤
```

### ❌ 不应该

```javascript
// 1. meta 信息不完整
export const meta = { name: 'x' }  // 缺少 description 和 phases

// 2. 无边界的连续 agent 调用
const a = await agent(...)
const b = await agent(...)  // 没有 phase 划分，难以追踪
const c = await agent(...)

// 3. 静默错误吞掉
const result = await agent(...).catch(() => null)  // 不知道发生了什么
```

---

## Agent Prompt 设计

### ✅ 应该

```javascript
// 1. 明确的 Schema 指令
`任务：分析以下代码...

必须用 JSON 回复:
{
  "findings": [...],  // array of {file, line, severity, description}
  "summary": "..."
}`  // ← Schema 指令必须明确

// 2. 明确的判断标准
`判断这个问题是否真实存在。如果：
- 代码确实有bug → real=true
- 代码实际上是正确的 → real=false
- 不确定 → real=false（保守）`

// 3. 明确的输入边界
`分析文件：${file}
行号：${line}
上下文：${context}`  // ← 明确告诉 agent 看哪里
```

### ❌ 不应该

```javascript
// 1. 模糊的 Schema 指令
`请分析代码并给出建议`  // ← 没有明确格式

// 2. 缺乏判断标准
`判断这是否是个问题`  // ← 什么标准？

// 3. 缺乏上下文
`分析这个文件`  // ← 哪个文件？
```

---

## Schema 设计

### ✅ 应该

```javascript
const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    severity: {
      type: 'string',
      enum: ['critical', 'high', 'medium', 'low'],  // ← 有限枚举
    },
    tags: { type: 'array', items: { type: 'string' } },  // ← 灵活扩展
  },
  required: ['file', 'severity'],  // ← 只要求必要字段
  additionalProperties: true,  // ← 允许额外字段
}
```

### ❌ 不应该

```javascript
// 1. 过度约束
{
  type: 'object',
  properties: { /* 50 个字段 */ },
  required: [ /* 全部 50 个 */ ],  // ← 太严格，agent 容易失败
}

// 2. 缺乏约束
{
  type: 'object',
  additionalProperties: true,  // ← 太宽松，失去 Schema 意义
  properties: { name: { type: 'string' } }
}

// 3. 类型混淆
{
  properties: {
    count: { type: 'string' },  // ← 应该是 integer
  }
}
```

---

## 性能优化

### 何时用并行

```javascript
// ✅ 独立任务 → 并行
const [resultA, resultB, resultC] = await parallel([
  () => agent('分析文件 A'),
  () => agent('分析文件 B'),
  () => agent('分析文件 C'),
])

// ✅ 同维度多实例 → 并行
const votes = await parallel(
  Array.from({length: 3}, () => () => agent('评审这个问题'))
)
```

### 何时用串行

```javascript
// ✅ 有依赖 → 串行
const verified = await pipeline(items,
  item => agent('Transform', {schema: TRANSFORM_SCHEMA}),     // 必须先转换
  prev => agent('Verify ' + prev.originalItem, {schema: ...})  // 依赖转换结果
)

// ✅ 需要顺序保证 → 串行
for (const item of orderedItems) {
  await agent(`处理 ${item}（必须按顺序）`)
}
```

### Token 预算保护

```javascript
export default async function ({ args }) {
  // ✅ 有预算限制的循环
  while (budget.total && budget.remaining() > 50_000) {
    const result = await agent('Find more...', {schema: BUGS_SCHEMA})
    bugs.push(...result.bugs)
    log(`${bugs.length} found, ${Math.round(budget.remaining()/1000)}k remaining`)
  }

  // ❌ 无上限的循环
  while (true) {  // ← 可能无限消耗 token
    const result = await agent(...)
  }
}
```

---

## 常见错误

### 1. 嵌套 Workflow（致命）

```javascript
// ❌ 致命错误：workflow() 不可嵌套
phase('Outer')
await workflow({ scriptPath: 'inner.js', ... })  // ← 抛出异常

// ✅ 正确：在同一 Workflow 内直接调用 agent
phase('Inner')
await agent(...)
```

### 2. Date.now() / Math.random() 在 Script 中

```javascript
// ❌ 致命错误：破坏 resume 功能
const ts = Date.now()
const id = Math.random()

// ✅ 正确：通过 args 传入或依赖外部生成
const ts = args.timestamp
const id = args.runId
```

### 3. Barrier 误用

```javascript
// ❌ 误用 barrier：明明可以用 pipeline
const [a, b, c] = await parallel([...])  // barrier
const results = a.concat(b).concat(c)   // 手动合并

// ✅ 正确：使用 pipeline 自动合并
const results = await pipeline(items, ...)

// ✅ 需要真正的 barrier 时：
const all = await parallel(FINDERS.map(...))
const deduped = dedupe(all.flatMap(r => r.findings))
```

### 4. 裸字符串传递

```javascript
// ❌ 脆弱：依赖解析
const raw = await agent('Find issues')
const bugs = JSON.parse(raw.match(/```json\n([\s\S]*?)\n```/)[1])

// ✅ 正确：Schema 验证
const result = await agent('Find issues', {schema: ISSUES_SCHEMA})
result.issues.forEach(...)
```

### 5. 缺乏进度追踪

```javascript
// ❌ 难以调试
const result = await agent(...)

// ✅ 清晰可见
phase('Scan')
const result = await agent(...)
log(`扫描完成: ${result.items.length} 项`)
```
