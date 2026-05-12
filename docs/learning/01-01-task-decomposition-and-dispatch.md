# OpenClaw 任务拆解与下发机制详解

## 📋 目录

- [1. 概述](#1-概述)
- [2. 核心架构设计](#2-核心架构设计)
- [3. 任务拆分策略](#3-任务拆分策略)
- [4. sessions_spawn 深度解析](#4-sessions_spawn-深度解析)
- [5. 子代理生命周期管理](#5-子代理生命周期管理)
- [6. 结果通知与整合](#6-结果通知与整合)
- [7. 并发控制与资源保护](#7-并发控制与资源保护)
- [8. 上下文继承与隔离](#8-上下文继承与隔离)
- [9. 典型使用场景](#9-典型使用场景)
- [10. 最佳实践](#10-最佳实践)

---

## 1. 概述

OpenClaw 的任务拆解与下发机制是一个**智能化的分布式任务执行系统**，它允许主 Agent 将复杂的大任务动态拆分为多个子任务，通过派生子代理（Subagent）并行执行，最终将结果整合返回。

### 1.1 核心价值

- **🎯 智能分解**：Agent 可根据任务复杂度自主决定是否需要拆分
- **⚡ 并行执行**：多个子代理可同时工作，显著提升效率
- **🔒 安全隔离**：每个子代理在独立的会话和沙箱中运行
- **🔄 自动整合**：子任务完成后自动通知父代理并整合结果
- **🛡️ 容错保护**：深度限制、并发控制、超时保护等多层防护

### 1.2 设计理念

```
┌─────────────────────────────────────────────┐
│       OpenClaw 任务拆解设计原则              │
├─────────────────────────────────────────────┤
│ • Dynamic: 运行时动态决策，非预定义          │
│ • Hierarchical: 树状结构，支持嵌套           │
│ • Isolated: 完全隔离，互不干扰               │
│ • Observable: 全链路可追踪                   │
│ • Fault-tolerant: 多层防护，优雅降级         │
└─────────────────────────────────────────────┘
```

---

## 2. 核心架构设计

### 2.1 整体架构图

```
用户/触发器
    │
    ▼
┌──────────────────────────────────┐
│      主 Agent (Parent)            │
│  接收任务并分析复杂度              │
└────────────┬─────────────────────┘
             │
             │ 调用 sessions_spawn
             ▼
┌──────────────────────────────────┐
│   Subagent Spawn System           │
│  src/agents/subagent-spawn.ts     │
│                                   │
│  • 验证深度限制                    │
│  • 检查并发配额                    │
│  • 创建子会话                      │
│  • 配置上下文继承                  │
└────────────┬─────────────────────┘
             │
             │ 注册到注册表
             ▼
┌──────────────────────────────────┐
│  Subagent Registry                │
│  src/agents/subagent-registry.ts  │
│                                   │
│  • 生命周期管理                    │
│  • 状态跟踪                        │
│  • 孤儿检测                        │
│  • 资源清理                        │
└────────────┬─────────────────────┘
             │
             │ 入队到独立 Lane
             ▼
┌──────────────────────────────────┐
│   Lane Queue Manager              │
│  src/process/command-queue.ts     │
│                                   │
│  • 会话内串行                      │
│  • 会话间并行                      │
│  • 资源隔离                        │
└────────────┬─────────────────────┘
             │
             │ 执行
             ▼
┌──────────────────────────────────┐
│   Subagent Execution              │
│  src/agents/pi-embedded-runner/   │
│                                   │
│  • LLM 推理循环                    │
│  • 工具调用                        │
│  • 上下文管理                      │
└────────────┬─────────────────────┘
             │
             │ 完成
             ▼
┌──────────────────────────────────┐
│  Subagent Announce System         │
│  src/agents/subagent-announce.ts  │
│                                   │
│  • 捕获完成结果                    │
│  • 格式化通知消息                  │
│  • 重试投递                        │
│  • 幂等性保证                      │
└────────────┬─────────────────────┘
             │
             │ 通知父代理
             ▼
┌──────────────────────────────────┐
│      主 Agent (Parent)            │
│  接收并整合子任务结果              │
└──────────────────────────────────┘
```

### 2.2 关键组件映射

| 组件 | 核心文件 | 职责 |
|------|---------|------|
| **任务拆分入口** | `src/agents/subagent-spawn.ts` | 验证、创建、配置子代理 |
| **注册表管理** | `src/agents/subagent-registry.ts` | 生命周期、状态跟踪、清理 |
| **通知系统** | `src/agents/subagent-announce.ts` | 结果捕获、格式化、投递 |
| **执行引擎** | `src/agents/pi-embedded-runner/run.ts` | LLM 推理、工具调用 |
| **队列管理** | `src/process/command-queue.ts` | 并发控制、Lane 隔离 |
| **工作流编排** | `src/tasks/task-flow-registry.ts` | 多步骤工作流状态管理 |
| **任务跟踪** | `src/tasks/task-registry.ts` | 后台任务生命周期跟踪 |

---

## 3. 任务拆分策略

### 3.1 拆分决策维度

OpenClaw 支持多种任务拆分方式，根据任务特性选择最优策略：

#### 3.1.1 基于 LLM 的智能拆分

主 Agent 在执行过程中，通过 LLM 分析任务复杂度并自主决定是否需要拆分：

```typescript
// 伪代码示例 - Agent 内部决策逻辑
const complexity = await analyzeTaskComplexity(task);

if (complexity > THRESHOLD) {
  // 拆分为多个子任务
  const subtasks = await decomposeTask(task);
  
  // 并行执行子任务
  for (const subtask of subtasks) {
    await callTool('sessions_spawn', { 
      task: subtask.description,
      agentId: selectOptimalAgent(subtask),
      model: selectOptimalModel(subtask),
      context: 'fork' // 继承部分上下文
    });
  }
}
```

**拆分决策因素：**
- 任务描述的长度和复杂度
- 所需工具调用的数量
- 预期执行时间
- 上下文窗口限制
- 可用模型的能力边界

#### 3.1.2 基于工具调用的显式拆分

Agent 可以通过特定工具主动进行任务分解：

**sessions_spawn 工具**（最核心的拆分机制）：

```typescript
interface SessionsSpawnParams {
  task: string;              // 必需：任务描述
  label?: string;            // 可选：任务标签（用于标识）
  runtime?: "subagent" | "acp";  // 运行时类型
  agentId?: string;          // 目标 Agent ID（默认继承当前）
  model?: string;            // 模型覆盖（如 "anthropic/claude-3-opus"）
  thinking?: string;         // 思考级别（low/medium/high）
  runTimeoutSeconds?: number;// 超时时间（秒）
  thread?: boolean;          // 是否绑定到频道线程
  mode?: "run" | "session";  // 运行模式（一次性 or 持久会话）
  cleanup?: "delete" | "keep"; // 清理策略
  sandbox?: "inherit" | "require"; // 沙箱模式
  context?: "isolated" | "fork"; // 上下文模式
  attachments?: Attachment[]; // 附件传递
}
```

**使用示例：**

```typescript
// 简单拆分 - 研究任务
await sessions_spawn({
  task: "Research quantum computing trends in 2024",
  label: "quantum-research",
  model: "anthropic/claude-3-opus",
  context: "fork"
});

// 并行拆分 - 多语言翻译
const translations = await Promise.all([
  sessions_spawn({
    task: "Translate the document to French",
    agentId: "translator-fr",
    context: "isolated"
  }),
  sessions_spawn({
    task: "Translate the document to Spanish",
    agentId: "translator-es",
    context: "isolated"
  }),
  sessions_spawn({
    task: "Translate the document to German",
    agentId: "translator-de",
    context: "isolated"
  })
]);
```

**llm-task 工具**（用于 Lobster 工作流）：

```typescript
interface LlmTaskParams {
  prompt: string;            // 任务指令
  input?: unknown;           // 输入负载
  schema?: unknown;          // JSON Schema 验证
  provider?: string;         // Provider 覆盖
  model?: string;            // Model 覆盖
  thinking?: string;         // 思考级别
  timeoutMs?: number;        // 超时时间
}
```

#### 3.1.3 基于上下文的自动拆分

当上下文长度接近模型限制时，自动触发**上下文压缩**或**任务分段**：

```typescript
// src/agents/pi-embedded-runner/compact.ts
async function compactContext(params: CompactParams): Promise<CompactResult> {
  // 1. 保留最近的消息
  const recentMessages = messages.slice(-RECENT_MESSAGE_COUNT);
  
  // 2. 压缩历史消息为摘要
  const summary = await summarizeHistory({
    messages: oldMessages,
    model: compressionModel,
  });
  
  // 3. 构建新的上下文
  return [
    { role: "system", content: summary },
    ...recentMessages,
  ];
}
```

### 3.2 OpenProse 声明式编排

OpenProse 提供了一种声明式的任务编排语言，简化复杂工作流的定义：

```prose
# 定义专用 Agent
agent researcher:
  model: opus
  prompt: "You are a research expert"

agent writer:
  model: sonnet
  prompt: "You are a technical writer"

# 并行执行多个子任务
parallel:
  research = session: researcher
    prompt: "Research quantum computing trends"
  
  analysis = session: analyst
    prompt: "Analyze market data"

# 整合结果
output report = session: writer
  prompt: "Synthesize research and analysis"
  context: { research, analysis }
```

**编译后的执行逻辑：**

```typescript
// 并行启动所有 session
const [research, analysis] = await Promise.all([
  Task({
    description: "OpenProse session",
    prompt: "Research quantum computing trends\n\nSystem: You are a research expert",
    subagent_type: "general-purpose",
    model: "opus"
  }),
  Task({
    description: "OpenProse session",
    prompt: "Analyze market data",
    subagent_type: "general-purpose"
  })
]);

// 整合结果
const report = await Task({
  description: "OpenProse session",
  prompt: "Synthesize research and analysis",
  context: { research, analysis }
});
```

---

## 4. sessions_spawn 深度解析

这是**最核心的任务拆分机制**，让我们深入剖析其实现细节。

### 4.1 执行流程详解

```
父 Agent 调用 sessions_spawn
    ↓
┌─────────────────────────────────────┐
│ Step 1: 参数验证                     │
│ • 检查 agentId 格式合法性            │
│ • 解析 mode、context、sandbox 等参数 │
└────────────┬────────────────────────┘
             ↓
┌─────────────────────────────────────┐
│ Step 2: 深度限制检查                  │
│ • 获取当前会话的 spawn depth         │
│ • 对比 maxSpawnDepth（默认 2）       │
│ • 超限则拒绝                          │
└────────────┬────────────────────────┘
             ↓
┌─────────────────────────────────────┐
│ Step 3: 并发限制检查                  │
│ • 统计当前活跃子代理数量              │
│ • 对比 maxChildrenPerAgent（默认 5） │
│ • 超限则拒绝                          │
└────────────┬────────────────────────┘
             ↓
┌─────────────────────────────────────┐
│ Step 4: Agent 权限检查                │
│ • 检查 requireAgentId 配置           │
│ • 验证 allowAgents 白名单            │
│ • 未授权则拒绝                        │
└────────────┬────────────────────────┘
             ↓
┌─────────────────────────────────────┐
│ Step 5: 沙箱兼容性检查                │
│ • 检查父子会话的沙箱状态              │
│ • 沙箱会话不能派生非沙箱子代理        │
│ • 不兼容则拒绝                        │
└────────────┬────────────────────────┘
             ↓
┌─────────────────────────────────────┐
│ Step 6: 生成子会话密钥                │
│ childSessionKey =                   │
│   "agent:{targetAgentId}:           │
│    subagent:{uuid}"                 │
└────────────┬────────────────────────┘
             ↓
┌─────────────────────────────────────┐
│ Step 7: 解析模型和 Thinking 配置     │
│ • 应用 agent 级别的默认配置          │
│ • 处理 override 参数                 │
│ • 验证模型可用性                      │
└────────────┬────────────────────────┘
             ↓
┌─────────────────────────────────────┐
│ Step 8: 初始化子会话状态              │
│ • 设置 spawnDepth                    │
│ • 设置 subagentRole                  │
│ • 设置 subagentControlScope          │
│ • 持久化到 session store             │
└────────────┬────────────────────────┘
             ↓
┌─────────────────────────────────────┐
│ Step 9: 准备上下文环境                │
│ • isolated: 全新空上下文             │
│ • fork: 从父会话分叉部分消息         │
│ • 计算 token 预算                    │
└────────────┬────────────────────────┘
             ↓
┌─────────────────────────────────────┐
│ Step 10: 线程绑定（可选）             │
│ • 如果 thread=true                   │
│ • 调用 channel 插件的                │
│   subagent_spawning hook            │
│ • 创建或绑定线程                      │
└────────────┬────────────────────────┘
             ↓
┌─────────────────────────────────────┐
│ Step 11: 处理附件（可选）             │
│ • 解码 base64 内容                   │
│ • 写入子会话的附件目录                │
│ • 记录文件元数据                      │
└────────────┬────────────────────────┘
             ↓
┌─────────────────────────────────────┐
│ Step 12: 注册到 Subagent Registry    │
│ • 创建 SubagentRunRecord             │
│ • 记录 requesterSessionKey           │
│ • 记录 task、label、model 等信息     │
│ • 设置 createdAt 时间戳              │
└────────────┬────────────────────────┘
             ↓
┌─────────────────────────────────────┐
│ Step 13: 发射生命周期事件             │
│ • emitSessionLifecycleEvent          │
│   ("lifecycle.create")              │
│ • 触发 subagent_spawning Hook        │
└────────────┬────────────────────────┘
             ↓
┌─────────────────────────────────────┐
│ Step 14: 提交任务到 Lane 队列         │
│ • 加入 AGENT_LANE_SUBAGENT           │
│ • 等待调度执行                        │
└────────────┬────────────────────────┘
             ↓
┌─────────────────────────────────────┐
│ Step 15: 返回接受结果                 │
│ {                                    │
│   status: "accepted",                │
│   childSessionKey: "...",            │
│   runId: "...",                      │
│   mode: "run" | "session",           │
│   note: "..."                        │
│ }                                    │
└─────────────────────────────────────┘
```

### 4.2 核心代码实现

```typescript
// src/agents/subagent-spawn.ts

export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
  const task = params.task;
  const label = params.label?.trim() || "";
  const requestedAgentId = params.agentId?.trim();

  // === Step 1: 验证 agentId 格式 ===
  if (requestedAgentId && !isValidAgentId(requestedAgentId)) {
    return {
      status: "error",
      error: `Invalid agentId "${requestedAgentId}". Agent IDs must match [a-z0-9][a-z0-9_-]{0,63}.`,
    };
  }

  // === 解析配置参数 ===
  const spawnMode = resolveSpawnMode({
    requestedMode: params.mode,
    threadRequested: params.thread === true,
  });
  const contextMode = params.context === "fork" ? "fork" : "isolated";
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const cleanup = spawnMode === "session" ? "keep" : (params.cleanup ?? "keep");

  // === 加载配置 ===
  const cfg = loadConfig();
  const requesterSessionKey = ctx.agentSessionKey;
  
  // === Step 2: 深度限制检查 ===
  const callerDepth = getSubagentDepthFromSessionStore(requesterSessionKey, { cfg });
  const maxSpawnDepth = cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? 2;
  
  if (callerDepth >= maxSpawnDepth) {
    return {
      status: "forbidden",
      error: `sessions_spawn is not allowed at this depth (current: ${callerDepth}, max: ${maxSpawnDepth})`,
    };
  }

  // === Step 3: 并发限制检查 ===
  const maxChildren = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5;
  const activeChildren = countActiveRunsForSession(requesterSessionKey);
  
  if (activeChildren >= maxChildren) {
    return {
      status: "forbidden",
      error: `Max active children reached (${activeChildren}/${maxChildren})`,
    };
  }

  // === Step 4: Agent 权限检查 ===
  const targetAgentId = requestedAgentId 
    ? normalizeAgentId(requestedAgentId) 
    : parseAgentSessionKey(requesterSessionKey)?.agentId;
  
  const allowAgents = cfg.agents?.defaults?.subagents?.allowAgents ?? [];
  const allowAny = allowAgents.some((value) => value.trim() === "*");
  
  if (!allowAny && !allowAgents.includes(targetAgentId)) {
    return {
      status: "forbidden",
      error: `agentId is not allowed (allowed: ${allowAgents.join(", ") || "none"})`,
    };
  }

  // === Step 5: 沙箱兼容性检查 ===
  const requesterRuntime = resolveSandboxRuntimeStatus({ cfg, sessionKey: requesterSessionKey });
  const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
  const childRuntime = resolveSandboxRuntimeStatus({ cfg, sessionKey: childSessionKey });
  
  if (!childRuntime.sandboxed && (requesterRuntime.sandboxed || sandboxMode === "require")) {
    return {
      status: "forbidden",
      error: "Sandboxed sessions cannot spawn unsandboxed subagents.",
    };
  }

  // === Step 6-7: 解析模型配置 ===
  const plan = resolveSubagentModelAndThinkingPlan({
    cfg,
    targetAgentId,
    modelOverride: params.model,
    thinkingOverrideRaw: params.thinking,
  });
  
  if (plan.status === "error") {
    return { status: "error", error: plan.error };
  }

  // === Step 8: 初始化子会话状态 ===
  const childDepth = callerDepth + 1;
  const childCapabilities = resolveSubagentCapabilities({
    depth: childDepth,
    maxSpawnDepth,
  });
  
  await patchChildSession({
    spawnDepth: childDepth,
    subagentRole: childCapabilities.role === "main" ? null : childCapabilities.role,
    subagentControlScope: childCapabilities.controlScope,
    ...plan.initialSessionPatch,
  });

  // === Step 9: 准备上下文环境 ===
  const preparedSpawnContext = await prepareSubagentSessionContext({
    cfg,
    contextMode,
    requesterInternalKey: requesterSessionKey,
    childSessionKey,
  });
  
  if (preparedSpawnContext.status === "error") {
    await cleanupProvisionalSession(childSessionKey);
    return {
      status: "error",
      error: preparedSpawnContext.error,
      childSessionKey,
    };
  }

  // === Step 10: 线程绑定（如果需要）===
  if (params.thread) {
    const bindResult = await ensureThreadBindingForSubagentSpawn({
      hookRunner: getGlobalHookRunner(),
      childSessionKey,
      agentId: targetAgentId,
      label,
      mode: spawnMode,
      requesterSessionKey,
      requester: { /* ... */ },
    });
    
    if (bindResult.status === "error") {
      await cleanupProvisionalSession(childSessionKey);
      return { status: "error", error: bindResult.error, childSessionKey };
    }
  }

  // === Step 11: 处理附件 ===
  let attachmentReceipt: SubagentAttachmentReceipt | undefined;
  if (params.attachments?.length) {
    attachmentReceipt = await materializeSubagentAttachments({
      childSessionKey,
      attachments: params.attachments,
      attachMountPath: params.attachMountPath,
    });
  }

  // === Step 12: 注册到 Subagent Registry ===
  const runId = crypto.randomUUID();
  registerSubagentRun({
    runId,
    childSessionKey,
    controllerSessionKey: requesterSessionKey,
    requesterSessionKey,
    requesterDisplayKey: resolveDisplaySessionKey({ key: requesterSessionKey }),
    task,
    cleanup,
    label,
    model: plan.resolvedModel,
    runTimeoutSeconds: params.runTimeoutSeconds,
    spawnMode,
    expectsCompletionMessage: params.expectsCompletionMessage !== false,
    attachmentsDir: attachmentReceipt?.relDir,
  });

  // === Step 13: 发射生命周期事件 ===
  emitSessionLifecycleEvent("lifecycle.create", {
    sessionKey: childSessionKey,
    metadata: {
      parentSessionKey: requesterSessionKey,
      task,
      label,
    },
  });

  // === Step 14: 提交到 Lane 队列 ===
  // （由 Pi Embedded Runner 自动处理）

  // === Step 15: 返回结果 ===
  return {
    status: "accepted",
    childSessionKey,
    runId,
    mode: spawnMode,
    modelApplied: !!plan.resolvedModel,
    note: resolveSubagentSpawnAcceptedNote({ spawnMode, label }),
    attachments: attachmentReceipt ? {
      count: attachmentReceipt.files.length,
      totalBytes: attachmentReceipt.totalBytes,
      files: attachmentReceipt.files,
      relDir: attachmentReceipt.relDir,
    } : undefined,
  };
}
```

### 4.3 深度与并发限制详解

#### 深度限制防止无限递归

```typescript
// 计算当前会话的 spawn 深度
const callerDepth = getSubagentDepthFromSessionStore(requesterSessionKey, { cfg });

// 默认最大深度为 2
const maxSpawnDepth = cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? 2;

if (callerDepth >= maxSpawnDepth) {
  return {
    status: "forbidden",
    error: `Maximum spawn depth (${maxSpawnDepth}) reached`,
  };
}

// 子代理的深度 = 父代理深度 + 1
const childDepth = callerDepth + 1;
```

**深度层级示例：**

```
Level 0: 主 Agent (agent:main:main)
  └─ Level 1: 子代理 A (agent:main:subagent:uuid-1)
       └─ Level 2: 孙代理 B (agent:main:subagent:uuid-2)  ← 最后一层
            └─ ❌ 无法再派生（达到 maxDepth=2）
```

#### 并发限制防止资源耗尽

```typescript
// 统计当前活跃的子代理数量
const activeChildren = countActiveRunsForSession(requesterSessionKey);

// 默认最大并发数为 5
const maxChildren = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5;

if (activeChildren >= maxChildren) {
  return {
    status: "forbidden",
    error: `Max active children reached (${activeChildren}/${maxChildren})`,
  };
}
```

**并发控制示例：**

```
主 Agent (agent:main:main)
  ├─ ✅ 子代理 1 (running)
  ├─ ✅ 子代理 2 (running)
  ├─ ✅ 子代理 3 (running)
  ├─ ✅ 子代理 4 (running)
  ├─ ✅ 子代理 5 (running)  ← 已达上限
  └─ ❌ 子代理 6 (rejected - Max active children reached 5/5)
```

---

## 5. 子代理生命周期管理

### 5.1 Subagent Registry 核心功能

Subagent Registry 是整个子代理系统的**中枢神经**，负责管理所有子代理的生命周期。

**核心文件：** `src/agents/subagent-registry.ts`

**主要职责：**

1. **注册管理**：记录每个子代理的创建信息
2. **状态跟踪**：实时监控子代理的运行状态
3. **孤儿检测**：发现并清理孤立的子代理会话
4. **资源清理**：任务完成后自动释放资源
5. **持久化存储**：将注册表保存到磁盘，支持重启恢复

### 5.2 子代理运行记录结构

```typescript
// src/agents/subagent-registry.types.ts

export type SubagentRunRecord = {
  // === 基本信息 ===
  runId: string;                        // 唯一运行 ID
  childSessionKey: string;              // 子会话密钥
  controllerSessionKey?: string;        // 控制器会话密钥
  requesterSessionKey: string;          // 请求者会话密钥
  requesterDisplayKey: string;          // 显示用会话密钥
  
  // === 任务信息 ===
  task: string;                         // 任务描述
  label?: string;                       // 任务标签
  model?: string;                       // 使用的模型
  
  // === 配置信息 ===
  cleanup: "delete" | "keep";          // 清理策略
  spawnMode?: SpawnSubagentMode;        // 派生模式
  runTimeoutSeconds?: number;           // 超时时间
  
  // === 时间戳 ===
  createdAt: number;                    // 创建时间
  startedAt?: number;                   // 开始时间
  endedAt?: number;                     // 结束时间
  
  // === 结果信息 ===
  outcome?: SubagentRunOutcome;         // 运行结果
  endedReason?: SubagentLifecycleEndedReason; // 结束原因
  
  // === 通知相关 ===
  expectsCompletionMessage?: boolean;   // 是否期待完成消息
  announceRetryCount?: number;          // 通知重试次数
  lastAnnounceRetryAt?: number;         // 最后重试时间
  
  // === 附件相关 ===
  attachmentsDir?: string;              // 附件目录
  retainAttachmentsOnKeep?: boolean;    // keep 模式下是否保留附件
};
```

### 5.3 生命周期状态机

```
                    ┌──────────────┐
                    │   Created    │
                    │  (registered)│
                    └──────┬───────┘
                           │
                           │ start execution
                           ▼
                    ┌──────────────┐
              ┌────▶│   Running    │◀─────┐
              │     │  (executing) │      │
              │     └──────┬───────┘      │
              │            │              │
              │     ┌──────┴───────┐      │
              │     │   Steered    │      │
              │     │  (restarted) │      │
              │     └──────┬───────┘      │
              │            │              │
              │     ┌──────┴───────┐      │
              │     │   Waiting    │      │
              │     │ (descendants)│      │
              │     └──────┬───────┘      │
              │            │              │
              │     ┌──────┴───────┐      │
              │     │   Ended      │──────┘
              │     │  (completed) │  retry
              │     └──────┬───────┘
              │            │
              │     ┌──────┴───────┐
              │     │  Announcing  │
              │     │  (delivering)│
              │     └──────┬───────┘
              │            │
              │     ┌──────┴───────┐
              └────▶│   Cleanup    │
                    │  (removing)  │
                    └──────────────┘
```

### 5.4 孤儿检测与清理

**问题场景：** 当父代理会话被删除或崩溃时，子代理可能变成"孤儿"，继续占用资源。

**解决方案：**

```typescript
// src/agents/subagent-registry-helpers.ts

export function reconcileOrphanedRestoredRuns(): void {
  const runs = getSubagentRunsSnapshotForRead();
  
  for (const run of runs) {
    // 检查父会话是否仍然存在
    const parentExists = hasUsableSessionEntry(run.requesterSessionKey);
    
    if (!parentExists) {
      log.warn("Detected orphaned subagent run", {
        runId: run.runId,
        childSessionKey: run.childSessionKey,
        requesterSessionKey: run.requesterSessionKey,
      });
      
      // 标记为孤儿并安排清理
      markRunAsOrphaned(run.runId);
      scheduleCleanup(run.childSessionKey);
    }
  }
}
```

**清理策略：**

```typescript
// 根据 cleanup 配置决定是否删除会话
if (run.cleanup === "delete") {
  await callGateway({
    method: "sessions.delete",
    params: { key: run.childSessionKey },
  });
  
  // 删除附件目录
  if (run.attachmentsDir) {
    await safeRemoveAttachmentsDir(run.attachmentsDir);
  }
} else {
  // keep 模式下保留会话，但标记为已完成
  markRunAsCompleted(run.runId);
}
```

### 5.5 持久化与恢复

**持久化存储：**

```typescript
// src/agents/subagent-registry-state.ts

const REGISTRY_FILE = "subagent-runs.json";

export async function persistSubagentRunsToDisk(): Promise<void> {
  const snapshot = getSubagentRunsSnapshotForRead();
  const filePath = path.join(getStateDir(), REGISTRY_FILE);
  
  await fs.writeFile(
    filePath,
    JSON.stringify(snapshot, null, 2),
    "utf-8"
  );
}
```

**启动时恢复：**

```typescript
export async function restoreSubagentRunsFromDisk(): Promise<void> {
  const filePath = path.join(getStateDir(), REGISTRY_FILE);
  
  try {
    const data = await fs.readFile(filePath, "utf-8");
    const runs = JSON.parse(data);
    
    for (const run of runs) {
      // 检查会话是否仍然活跃
      if (isSubagentSessionRunActive(run.childSessionKey)) {
        registerSubagentRun(run);
      } else {
        // 会话已结束，安排清理
        scheduleCleanup(run.childSessionKey);
      }
    }
  } catch (err) {
    log.warn("Failed to restore subagent runs from disk", { error: err });
  }
}
```

---

## 6. 结果通知与整合

### 6.1 Announce 系统架构

子代理完成后，通过 **Announce 系统**向父代理报告结果。这是一个可靠的消息投递机制，支持重试和幂等性保证。

**核心文件：** `src/agents/subagent-announce.ts`

**工作流程：**

```
子代理执行完成
    │
    ▼
┌──────────────────────────────────┐
│  captureSubagentCompletionReply  │
│  • 读取子代理输出                 │
│  • 提取关键结果                   │
│  • 过滤静默令牌                   │
└────────────┬─────────────────────┘
             │
             ▼
┌──────────────────────────────────┐
│  buildAnnounceMessage            │
│  • 格式化结果                     │
│  • 添加元数据                     │
│  • 生成 idempotency key          │
└────────────┬─────────────────────┘
             │
             ▼
┌──────────────────────────────────┐
│  deliverSubagentAnnouncement     │
│  • 发送到父会话                   │
│  • 重试失败投递                   │
│  • 指数退避                       │
└────────────┬─────────────────────┘
             │
             ▼
┌──────────────────────────────────┐
│  Parent Agent Receives           │
│  • 解析通知消息                   │
│  • 整合到上下文                   │
│  • 继续工作流                     │
└──────────────────────────────────┘
```

### 6.2 捕获完成结果

```typescript
// src/agents/subagent-announce-output.ts

export async function captureSubagentCompletionReply(
  childSessionKey: string,
  options?: { timeoutMs?: number }
): Promise<SubagentRunOutcome | undefined> {
  // 1. 等待子代理运行结束
  const outcome = await waitForSubagentRunOutcome({
    childSessionKey,
    timeoutMs: options?.timeoutMs ?? 300_000, // 默认 5 分钟
  });
  
  if (!outcome) {
    log.warn("Subagent run timed out", { childSessionKey });
    return undefined;
  }
  
  // 2. 读取子代理的输出
  const output = await readSubagentOutput({
    childSessionKey,
    runId: outcome.runId,
  });
  
  // 3. 过滤静默令牌（silent token）
  const cleanedOutput = stripSilentToken(output.text, SILENT_REPLY_TOKEN);
  
  // 4. 构建结果对象
  return {
    status: outcome.status,
    text: cleanedOutput,
    runId: outcome.runId,
    endedAt: outcome.endedAt,
    attachments: outcome.attachments,
  };
}
```

### 6.3 格式化通知消息

```typescript
// src/agents/subagent-announce.ts

function buildAnnounceReplyInstruction(params: {
  requesterIsSubagent: boolean;
  announceType: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
}): string {
  if (params.requesterIsSubagent) {
    // 子代理 → 父代理：内部编排更新
    return `Convert this completion into a concise internal orchestration update for your parent agent in your own words. Keep this internal context private. If this result is duplicate or no update is needed, reply ONLY: ${SILENT_REPLY_TOKEN}.`;
  }
  
  if (params.expectsCompletionMessage) {
    // 直接发送给用户
    return `A completed ${params.announceType} is ready for user delivery. Convert the result above into your normal assistant voice and send that user-facing update now.`;
  }
  
  // 默认行为
  return `A completed ${params.announceType} is ready for user delivery. Convert the result above into your normal assistant voice and send that user-facing update now, and do not copy the internal event text verbatim. Reply ONLY: ${SILENT_REPLY_TOKEN} if this exact result was already delivered to the user in this same turn.`;
}
```

### 6.4 可靠投递与重试

```typescript
// src/agents/subagent-announce-delivery.ts

export async function runAnnounceDeliveryWithRetry<T>(params: {
  operation: string;
  signal?: AbortSignal;
  run: () => Promise<T>;
  maxRetries?: number;
  baseDelayMs?: number;
}): Promise<T> {
  const maxRetries = params.maxRetries ?? 3;
  const baseDelayMs = params.baseDelayMs ?? 1000;
  
  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (params.signal?.aborted) {
      throw new Error("Announce delivery aborted");
    }
    
    try {
      return await params.run();
    } catch (err) {
      lastError = err as Error;
      log.warn(`Announce delivery attempt ${attempt + 1} failed`, {
        operation: params.operation,
        error: err,
      });
      
      if (attempt < maxRetries) {
        // 指数退避：1s, 2s, 4s, 8s
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        await sleep(delayMs);
      }
    }
  }
  
  throw lastError ?? new Error("Announce delivery failed after retries");
}
```

### 6.5 幂等性保证

为了防止重复通知，系统使用 **idempotency key**：

```typescript
// src/agents/announce-idempotency.ts

export function buildAnnounceIdempotencyKey(announceId: string): string {
  return `subagent-announce:${announceId}`;
}

export function buildAnnounceIdFromChildRun(run: SubagentRunRecord): string {
  return `${run.childSessionKey}:${run.runId}`;
}

// 使用时
const announceId = buildAnnounceIdFromChildRun(run);
const idempotencyKey = buildAnnounceIdempotencyKey(announceId);

await callGateway({
  method: "agent",
  params: {
    sessionKey: parentSessionKey,
    message: announceMessage,
    idempotencyKey, // ← 确保同一通知只投递一次
  },
});
```

### 6.6 后代唤醒机制

当子代理等待其子代理（后代）完成时，需要特殊的唤醒机制：

```typescript
// src/agents/subagent-announce.ts

async function wakeSubagentRunAfterDescendants(params: {
  runId: string;
  childSessionKey: string;
  taskLabel: string;
  findings: string;
  announceId: string;
}): Promise<boolean> {
  const wakeMessage = buildDescendantWakeMessage({
    findings: params.findings,
    taskLabel: params.taskLabel,
  });
  
  // 发送唤醒消息
  const wakeResponse = await runAnnounceDeliveryWithRetry({
    operation: "descendant wake agent call",
    run: async () =>
      await callGateway({
        method: "agent",
        params: {
          sessionKey: params.childSessionKey,
          message: wakeMessage,
          deliver: false,
          idempotencyKey: buildAnnounceIdempotencyKey(`${params.announceId}:wake`),
        },
      }),
  });
  
  return !!wakeResponse?.runId;
}

function buildDescendantWakeMessage(params: {
  findings: string;
  taskLabel: string;
}): string {
  return [
    "[Subagent Context] Your prior run ended while waiting for descendant subagent completions.",
    "[Subagent Context] All pending descendants for that run have now settled.",
    "[Subagent Context] Continue your workflow using these results. Spawn more subagents if needed, otherwise send your final answer.",
    "",
    `Task: ${params.taskLabel}`,
    "",
    params.findings,
  ].join("\n");
}
```

---

## 7. 并发控制与资源保护

### 7.1 Lane 队列管理系统

Lane 队列是 OpenClaw 的**并发控制核心**，确保任务有序执行并避免资源竞争。

**核心文件：** `src/process/command-queue.ts`

**Lane 类型：**

```typescript
// src/process/lanes.ts

export enum CommandLane {
  MAIN = "main",                    // 主会话 Lane
  SUBAGENT = "subagent",            // 子代理 Lane
  CRON = "cron",                    // Cron 任务 Lane
  CLI = "cli",                      // CLI 命令 Lane
  CHANNEL_PREFIX = "channel:",      // 频道专属 Lane（如 channel:whatsapp）
}
```

**工作原理：**

```
┌─────────────────────────────────────────────┐
│              Lane Queue Manager              │
├─────────────────────────────────────────────┤
│                                             │
│  Lane: main                                 │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐      │
│  │ Task 1  │→│ Task 2  │→│ Task 3  │      │
│  └─────────┘ └─────────┘ └─────────┘      │
│   (串行执行)                                │
│                                             │
│  Lane: subagent                             │
│  ┌─────────┐ ┌─────────┐                  │
│  │ Sub 1   │→│ Sub 2   │                  │
│  └─────────┘ └─────────┘                  │
│   (串行执行)                                │
│                                             │
│  Lane: cron                                 │
│  ┌─────────┐ ┌─────────┐                  │
│  │ Cron 1  │→│ Cron 2  │                  │
│  └─────────┘ └─────────┘                  │
│   (串行执行)                                │
│                                             │
│  不同 Lane 之间可以并行执行                  │
└─────────────────────────────────────────────┘
```

### 7.2 会话级串行，会话间并行

```typescript
// src/process/command-queue.ts

class CommandQueueManager {
  private lanes = new Map<string, CommandLane>();
  
  // 将命令加入队列
  async enqueue(command: Command): Promise<void> {
    const lane = this.resolveLane(command);
    
    // 同一 Lane 内的命令串行执行
    await lane.enqueue(async () => {
      await this.executeCommand(command);
    });
  }
  
  // 解析 Lane
  private resolveLane(command: Command): CommandLane {
    const sessionKey = command.sessionKey;
    
    // 子代理使用专用的 subagent Lane
    if (sessionKey.includes(":subagent:")) {
      return this.getOrCreateLane(CommandLane.SUBAGENT);
    }
    
    // Cron 任务使用专用的 cron Lane
    if (isCronSessionKey(sessionKey)) {
      return this.getOrCreateLane(CommandLane.CRON);
    }
    
    // 其他会话使用基于会话密钥的 Lane
    return this.getOrCreateLane(`session:${sessionKey}`);
  }
}
```

**实际效果：**

```
时间轴 →

Lane main:        [Task A ...........] [Task B .........]
Lane subagent:    [Sub 1 ..] [Sub 2 ..] [Sub 3 ..]
Lane cron:        [Cron 1 ............] [Cron 2 ..]

                  ↑ 不同 Lane 并行执行
                  ↑ 同一 Lane 内串行执行
```

### 7.3 超时控制

子代理支持多种超时机制：

```typescript
// src/agents/subagent-spawn-plan.ts

export function resolveConfiguredSubagentRunTimeoutSeconds(params: {
  cfg: OpenClawConfig;
  runTimeoutSeconds?: number;
}): number {
  // 1. 优先使用调用方指定的超时时间
  if (params.runTimeoutSeconds !== undefined) {
    return params.runTimeoutSeconds;
  }
  
  // 2. 其次使用配置文件的默认值
  return params.cfg.agents?.defaults?.subagents?.runTimeoutSeconds ?? 0; // 0 表示无超时
}
```

**超时处理：**

```typescript
// src/agents/pi-embedded-runner/run.ts

async function executeWithTimeout(params: {
  sessionKey: string;
  timeoutSeconds: number;
}): Promise<ExecutionResult> {
  if (params.timeoutSeconds <= 0) {
    // 无超时限制
    return await executeWithoutTimeout(params.sessionKey);
  }
  
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new TimeoutError(`Execution timed out after ${params.timeoutSeconds}s`));
    }, params.timeoutSeconds * 1000);
  });
  
  return await Promise.race([
    executeWithoutTimeout(params.sessionKey),
    timeoutPromise,
  ]);
}
```

### 7.4 沙箱隔离

子代理可以在独立的沙箱环境中运行，提供额外的安全保障：

```typescript
// src/agents/subagent-spawn.ts

// 沙箱兼容性检查
const requesterRuntime = resolveSandboxRuntimeStatus({ 
  cfg, 
  sessionKey: requesterSessionKey 
});

const childRuntime = resolveSandboxRuntimeStatus({ 
  cfg, 
  sessionKey: childSessionKey 
});

// 沙箱会话不能派生非沙箱子代理
if (!childRuntime.sandboxed && (requesterRuntime.sandboxed || sandboxMode === "require")) {
  return {
    status: "forbidden",
    error: "Sandboxed sessions cannot spawn unsandboxed subagents.",
  };
}
```

**沙箱模式：**

```typescript
type SandboxMode = 
  | "inherit"   // 继承父会话的沙箱配置
  | "require";  // 强制要求沙箱环境
```

---

## 8. 上下文继承与隔离

### 8.1 两种上下文模式

OpenClaw 支持两种上下文继承策略：

```typescript
type SpawnSubagentContextMode = 
  | "isolated"   // 完全隔离，无上下文
  | "fork";      // 分叉，继承部分上下文
```

#### 8.1.1 Isolated 模式（完全隔离）

```typescript
// 创建全新的空会话
const childSession = {
  sessionKey: childSessionKey,
  messages: [], // 空消息列表
  metadata: {
    spawnDepth: childDepth,
    subagentRole: "worker",
  },
};
```

**适用场景：**
- 独立的研究任务
- 不需要父会话背景信息的任务
- 需要完全隔离环境的任务

#### 8.1.2 Fork 模式（分叉继承）

```typescript
// src/agents/subagent-spawn.runtime.ts

async function forkSessionFromParent(params: {
  parentSessionKey: string;
  childSessionKey: string;
  maxTokens?: number;
}): Promise<void> {
  // 1. 获取父会话消息
  const parentMessages = await getSessionMessages(parentSessionKey);
  
  // 2. 选择要继承的消息（通常是最近的 N 条）
  const inheritedMessages = selectMessagesForFork(
    parentMessages,
    params.maxTokens ?? 10000 // 默认 10k tokens
  );
  
  // 3. 创建子会话并注入消息
  await createSession({
    sessionKey: params.childSessionKey,
    messages: inheritedMessages,
    metadata: {
      forkedFrom: parentSessionKey,
      spawnDepth: childDepth,
    },
  });
}

function selectMessagesForFork(
  messages: Message[],
  maxTokens: number
): Message[] {
  // 从后往前选择消息，直到达到 token 限制
  const selected: Message[] = [];
  let totalTokens = 0;
  
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(messages[i]);
    
    if (totalTokens + msgTokens > maxTokens) {
      break;
    }
    
    selected.unshift(messages[i]);
    totalTokens += msgTokens;
  }
  
  return selected;
}
```

**适用场景：**
- 需要延续父会话上下文的任务
- 基于之前讨论的后续工作
- 需要参考历史对话的任务

### 8.2 上下文分叉示例

```
父会话消息历史：
┌─────────────────────────────────────┐
│ User: 帮我研究量子计算的最新进展      │
│ Agent: 好的，我来帮你...             │
│ User: 重点关注 2024 年的突破         │
│ Agent: 2024 年有几个重要突破...      │
│ User: 能详细说说 IBM 的贡献吗？      │
│ Agent: IBM 在 2024 年...            │
└─────────────────────────────────────┘
                    │
                    │ fork (maxTokens=5000)
                    ▼
子会话继承的消息：
┌─────────────────────────────────────┐
│ User: 重点关注 2024 年的突破         │
│ Agent: 2024 年有几个重要突破...      │
│ User: 能详细说说 IBM 的贡献吗？      │
│ Agent: IBM 在 2024 年...            │
└─────────────────────────────────────┘
                    │
                    │ 新任务
                    ▼
子会话新任务：
┌─────────────────────────────────────┐
│ Task: 详细分析 IBM 在量子计算领域的   │
│       技术路线和未来规划              │
└─────────────────────────────────────┘
```

### 8.3 工作空间继承

子代理还可以继承父代理的工作空间（文件系统访问权限）：

```typescript
// src/agents/spawned-context.ts

export function resolveSpawnedWorkspaceInheritance(params: {
  parentSessionKey: string;
  childSessionKey: string;
}): WorkspaceInheritance {
  const parentWorkspace = getWorkspaceForSession(params.parentSessionKey);
  
  return {
    // 继承父会话的工作空间目录
    workspaceDir: parentWorkspace.dir,
    
    // 选择性挂载子目录
    mounts: parentWorkspace.mounts.filter(mount => 
      mount.readOnly || isAllowedForSubagent(mount)
    ),
    
    // 环境变量继承
    envVars: filterSensitiveEnvVars(parentWorkspace.envVars),
  };
}
```

---

## 9. 典型使用场景

### 9.1 场景一：并行研究任务

**需求：** 同时研究多个主题并整合结果

```typescript
// 主 Agent 执行逻辑

// 1. 并行启动三个研究子代理
const [aiResearch, bioResearch, spaceResearch] = await Promise.all([
  sessions_spawn({
    task: "Research latest AI breakthroughs in 2024",
    label: "ai-research",
    model: "anthropic/claude-3-opus",
    context: "isolated",
  }),
  sessions_spawn({
    task: "Research biotechnology advances in 2024",
    label: "bio-research",
    model: "anthropic/claude-3-opus",
    context: "isolated",
  }),
  sessions_spawn({
    task: "Research space exploration milestones in 2024",
    label: "space-research",
    model: "anthropic/claude-3-opus",
    context: "isolated",
  }),
]);

// 2. 等待所有子代理完成（自动通过 announce 通知）

// 3. 整合结果并生成报告
const finalReport = await generateReport({
  sections: [aiResearch, bioResearch, spaceResearch],
});

sendToUser(finalReport);
```

### 9.2 场景二：多语言翻译流水线

**需求：** 将文档翻译成多种语言

```typescript
// 1. 读取源文档
const sourceDoc = await readFile("document.md");

// 2. 并行翻译
const languages = ["fr", "es", "de", "ja", "zh"];
const translations = await Promise.all(
  languages.map(lang =>
    sessions_spawn({
      task: `Translate the following document to ${lang}:\n\n${sourceDoc}`,
      label: `translate-${lang}`,
      agentId: `translator-${lang}`,
      context: "isolated",
      cleanup: "delete", // 翻译完成后删除会话
    })
  )
);

// 3. 保存翻译结果
for (let i = 0; i < languages.length; i++) {
  await writeFile(`document.${languages[i]}.md`, translations[i].text);
}
```

### 9.3 场景三：代码审查工作流

**需求：** 对代码库进行全面审查

```typescript
// 1. 获取代码变更列表
const changes = await gitDiff();

// 2. 按模块拆分审查任务
const modules = groupChangesByModule(changes);

// 3. 并行审查各模块
const reviews = await Promise.all(
  Object.entries(modules).map(([module, diffs]) =>
    sessions_spawn({
      task: `Review code changes in ${module} module:\n\n${diffs}\n\nFocus on: security, performance, best practices`,
      label: `review-${module}`,
      agentId: "code-reviewer",
      model: "anthropic/claude-3-opus",
      context: "isolated",
      attachments: [
        {
          name: "diffs.txt",
          content: diffs,
          encoding: "utf8",
        },
      ],
    })
  )
);

// 4. 整合审查意见
const consolidatedReview = consolidateReviews(reviews);

// 5. 生成审查报告
generateReviewReport(consolidatedReview);
```

### 9.4 场景四：数据分析管道

**需求：** 处理大规模数据集并生成洞察

```typescript
// 1. 数据预处理
const preprocessedData = await sessions_spawn({
  task: "Clean and preprocess the dataset: handle missing values, normalize formats",
  label: "data-preprocessing",
  agentId: "data-engineer",
});

// 2. 并行分析不同维度
const analyses = await Promise.all([
  sessions_spawn({
    task: "Perform statistical analysis on user engagement metrics",
    label: "engagement-analysis",
    agentId: "data-analyst",
    attachments: [{ name: "data.csv", content: preprocessedData.text }],
  }),
  sessions_spawn({
    task: "Analyze revenue trends and forecast next quarter",
    label: "revenue-analysis",
    agentId: "data-analyst",
    attachments: [{ name: "data.csv", content: preprocessedData.text }],
  }),
  sessions_spawn({
    task: "Identify customer segmentation patterns",
    label: "segmentation-analysis",
    agentId: "data-analyst",
    attachments: [{ name: "data.csv", content: preprocessedData.text }],
  }),
]);

// 3. 综合洞察
const insights = await sessions_spawn({
  task: "Synthesize all analysis results into actionable business insights",
  label: "insight-synthesis",
  agentId: "business-analyst",
  context: "fork", // 继承之前的分析结果
});

// 4. 生成可视化报告
generateDashboard(insights.text);
```

### 9.5 场景五：自动化测试套件

**需求：** 运行全面的测试并汇总结果

```typescript
// 1. 并行运行不同类型的测试
const testResults = await Promise.all([
  sessions_spawn({
    task: "Run unit tests and report failures",
    label: "unit-tests",
    agentId: "test-runner",
    sandbox: "require", // 在沙箱中运行
  }),
  sessions_spawn({
    task: "Run integration tests against staging environment",
    label: "integration-tests",
    agentId: "test-runner",
    sandbox: "require",
  }),
  sessions_spawn({
    task: "Run E2E tests with Playwright",
    label: "e2e-tests",
    agentId: "test-runner",
    sandbox: "require",
  }),
  sessions_spawn({
    task: "Run performance benchmarks",
    label: "perf-tests",
    agentId: "test-runner",
    sandbox: "require",
  }),
]);

// 2. 汇总测试结果
const summary = summarizeTestResults(testResults);

// 3. 如果有失败，深入分析
if (summary.failedTests > 0) {
  await sessions_spawn({
    task: `Analyze failing tests and suggest fixes:\n\n${summary.failures}`,
    label: "failure-analysis",
    agentId: "debug-expert",
  });
}

// 4. 发送测试报告
sendTestReport(summary);
```

---

## 10. 最佳实践

### 10.1 合理设置深度限制

**建议：** 保持 `maxSpawnDepth` 在 2-3 之间

```yaml
# config.yaml
agents:
  defaults:
    subagents:
      maxSpawnDepth: 2  # 推荐值
```

**原因：**
- 过深的嵌套会导致调试困难
- 增加资源消耗和延迟
- 错误传播链过长

### 10.2 选择合适的模型

根据任务难度选择模型：

```typescript
// 高难度推理任务
sessions_spawn({
  task: "Complex architectural design",
  model: "anthropic/claude-3-opus", // 强大但昂贵
});

// 常规任务
sessions_spawn({
  task: "Code review",
  model: "anthropic/claude-3-sonnet", // 性价比高
});

// 简单任务
sessions_spawn({
  task: "Format validation",
  model: "anthropic/claude-3-haiku", // 快速便宜
});
```

### 10.3 使用 Lane 隔离

将不同类型任务分配到不同 Lane：

```typescript
// 长时间运行的任务使用独立 Lane
sessions_spawn({
  task: "Generate comprehensive report",
  // 自动进入 subagent Lane
});

// 避免在主 Lane 中执行耗时操作
// ❌ 不好
await longRunningTask();

// ✅ 好
await sessions_spawn({
  task: "Long running task",
  mode: "session",
});
```

### 10.4 监控任务状态

定期检查 TaskFlow 和 Task Registry：

```bash
# 查看活跃任务
openclaw tasks list --status running

# 查看特定工作流
openclaw taskflow show <flow-id>

# 查看子代理状态
openclaw subagents list
```

### 10.5 配置重试策略

为关键任务设置合理的重试：

```yaml
# config.yaml
agents:
  defaults:
    subagents:
      announce:
        maxRetries: 3
        baseDelayMs: 1000
```

### 10.6 及时清理无用会话

```typescript
// 一次性任务使用 delete 清理
sessions_spawn({
  task: "Quick calculation",
  cleanup: "delete", // 完成后自动删除
});

// 需要后续交互的任务使用 keep
sessions_spawn({
  task: "Interactive debugging session",
  cleanup: "keep", // 保留会话
  mode: "session",
});
```

### 10.7 使用标签便于追踪

```typescript
sessions_spawn({
  task: "Research topic",
  label: "research-2024-q1", // 清晰的标签
});

// 后续可以通过标签查询
const runs = listSubagentRuns({ label: "research-2024-q1" });
```

### 10.8 附件传递最佳实践

```typescript
// ✅ 好的做法：明确指定编码和 MIME 类型
sessions_spawn({
  task: "Analyze this data",
  attachments: [
    {
      name: "dataset.csv",
      content: base64Encode(csvContent),
      encoding: "base64",
      mimeType: "text/csv",
    },
  ],
});

// ❌ 不好的做法：缺少元数据
sessions_spawn({
  task: "Analyze this data",
  attachments: [
    {
      name: "data",
      content: csvContent,
      // 缺少 encoding 和 mimeType
    },
  ],
});
```

### 10.9 错误处理与降级

```typescript
try {
  const result = await sessions_spawn({
    task: "Critical analysis",
    model: "anthropic/claude-3-opus",
  });
  
  if (result.status === "accepted") {
    // 等待结果
    await waitForCompletion(result.childSessionKey);
  } else {
    // 降级到备用方案
    console.warn("Spawn failed:", result.error);
    await fallbackAnalysis();
  }
} catch (error) {
  // 异常处理
  console.error("Unexpected error:", error);
  await emergencyProcedure();
}
```

### 10.10 性能优化技巧

1. **批量派生**：使用 `Promise.all` 并行启动多个子代理
2. **上下文裁剪**：fork 模式下限制继承的 token 数量
3. **模型缓存**：相同配置的子代理可以复用模型连接
4. **懒加载**：只在需要时才加载大型附件
5. **提前终止**：检测到足够信息时提前结束子代理

---

## 总结

OpenClaw 的任务拆解与下发机制通过以下核心设计实现了强大的任务管理能力：

### 核心优势

1. **🎯 智能拆分**：基于 LLM 的自主任务分解和 sessions_spawn 工具
2. **⚡ 并行执行**：多个子代理同时工作，显著提升效率
3. **🔒 安全隔离**：深度限制、并发控制、沙箱隔离等多层防护
4. **🔄 可靠通知**：Announce 系统支持重试和幂等性保证
5. **📊 可观测性**：完整的任务生命周期跟踪和审计
6. **🛠️ 灵活配置**：丰富的参数支持各种使用场景

### 架构亮点

- **分层设计**：从 Spawn → Registry → Execution → Announce 的清晰分层
- **状态管理**：完善的生命周期状态机和持久化机制
- **资源保护**：深度限制、并发限制、超时控制、沙箱隔离
- **容错机制**：重试、降级、孤儿检测、自动清理
- **扩展性**：插件化的 Hook 系统，支持自定义行为

### 适用场景

✅ **适合的场景：**
- 复杂的研究和分析任务
- 多步骤的数据处理管道
- 并行的代码审查和质量检查
- 多语言翻译和本地化
- 自动化测试和质量保证
- 需要人工审批的工作流

❌ **不适合的场景：**
- 实时性要求极高的任务（秒级响应）
- 需要严格事务一致性的操作
- 超大规模分布式计算（考虑专用框架）
- 简单的单次查询（ overhead 过高）

### 未来展望

随着 OpenClaw 的发展，任务拆解机制可能会进一步增强：

1. **智能负载均衡**：根据系统资源自动调整并发数
2. **自适应拆分**：LLM 自动判断最优拆分策略
3. **跨节点分发**：支持在多机器间分配子任务
4. **结果缓存**：避免重复执行相同任务
5. **可视化编排**：图形化的工作流设计器

这套机制使得 OpenClaw 能够高效地处理从简单的一次性任务到复杂的多步骤工作流的各种场景，同时保持了良好的可扩展性和可维护性。