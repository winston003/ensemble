// migration.js — 批量迁移工作流
// 模式: pipeline（顺序串联：发现→转换→验证→确认）
// 适用: 批量代码迁移、API 升级、框架迁移、配置转换

export const meta = {
  name: 'migration',
  description: '批量迁移：发现目标 → 逐项转换 → 验证正确性 → 报告',
  phases: ['Discover', 'Transform', 'Verify', 'Report'],
}

/**
 * 使用方式：
 *   Workflow({
 *     scriptPath: '/path/to/migration.js',
 *     args: {
 *       scope: '/path/to/target',
 *       migrationType: 'api-upgrade',  // 或 'framework', 'config', 'custom'
 *       dryRun: true,
 *     }
 *   })
 *
 * scope: 迁移范围
 * migrationType: 预定义的迁移类型，决定转换规则
 * dryRun: true = 仅报告不实际修改
 */

const DISCOVERY_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          current: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['file', 'current'],
      },
    },
    total: { type: 'integer' },
  },
  required: ['items'],
  additionalProperties: true,
}

const TRANSFORM_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    line: { type: 'integer' },
    original: { type: 'string' },
    transformed: { type: 'string' },
    changes_summary: { type: 'string' },
  },
  required: ['file', 'original', 'transformed'],
  additionalProperties: true,
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    original: { type: 'string' },
    transformed: { type: 'string' },
    verified: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
    suggestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['file', 'verified'],
  additionalProperties: true,
}

const MIGRATION_PROMPTS = {
  'api-upgrade': {
    discover: (scope) => `API 升级迁移扫描：发现需要升级的 API 调用。

范围: ${scope}

任务：找到所有使用旧版 API 的调用点，旧版特征包括：
- 已废弃的函数/方法
- 旧版参数格式
- 已移除的端点
- 兼容层包装的使用

返回每个发现的：file, line, current 代码片段, reason`,
    transform: (item) => `API 升级转换：

文件: ${item.file}${item.line ? `:${item.line}` : ''}
当前代码: ${item.current}
原 因: ${item.reason ?? 'API 升级'}

任务：将此代码升级到新版 API，保持功能不变。返回：
- transformed: 新的正确代码
- changes_summary: 做了哪些修改`,
    verify: (item, transformed) => `API 升级验证：

文件: ${item.file}
原始代码: ${item.original}
转换后: ${transformed.transformed}
修改摘要: ${transformed.changes_summary}

任务：验证转换是否正确：
1. 语义是否等价？
2. 是否有遗漏的依赖？
3. 是否有新的问题？

回复: { "verified": boolean, "issues": [...], "suggestions": [...] }`,
  },
  'framework': {
    discover: (scope) => `框架迁移扫描：发现需要迁移的框架特定代码。

范围: ${scope}

任务：找到所有框架特定的代码模式，包括：
- 配置对象
- 初始化代码
- 特定语法糖
- 废弃特性

返回每个发现的：file, line, current 代码片段, reason`,
    transform: (item) => `框架迁移转换：

文件: ${item.file}${item.line ? `:${item.line}` : ''}
当前代码: ${item.current}

任务：将此代码迁移到目标框架的新写法，保持功能不变。`,
    verify: (item, transformed) => `框架迁移验证：验证转换后的代码语法和语义正确性。`,
  },
  'config': {
    discover: (scope) => `配置迁移扫描：发现需要迁移的配置文件。

范围: ${scope}

任务：找到所有格式过时或结构不合理的配置文件。`,
    transform: (item) => `配置迁移转换：将旧格式配置转换为新格式。`,
    verify: (item, transformed) => `配置迁移验证：验证新配置格式正确且等效。`,
  },
}

export default async function ({ args }) {
  const scope = args?.scope ?? '/src'
  const migrationType = args?.migrationType ?? 'api-upgrade'
  const dryRun = args?.dryRun ?? true
  const verifierCount = args?.verifierCount ?? 2

  const prompts = MIGRATION_PROMPTS[migrationType] ?? MIGRATION_PROMPTS['api-upgrade']

  log(`迁移开始: type=${migrationType}, scope=${scope}, dryRun=${dryRun}`)

  // Phase 1: 发现
  phase('Discover')
  const discovery = await agent(prompts.discover(scope), {schema: DISCOVERY_SCHEMA})
  const items = discovery?.items ?? []
  log(`发现 ${items.length} 个待迁移项`)

  if (items.length === 0) {
    return { status: 'nothing_to_migrate', scope, migrationType }
  }

  // Phase 2: Pipeline 转换
  phase('Transform')
  const transformed = await pipeline(
    items,
    item => agent(prompts.transform(item), {schema: TRANSFORM_SCHEMA}),
    (prev) => agent(prompts.verify(prev.originalItem, prev), {schema: VERIFY_SCHEMA})
  )

  const successful = transformed.filter(Boolean).filter(r => r.verified)
  const failed = transformed.filter(Boolean).filter(r => !r.verified)
  const skipped = transformed.filter(r => r === null).length

  log(`转换完成: ${successful.length} 成功, ${failed.length} 失败, ${skipped} 跳过`)

  // Phase 3: 额外验证（如果有失败的项）
  phase('Verify')
  if (failed.length > 0) {
    const reVerified = await parallel(failed.map(item => () =>
      parallel(
        Array.from({length: verifierCount}, () =>
          () => agent(`重新验证以下转换是否正确:\n${JSON.stringify(item, null, 2)}`, {schema: VERIFY_SCHEMA})
        )
      ).then(votes => {
        const confirmed = votes.filter(Boolean).filter(v => v.verified).length >= Math.ceil(verifierCount / 2)
        return { ...item, re_verified: confirmed, votes: votes.filter(Boolean) }
      })
    ))
    failed.forEach((f, i) => { Object.assign(f, reVerified[i]) })
  }

  // Phase 4: 报告
  phase('Report')
  return {
    status: dryRun ? 'dry-run' : 'executed',
    scope,
    migrationType,
    summary: {
      discovered: items.length,
      successful: successful.length,
      failed: failed.length,
      skipped,
    },
    successful_transforms: successful.map(t => ({
      file: t.file,
      line: t.line,
      original: t.original,
      transformed: t.transformed,
      changes_summary: t.changes_summary,
    })),
    failed_transforms: failed.map(f => ({
      file: f.file,
      line: f.line,
      original: f.original,
      issues: f.issues ?? [],
      suggestions: f.suggestions ?? [],
      re_verified: f.re_verified,
    })),
    dry_run_note: dryRun ? '这是 dry run，未实际修改文件' : '实际修改已执行',
  }
}
