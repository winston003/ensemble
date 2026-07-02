# 核心协作模式

## 模式总览

| 模式 | 何时用 | 何时换 |
|------|--------|--------|
| **fan-out** | 独立调查、搜索、跨多路径探索 | 结果需要相互参照时 |
| **pipeline** | 严格顺序依赖（上一阶段输出是下一阶段输入） | 阶段间无依赖时 |
| **judge-panel** | 关键结论需要对抗性验证（安全、架构、bug） | 低风险探索性任务 |
| **loop-until-dry** | 规模未知（bug 列表、issue 发现、边缘 case） | 规模已知且固定时 |
| **hybrid** | 复合场景（调研+验证+实现+审查） | 单一模式可覆盖时 |

---

## fan-out（并行发散）

**特征**：N 个 agent 各自独立工作，无中间同步点，全完成后汇总。

```
[Agent A] ─┐
[Agent B] ─┼─→ [合并结果]
[Agent C] ─┘
```

**适用**：Explore 搜索、文件扫描、多视角独立调查。

**脚本结构**：
```javascript
export const meta = { name: 'fan-out', phases: ['Explore', 'Merge'] }

phase('Explore')
const results = await parallel(FINDERS.map(f => () => agent(f.prompt, {schema: FINDINGS_SCHEMA})))

phase('Merge')
const merged = results.filter(Boolean).flatMap(r => r.findings)
return { total: merged.length, findings: dedupe(merged) }
```

**决策要点**：
- 各 agent 任务是否真正独立？（有依赖就别用）
- 是否需要 `isolation: 'worktree'` 防止文件冲突？
- 汇总时如何去重？（dedupe key 是什么？）

---

## pipeline（流水线）

**特征**：每个 item 独立经过所有阶段，无跨 item 同步，壁障在单个 item 内部。

```
Item A: [S1] → [S2] → [S3]
Item B: [S1] → [S2] → [S3]   （S1 和 S3 之间无等待）
Item C: [S1] → [S2] → [S3]
```

**适用**：批量转换、批量审查、每个 item 独立走完全流程。

**脚本结构**：
```javascript
export const meta = { name: 'pipeline', phases: ['Transform', 'Validate', 'Write'] }

const items = ['a.ts', 'b.ts', 'c.ts']
const results = await pipeline(
  items,
  item => agent(`Transform ${item}`, {schema: TRANSFORM_SCHEMA}),
  prev => agent(`Validate output for ${prev.originalItem}`, {schema: VALIDATE_SCHEMA}),
  prev => agent(`Write ${prev.originalItem}`, {schema: WRITE_SCHEMA})
)
```

**决策要点**：
- item 之间是否需要横向比较？（需要 → 考虑 hybrid 加 barrier）
- 某阶段失败是否跳过该 item？（是 → 不 catch，让其 null）
- 顺序是否重要？（是 → 用 for...of 替代 pipeline）

---

## judge-panel（评审团）

**特征**：一个结论由 N 个独立 agent 从不同角度质疑，结论存活条件：多数认为真实。

```
结论 ─→ [质疑者A] ─┐
     ─→ [质疑者B] ─┼─→ 存活 ≥ 2/3
     ─→ [质疑者C] ─┘
```

**适用**：安全漏洞确认、架构决策、关键 bug 是否真实。

**脚本结构**：
```javascript
export const meta = { name: 'judge-panel', phases: ['Find', 'Judge', 'Confirm'] }

phase('Find')
const findings = await agent('Find potential issues', {schema: ISSUES_SCHEMA})

phase('Judge')
const judged = await parallel(findings.issues.map(issue => () =>
  parallel([
    () => agent(`Correctness lens: ${issue}`, {schema: VERDICT_SCHEMA}),
    () => agent(`Security lens: ${issue}`, {schema: VERDICT_SCHEMA}),
    () => agent(`Perf lens: ${issue}`, {schema: VERDICT_SCHEMA}),
  ]).then(votes => ({ issue, real: votes.filter(Boolean).filter(v => v.real).length >= 2 }))
))

phase('Confirm')
const confirmed = judged.filter(v => v.real)
return { confirmed }
```

**决策要点**：
- 几个 lens 足够？（安全类 ≥ 3，业务类 ≥ 2）
- 阈值多少合理？（高风险 → 全票，低风险 → 过半数）
- 质疑 prompt 是否足够对抗？（必须能 refute，不只是 re-describe）

---

## loop-until-dry（穷尽搜索）

**特征**：迭代发现直到连续 K 轮无新发现。

```
Round 1: [Finder] ─→ findings₁
Round 2: [Finder] ─→ findings₂（对比 findings₁ 去重）
...
Round N: [Finder] ─→ []（连续 dry=2 → 退出）
```

**适用**：未知规模的 bug 列表、issue 发现、边缘 case 枚举。

**脚本结构**：
```javascript
export const meta = { name: 'loop-until-dry', phases: ['Find', 'Dedup'] }

const seen = new Set()
const confirmed = []
let dry = 0

while (dry < 2) {
  const found = (await parallel(FINDERS.map(f => () => agent(f.prompt, {schema: BUGS_SCHEMA}))))
    .filter(Boolean).flatMap(r => r.bugs)

  const fresh = found.filter(b => !seen.has(key(b)))
  if (!fresh.length) { dry++; continue }

  dry = 0
  fresh.forEach(b => seen.add(key(b)))
  const verified = await parallel(fresh.map(b => () => agent(`Verify: ${b}`, {schema: VERDICT})))
  confirmed.push(...verified.filter(Boolean).filter(v => v.real).map(v => v.bug))
}

return { confirmed, totalFound: seen.size }
```

**决策要点**：
- key() 函数如何定义唯一性？（文件+行号？描述相似度？）
- dry 阈值多少？（资源受限 → 2，穷尽要求高 → 3~5）
- 是否需要 budget 保护？（`while (budget.total && budget.remaining() > 50_000)`）

---

## hybrid（混合编排）

**特征**：pipeline + fan-out + barrier 的组合，典型场景需要先横向探索再纵向串联。

```
Phase 1 [Explore]:   [A] [B] [C]        （并行，3 个独立调查方向）
Phase 2 [Barrier]:   汇总 → 发现范围
Phase 3 [Pipeline]:  每项 → 验证 → 修复 （每项独立走完全流程）
Phase 4 [Barrier]:   最终合并
```

**典型模板**：
```javascript
export const meta = { name: 'hybrid', phases: ['Explore', 'Dedup', 'Process', 'Finalize'] }

// Phase 1-2: fan-out + barrier
const allFindings = (await parallel(FINDERS.map(...))).filter(Boolean).flatMap(...)
const deduped = dedupeByKey(allFindings, f => `${f.file}:${f.line}`)

// Phase 3: pipeline each deduped item
const processed = await pipeline(deduped,
  item => agent(`Investigate ${item}`, {schema: INV_SCHEMA}),
  prev => agent(`Verify ${prev.originalItem}`, {schema: VERIFY_SCHEMA}),
  prev => agent(`Fix ${prev.originalItem}`, {schema: FIX_SCHEMA})
)

// Phase 4: final merge
return { processed: processed.filter(Boolean) }
```

**决策要点**：
- 哪个 phase 需要 barrier？（必须全部完成才能进入下一阶段）
- barrier 的汇总逻辑是什么？（concat？merge？pick winners？）
- 哪个 phase 是纯 pipeline？（无需跨 item 比较）
