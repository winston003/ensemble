// audit.js — 全面审计工作流
// 模式: loop-until-dry + judge-panel（穷尽发现问题 + 对抗性验证）
// 适用: 代码库全面审计、未知问题发现、安全弱点扫描

export const meta = {
  name: 'audit',
  description: '全面审计：穷尽发现 → 对抗验证 → 分级报告',
  phases: ['Scan', 'Dedup', 'Verify', 'Report'],
}

/**
 * 使用方式：
 *   Workflow({
 *     scriptPath: '/path/to/audit.js',
 *     args: {
 *       scope: '/path/to/codebase',
 *       categories: ['security', 'performance', 'reliability', 'maintainability'],
 *       dryRounds: 2,
 *     }
 *   })
 *
 * scope: 审计范围（路径、目录、或空表示全库）
 * categories: 要审计的维度
 * dryRounds: 连续多少轮无新发现则停止（默认 2）
 */

const BUG_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'integer' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
    type: { type: 'string' },
    description: { type: 'string' },
    evidence: { type: 'string' },
    suggestion: { type: 'string' },
  },
  required: ['category', 'severity', 'type', 'description'],
  additionalProperties: true,
}

const SCAN_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    bugs: { type: 'array', items: BUG_SCHEMA },
  },
  required: ['bugs'],
  additionalProperties: true,
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    real: { type: 'boolean' },
    reason: { type: 'string' },
    severity_override: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
  },
  required: ['real', 'reason'],
  additionalProperties: true,
}

function makeKey(bug) {
  return `${bug.category}:${bug.type}:${bug.file ?? ''}:${bug.line ?? 0}:${(bug.description ?? '').slice(0, 80)}`
}

function severityScore(s) {
  const map = { critical: 5, high: 4, medium: 3, low: 2, info: 1 }
  return map[s] ?? 0
}

const SCAN_PROMPTS = {
  security: (scope) => `安全审计：扫描以下代码范围寻找安全漏洞。

范围: ${scope || '全库'}

请重点查找：
- 注入攻击（SQL、命令、代码注入）
- 认证/授权缺陷
- 敏感数据暴露（日志、硬编码密钥、错误信息）
- 序列化安全问题
- 加密实现错误
- 依赖已知 CVE

每个问题必须包含: category=security, severity, description, evidence, suggestion`,
  performance: (scope) => `性能审计：扫描以下代码范围寻找性能问题。

范围: ${scope || '全库'}

请重点查找：
- N+1 查询问题
- 不必要的重复计算
- 大内存分配
- 同步阻塞操作
- 无上限的循环或递归
- 缺少分页/流式处理

每个问题必须包含: category=performance, severity, description, evidence, suggestion`,
  reliability: (scope) => `可靠性审计：扫描以下代码范围寻找可靠性问题。

范围: ${scope || '全库'}

请重点查找：
- 未处理的异常
- 空指针/类型错误
- 竞态条件
- 超时/重试配置缺失
- 单点故障
- 资源泄漏

每个问题必须包含: category=reliability, severity, description, evidence, suggestion`,
  maintainability: (scope) => `可维护性审计：扫描以下代码范围寻找代码坏味道。

范围: ${scope || '全库'}

请重点查找：
- 过长函数/文件
- 重复代码
- 命名不规范
- 注释缺失或误导
- 违反 SOLID 原则
- 循环依赖

每个问题必须包含: category=maintainability, severity, description, evidence, suggestion`,
}

const VERIFY_PROMPTS = {
  security: (bug) => `安全评审员验证以下问题：

${JSON.stringify(bug, null, 2)}

这个安全问题是否真实？考虑：
1. 是否确实可被利用？
2. 攻击面是否存在？
3. 现有防护是否已缓解？

回复: { "real": boolean, "reason": "...", "severity_override": "..." }`,
  performance: (bug) => `性能评审员验证以下问题：

${JSON.stringify(bug, null, 2)}

这个性能问题是否真实？考虑：
1. 是否在真实流量下会显现？
2. 问题规模是否足以影响用户？
3. 现有性能测试是否已覆盖？

回复: { "real": boolean, "reason": "...", "severity_override": "..." }`,
  reliability: (bug) => `可靠性评审员验证以下问题：

${JSON.stringify(bug, null, 2)}

这个可靠性问题是否真实？考虑：
1. 是否在特定条件下触发？
2. 是否有未覆盖的错误路径？
3. 现有测试是否已覆盖此场景？

回复: { "real": boolean, "reason": "...", "severity_override": "..." }`,
  maintainability: (bug) => `可维护性评审员验证以下问题：

${JSON.stringify(bug, null, 2)}

这个可维护性问题是否值得修复？考虑：
1. 是否确实影响开发效率？
2. 修复成本 vs 收益如何？
3. 是否已有约定俗成的例外？

回复: { "real": boolean, "reason": "...", "severity_override": "..." }`,
}

export default async function ({ args }) {
  const scope = args?.scope ?? ''
  const categories = args?.categories ?? ['security', 'performance', 'reliability']
  const dryRounds = args?.dryRounds ?? 2
  const verifyPerBug = args?.verifyPerBug ?? 2  // 每个 bug 需要几个 lens 验证

  log(`审计开始: scope=${scope || '全库'}, categories=${categories.join(',')}`)

  const seen = new Set()
  const confirmedByCategory = {}
  categories.forEach(c => { confirmedByCategory[c] = [] })

  let dry = 0
  let totalScanned = 0

  // Phase 1-2: loop-until-dry
  while (dry < dryRounds) {
    phase('Scan')

    const prompts = categories.map(cat => SCAN_PROMPTS[cat]?.(scope) ?? SCAN_PROMPTS.reliability(scope))
    const scanResults = (await parallel(prompts.map(p => () => agent(p, {schema: SCAN_RESULT_SCHEMA}))))
      .filter(Boolean)
      .flatMap(r => r.bugs ?? [])

    totalScanned += scanResults.length

    const fresh = scanResults.filter(b => !seen.has(makeKey(b)))
    if (fresh.length === 0) {
      dry++
      log(`第 ${dry} 轮无新发现（连续 ${dry}/${dryRounds}）`)
      continue
    }

    dry = 0
    fresh.forEach(b => seen.add(makeKey(b)))
    log(`新发现 ${fresh.length} 个问题（累计 ${seen.size} 个唯一问题）`)

    // Phase 3: 验证
    phase('Verify')
    const verified = await parallel(fresh.map(bug => () => {
      const lensCount = verifyPerBug
      const lensMap = {
        security: VERIFY_PROMPTS.security,
        performance: VERIFY_PROMPTS.performance,
        reliability: VERIFY_PROMPTS.reliability,
        maintainability: VERIFY_PROMPTS.maintainability,
      }
      const promptFn = lensMap[bug.category] ?? lensMap.reliability
      return parallel(
        Array.from({length: lensCount}, (_, i) => () =>
          agent(promptFn(bug), {schema: VERDICT_SCHEMA})
        )
      ).then(votes => {
        const realVotes = votes.filter(Boolean)
        const confirmed = realVotes.filter(v => v.real).length >= Math.ceil(lensCount / 2)
        const override = realVotes.find(v => v.severity_override)?.severity_override
        return {
          bug,
          confirmed,
          votes: `${confirmed ? realVotes.filter(v=>v.real).length : 0}/${realVotes.length}`,
          severity: override ?? bug.severity,
        }
      })
    }))

    const newlyConfirmed = verified.filter(v => v.confirmed)
    newlyConfirmed.forEach(v => {
      confirmedByCategory[v.bug.category]?.push(v)
    })

    phase('Dedup')
  }

  // Phase 4: 报告
  phase('Report')

  const allConfirmed = Object.entries(confirmedByCategory).flatMap(([cat, items]) => items)

  const bySeverity = {}
  allConfirmed.forEach(v => {
    const s = v.severity
    if (!bySeverity[s]) bySeverity[s] = []
    bySeverity[s].push(v)
  })

  const severityOrder = ['critical', 'high', 'medium', 'low', 'info']
  const sortedConfirmed = severityOrder.flatMap(s => (bySeverity[s] ?? []))

  return {
    scope: scope || '全库',
    categories,
    stats: {
      total_unique_discovered: seen.size,
      total_confirmed: allConfirmed.length,
      by_category: Object.fromEntries(
        categories.map(c => [c, confirmedByCategory[c]?.length ?? 0])
      ),
      by_severity: Object.fromEntries(
        severityOrder.map(s => [s, bySeverity[s]?.length ?? 0])
      ),
    },
    confirmed: sortedConfirmed,
    conclusion: allConfirmed.length === 0
      ? '未发现确认问题'
      : `共发现 ${allConfirmed.length} 个确认问题（critical: ${bySeverity.critical?.length ?? 0}）`,
  }
}
