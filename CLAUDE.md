# CLAUDE.md — Ensemble

> 多 Agent 协作的设计模式与 Workflow 脚手架

## 项目概述

Ensemble 是一套项目无关的多 Agent 协作 SOP 和模式库，适用于 Claude Code Workflow 编排场景。

**核心价值**：把"多 Agent 怎么协作"这个每次都要从零推导的问题，变成可复用的模式模板。

## 执行约定

- 所有 Workflow 脚本必须从 `export const meta = {...}` 开始
- Schema 定义使用 JSON Schema Draft 2020-12
- 并行 agent 数量上限由 `min(16, cpu_cores - 2)` 控制
- 不使用 `Date.now()` / `Math.random()` / 无参 `new Date()` — 会破坏 resume
- 跨代理结果传递必须通过 Schema 验证，不允许隐式字符串解析

## Schema 契约规则

```javascript
// ✅ 正确：Schema 验证返回
schema: FINDINGS_SCHEMA  // agent() 返回结构化对象

// ❌ 错误：依赖解析 agent 原始文本
const result = await agent('...')  // 返回原始文本，需二次解析
```

## Phase 命名规范

- 与 `meta.phases` 完全一致
- 大写 + 动词性：`['Scan', 'Verify', 'Synthesize']`
- 每个 phase 结束时应有 `log('N 项完成')` 确认

## 反模式（禁止）

1. **嵌套 Workflow** — workflow() 不可嵌套，违反则抛出
2. **裸字符串跨代理传递** — 必须经 Schema 包装
3. **同步 barrier 滥用** — 明明可以用 pipeline() 偏偏用 parallel 再等
4. **不设上限的 loop** — loop-until-dry 必须有 dry counter
