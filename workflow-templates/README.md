# Workflow 模板索引

> 项目无关的可直接复用 Workflow 脚本

## 模板列表

| 模板 | 模式 | 适用场景 |
|------|------|----------|
| `research.yaml` | hybrid | 深度调研、多源验证、综合报告 |
| `code-review.yaml` | judge-panel | 代码变更审查（bug/安全/可复用性） |
| `audit.yaml` | loop-until-dry + judge-panel | 全面审计、穷尽发现问题 |
| `migration.yaml` | pipeline | 批量迁移、顺序转换 |

## 使用方式

```javascript
// 直接复制 script 内容到 Workflow 工具的 script 字段
// 或使用 { scriptPath: '/path/to/template.js' } 引用
```

## 通用 Schema 定义

所有模板使用统一的 Schema 前缀，避免冲突：

```javascript
const COMMON_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: { $ref: '#' }
    },
    total: { type: 'integer' }
  }
}
```

具体 schema 在各模板文件中定义。
