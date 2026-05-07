# OpenClaw Agents 目录架构详解

> **文档版本**: v1.0  
> **最后更新**: 2026-05-07  
> **适用范围**: OpenClaw Agent 运行时系统核心模块

---

## 📋 目录

- [概述](#概述)
- [核心架构模块](#核心架构模块)
  - [1. Agent 执行引擎 (pi-embedded-runner/)](#1-agent-执行引擎-pi-embedded-runner)
  - [2. Agent 命令系统 (agent-command.ts, command/)](#2-agent-命令系统-agent-commandts-command)
  - [3. 子 Agent 注册表 (subagent-*.ts)](#3-子-agent-注册表-subagent-ts)
  - [4. 认证配置 (auth-profiles/)](#4-认证配置-auth-profiles)
  - [5. 沙箱系统 (sandbox/)](#5-沙箱系统-sandbox)
  - [6. 技能系统 (skills/, skills-*.ts)](#6-技能系统-skills-skills-ts)
  - [7. 模型选择与故障转移 (model-*.ts)](#7-模型选择与故障转移-model-ts)
  - [8. 系统提示词 (system-prompt.ts)](#8-系统提示词-system-promptts)
  - [9. 工具系统 (tools/, pi-tools.ts)](#9-工具系统-tools-pi-toolsts)
  - [10. Hooks 系统 (pi-hooks/)](#10-hooks-系统-pi-hooks)
- [辅助模块](#辅助模块)
- [关键特性](#关键特性)
- [数据流与交互](#数据流与交互)
- [性能优化策略](#性能优化策略)
- [安全架构](#安全架构)

---

## 概述

`src/agents/` 目录是 OpenClaw Agent 运行时系统的核心,包含了从会话管理、模型交互到工具执行的全部基础设施。该目录采用模块化设计,通过清晰的职责分离实现了高可维护性和可扩展性。

### 目录结构概览

```
src/agents/
├── pi-embedded-runner/      # Agent 执行引擎(136 个文件)
├── sandbox/                 # 沙箱隔离系统(71 个文件)
├── auth-profiles/           # 认证配置管理(59 个文件)
├── skills/                  # 技能系统(27 个文件)
├── command/                 # 命令处理(20 个文件)
├── cli-runner/              # CLI 执行器(26 个文件)
├── pi-hooks/                # 生命周期钩子(10 个文件)
├── tools/                   # 内置工具集(120 个文件)
├── schema/                  # Schema 验证(5 个文件)
├── runtime-plan/            # 运行时计划(10 个文件)
├── test-helpers/            # 测试辅助(25 个文件)
├── harness/                 # 测试框架(21 个文件)
└── *.ts                     # 顶层核心模块(~200 个文件)
```

总代码量:约 1000+ 个 TypeScript 文件,超过 1MB 的核心逻辑代码。

---

## 核心架构模块

### 1. Agent 执行引擎 (pi-embedded-runner/)

**位置**: `src/agents/pi-embedded-runner/`  
**规模**: 136 个文件,约 100KB+ 代码

#### 核心职责

嵌入式 Pi Agent 运行时的核心实现,负责与 LLM 提供商的完整交互流程。

#### 主要模块

##### 1.1 运行时核心 (run/)

**文件**: `run.ts` (100.4KB), `runs.ts` (13.1KB)

- **会话执行循环**: 处理完整的请求-响应周期
- **流式响应处理**: 支持实时文本输出和工具调用
- **错误恢复**: 自动重试、补偿执行和状态回滚
- **并发控制**: 管理多个并行会话的执行

**关键函数**:
```typescript
// 执行单个 Agent 回合
async function runEmbeddedPiAgent(params: RunParams): Promise<RunResult>

// 管理会话状态
class SessionManager {
  async initialize(sessionId: string): Promise<void>
  async executeTurn(turn: Turn): Promise<TurnResult>
}
```

##### 1.2 上下文压缩 (compact/)

**文件**: `compact.ts` (49.4KB), `compaction-hooks.ts` (9.3KB)

- **智能压缩**: 基于 token 计数和语义重要性进行上下文裁剪
- **历史归档**: 将旧消息转换为摘要以节省空间
- **钩子系统**: 允许自定义压缩策略
- **安全超时**: 防止压缩过程无限循环

**压缩策略**:
- Token 阈值触发(默认 80% 上下文窗口)
- 工具结果截断(保留关键信息)
- 消息合并(相似内容聚合)
- 优先级排序(系统提示 > 最近消息 > 工具调用)

##### 1.3 模型适配器 (model.*.ts)

**文件**: `model.ts` (28.7KB), `openai-stream-wrappers.ts`, `anthropic-family-*.ts`

- **多提供商支持**: Anthropic、OpenAI、Google、Moonshot、Minimax 等
- **流式包装器**: 统一不同提供商的 SSE/stream 格式
- **能力检测**: 自动识别模型支持的功能(工具调用、缓存等)
- **参数转换**: 标准化请求参数到各提供商的格式

**支持的提供商**:
- OpenAI (Responses API, Completions API)
- Anthropic (Messages API)
- Google (Gemini API)
- Moonshot (Kimi API)
- Minimax
- Z.AI
- OpenRouter
- AWS Bedrock
- 以及更多...

##### 1.4 工具执行 (tools/)

**文件**: `tool-result-truncation.ts` (22.9KB), `tool-schema-runtime.ts` (3.7KB)

- **Schema 验证**: 确保工具调用符合 JSON Schema 规范
- **结果截断**: 防止过大的工具输出耗尽上下文
- **重放机制**: 在压缩后重新注入必要的工具结果
- **错误分类**: 区分可重试和不可重试的错误

##### 1.5 会话管理 (session-*.ts)

**文件**: `session-manager-*.ts`, `session-truncation.ts` (9.0KB)

- **状态持久化**: 会话历史的磁盘存储和恢复
- **转储策略**: 定期保存会话快照
- **清理机制**: 自动删除过期或孤儿会话
- **指标追踪**: Token 使用量、执行时间等统计

##### 1.6 缓存优化 (cache-*.ts)

**文件**: `google-prompt-cache.ts` (12.6KB), `cache-ttl.ts` (3.4KB)

- **提示词缓存**: 利用提供商的缓存 API(Anthropic Prompt Caching、Google Context Caching)
- **TTL 管理**: 控制缓存有效期
- **失效策略**: 基于内容哈希的智能失效
- **成本优化**: 减少重复内容的 token 消耗

#### 关键特性

1. **懒加载优化**: 动态 import 减少冷启动时间至 <500ms
2. **流式处理**: 实时输出提升用户体验
3. **故障恢复**: 多层重试和降级策略
4. **性能监控**: 详细的执行指标和日志
5. **可扩展性**: 插件化的模型适配器和工具系统

---

### 2. Agent 命令系统 (agent-command.ts, command/)

**位置**: `src/agents/agent-command.ts`, `src/agents/command/`  
**规模**: 主文件 40.8KB + 20 个子模块

#### 核心职责

处理来自 CLI、网关或其他触发源的 Agent 执行请求,管理请求的生命周期。

#### 主要模块

##### 2.1 命令处理器 (agent-command.ts)

**功能**:
- **请求解析**: 从各种来源提取执行参数
- **会话路由**: 确定目标会话(新建或现有)
- **模型选择**: 根据配置选择合适的模型和提供商
- **执行调度**: 将请求提交到执行队列

**请求来源**:
- CLI 命令行 (`openclaw agent ...`)
- WebSocket 网关
- HTTP API
- 定时任务 (cron)
- 事件触发器

##### 2.2 命令子模块 (command/)

**主要文件**:
- `command-dispatch.ts`: 请求分发和路由
- `command-validation.ts`: 参数验证和规范化
- `command-queue.ts`: 并发控制和排队
- `command-context.ts`: 执行上下文构建

**处理流程**:
```
请求接收 → 参数验证 → 会话解析 → 模型选择 → 执行调度 → 结果返回
```

##### 2.3 会话管理

**功能**:
- **会话创建**: 初始化新的对话会话
- **会话恢复**: 从磁盘加载历史会话
- **会话锁定**: 防止并发写入冲突
- **会话清理**: 定期清理过期会话

**会话状态机**:
```
Created → Active → (Paused ↔ Resumed) → Completed/Failed
                    ↓
                 Archived
```

#### 关键特性

1. **多源支持**: 统一的请求处理接口
2. **并发控制**: 限制同时执行的 Agent 数量
3. **状态持久化**: 会话历史可靠存储
4. **故障隔离**: 单个请求失败不影响其他请求
5. **可观测性**: 完整的请求追踪和日志

---

### 3. 子 Agent 注册表 (subagent-*.ts)

**位置**: `src/agents/subagent-*.ts`  
**规模**: ~30 个文件,约 200KB+ 代码

#### 核心职责

管理嵌套 Agent 会话的创建、监控、公告和清理,支持复杂的任务分解和并行执行。

#### 主要模块

##### 3.1 注册表核心 (subagent-registry.ts)

**文件**: `subagent-registry.ts` (37.8KB)

**功能**:
- **运行记录管理**: 跟踪所有活跃和已完成的子 Agent
- **持久化**: 将运行记录保存到磁盘并支持恢复
- **孤儿检测**: 自动发现并清理父会话已结束的子 Agent
- **事件监听**: 响应 Agent 生命周期事件

**数据结构**:
```typescript
interface SubagentRunRecord {
  id: string;
  parentId: string;
  status: 'running' | 'completed' | 'failed' | 'orphaned';
  createdAt: Date;
  completedAt?: Date;
  model: string;
  provider: string;
  metrics: ExecutionMetrics;
}
```

##### 3.2 子 Agent 创建 (subagent-spawn.ts)

**文件**: `subagent-spawn.ts` (40.4KB)

**功能**:
- **深度验证**: 检查嵌套层级是否超过限制(默认 3 层)
- **资源配额**: 验证父会话的资源预算
- **上下文继承**: 复制父会话的配置和技能
- **工作空间初始化**: 为子 Agent 创建独立的工作环境

**创建流程**:
```
验证深度限制 → 检查资源配额 → 继承上下文 → 初始化工作空间 → 启动会话
```

##### 3.3 公告系统 (subagent-announce*.ts)

**文件**: 
- `subagent-announce.ts` (21.6KB)
- `subagent-announce-delivery.ts` (30.4KB)
- `subagent-announce-queue.ts` (8.4KB)

**功能**:
- **完成通知**: 子 Agent 完成后向父会话发送摘要
- **重试机制**: 确保公告可靠送达
- **队列管理**: 处理并发公告请求
- **格式化处理**: 生成易读的结果摘要

**公告内容**:
- 执行摘要(成功/失败)
- 关键发现和决策
- 生成的文件或修改
- Token 使用统计
- 建议的后续步骤

##### 3.4 运行时控制 (subagent-control.ts)

**文件**: `subagent-control.ts` (24.3KB)

**功能**:
- **暂停/恢复**: 动态控制子 Agent 执行
- **强制终止**: 紧急情况下停止子 Agent
- **健康监控**: 检测卡死或异常的子 Agent
- **资源清理**: 终止时释放所有资源

**控制命令**:
```bash
openclaw subagent pause <id>
openclaw subagent resume <id>
openclaw subagent terminate <id>
openclaw subagent list --status running
```

##### 3.5 列表和查询 (subagent-list.ts, subagent-registry-queries.ts)

**文件**: 
- `subagent-list.ts` (9.6KB)
- `subagent-registry-queries.ts` (8.8KB)

**功能**:
- **过滤查询**: 按状态、父会话、请求者等条件筛选
- **排序功能**: 按时间、状态、资源使用排序
- **统计信息**: 显示总体指标和趋势
- **导出支持**: 支持 JSON/CSV 格式导出

**查询示例**:
```typescript
// 查询特定父会话的所有子 Agent
const children = querySubagents({ parentId: 'session-123' });

// 查询运行超过 10 分钟的子 Agent
const longRunning = querySubagents({ 
  status: 'running',
  minDuration: 600 
});
```

##### 3.6 生命周期管理 (subagent-registry-lifecycle.ts)

**文件**: `subagent-registry-lifecycle.ts` (25.4KB)

**功能**:
- **状态机**: 管理子 Agent 的状态转换
- **重试逻辑**: 处理临时失败的自动重试
- **优雅关闭**: 确保资源正确释放
- **状态持久化**: 定期保存生命周期状态

**状态转换**:
```
Pending → Running → Completing → Completed
              ↓         ↓
          Paused    Failed → Retrying
              ↓
          Terminated
```

##### 3.7 辅助模块

- **subagent-depth.ts** (4.7KB): 嵌套深度计算和限制检查
- **subagent-system-prompt.ts** (6.1KB): 为子 Agent 生成精简的系统提示词
- **subagent-capabilities.ts** (8.9KB): 子 Agent 能力声明和限制
- **subagent-orphan-recovery.ts** (16.5KB): 孤儿会话检测和恢复
- **subagent-session-metrics.ts** (2.3KB): 会话指标收集和报告

#### 关键特性

1. **嵌套支持**: 最多 3 层嵌套(可配置)
2. **资源隔离**: 每个子 Agent 独立的工作空间和会话
3. **自动清理**: 孤儿会话自动检测和清理
4. **公告机制**: 完成后自动向父会话汇报
5. **并发控制**: 限制同一父会话下的并发子 Agent 数量
6. **持久化**: 运行记录保存到磁盘,重启后恢复
7. **超时管理**: 独立的超时配置,防止无限运行

#### 使用场景

- **并行任务**: 同时执行多个独立的研究或分析任务
- **任务分解**: 将复杂项目拆分为子任务由不同 Agent 处理
- **沙箱执行**: 在隔离环境中运行不受信任的代码
- **递归思考**: Agent 创建子 Agent 进行自我反思和验证
- **专家咨询**: 为特定领域问题创建专门的子 Agent

---

### 4. 认证配置 (auth-profiles/)

**位置**: `src/agents/auth-profiles/`  
**规模**: 59 个文件,约 150KB+ 代码

#### 核心职责

管理多提供商的 OAuth 令牌、API 密钥和其他认证凭证,支持自动刷新、故障转移和冷却期管理。

#### 主要模块

##### 4.1 OAuth 管理器 (oauth*.ts)

**文件**: 
- `oauth-manager.ts` (20.3KB)
- `oauth.ts` (11.8KB)
- `oauth-shared.ts` (5.5KB)

**功能**:
- **令牌刷新**: 自动刷新即将过期的 OAuth 令牌
- **并发控制**: 防止多个 Agent 同时刷新同一令牌
- **错误处理**: 分类和处理各种刷新失败
- **身份 adopt**: 在主 Agent 失败时切换到备用身份

**刷新策略**:
- 提前刷新(过期前 5 分钟)
- 指数退避重试
- 锁定机制防止竞态条件
- 失败后冷却期

##### 4.2 配置文件管理 (profiles.ts, store.ts)

**文件**: 
- `profiles.ts` (4.9KB)
- `store.ts` (12.3KB)
- `persisted.ts` (15.8KB)

**功能**:
- **配置存储**: 持久化认证配置文件到磁盘
- **配置加载**: 从多个源加载配置(环境变量、配置文件、密钥管理器)
- **配置合并**: 智能合并多个配置源
- **配置验证**: 验证配置的完整性和有效性

**配置源优先级**:
1. 环境变量(最高优先级)
2. 用户配置文件 (~/.openclaw/auth.json)
3. 系统配置文件
4. 默认值(最低优先级)

##### 4.3 凭证状态跟踪 (credential-state.ts, usage.ts)

**文件**: 
- `credential-state.ts` (3.3KB)
- `usage.ts` (25.2KB)
- `usage-state.ts` (6.2KB)

**功能**:
- **状态监控**: 跟踪每个凭证的健康状态
- **使用统计**: 记录 API 调用次数、token 消耗等
- **速率限制**: 监控和遵守提供商的速率限制
- **成本追踪**: 累计 API 使用成本

**状态指标**:
- 最后使用时间
- 成功率/失败率
- 平均响应时间
- Token 使用量
- 剩余配额

##### 4.4 配置文件轮换 (order.ts, policy.ts)

**文件**: 
- `order.ts` (7.7KB)
- `policy.ts` (4.1KB)

**功能**:
- **轮询策略**: 在多个配置文件之间轮换使用
- **故障转移**: 当前配置失败时自动切换到下一个
- **负载均衡**: 均匀分配负载到多个凭证
- **优先级排序**: 基于性能和成本的智能排序

**轮换算法**:
```typescript
// 基于最后使用时间和成功率的加权轮询
function selectAuthProfile(profiles: AuthProfile[]): AuthProfile {
  return profiles.sort((a, b) => {
    const scoreA = calculateScore(a); // 考虑成功率、延迟、成本
    const scoreB = calculateScore(b);
    return scoreB - scoreA;
  })[0];
}
```

##### 4.5 外部认证集成 (external-*.ts)

**文件**: 
- `external-auth.ts` (3.6KB)
- `external-cli-sync.ts` (7.2KB)

**功能**:
- **CLI 同步**: 与外部 CLI 工具共享认证状态
- **OAuth 回调**: 处理 OAuth 授权回调
- **设备授权**: 支持设备流授权(如 GitHub Copilot)
- **密钥环集成**: 与系统密钥环集成

##### 4.6 诊断和修复 (doctor.ts, repair.ts)

**文件**: 
- `doctor.ts` (1.5KB)
- `repair.ts` (5.0KB)

**功能**:
- **健康检查**: 诊断认证配置问题
- **自动修复**: 尝试自动修复常见问题
- **配置验证**: 验证配置的完整性和一致性
- **建议生成**: 提供改进建议

**诊断命令**:
```bash
openclaw auth doctor
openclaw auth repair --profile openai
```

##### 4.7 辅助模块

- **types.ts** (2.7KB): 认证相关的类型定义
- **constants.ts** (2.2KB): 常量和默认值
- **paths.ts** (0.7KB): 配置文件路径管理
- **display.ts** (0.5KB): 认证信息的格式化显示
- **identity.ts** (1.4KB): 身份标识管理

#### 关键特性

1. **多凭证支持**: 同时管理多个提供商的多个凭证
2. **自动刷新**: OAuth 令牌自动刷新,无需人工干预
3. **故障转移**: 凭证失败时自动切换到备用凭证
4. **冷却期管理**: 失败的凭证进入冷却期,避免频繁重试
5. **使用追踪**: 详细的 API 使用和成本统计
6. **安全存储**: 敏感信息加密存储
7. **并发安全**: 锁机制防止竞态条件

#### 支持的认证类型

- **OAuth 2.0**: Google, Microsoft, GitHub 等
- **API Keys**: OpenAI, Anthropic, Moonshot 等
- **Bearer Tokens**: 自定义令牌认证
- **AWS Credentials**: AWS Bedrock IAM 角色
- **Service Accounts**: Google Cloud 服务账号

---

### 5. 沙箱系统 (sandbox/)

**位置**: `src/agents/sandbox/`  
**规模**: 71 个文件,约 120KB+ 代码

#### 核心职责

提供隔离的执行环境,确保非主会话的 Agent 在安全的沙箱中运行,防止对主机系统造成意外影响。

#### 主要模块

##### 5.1 Docker 后端 (docker*.ts)

**文件**: 
- `docker.ts` (18.5KB)
- `docker-backend.ts` (3.9KB)

**功能**:
- **容器管理**: 创建、启动、停止和清理 Docker 容器
- **资源配置**: CPU、内存、网络限制
- **镜像管理**: 拉取、缓存和版本管理
- **网络模式**: bridge、host、none 等网络配置

**容器配置**:
```yaml
docker:
  image: "openclaw/sandbox:latest"
  memoryLimit: "2g"
  cpuLimit: 1.0
  networkMode: "bridge"
  volumes:
    - "~/workspace:/workspace:rw"
```

##### 5.2 SSH 后端 (ssh*.ts)

**文件**: 
- `ssh.ts` (12.2KB)
- `ssh-backend.ts` (9.1KB)

**功能**:
- **远程执行**: 在远程主机上运行 Agent
- **认证方式**: 支持密钥和密码认证
- **环境变量**: 安全传递环境变量
- **会话管理**: SSH 连接池和复用

**远程配置**:
```yaml
ssh:
  host: "remote.example.com"
  port: 22
  user: "agent"
  keyPath: "~/.ssh/agent_key"
  environment:
    OPENCLAW_WORKSPACE: "/home/agent/workspace"
```

##### 5.3 浏览器自动化 (browser.ts)

**文件**: `browser.ts` (16.5KB)

**功能**:
- **Playwright 集成**: 完整的浏览器自动化支持
- **VNC 支持**: 可选的图形界面访问
- **会话隔离**: 每个会话独立的浏览器实例
- **资源清理**: 会话结束后自动关闭浏览器

**使用场景**:
- 网页抓取和数据提取
- 表单填写和提交
- 截图和 PDF 生成
- Web 应用测试

##### 5.4 文件系统桥接 (fs-bridge*.ts)

**文件**: 
- `fs-bridge.ts` (9.3KB)
- `remote-fs-bridge.ts` (16.8KB)
- `fs-bridge-path-safety.ts` (9.2KB)

**功能**:
- **安全暴露**: 选择性地将主机文件暴露给沙箱
- **路径验证**: 防止路径遍历攻击
- **权限控制**: 读写权限细粒度控制
- **符号链接保护**: 防止符号链接攻击

**安全策略**:
```typescript
// 只允许访问工作空间内的文件
const allowedPaths = ['/workspace', '/tmp'];
const blockedPatterns = ['../*', '/etc/*', '/root/*'];
```

##### 5.5 配置管理 (config.ts, context.ts)

**文件**: 
- `config.ts` (11.0KB)
- `context.ts` (8.7KB)

**功能**:
- **配置解析**: 合并全局和 Agent 特定的沙箱配置
- **上下文构建**: 准备沙箱执行环境
- **挂载点管理**: 管理工作空间挂载
- **环境变量注入**: 安全地注入环境变量

**配置优先级**:
1. Agent 级别配置(最高)
2. 会话级别配置
3. 全局默认配置(最低)

##### 5.6 安全策略 (tool-policy.ts, validate-sandbox-security.ts)

**文件**: 
- `tool-policy.ts` (7.6KB)
- `validate-sandbox-security.ts` (13.1KB)

**功能**:
- **工具访问控制**: 定义允许/禁止的工具列表
- **安全检查**: 运行时检测潜在安全漏洞
- **策略验证**: 验证沙箱配置的安全性
- **风险评估**: 评估操作的风险等级

**策略示例**:
```yaml
toolPolicy:
  allowed:
    - read
    - write
    - bash
  denied:
    - exec_sudo
    - network_scan
  workspaceOnly: true
```

##### 5.7 环境清理 (sanitize-env-vars.ts)

**文件**: `sanitize-env-vars.ts` (2.9KB)

**功能**:
- **敏感信息移除**: 清除密码、密钥等敏感变量
- **白名单过滤**: 只允许指定的环境变量
- **注入防护**: 防止环境变量注入攻击

**清理规则**:
```typescript
const BLOCKED_PATTERNS = [
  /PASSWORD/i,
  /SECRET/i,
  /TOKEN/i,
  /KEY/i,
  /CREDENTIAL/i
];
```

##### 5.8 辅助模块

- **config-hash.ts** (1.7KB): 基于配置生成唯一哈希,用于容器复用
- **registry.ts** (5.9KB): 沙箱实例注册表
- **manage.ts** (3.7KB): 沙箱生命周期管理
- **prune.ts** (3.8KB): 定期清理未使用的沙箱
- **workspace-mounts.ts** (1.1KB): 工作空间挂载配置
- **network-mode.ts** (1.0KB): 网络模式管理
- **novnc-auth.ts** (2.9KB): VNC 认证管理

#### 关键特性

1. **多后端支持**: Docker、SSH、本地进程
2. **资源隔离**: CPU、内存、网络、文件系统的完全隔离
3. **工作空间挂载**: 选择性地将主机目录挂载到沙箱
4. **浏览器自动化**: 独立的浏览器实例,支持无头和有头模式
5. **VNC 访问**: 可选的图形界面访问用于调试
6. **自动清理**: 会话结束后自动清理容器和资源
7. **安全策略**: 细粒度的工具和文件系统访问控制
8. **配置哈希**: 基于配置生成唯一标识,复用相同配置的容器

#### 沙箱模式

- **main**: 主会话不使用沙箱(默认)
- **non-main**: 非主会话(群组、频道)使用沙箱
- **always**: 所有会话都使用沙箱
- **never**: 禁用沙箱(不推荐)

#### 使用场景

- **非主会话沙箱化**: 群组、频道中的消息在隔离环境中执行
- **不受信任的代码**: 执行用户提供的脚本或代码
- **浏览器任务**: 网页抓取、表单填写、截图
- **远程执行**: 在远程服务器上运行 Agent
- **实验环境**: 测试新功能而不影响主系统

---

### 6. 技能系统 (skills/, skills-*.ts)

**位置**: `src/agents/skills/`, `src/agents/skills-*.ts`  
**规模**: 27 个核心文件 + 10+ 个安装相关文件,约 100KB+ 代码

#### 核心职责

管理和加载 Agent 技能(Skills),为 Agent 提供领域专业知识、工具集成和工作流程自动化能力。

#### 主要模块

##### 6.1 工作区技能加载 (workspace.ts)

**文件**: `workspace.ts` (31.6KB)

**功能**:
- **多源收集**: 从 bundled、workspace、plugin 三个源加载技能
- **冲突解决**: 处理同名技能的优先级
- **提示词构建**: 生成技能相关的系统提示词片段
- **动态加载**: 按需加载技能,减少启动时间

**技能来源**:
1. **Bundled**: OpenClaw 内置的技能包
2. **Workspace**: 用户工作区中的自定义技能
3. **Plugin**: 插件提供的技能

**加载流程**:
```
扫描技能目录 → 解析 frontmatter → 验证完整性 → 构建索引 → 生成提示词
```

##### 6.2 技能元数据 (skill-contract.ts, frontmatter.ts)

**文件**: 
- `skill-contract.ts` (2.0KB)
- `frontmatter.ts` (6.1KB)

**功能**:
- **元数据解析**: 从 YAML frontmatter 提取技能信息
- **完整性验证**: 验证必需字段和格式
- **版本检查**: 确保技能与 OpenClaw 版本兼容
- **依赖声明**: 声明技能所需的系统和语言包

**Frontmatter 示例**:
```yaml
---
name: web-research
description: Conducts comprehensive web research
version: 1.2.0
authors:
  - OpenClaw Team
tags:
  - research
  - web
  - analysis
commands:
  - name: search
    description: Search the web for information
    parameters:
      query: string
      maxResults: number
dependencies:
  npm:
    - puppeteer
  system:
    - curl
---
```

##### 6.3 命令规范 (command-specs.ts)

**文件**: `command-specs.ts` (6.9KB)

**功能**:
- **Schema 生成**: 为技能命令生成 JSON Schema
- **参数验证**: 定义参数的类型、范围和约束
- **工具注册**: 将技能命令注册为可调用的工具
- **文档生成**: 自动生成命令帮助文档

**Schema 示例**:
```json
{
  "name": "web_research_search",
  "description": "Search the web for information",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Search query"
      },
      "maxResults": {
        "type": "number",
        "minimum": 1,
        "maximum": 20,
        "default": 10
      }
    },
    "required": ["query"]
  }
}
```

##### 6.4 环境变量覆盖 (env-overrides.ts)

**文件**: `env-overrides.ts` (7.7KB)

**功能**:
- **变量覆盖**: 应用技能特定的环境变量
- **条件覆盖**: 基于平台、提供商等条件应用不同的覆盖
- **作用域隔离**: 确保环境变量只在技能执行期间生效
- **安全过滤**: 防止敏感信息泄露

**覆盖示例**:
```yaml
envOverrides:
  API_ENDPOINT: "https://api.example.com"
  TIMEOUT: "30000"
  conditions:
    - when: provider == "openai"
      set:
        MODEL: "gpt-4"
    - when: platform == "linux"
      set:
        BROWSER: "chromium"
```

##### 6.5 Agent 过滤器 (agent-filter.ts)

**文件**: `agent-filter.ts` (1.7KB)

**功能**:
- **技能过滤**: 允许/禁止特定 Agent 使用某些技能
- **通配符支持**: 支持 glob 模式匹配
- **继承机制**: 子 Agent 可以继承或覆盖父 Agent 的过滤规则

**过滤配置**:
```yaml
skills:
  allow:
    - "research-*"
    - "coding-*"
  deny:
    - "experimental-*"
```

##### 6.6 技能安装 (skills-install*.ts)

**文件**: 
- `skills-install.ts` (17.7KB)
- `skills-clawhub.ts` (13.6KB)
- `skills-status.ts` (7.7KB)
- `skills-install-download.ts` (7.6KB)
- `skills-install-extract.ts` (6.8KB)

**功能**:
- **下载管理**: 从 ClawHub 或 URL 下载技能包
- **解压验证**: 解压并验证技能文件的完整性
- **依赖安装**: 自动安装技能所需的 npm、pip、brew 包
- **状态检查**: 检查工作区技能的状态和更新

**安装流程**:
```
搜索技能 → 下载包 → 验证签名 → 解压文件 → 安装依赖 → 注册技能
```

**ClawHub 集成**:
```bash
# 搜索技能
openclaw skills search web-research

# 安装技能
openclaw skills install @openclaw/web-research

# 更新技能
openclaw skills update

# 检查状态
openclaw skills status
```

##### 6.7 本地加载器 (local-loader.ts)

**文件**: `local-loader.ts` (4.6KB)

**功能**:
- **文件系统扫描**: 从指定目录加载技能
- **格式解析**: 解析 skill.md/SKILL.md 文件
- **资源提取**: 提取 references、scripts、assets 等资源
- **错误处理**:  gracefully 处理损坏或不完整的技能

##### 6.8 辅助模块

- **types.ts** (2.4KB): 技能相关的类型定义
- **source.ts** (0.5KB): 技能来源枚举
- **config.ts** (3.3KB): 技能配置管理
- **filter.ts** (1.1KB): 技能过滤逻辑
- **serialize.ts** (0.4KB): 技能序列化
- **refresh.ts** (5.9KB): 技能状态刷新
- **plugin-skills.ts** (4.0KB): 插件技能集成
- **bundled-dir.ts** (2.3KB): 内置技能目录管理

#### 技能结构

标准的技能包结构:

```
my-skill/
├── skill.md              # 技能描述和指令(必需)
├── SKILL.md              # 替代名称(兼容)
├── references/           # 参考文档(可选)
│   ├── api-guide.md
│   └── best-practices.md
├── scripts/              # 辅助脚本(可选)
│   ├── setup.sh
│   └── cleanup.py
├── assets/               # 静态资源(可选)
│   └── logo.png
└── examples/             # 示例用法(可选)
    └── basic-usage.md
```

#### 关键特性

1. **多源技能**: Bundled(内置)、Workspace(用户)、Plugin(插件)
2. **动态加载**: 按需加载技能,减少启动时间
3. **环境隔离**: 每个技能可以有独立的环境变量
4. **依赖管理**: 自动安装技能所需的系统和语言包
5. **命令规范**: 自动生成工具 schema 供 LLM 调用
6. **版本控制**: 支持技能版本锁定和更新
7. **冲突解决**: 同名技能按优先级选择
8. **条件启用**: 基于平台、提供商、会话类型动态启用/禁用

#### 使用场景

- **领域专业知识**: 为特定领域(编程、写作、数据分析)提供专业指导
- **工具集成**: 封装外部 API 或工具的调用逻辑
- **工作流程自动化**: 预定义的多步骤任务流程
- **团队协作**: 共享标准化的操作指南
- **快速原型**: 快速试验新的 Agent 能力

#### 技能生命周期

1. **发现**: 从 ClawHub、GitHub 或本地目录
2. **安装**: 下载到工作区,安装依赖
3. **加载**: 解析元数据,构建命令规范
4. **注入**: 在系统提示词中包含技能指令
5. **执行**: Agent 根据技能指导调用工具
6. **更新**: 定期检查新版本
7. **卸载**: 移除技能和清理依赖

---

### 7. 模型选择与故障转移 (model-*.ts)

**位置**: `src/agents/model-*.ts`  
**规模**: ~30 个文件,约 150KB+ 代码

#### 核心职责

解析模型引用、管理提供商认证映射、实现故障转移策略和错误分类,确保 Agent 能够可靠地访问 LLM 服务。

#### 主要模块

##### 7.1 模型选择核心 (model-selection.ts)

**文件**: `model-selection.ts` (11.0KB), `model-selection-shared.ts` (22.2KB)

**功能**:
- **引用解析**: 将模型别名解析为具体的提供商和模型 ID
- **提供商映射**: 根据模型选择正确的提供商配置
- **默认值处理**: 应用默认的模型和提供商配置
- **验证检查**: 验证模型引用的有效性

**解析流程**:
```
模型引用 → 别名查找 → 提供商确定 → 配置加载 → 验证 → 返回完整配置
```

**示例**:
```typescript
// 输入: "gpt-4"
// 输出: { provider: "openai", model: "gpt-4-turbo", apiKey: "..." }

// 输入: "claude-3-opus"
// 输出: { provider: "anthropic", model: "claude-3-opus-20240229", apiKey: "..." }
```

##### 7.2 故障转移 (model-fallback.ts)

**文件**: `model-fallback.ts` (33.2KB)

**功能**:
- **错误分类**: 区分可重试和不可重试的错误
- **故障转移**: 当前模型失败时自动切换到备用模型
- **重试策略**: 指数退避重试
- **观察记录**: 记录故障模式和成功率

**故障转移链**:
```yaml
fallbackChain:
  - provider: "openai"
    model: "gpt-4-turbo"
  - provider: "anthropic"
    model: "claude-3-opus"
  - provider: "google"
    model: "gemini-1.5-pro"
```

**错误分类**:
- **可重试**: 网络超时、速率限制、临时服务器错误
- **不可重试**: 认证失败、无效模型、配额耗尽
- **需切换**: 工具不支持、上下文过长、内容过滤

##### 7.3 认证管理 (model-auth.ts)

**文件**: `model-auth.ts` (23.8KB)

**功能**:
- **凭证映射**: 将提供商映射到对应的认证配置文件
- **令牌获取**: 从 auth-profiles 获取有效的 API 密钥或令牌
- **自动刷新**: 触发 OAuth 令牌的自动刷新
- **故障转移**: 当前凭证失败时切换到备用凭证

**认证流程**:
```
提供商 → 查找 auth-profile → 检查有效性 → (刷新如果需要) → 返回凭证
```

##### 7.4 模型目录 (model-catalog.ts)

**文件**: `model-catalog.ts` (8.4KB)

**功能**:
- **模型注册**: 维护已知模型的目录
- **能力声明**: 记录每个模型支持的功能(工具调用、缓存等)
- **元数据**: 存储模型的上下文窗口、定价等信息
- **动态更新**: 支持从提供商 API 同步最新模型列表

**目录条目**:
```typescript
interface ModelEntry {
  id: string;
  provider: string;
  displayName: string;
  capabilities: {
    tools: boolean;
    caching: boolean;
    vision: boolean;
    reasoning: boolean;
  };
  limits: {
    contextWindow: number;
    maxOutput: number;
  };
  pricing: {
    inputPerMillion: number;
    outputPerMillion: number;
  };
}
```

##### 7.5 模型扫描 (model-scan.ts)

**文件**: `model-scan.ts` (13.7KB)

**功能**:
- **配置扫描**: 从配置文件中发现模型定义
- **提供商发现**: 自动检测可用的提供商
- **去重合并**: 合并来自多个源的模型定义
- **验证检查**: 验证模型配置的完整性

##### 7.6 兼容性处理 (model-compat.test.ts)

**文件**: `model-compat.test.ts` (22.6KB)

**功能**:
- **参数转换**: 将通用参数转换为提供商特定格式
- **功能模拟**: 在不支持某些功能的模型上模拟行为
- **降级策略**: 在高级功能不可用时提供降级方案

**兼容性示例**:
```typescript
// OpenAI 的 reasoning_effort 参数在其他提供商上的处理
if (provider !== 'openai') {
  // 转换为等效的思考控制参数或忽略
  delete params.reasoningEffort;
}
```

##### 7.7 辅助模块

- **model-ref-shared.ts** (3.2KB): 模型引用的共享逻辑
- **model-ref-profile.ts** (1.8KB): 基于配置文件的模型引用
- **model-runtime-aliases.ts** (4.3KB): 运行时别名解析
- **model-alias-lines.ts** (0.8KB): 别名行解析
- **model-allowlist-entry.ts** (1.0KB): 允许列表条目
- **model-auth-env.ts** (3.0KB): 环境变量认证
- **model-auth-label.ts** (2.5KB): 认证标签
- **model-auth-markers.ts** (3.8KB): 认证标记
- **model-thinking-default.ts** (3.2KB): 思考模式默认值
- **model-tool-support.ts** (0.3KB): 工具支持检测
- **model-suppression.ts** (1.4KB): 模型抑制策略
- **models-config.ts** (6.1KB): 模型配置管理
- **models-config.merge.ts** (7.7KB): 配置合并逻辑
- **live-model-*.ts**: 实时模型测试和探针

#### 关键特性

1. **智能解析**: 灵活的模型引用解析,支持别名和简写
2. **故障转移**: 多层次的故障转移和降级策略
3. **错误分类**: 精确的错误分类指导恢复策略
4. **认证集成**: 与 auth-profiles 无缝集成
5. **能力检测**: 自动检测模型支持的功能
6. **动态更新**: 支持从提供商同步最新模型信息
7. **兼容性层**: 处理不同提供商的 API 差异

#### 故障转移策略

**层级 1: 同提供商内切换**
```
gpt-4-turbo → gpt-4 → gpt-3.5-turbo
```

**层级 2: 跨提供商切换**
```
OpenAI GPT-4 → Anthropic Claude-3 → Google Gemini-1.5
```

**层级 3: 功能降级**
```
工具调用 → 纯文本交互
缓存 → 无缓存
流式 → 非流式
```

**层级 4: 人工介入**
```
通知用户 → 等待手动选择 → 继续执行
```

---

### 8. 系统提示词 (system-prompt.ts)

**位置**: `src/agents/system-prompt.ts`  
**规模**: 主文件 47.4KB + 多个辅助文件

#### 核心职责

动态构建和优化系统提示词,管理上下文文件的排序和注入,确保提示词的缓存友好性和稳定性。

#### 主要模块

##### 8.1 提示词构建核心 (system-prompt.ts)

**文件**: `system-prompt.ts` (47.4KB)

**功能**:
- **动态组装**: 根据会话配置动态构建系统提示词
- **组件注入**: 注入身份、技能、工具、上下文等组件
- **排序优化**: 优化组件顺序以提升模型性能
- **缓存键生成**: 生成稳定的缓存键以最大化缓存命中率

**提示词组件**:
```
1. 系统指令(核心行为准则)
2. 身份信息(Agent 名称、角色)
3. 当前时间(动态时间戳)
4. 工作空间信息(项目上下文)
5. 技能指令(加载的技能)
6. 工具定义(可用工具列表)
7. 会话历史摘要(压缩后的历史)
8. 附加上下文(用户提供的文件)
```

**构建流程**:
```typescript
async function buildSystemPrompt(params: PromptParams): Promise<string> {
  const components = [];
  
  // 1. 核心系统指令
  components.push(await loadCoreInstructions());
  
  // 2. 身份信息
  components.push(formatIdentity(params.identity));
  
  // 3. 时间信息
  components.push(formatCurrentTime());
  
  // 4. 工作空间上下文
  components.push(await loadWorkspaceContext(params.workspace));
  
  // 5. 技能指令
  components.push(await buildSkillsPrompt(params.skills));
  
  // 6. 工具定义
  components.push(formatToolDefinitions(params.tools));
  
  // 7. 附加上下文
  components.push(await loadAdditionalContext(params.contextFiles));
  
  return components.join('\n\n');
}
```

##### 8.2 提示词参数 (system-prompt-params.ts)

**文件**: `system-prompt-params.ts` (3.1KB)

**功能**:
- **参数提取**: 从会话配置中提取提示词构建参数
- **默认值应用**: 应用合理的默认值
- **验证检查**: 验证参数的完整性和有效性

##### 8.3 提示词覆盖 (system-prompt-override.ts)

**文件**: `system-prompt-override.ts` (0.8KB)

**功能**:
- **自定义覆盖**: 允许用户完全覆盖系统提示词
- **部分替换**: 支持替换特定组件
- **条件覆盖**: 基于会话类型应用不同的覆盖

##### 8.4 提示词缓存 (system-prompt-cache-boundary.ts)

**文件**: `system-prompt-cache-boundary.ts` (1.6KB)

**功能**:
- **缓存边界**: 定义哪些部分可以缓存,哪些必须动态生成
- **稳定性保证**: 确保缓存键的稳定性
- **失效策略**: 定义缓存失效的条件

**缓存策略**:
```typescript
// 可缓存部分(稳定)
- 核心系统指令
- 工具定义
- 技能指令(未更新时)

// 不可缓存部分(动态)
- 当前时间
- 会话历史
- 用户提供的上下文
```

##### 8.5 提示词报告 (system-prompt-report.ts)

**文件**: `system-prompt-report.ts` (4.3KB)

**功能**:
- **统计分析**: 统计提示词的 token 分布
- **组件占比**: 显示各组件的 token 占比
- **优化建议**: 提供减少 token 使用的建议
- **可视化**: 生成提示词结构的可视化报告

**报告示例**:
```
System Prompt Analysis:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Tokens: 3,245

Components:
  Core Instructions:  1,200 tokens (37%)
  Identity:              150 tokens (5%)
  Skills:                800 tokens (25%)
  Tools:                 650 tokens (20%)
  Context Files:         445 tokens (13%)

Recommendations:
  - Consider removing unused skills to save 300 tokens
  - Context files are large, consider summarization
```

##### 8.6 提示词稳定性测试 (system-prompt-stability.test.ts)

**文件**: `system-prompt-stability.test.ts` (5.3KB)

**功能**:
- **缓存键稳定性**: 验证相同配置生成相同的缓存键
- **组件隔离**: 确保一个组件的变化不影响其他组件的缓存
- **回归测试**: 防止提示词构建逻辑的意外变化

##### 8.7 辅助模块

- **system-prompt.types.ts** (0.1KB): 类型定义
- **system-prompt-contribution.ts** (0.9KB): 贡献度计算
- **system-prompt.test.ts** (41.0KB): 全面的单元测试
- **prompt-cache-stability.ts** (0.7KB): 缓存稳定性检查
- **prompt-composition.test.ts** (4.2KB): 组合测试
- **prompt-overlay-runtime-contract.test.ts** (3.0KB): 覆盖运行时契约测试

#### 关键特性

1. **动态构建**: 根据会话配置灵活构建提示词
2. **组件化**: 模块化的提示词组件,易于维护和扩展
3. **缓存优化**: 智能缓存策略减少 token 消耗
4. **稳定性保证**: 确保相同配置生成一致的提示词
5. **可观测性**: 详细的统计和报告功能
6. **自定义支持**: 允许用户覆盖和定制提示词
7. **性能优化**: 优化的组件排序和格式化

#### 提示词最佳实践

**大小控制**:
- 目标:< 5,000 tokens
- 警告:5,000 - 8,000 tokens
- 危险:> 8,000 tokens

**组件优先级**:
1. 核心指令(必须)
2. 工具定义(必须)
3. 技能指令(重要)
4. 上下文文件(可选)
5. 历史信息(可选,可压缩)

**优化技巧**:
- 移除未使用的技能
- 压缩冗长的工具描述
- 使用缩写和简写
- 定期清理过期上下文
- 利用提供商的缓存功能

---

### 9. 工具系统 (tools/, pi-tools.ts)

**位置**: `src/agents/tools/`, `src/agents/pi-tools.ts`  
**规模**: 120 个工具文件 + 核心文件,约 200KB+ 代码

#### 核心职责

提供 OpenClaw 内置的工具集,管理工具的策略、权限和执行,包括会话管理、文件系统操作、Bash 执行、媒体处理等功能。

#### 主要模块

##### 9.1 工具核心 (pi-tools.ts)

**文件**: `pi-tools.ts` (27.6KB)

**功能**:
- **工具注册**: 注册和管理所有可用工具
- **Schema 定义**: 定义工具的 JSON Schema
- **执行调度**: 调度和执行工具调用
- **结果处理**: 处理和格式化工具执行结果

**工具分类**:
- **会话工具**: sessions_list, sessions_read, sessions_write
- **文件工具**: read, write, edit, ls, grep
- **Bash 工具**: bash, exec
- **媒体工具**: camera, screenshot, media_info
- **系统工具**: cron, schedule, notify
- **网络工具**: fetch, http_request
- **Agent 工具**: subagent_spawn, subagent_list

##### 9.2 Bash 工具 (bash-tools.*)

**文件**: 
- `bash-tools.exec.ts` (56.1KB)
- `bash-tools.exec-runtime.ts` (28.7KB)
- `bash-tools.process.ts` (20.8KB)
- 以及其他 20+ 个相关文件

**功能**:
- **命令执行**: 在沙箱或主机上执行 Bash 命令
- **PTY 支持**: 伪终端支持交互式命令
- **超时控制**: 命令执行超时管理
- **审批流程**: 危险命令需要用户审批
- **输出捕获**: 捕获 stdout、stderr 和退出码

**执行模式**:
```typescript
// 前台执行(阻塞)
await execCommand('ls -la', { mode: 'foreground' });

// 后台执行(异步)
const process = await execCommand('long-running-task', { mode: 'background' });

// PTY 执行(交互式)
await execCommand('vim file.txt', { mode: 'pty' });
```

**安全特性**:
- 命令白名单/黑名单
- 路径限制(只能访问工作空间)
- 资源限制(CPU、内存、时间)
- 危险命令检测(rm -rf, sudo 等)
- 用户审批流程

##### 9.3 会话工具 (openclaw-tools.sessions.*)

**文件**: 
- `openclaw-tools.sessions.test.ts` (39.8KB)
- `openclaw-tools.session-status.test.ts` (49.5KB)

**功能**:
- **会话列表**: 列出所有活跃和历史会话
- **会话读取**: 读取会话的历史消息
- **会话写入**: 向会话添加消息
- **会话状态**: 查询会话的状态和指标
- **会话管理**: 暂停、恢复、终止会话

**工具示例**:
```typescript
// 列出会话
sessions_list({ limit: 10, status: 'active' })

// 读取会话
sessions_read({ sessionId: 'abc123', fromIndex: 0 })

// 写入会话
sessions_write({ 
  sessionId: 'abc123', 
  message: { role: 'assistant', content: 'Hello!' } 
})
```

##### 9.4 文件工具 (pi-tools.read.ts, pi-tools.host-edit.ts)

**文件**: 
- `pi-tools.read.ts` (27.8KB)
- `pi-tools.host-edit.ts` (6.2KB)

**功能**:
- **文件读取**: 读取文件内容(支持大文件分页)
- **文件写入**: 写入新文件或覆盖现有文件
- **文件编辑**: 增量编辑文件(插入、删除、替换)
- **目录列表**: 列出目录内容
- **文件搜索**: 使用 glob 或 grep 搜索文件
- **路径验证**: 确保文件路径在工作空间内

**安全特性**:
- 工作空间限制(默认只能访问工作空间)
- 文件大小限制(防止读取超大文件)
- 二进制文件检测(避免读取非文本文件)
- 符号链接保护(防止路径遍历)
- 权限检查(检查文件读写权限)

##### 9.5 工具策略 (pi-tools.policy.ts, tool-policy.ts)

**文件**: 
- `pi-tools.policy.ts` (14.5KB)
- `tool-policy.ts` (5.9KB)

**功能**:
- **访问控制**: 定义哪些工具可以被哪些 Agent 使用
- **权限检查**: 在执行前检查工具权限
- **策略合并**: 合并全局、Agent 和会话级别的策略
- **动态策略**: 基于会话类型动态调整策略

**策略配置**:
```yaml
toolPolicy:
  defaults:
    allowed:
      - read
      - write
      - bash
    denied:
      - exec_sudo
  
  agents:
    researcher:
      allowed:
        - fetch
        - web_search
      denied:
        - write
  
  sessions:
    main:
      allowAll: true
    non-main:
      requireApproval:
        - bash
        - write
```

##### 9.6 工具显示 (tool-display*.ts)

**文件**: 
- `tool-display.ts` (2.4KB)
- `tool-display-config.ts` (13.6KB)
- `tool-display-exec.ts` (11.2KB)
- `tool-display-common.ts` (12.1KB)

**功能**:
- **结果格式化**: 格式化工具执行结果以供显示
- **配置管理**: 管理工具显示的配置
- **摘要生成**: 生成工具结果的简短摘要
- **详细视图**: 提供完整结果的详细视图

**显示策略**:
- 短结果:完整显示
- 中等结果:显示前 N 行 + "..."
- 长结果:显示摘要 + 链接到完整结果
- 二进制结果:显示元数据(大小、类型)

##### 9.7 工具目录 (tool-catalog.ts)

**文件**: `tool-catalog.ts` (9.4KB)

**功能**:
- **工具注册表**: 维护所有可用工具的目录
- **能力查询**: 查询工具的功能和限制
- **Schema 检索**: 快速获取工具的 JSON Schema
- **动态更新**: 支持运行时添加新工具

##### 9.8 Before Tool Call Hook (pi-tools.before-tool-call.ts)

**文件**: `pi-tools.before-tool-call.ts` (17.9KB)

**功能**:
- **前置钩子**: 在工具执行前运行的钩子
- **参数验证**: 验证工具调用参数
- **权限检查**: 执行额外的权限检查
- **预处理**: 对参数进行预处理或转换
- **拦截**: 在特定条件下拦截工具调用

**钩子示例**:
```typescript
beforeToolCall.register('bash', async (params) => {
  // 检查命令是否在白名单中
  if (!isCommandAllowed(params.command)) {
    throw new Error('Command not allowed');
  }
  
  // 记录审计日志
  await logAudit('bash_exec', params);
  
  return params; // 可能修改后的参数
});
```

##### 9.9 工具图像 (tool-images.ts)

**文件**: `tool-images.ts` (11.1KB)

**功能**:
- **图像处理**: 处理工具返回的图像数据
- **格式转换**: 在不同图像格式之间转换
- **尺寸调整**: 调整图像大小以符合模型要求
- **Base64 编码**: 将图像编码为 Base64 以供模型使用

##### 9.10 工具循环检测 (tool-loop-detection.ts)

**文件**: `tool-loop-detection.ts` (20.6KB)

**功能**:
- **循环检测**: 检测工具调用的无限循环
- **模式识别**: 识别重复的工具调用模式
- **中断机制**: 在检测到循环时中断执行
- **警告生成**: 生成循环检测的警告和建议

**检测策略**:
- 相同工具连续调用 N 次
- 相同参数模式重复出现
- 工具调用链形成循环
- 执行时间超过阈值

##### 9.11 有效工具清单 (tools-effective-inventory.ts)

**文件**: `tools-effective-inventory.ts` (9.2KB)

**功能**:
- **清单构建**: 构建当前会话的有效工具清单
- **策略应用**: 应用工具策略过滤工具
- **去重合并**: 合并来自多个源的工具
- **优先级排序**: 按优先级排序工具

##### 9.12 辅助模块

- **pi-tools.params.ts** (4.1KB): 参数处理
- **pi-tools.schema.ts** (1.2KB): Schema 管理
- **pi-tools.abort.ts** (1.9KB): 中止处理
- **pi-tools.deferred-followup.ts** (0.7KB): 延迟跟进
- **tool-call-id.ts** (15.2KB): 工具调用 ID 管理
- **tool-fs-policy.ts** (2.2KB): 文件系统策略
- **tool-mutation.ts** (6.4KB): 突变检测
- **tool-error-summary.ts** (0.4KB): 错误摘要
- **tool-description-*.ts**: 工具描述管理

#### 关键特性

1. **丰富的工具集**: 120+ 内置工具覆盖常见任务
2. **细粒度权限**: 基于角色的工具访问控制
3. **安全执行**: 多层安全防护和审批流程
4. **灵活配置**: 全局、Agent、会话级别的策略配置
5. **结果优化**: 智能的结果格式化和摘要
6. **循环保护**: 自动检测和防止工具调用循环
7. **可扩展性**: 支持插件添加自定义工具

#### 工具执行流程

```
1. Agent 请求工具调用
       ↓
2. 参数验证和 Schema 检查
       ↓
3. 权限检查(策略评估)
       ↓
4. Before Hook 执行
       ↓
5. 工具执行(沙箱或主机)
       ↓
6. 结果捕获和处理
       ↓
7. After Hook 执行
       ↓
8. 结果格式化
       ↓
9. 返回给 Agent
```

---

### 10. Hooks 系统 (pi-hooks/)

**位置**: `src/agents/pi-hooks/`  
**规模**: 10 个文件

#### 核心职责

提供会话生命周期钩子,允许在关键时刻插入自定义逻辑,包括上下文修剪、压缩保护和工具结果中间件。

#### 主要模块

##### 10.1 会话生命周期钩子

**功能**:
- **会话创建**: 在新会话创建时触发
- **会话结束**: 在会话结束时触发
- **消息添加**: 在每条消息添加前后触发
- **工具调用**: 在工具调用前后触发

**钩子类型**:
```typescript
interface SessionHooks {
  onSessionCreate?: (session: Session) => void;
  onSessionEnd?: (session: Session, reason: EndReason) => void;
  onMessageBefore?: (message: Message) => Message | Promise<Message>;
  onMessageAfter?: (message: Message) => void;
  onToolCallBefore?: (call: ToolCall) => ToolCall | Promise<ToolCall>;
  onToolCallAfter?: (result: ToolResult) => ToolResult | Promise<ToolResult>;
}
```

##### 10.2 上下文修剪钩子

**功能**:
- **智能修剪**: 基于语义重要性修剪上下文
- **保护规则**: 保护重要的系统消息和工具定义
- **自定义策略**: 允许自定义修剪策略
- **预览模式**: 预览修剪效果而不实际应用

**修剪策略**:
- 删除早期的助手消息
- 压缩工具结果
- 移除重复内容
- 保留关键的系统指令

##### 10.3 压缩保护钩子

**功能**:
- **保护标记**: 标记不应被压缩的消息
- **最小保留**: 确保最重要的消息不被删除
- **优先级队列**: 按重要性排序消息
- **动态调整**: 根据上下文窗口大小调整保护级别

##### 10.4 工具结果中间件

**功能**:
- **结果转换**: 在返回给 Agent 前转换工具结果
- **结果过滤**: 过滤敏感或不必要的信息
- **结果增强**: 添