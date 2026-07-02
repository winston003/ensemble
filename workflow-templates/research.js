// research.js — 深度调研工作流
// 模式: hybrid (fan-out + pipeline + barrier)
// 适用: 未知领域的全面调研、多源交叉验证

export const meta = {
  name: 'research',
  description: '深度调研：并行探索 → 去重汇总 → 逐项深挖 → 合成报告',
  phases: ['Explore', 'Dedup', 'DeepDive', 'Synthesize'],
}

/**
 * 使用方式：
 *   Workflow({ scriptPath: '/path/to/research.js', args: { query: '调研主题', dimensions: 3 } })
 *
 * dimensions: 并行探索的角度数量（默认 3）
 * dedupeKey:  去重的唯一标识字段（默认 'source'）
 */

// --- Schema 定义 ---
const SOURCE_SCHEMA = {
  type: 'object',
  properties: {
    source: { type: 'string' },
    url: { type: 'string' },
    claim: { type: 'string' },
    evidence: { type: 'string' },
  },
  required: ['source', 'claim'],
  additionalProperties: true,
}

const EXPLORE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    sources: { type: 'array', items: SOURCE_SCHEMA },
    gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['sources'],
  additionalProperties: true,
}

const DEEPDIVE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    topic: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    verified: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['topic', 'findings', 'verified'],
  additionalProperties: true,
}

// --- 辅助函数 ---
function dedupeByKey(items, keyFn) {
  const seen = new Set()
  return items.filter(item => {
    const k = keyFn(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// --- Workflow Script ---
export default async function ({ args }) {
  const query = args?.query ?? 'unknown topic'
  const dimensions = args?.dimensions ?? 3

  log(`开始调研: ${query}（${dimensions} 个维度）`)

  // Phase 1: fan-out 并行探索
  phase('Explore')
  const exploreAgents = [
    '搜索核心概念定义与历史',
    '搜索最新行业动态与趋势',
    '搜索技术实现与架构方案',
    '搜索典型用例与最佳实践',
    '搜索已知问题与局限',
  ].slice(0, dimensions)

  const rawResults = (await parallel(exploreAgents.map(prompt => () =>
    agent(`调研主题: ${query}。任务: ${prompt}`, {schema: EXPLORE_RESULT_SCHEMA})
  ))).filter(Boolean)

  log(`探索完成: ${rawResults.length} 个维度，合并去重`)

  // Barrier: 汇总所有 sources
  const allSources = rawResults.flatMap(r => r.sources ?? [])
  const allGaps = rawResults.flatMap(r => r.gaps ?? []).filter(Boolean)

  // Phase 2: Dedup
  phase('Dedup')
  const dedupedSources = dedupeByKey(allSources, s => s.source ?? s.url ?? JSON.stringify(s))
  const uniqueGaps = [...new Set(allGaps)]

  log(`去重完成: ${dedupedSources.length} 个独立来源，${uniqueGaps.length} 个待深挖缺口`)

  if (dedupedSources.length === 0) {
    return { query, status: 'no_data', gaps: uniqueGaps }
  }

  // Phase 3: Pipeline 深挖每个来源
  phase('DeepDive')
  const deepDived = await pipeline(
    dedupedSources,
    source => agent(
      `对以下来源进行深度分析: ${source.claim}\n来源: ${source.source}\n证据: ${source.evidence ?? '无'}`,
      {schema: DEEPDIVE_RESULT_SCHEMA}
    ),
    prev => agent(
      `验证以下发现的真实性: ${prev.findings?.join(' | ') ?? 'N/A'}`,
      {schema: DEEPDIVE_RESULT_SCHEMA}
    )
  )

  const verified = deepDived.filter(Boolean).filter(r => r.verified)
  log(`深挖完成: ${verified.length}/${deepDived.length} 项通过验证`)

  // Phase 4: 合成报告
  phase('Synthesize')
  const report = {
    query,
    summary: `共调研 ${dedupedSources.length} 个来源，${verified.length} 项经独立验证`,
    verifiedFindings: verified.map(v => ({
      topic: v.topic,
      findings: v.findings,
      confidence: v.confidence ?? 0.5,
    })),
    gaps: uniqueGaps,
    timestamp: new Date().toISOString(),
  }

  return report
}
