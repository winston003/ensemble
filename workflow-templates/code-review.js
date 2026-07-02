// code-review.js — 代码审查工作流
// 模式: judge-panel（多维度对抗性验证）
// 适用: PR 变更审查、安全扫描、关键代码质量把关

export const meta = {
  name: 'code-review',
  description: '代码审查：发现 → 3 视角对抗验证 → 确认问题',
  phases: ['Review', 'Verify', 'Report'],
}

/**
 * 使用方式：
 *   Workflow({
 *     scriptPath: '/path/to/code-review.js',
 *     args: {
 *       diffUrl: 'https://github.com/.../pull/123',
 *       files: ['src/a.ts', 'src/b.ts'],
 *     }
 *   })
 *
 * files: 需要审查的文件列表（传入空数组则 agent 自动扫描变更）
 * verdictThreshold: 确认阈值（默认 2，即至少 2 个 lens 认为有问题）
 */

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    line: { type: 'integer' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    type: { type: 'string', enum: ['bug', 'security', 'perf', 'cleanup', 'design'] },
    title: { type: 'string' },
    description: { type: 'string' },
    suggestion: { type: 'string' },
  },
  required: ['file', 'title', 'type', 'severity'],
  additionalProperties: true,
}

const FINDINGS_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: FINDING_SCHEMA },
    summary: { type: 'string' },
  },
  required: ['findings'],
  additionalProperties: true,
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    real: { type: 'boolean' },
    reason: { type: 'string' },
    severity_override: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
  },
  required: ['real', 'reason'],
  additionalProperties: true,
}

const LENSES = [
  {
    name: 'correctness',
    prompt: (f) => `你是正确性评审员。审查以下代码问题：

文件: ${f.file}${f.line ? `:${f.line}` : ''}
问题: ${f.title}
描述: ${f.description ?? '无'}

任务：判断这个问题是否真实存在。如果代码行为与预期不符，返回 real=true。如果代码实际上是正确的，返回 real=false。

必须用 JSON 回复: { "real": boolean, "reason": "..." }`,
  },
  {
    name: 'security',
    prompt: (f) => `你是安全评审员。审查以下代码问题：

文件: ${f.file}${f.line ? `:${f.line}` : ''}
问题: ${f.title}
描述: ${f.description ?? '无'}
建议: ${f.suggestion ?? '无'}

任务：从安全角度判断这个问题是否真实威胁。包括但不限于：注入风险、数据泄露、认证绕过、敏感信息暴露。

必须用 JSON 回复: { "real": boolean, "reason": "..." }`,
  },
  {
    name: 'perf',
    prompt: (f) => `你是性能评审员。审查以下代码问题：

文件: ${f.file}${f.line ? `:${f.line}` : ''}
问题: ${f.title}
描述: ${f.description ?? '无'}

任务：从性能角度判断这个问题是否会导致性能问题。包括：N+1 查询、不必要的重复计算、大内存分配、同步阻塞。

必须用 JSON 回复: { "real": boolean, "reason": "..." }`,
  },
]

const DEFAULT_REVIEWER_PROMPT = `你是高级代码审查专家。审查以下文件的变更：

{files}

请找出以下类型的问题：
1. Bug（逻辑错误、边界条件、异常处理）
2. 安全漏洞（注入、认证、授权、敏感数据）
3. 性能问题（算法复杂度、内存效率、数据库查询）
4. 代码坏味道（重复、过长、命名不清）
5. 设计问题（抽象泄漏、紧耦合、违反SOLID）

每个问题请提供：
- severity: critical/high/medium/low
- type: bug/security/perf/cleanup/design
- title: 简短标题
- description: 详细描述
- suggestion: 修复建议

必须用 JSON 回复: { "findings": [...], "summary": "..." }`

export default async function ({ args }) {
  const files = args?.files ?? []
  const verdictThreshold = args?.verdictThreshold ?? 2
  const reviewPrompt = args?.reviewPrompt ?? DEFAULT_REVIEWER_PROMPT
  const lensCount = args?.lensCount ?? 3

  log(`代码审查开始: ${files.length} 个文件，${LENSES.length} 个验证视角`)

  // Phase 1: 发现问题
  phase('Review')
  const reviewResult = await agent(
    reviewPrompt.replace('{files}', files.length > 0 ? files.join('\n') : '（请自行扫描所有变更）'),
    {schema: FINDINGS_RESULT_SCHEMA}
  )

  const findings = reviewResult?.findings ?? []
  log(`发现 ${findings.length} 个潜在问题`)

  if (findings.length === 0) {
    return { status: 'clean', files, verdictThreshold }
  }

  // Phase 2: 对抗性验证
  phase('Verify')
  const activeLenses = LENSES.slice(0, lensCount)

  const judged = await parallel(findings.map(f => () =>
    parallel(activeLenses.map(lens => () =>
      agent(lens.prompt(f), {schema: VERDICT_SCHEMA})
    )).then(votes => {
      const realVotes = votes.filter(Boolean)
      const confirmedCount = realVotes.filter(v => v.real).length
      const severityOverride = realVotes.find(v => v.severity_override)?.severity_override
      return {
        finding: f,
        verified: confirmedCount >= verdictThreshold,
        votes: confirmedCount,
        total: realVotes.length,
        severity: severityOverride ?? f.severity,
        reasons: realVotes.map(v => `[${v.real ? '✗' : '✓'}] ${v.reason}`),
      }
    })
  ))

  const confirmed = judged.filter(r => r.verified)
  const dismissed = judged.filter(r => !r.verified)

  log(`验证完成: ${confirmed.length} 个问题确认，${dismissed.length} 个问题被否决`)

  // Phase 3: 生成报告
  phase('Report')
  return {
    status: confirmed.length > 0 ? 'issues_found' : 'clean',
    files,
    verdictThreshold,
    lensCount: activeLenses.length,
    confirmed: confirmed.map(r => ({
      ...r.finding,
      severity: r.severity,
      verified_by: `${r.votes}/${r.total}`,
      reasons: r.reasons,
    })),
    dismissed: dismissed.map(r => ({
      ...r.finding,
      reason: '被否决（不足以触发阈值）',
    })),
  }
}
