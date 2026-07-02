# Agent 协议与约定

## 目录

- [Schema 契约](#schema-契约)
- [结果传递约定](#结果传递约定)

---

## Schema 契约

### 核心原则

1. **Schema 是代理间的「宪法」** — 所有数据交换必须经 Schema 验证
2. **Schema 先行于 Prompt** — 在写 agent prompt 之前先定义输出 Schema
3. **Schema 一致性** — 相同类型的数据在不同 agent 间使用相同的 Schema

### Schema 定义位置

```
schema/
├── schemas.js          # 共享 Schema 定义
└── README.md           # Schema 索引
```

### 命名规范

- Schema 变量：`UPPER_SNAKE_CASE_SCHEMA`
- Schema 文件：`schemas.js`
- Schema 命名：`类型_用途_SCHEMA`（如 `FINDING_SCHEMA`, `VERDICT_SCHEMA`）

### 常用 Schema 模板

```javascript
// 标准发现对象
const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    line: { type: 'integer' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    type: { type: 'string', enum: ['bug', 'security', 'perf', 'design'] },
    title: { type: 'string' },
    description: { type: 'string' },
    suggestion: { type: 'string' },
  },
  required: ['file', 'severity', 'type', 'title'],
  additionalProperties: true,
}

// 标准评审结果
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    real: { type: 'boolean' },
    reason: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['real', 'reason'],
  additionalProperties: true,
}

// 标准列表结果
const LIST_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    items: { type: 'array', items: { type: 'object' } },
    total: { type: 'integer' },
    page: { type: 'integer' },
  },
  required: ['items', 'total'],
  additionalProperties: true,
}
```

---

## 结果传递约定

### 好的做法

```javascript
// ✅ 通过 Schema 传递结果
const result = await agent('Find issues', {schema: FINDINGS_SCHEMA})
result.findings.forEach(f => process(f))

// ✅ Pipeline 中显式传递 originalItem
const processed = await pipeline(items,
  item => agent(`Transform ${item}`, {schema: TRANSFORM_SCHEMA}),
  prev => agent(`Verify ${prev.originalItem}`, {schema: VERIFY_SCHEMA})  // ✅ 显式引用
)
```

### 不好的做法

```javascript
// ❌ 依赖解析原始文本
const result = await agent('Find issues')  // 返回原始文本
const parsed = JSON.parse(result)  // ❌ 脆弱，容易失败

// ❌ Pipeline 中丢失上下文
prev => agent(`Verify ${prev}`)  // ❌ prev 是什么？不清晰
```

### 跨 Agent 结果合并规则

| 场景 | 合并方式 | 示例 |
|------|----------|------|
| 去重列表 | `dedupeByKey(items, k => k.file + ':' + k.line)` | findings 去重 |
| 并集 | `[...a, ...b]` | 多维度探索结果 |
| 交集 | `a.filter(x => b.some(y => y.id === x.id))` | 共同确认的问题 |
| 评分汇总 | `items.map(i => ({...i, score: avg(scores)}))` | 多视角评分 |
