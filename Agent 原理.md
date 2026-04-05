# OpenClaw Agent & Subagent 架构原理详解

> 本文档深入解析 OpenClaw 的 Agent 和 Subagent 系统的核心原理、运行机制和设计哲学。

## 目录

- [一、核心架构概述](#一核心架构概述)
- [二、Agent 运行时系统](#二-agent-运行时系统)
- [三、Subagent 系统详解](#三-subagent-系统详解)
- [四、上下文管理引擎](#四上下文管理引擎)
- [五、并发控制与隔离](#五并发控制与隔离)
- [六、插件与钩子系统](#六插件与钩子系统)
- [七、错误处理与恢复](#七错误处理与恢复)
- [八、性能优化策略](#八性能优化策略)
- [九、安全机制](#九安全机制)
- [十、实战场景](#十实战场景)

---

## 一、核心架构概述

### 1.1 架构分层设计

OpenClaw 采用**"中心化网关 (Gateway) + 分布式节点 (Nodes)"**的分层架构:

```
┌─────────────────────────────────────────────────────────┐
│                  Gateway (控制平面)                      │
│  - WebSocket RPC / HTTP 服务 / Control UI               │
│  - 会话管理 / 通道管理 / 工具调度                        │
│  - 生命周期事件广播 (SSE)                                │
└─────────────────────────────────────────────────────────┘
                          ↓ RPC 调用
┌─────────────────────────────────────────────────────────┐
│              Agent Runtime (运行时层)                    │
│  - Embedded PI Agent (模型交互核心)                      │
│  - Context Engine (上下文管理引擎)                       │
│  - Plugin System (插件化设计)                            │
│  - Hook System (生命周期钩子)                            │
└─────────────────────────────────────────────────────────┘
                          ↓ 孵化 (Spawn)
┌─────────────────────────────────────────────────────────┐
│            Subagent System (子代理系统)                  │
│  - Subagent Registry (注册表/生命周期管理)               │
│  - Subagent Spawn (生成逻辑)                             │
│  - Subagent Announce (完成通知机制)                      │
│  - Lane System (并发控制和资源隔离)                      │
└─────────────────────────────────────────────────────────┘
```

### 1.2 核心设计原则

1. **Push-based 完成通知**: Subagent 不 polling，依赖 completion events
2. **深度限制**: 默认最多 2 层嵌套，防止无限递归
3. **Lane 隔离**: 不同用途使用独立车道，避免资源竞争
4. **Workspace 继承**: 智能的工作空间传递策略
5. **Hook 扩展点**: 全生命周期的插件化扩展能力
6. **Context Engine 抽象**: 统一的上下文管理接口
7. **Transient Error Grace**: 15 秒宽限期处理临时错误
8. **Orphan Recovery**: 定期扫描恢复孤儿运行
9. **Stream First**: 流式处理降低延迟
10. **Security by Default**: 沙箱、限流、审批多层保护

### 1.3 Session Key 命名规范

Session Key 是识别 Agent 实例的核心标识:

```typescript
// 主 Agent
sessionKey = `agent:${agentId}:main`

// Subagent (单次运行)
sessionKey = `agent:${agentId}:subagent:${sessionId}`

// Cron Agent
sessionKey = `cron:${jobId}`

// Hook Agent
sessionKey = `hook:${hookName}:${messageId}`

// Thread-Bound Subagent (飞书群聊主题对话)
sessionKey = `agent:${agentId}:thread:${threadId}`
```

---

## 二、Agent 运行时系统

### 2.1 核心入口：runEmbeddedPiAgent

**文件路径**: `src/agents/pi-embedded-runner/run.ts`

**函数签名**:
```typescript
async function runEmbeddedPiAgent(params: RunEmbeddedPiAgentParams): Promise<EmbeddedPiRunResult>
```

**关键参数详解**:
```typescript
type RunEmbeddedPiAgentParams = {
  // 身份标识
  runId: string;              // 唯一运行 ID (UUID)
  sessionId: string;          // 会话 ID
  sessionKey?: string;        // 会话键 (决定存储路径)
  agentId: string;            // Agent 配置 ID
  
  // 工作空间
  workspaceDir: string;       // 工作空间目录
  agentDir?: string;          // Agent 代码目录
  
  // 模型选择
  provider: string;           // 提供者："anthropic", "openai", "ollama"
  model: string;              // 模型 ID: "claude-sonnet-4-6", "gpt-4o"
  authProfileId?: string;     // 认证 Profile ID (支持 OAuth 轮换)
  
  // 触发类型
  trigger?: "user" | "heartbeat" | "cron" | "memory";
  
  // 并发控制
  lane?: string;              // 车道名："global", "session", "subagent"
  
  // 功能开关
  allowGatewaySubagentBinding?: boolean;  // 是否允许调用 gateway.subagent 工具
  fastMode?: boolean;         // 快速模式 (跳过部分检查)
  senderIsOwner?: boolean;    // 发送者是否为 Owner (影响工具权限)
  
  // 超时控制
  timeoutMs?: number;         // 运行超时 (毫秒)
  
  // 思考级别
  thinkLevel?: "off" | "low" | "high";  // 推理强度
  
  // 回调函数
  onBlockReply?: (payload: BlockReplyPayload) => void;  // 文本块回复
  onReasoningStream?: (delta: string) => void;          // 推理流
  onAgentEvent?: (event: AgentEvent) => void;           // 生命周期事件
}
```

### 2.2 执行流程详解

#### 阶段 1: 环境准备 (0-50ms)

```typescript
// 1.1 工作空间解析
const workspaceResolution = resolveRunWorkspaceDir({
  workspaceDir: params.workspaceDir,
  sessionKey: params.sessionKey,
  agentId: params.agentId,
  config: params.config,
});

// 继承规则:
// - 同 Agent spawn: 继承父级 workspace
// - 跨 Agent spawn: 使用目标 Agent 配置
// - 显式覆盖：工具可指定 explicitWorkspaceDir

// 1.2 确保运行时插件加载
ensureRuntimePluginsLoaded({
  config: params.config,
  workspaceDir: resolvedWorkspace,
  allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
});

// 1.3 加载模型配置
await ensureOpenClawModelsJson(params.config, agentDir);

// 1.4 获取全局 Hook 运行器
const hookRunner = getGlobalHookRunner();
```

#### 阶段 2: Hook 执行 (30-80ms)

```typescript
const hookCtx = {
  runId: params.runId,
  agentId: workspaceResolution.agentId,
  sessionKey: params.sessionKey,
  sessionId: params.sessionId,
  workspaceDir: resolvedWorkspace,
  messageProvider: params.messageProvider ?? undefined,
  trigger: params.trigger,
  channelId: params.messageChannel ?? params.messageProvider ?? undefined,
};

// 2.1 before_model_resolve (可在请求前覆盖模型)
const beforeModelResolveEvent = { prompt: params.prompt };
const modelOverride = await hookRunner.runBeforeModelResolve(
  beforeModelResolveEvent,
  hookCtx
);

if (modelOverride?.providerOverride) {
  provider = modelOverride.providerOverride;
}
if (modelOverride?.modelOverride) {
  modelId = modelOverride.modelOverride;
}

// 2.2 before_prompt_build (可修改 systemPrompt)
const beforePromptBuildEvent = {
  prompt: params.prompt,
  messages: preparedMessages,
};
const promptModifications = await hookRunner.runBeforePromptBuild(
  beforePromptBuildEvent,
  hookCtx
);

// 可注入领域知识
if (promptModifications.prependSystemContext) {
  systemPrompt = promptModifications.prependSystemContext + "\n" + systemPrompt;
}

// 2.3 before_agent_start (最终调整)
await hookRunner.runBeforeAgentStart(
  { prompt: params.prompt, messages: preparedMessages },
  hookCtx
);
```

#### 阶段 3: 上下文组装 (40-120ms)

```typescript
// 3.1 初始化 Context Engine
const contextEngine = await ensureContextEnginesInitialized();

// 3.2 Bootstrap (可选，导入历史消息)
if (contextEngine.bootstrap) {
  const bootstrapResult = await contextEngine.bootstrap({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: sessionFile,
  });
  
  if (bootstrapResult.importedMessages) {
    log.info(`Imported ${bootstrapResult.importedMessages} historical messages`);
  }
}

// 3.3 Assemble (构建模型上下文)
const assembleResult = await contextEngine.assemble({
  sessionId: params.sessionId,
  sessionKey: params.sessionKey,
  messages: currentMessages,
  tokenBudget: resolveTokenBudget(params.model),
  model: params.model,
  prompt: params.prompt,
});

// assembleResult.messages 即为发送给模型的完整上下文
```

#### 阶段 4: 模型交互 (200ms - 数分钟)

```typescript
// 4.1 发射 lifecycle.start 事件
emitAgentEvent({
  runId: params.runId,
  stream: "lifecycle",
  data: {
    phase: "start",
    startedAt: Date.now(),
    provider,
    model: modelId,
  },
});

// 4.2 订阅 Embedded PI Session (流式处理核心)
const subscribeParams: SubscribeEmbeddedPiSessionParams = {
  messages: assembleResult.messages,
  provider,
  model: modelId,
  systemPrompt,
  tools: availableTools,
  toolChoice: "auto",
  
  // 流式回调
  onAssistant: (text) => {
    // 文本块输出
    emitAgentEvent({
      runId: params.runId,
      stream: "assistant",
      data: { text },
    });
    
    // 推送给 SSE 订阅者
    broadcastToConnIds(sessionKey, {
      type: "assistant_delta",
      text,
    });
  },
  
  onToolCall: async (toolCall) => {
    // 工具调用
    emitAgentEvent({
      runId: params.runId,
      stream: "tool_call",
      data: {
        toolCallId: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
        status: "in_progress",
      },
    });
    
    // 执行工具
    const result = await executeTool(toolCall, toolExecutionContext);
    
    // 返回结果给模型
    return result;
  },
  
  onReasoningStream: (delta) => {
    // 推理过程流式输出 (可选)
    if (params.onReasoningStream) {
      params.onReasoningStream(delta);
    }
  },
  
  onBlockReply: (payload) => {
    // 完整的回复块 (用于渠道投递)
    params.onBlockReply?.(payload);
  },
  
  reasoningMode: params.thinkLevel === "high" ? "stream" : "off",
  toolResultFormat: "markdown",
};

const runResult = await subscribeEmbeddedPiSession(subscribeParams);
```

#### 阶段 5: 后处理 (50-100ms)

```typescript
// 5.1 发射 lifecycle.end 事件
emitAgentEvent({
  runId: params.runId,
  stream: "lifecycle",
  data: {
    phase: "end",
    endedAt: Date.now(),
    usage: runResult.meta?.agentMeta?.usage,
  },
});

// 5.2 AfterTurn (触发 Context Engine 维护)
if (contextEngine.afterTurn) {
  await contextEngine.afterTurn({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: sessionFile,
    messages: allMessages,
    prePromptMessageCount: assembleResult.messages.length,
    isHeartbeat: params.trigger === "heartbeat",
    tokenBudget: resolveTokenBudget(params.model),
  });
}

// 5.3 持久化到磁盘
await persistSessionToDisk({
  sessionKey: params.sessionKey,
  messages: allMessages,
  metadata: {
    lastUsedAt: Date.now(),
    totalTokens: assembleResult.estimatedTokens,
  },
});

// 5.4 返回最终结果
return {
  payloads: runResult.payloads,
  meta: runResult.meta,
  success: true,
};
```

### 2.3 生命周期事件系统

**文件路径**: `src/infra/agent-events.ts`

**事件类型**:
```typescript
type AgentEventStream = 
  | "lifecycle"    // 生命周期状态
  | "assistant"    // 助手回复
  | "tool_call"    // 工具调用
  | "user"         // 用户消息
  | "reasoning"    // 推理过程
  ;

type AgentEvent<T extends AgentEventStream = any> = {
  runId: string;
  stream: T;
  data: AgentEventData[T];
};

interface AgentEventData {
  lifecycle: {
    phase: "start" | "end" | "error";
    startedAt?: number;
    endedAt?: number;
    error?: string;
    provider?: string;
    model?: string;
    failoverReason?: string;
  };
  
  assistant: {
    text: string;
    messageId?: string;
  };
  
  tool_call: {
    toolCallId: string;
    name: string;
    arguments?: unknown;
    status: "pending" | "in_progress" | "completed" | "failed";
    result?: unknown;
    error?: string;
  };
  
  reasoning: {
    delta: string;
    cumulative?: string;
  };
}
```

**事件发射器**:
```typescript
function emitAgentEvent(event: AgentEvent) {
  // 1. 本地日志记录
  const log = createSubsystemLogger("agent/events");
  log.debug(`Emitting ${event.stream} event`, { runId: event.runId });
  
  // 2. 广播到 Gateway SSE
  if (gatewayServer) {
    gatewayServer.broadcastToSession(event.runId, {
      type: "agent_event",
      stream: event.stream,
      data: event.data,
    });
  }
  
  // 3. 触发本地监听器
  const listeners = eventListeners.get(event.stream) || [];
  listeners.forEach(listener => listener(event));
}
```

---

## 三、Subagent 系统详解

### 3.1 核心概念

#### 3.1.1 Subagent 的定义

Subagent 是由父 Agent 动态创建的**子任务执行单元**,具有以下特征:

- **独立性**: 拥有独立的 session、workspace、工具集
- **隔离性**: 无法直接访问父 Agent 的敏感资源
- **短暂性**: 完成任务后自动清理 (或保留为 thread-bound session)
- **协作性**: 通过 announce 机制向父 Agent 汇报结果

#### 3.1.2 使用场景

1. **并行任务分解**: 同时研究多个子主题
2. **多层次分析**: 第一层分解任务，第二层具体执行
3. **专业化分工**: 不同 subagent 使用不同模型/工具
4. **长任务后台处理**: 主 Agent 继续响应用户，subagent 后台执行

### 3.2 Subagent Spawn 流程详解

**文件路径**: `src/agents/subagent-spawn.ts`

**核心函数**: `spawnSubagentDirect(params, ctx)`

#### 前置条件检查

```typescript
// 1. 检查生成深度
const currentDepth = calculateSpawnDepth(requesterSessionKey);
const maxDepth = cfg.agents?.defaults?.subagentMaxDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH; // 默认为 2

if (currentDepth >= maxDepth) {
  return {
    status: "rejected",
    reason: `Maximum spawn depth (${maxDepth}) reached`,
  };
}

// 2. 验证目标 Agent 是否在允许列表
const allowedAgents = resolveSubagentAllowlist(cfg, requesterAgentId);
if (!allowedAgents.includes(targetAgentId)) {
  return {
    status: "rejected",
    reason: `Agent "${targetAgentId}" is not in the allowed list`,
  };
}

// 3. 检查工作空间继承
const inheritedWorkspace = resolveInheritedWorkspace({
  requesterSessionKey,
  targetAgentId,
  explicitWorkspaceDir: params.workspaceDir,
});
```

#### Session 初始化

```typescript
// 1. 生成唯一的 childSessionKey
const childSessionKey = buildSubagentSessionKey({
  parentAgentId: requesterAgentId,
  childSessionId: crypto.randomUUID(),
});
// 格式：agent:{agentId}:subagent:{uuid}

// 2. 创建临时 session 记录
const initialSessionEntry: SessionEntry = {
  id: childSessionId,
  agentId: targetAgentId,
  workspaceDir: inheritedWorkspace,
  spawnedBy: {
    agentId: requesterAgentId,
    sessionKey: requesterInternalKey,
    runId: requesterRunId,
  },
  parentSessionKey: requesterInternalKey,
  spawnDepth: currentDepth + 1,
  createdAt: Date.now(),
  model: undefined,      // 由后续步骤设置
  modelProvider: undefined,
};

// 3. 应用初始 patch
await patchSessionEntry(childSessionKey, initialSessionEntry);

// 4. 持久化运行时模型
const resolvedModel = resolveSubagentSpawnModelSelection({
  cfg,
  targetAgentId,
  requestedModel: params.model,
});

if (resolvedModel) {
  await persistInitialChildSessionRuntimeModel({
    childSessionKey,
    provider: resolvedModel.provider,
    model: resolvedModel.model,
  });
}

// 5. 线程绑定 (可选，用于飞书群聊主题对话)
if (params.threadBound) {
  await ensureThreadBinding({
    childSessionKey,
    threadId: params.threadId,
    channel: params.channel,
  });
}
```

#### 附件处理

```typescript
// 1. 物化附件到临时目录
const attachmentsDir = path.join(
  tempDir(),
  `subagent-${childSessionId}-attachments`
);

const attachmentsReceipt = await materializeSubagentAttachments({
  attachments: params.attachments || [],
  targetDir: attachmentsDir,
});

// 2. 计算 SHA256 校验和
const attachmentManifest = attachmentsReceipt.map(att => ({
  filename: att.filename,
  sha256: calculateSHA256(att.path),
  size: fs.statSync(att.path).size,
}));

// 3. 生成附件清单
fs.writeFileSync(
  path.join(attachmentsDir, "manifest.json"),
  JSON.stringify(attachmentManifest, null, 2)
);
```

#### Gateway RPC 调用

```typescript
// 1. 构建子任务消息
const childTaskMessage: AgentMessage = {
  role: "user",
  content: [
    {
      type: "text",
      text: params.task || params.message,
    },
  ],
};

// 2. 构建系统提示词
const subagentSystemPrompt = buildSubagentSystemPrompt({
  task: params.task,
  label: params.label,
  parentContext: requesterContext,
  cleanupPolicy: params.cleanup || "delete",
  attachmentsNote: attachmentsReceipt.length > 0 
    ? `\n\n## Attachments\n\nThe following attachments have been provided:\n${attachmentsReceipt.map(a => `- ${a.filename}`).join("\n")}`
    : "",
});

// 3. 调用 gateway.agent() 方法
const childRunId = crypto.randomUUID();

try {
  const gatewayResult = await gateway.agent({
    agent: targetAgentId,
    session: childSessionKey,
    message: childTaskMessage.content[0].text,
    model: resolvedModel ? `${resolvedModel.provider}/${resolvedModel.model}` : undefined,
    thinkLevel: params.thinkLevel || "low",
    timeout: params.timeout || 300_000, // 5 分钟
    
    // 关键配置
    lane: "subagent",           // 独立车道，避免阻塞主 agent
    deliver: false,             // 不直接投递到外部渠道
    idempotencyKey: crypto.randomUUID(),
    
    // 元数据
    metadata: {
      spawnedBy: requesterAgentId,
      parentSessionKey: requesterInternalKey,
      label: params.label,
      cleanup: params.cleanup,
    },
    
    // 事件监听
    onEvent: (event) => {
      // 监听子代理生命周期
      if (event.stream === "lifecycle") {
        handleSubagentLifecycleEvent(event, childSessionKey);
      }
    },
  });
  
  if (!gatewayResult.success) {
    throw new Error(gatewayResult.error || "Gateway agent call failed");
  }
} catch (error) {
  // 失败回滚
  await deleteSessionEntry(childSessionKey);
  await fs.promises.rm(attachmentsDir, { recursive: true, force: true });
  
  return {
    status: "rejected",
    reason: `Gateway spawn failed: ${error.message}`,
  };
}
```

#### 注册与事件发射

```typescript
// 1. 注册到 Subagent Registry
await registerSubagentRun({
  runId: childRunId,
  childSessionKey,
  controllerSessionKey: requesterInternalKey,
  requesterSessionKey: requesterInternalKey,
  task: params.task || params.message,
  cleanup: params.cleanup || "delete",
  spawnMode: params.mode || "run",
  label: params.label,
  model: resolvedModel ? `${resolvedModel.provider}/${resolvedModel.model}` : undefined,
  workspaceDir: inheritedWorkspace,
  attachmentsDir,
});

// 2. 发射 lifecycle.create 事件
emitSessionLifecycleEvent({
  sessionKey: childSessionKey,
  reason: "create",
  parentSessionKey: requesterInternalKey,
  label: params.label,
});

// 3. 触发 subagent_spawning Hook
if (hookRunner?.hasHooks("subagent_spawning")) {
  await hookRunner.runSubagentSpawning(
    {
      childSessionKey,
      task: params.task,
      label: params.label,
      mode: params.mode || "run",
    },
    {
      runId: childRunId,
      requesterSessionKey: requesterInternalKey,
    }
  );
}

// 4. 返回接受结果
return {
  status: "accepted",
  childSessionKey,
  runId: childRunId,
  mode: params.mode || "run",
  note: params.mode === "session" 
    ? SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE 
    : SUBAGENT_SPAWN_ACCEPTED_NOTE,
  modelApplied: resolvedModel ? `${resolvedModel.provider}/${resolvedModel.model}` : undefined,
  attachments: attachmentsReceipt,
};
```

### 3.3 Subagent 生命周期管理

**文件路径**: `src/agents/subagent-registry-lifecycle.ts`

#### 状态机转换

```typescript
type SubagentState = 
  | "created"      // 刚创建，等待启动
  | "running"      // 正在执行
  | "ended"        // 正常结束
  | "error"        // 执行出错
  | "announcing"   // 正在通知父代理
  | "cleaning"     // 正在清理
  | "archived";    // 已归档

class SubagentLifecycleManager {
  private state = new Map<string, SubagentRunRecord>();
  
  // 监听生命周期事件
  constructor() {
    onAgentEvent((event) => {
      if (event.stream === "lifecycle") {
        this.handleLifecycleEvent(event);
      }
    });
  }
  
  private handleLifecycleEvent(event: AgentEvent<"lifecycle">) {
    const record = this.state.get(event.runId);
    if (!record) return;
    
    switch (event.data.phase) {
      case "start":
        record.state = "running";
        record.startedAt = Date.now();
        break;
        
      case "end":
        record.state = "ended";
        record.endedAt = Date.now();
        record.outcome = "success";
        this.triggerAnnounceFlow(record);
        break;
        
      case "error":
        record.state = "error";
        record.endedAt = Date.now();
        record.outcome = "failed";
        record.error = event.data.error;
        
        // 15 秒宽限期处理 transient error
        if (isTransientError(event.data.error)) {
          setTimeout(() => this.retrySubagent(record), LIFECYCLE_ERROR_RETRY_GRACE_MS);
        } else {
          this.triggerAnnounceFlow(record);
        }
        break;
    }
    
    // 持久化状态变更
    this.persistState(record);
  }
}
```

### 3.4 Announce Flow (完成通知机制)

**文件路径**: `src/agents/subagent-announce.ts`

#### 完整流程

```typescript
async function handleSubagentCompletion(record: SubagentRunRecord) {
  // 阶段 1: 捕获完成结果
  const frozenResultText = await captureSubagentCompletionReply({
    childSessionKey: record.childSessionKey,
    runId: record.runId,
  });
  
  if (!frozenResultText) {
    log.warn("No completion reply captured", { runId: record.runId });
    return;
  }
  
  record.frozenResultText = frozenResultText;
  
  // 阶段 2: 格式化通知内容
  const announceContent = await formatAnnounceContent({
    frozenResultText,
    record,
    includeStats: true,
  });
  
  // 阶段 3: 解析父代理上下文
  const requesterContext = await resolveRequesterForChildSession({
    childSessionKey: record.childSessionKey,
  });
  
  if (!requesterContext) {
    log.error("Cannot resolve requester context", { childSessionKey: record.childSessionKey });
    markAsOrphaned(record);
    return;
  }
  
  // 阶段 4: 构建 steering 消息
  const steerMessage: AgentMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: announceContent,
      },
    ],
  };
  
  // 阶段 5: 投递到父代理
  try {
    await deliverToParent({
      requesterContext,
      steerMessage,
      internalEvents: [
        {
          type: "subagent_completion",
          childSessionKey: record.childSessionKey,
          runId: record.runId,
          frozenResultText,
        },
      ],
      timeout: 60_000, // 60 秒超时
    });
    
    // 阶段 6: 清理决策
    if (record.cleanup === "delete") {
      await deleteSubagentSession(record.childSessionKey);
      await removeAttachments(record.attachmentsDir);
    }
    
    // 阶段 7: 触发 subagent_ended Hook
    await triggerSubagentEndedHook(record);
    
    // 阶段 8: 归档
    record.state = "archived";
    record.cleanupCompletedAt = Date.now();
    await archiveToDisk(record);
    
  } catch (error) {
    // 投递失败，重试机制
    record.announceRetryCount = (record.announceRetryCount || 0) + 1;
    
    if (record.announceRetryCount < MAX_ANNOUNCE_RETRY_COUNT) {
      scheduleRetry(record);
    } else {
      markAsOrphaned(record);
    }
  }
}
```

#### 防 Polling 设计

**关键原则**: Subagent 系统采用**push-based**完成通知，而非 polling

```typescript
// ❌ 错误做法：polling
while (!subagent.isComplete()) {
  await sleep(1000);
  const status = await checkSubagentStatus();
}

// ✅ 正确做法：监听 completion events
onAgentEvent((event) => {
  if (event.stream === "lifecycle" && event.data.phase === "end") {
    handleSubagentCompletion(event);
  }
});

// 父代理被明确告知不要 polling
const systemPrompt = `
IMPORTANT: Do NOT poll for subagent results.
You will receive a completion event when the subagent finishes.
Wait for the completion notification before proceeding.
`;
```

### 3.5 孤儿运行恢复

**文件路径**: `src/agents/subagent-registry-helpers.ts`

#### 孤儿检测

```typescript
function detectOrphanedRuns(): OrphanedRun[] {
  const allRuns = loadSubagentRunsFromDisk();
  const orphans: OrphanedRun[] = [];
  
  for (const run of allRuns) {
    // 超时未结束
    if (!run.endedAt && Date.now() - run.startedAt > SUBAGENT_TIMEOUT_MS) {
      orphans.push({
        run,
        reason: "timeout",
      });
    }
    
    // 清理卡住
    if (run.endedAt && !run.cleanupCompletedAt) {
      const timeSinceEnd = Date.now() - run.endedAt;
      if (timeSinceEnd > CLEANUP_TIMEOUT_MS) {
        orphans.push({
          run,
          reason: "cleanup-stalled",
        });
      }
    }
    
    // announce 失败达到上限
    if (run.announceRetryCount >= MAX_ANNOUNCE_RETRY_COUNT) {
      orphans.push({
        run,
        reason: "announce-failed",
      });
    }
  }
  
  return orphans;
}
```

#### 恢复策略

```typescript
async function reconcileOrphanedRuns() {
  const orphans = detectOrphanedRuns();
  
  for (const orphan of orphans) {
    log.info("Reconciling orphaned run", {
      runId: orphan.run.runId,
      reason: orphan.reason,
    });
    
    switch (orphan.reason) {
      case "timeout":
        // 标记为超时失败
        orphan.run.outcome = "failed";
        orphan.run.error = "Subagent execution timed out";
        orphan.run.endedAt = Date.now();
        await triggerAnnounceFlow(orphan.run);
        break;
        
      case "cleanup-stalled":
        // 强制清理
        await forceCleanup(orphan.run);
        break;
        
      case "announce-failed":
        // 尝试最后一次 announce
        const success = await attemptFinalAnnounce(orphan.run);
        if (!success) {
          log.error("Final announce failed, archiving as orphan", {
            runId: orphan.run.runId,
          });
          archiveAsOrphan(orphan.run);
        }
        break;
    }
  }
}

// 定期扫描 (每 5 分钟)
setInterval(reconcileOrphanedRuns, 5 * 60 * 1000);
```

---

## 四、上下文管理引擎

### 4.1 Context Engine 接口定义

**文件路径**: `src/context-engine/types.ts`

```typescript
interface ContextEngine {
  readonly info: ContextEngineInfo;
  
  // 引导初始化
  bootstrap?(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
  }): Promise<BootstrapResult>;
  
  // 消息摄入
  ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult>;
  
  // 批量摄入 (可选)
  ingestBatch?(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult>;
  
  // 上下文组装
  assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    model?: string;
    prompt?: string;
  }): Promise<AssembleResult>;
  
  // 上下文压缩
  compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
  }): Promise<CompactResult>;
  
  // 后处理
  afterTurn?(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
  }): Promise<void>;
  
  // Subagent 支持
  prepareSubagentSpawn?(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation>;
  
  onSubagentEnded?(params: {
    childSessionKey: string;
    reason: SubagentEndReason;
  }): Promise<void>;
}
```

---

## 五、并发控制与隔离

### 5.1 Lane 系统

**文件路径**: `src/agents/lanes.ts`

#### 车道类型

```typescript
type LaneType = 
  | "global"        // 全局车道 (默认)
  | "session"       // 会话级车道
  | "subagent"      // Subagent 专用车道
  | "cli"           // CLI 后端车道
  | "cron"          // Cron 任务车道
  ;

type LaneConfig = {
  type: LaneType;
  concurrency: number;     // 最大并发数
  queueSize: number;       // 队列大小
  timeoutMs: number;       // 超时时间
};

const DEFAULT_LANE_CONFIGS: Record<LaneType, LaneConfig> = {
  global: {
    type: "global",
    concurrency: 10,
    queueSize: 100,
    timeoutMs: 300_000,
  },
  
  session: {
    type: "session",
    concurrency: 1,  // 每个 session 串行执行
    queueSize: 50,
    timeoutMs: 300_000,
  },
  
  subagent: {
    type: "subagent",
    concurrency: 5,
    queueSize: 200,
    timeoutMs: 600_000,
  },
  
  cli: {
    type: "cli",
    concurrency: 3,
    queueSize: 20,
    timeoutMs: 120_000,
  },
  
  cron: {
    type: "cron",
    concurrency: 2,
    queueSize: 10,
    timeoutMs: 900_000,
  },
};
```

### 5.2 工作空间隔离

#### 继承规则

```typescript
function resolveInheritedWorkspace(params: {
  requesterSessionKey: string;
  targetAgentId: string;
  explicitWorkspaceDir?: string;
}): string {
  // 1. 显式覆盖优先
  if (params.explicitWorkspaceDir) {
    return params.explicitWorkspaceDir;
  }
  
  // 2. 同 Agent 内 spawn: 继承父级 workspace
  const requesterAgentId = extractAgentId(params.requesterSessionKey);
  if (requesterAgentId === params.targetAgentId) {
    const requesterSession = getSession(params.requesterSessionKey);
    return requesterSession.workspaceDir;
  }
  
  // 3. 跨 Agent spawn: 使用目标 Agent 配置
  const targetAgentConfig = loadAgentConfig(params.targetAgentId);
  return targetAgentConfig.workspaceDir || getDefaultWorkspace();
}
```

---

## 六、插件与钩子系统

### 6.1 Hook 类型详解

**文件路径**: `src/plugins/types.ts`

#### Agent 生命周期钩子

```typescript
type PluginHooks = {
  // 模型解析前 (可覆盖 model/provider)
  before_model_resolve: (
    event: { prompt: string },
    context: PluginHookAgentContext
  ) => Promise<{
    modelOverride?: string;
    providerOverride?: string;
  } | void>;
  
  // 提示词构建前 (可修改 systemPrompt)
  before_prompt_build: (
    event: {
      prompt: string;
      messages: unknown[];
    },
    context: PluginHookAgentContext
  ) => Promise<{
    systemPrompt?: string;
    prependContext?: string;
    prependSystemContext?: string;
    appendSystemContext?: string;
  } | void>;
  
  // Agent 启动前 (最终调整)
  before_agent_start: (
    event: {
      prompt: string;
      messages?: unknown[];
    },
    context: PluginHookAgentContext
  ) => Promise<void>;
  
  // Subagent 相关
  subagent_spawning: (
    event: {
      childSessionKey: string;
      task: string;
      label?: string;
      mode: "run" | "session";
    },
    context: {
      runId: string;
      requesterSessionKey: string;
    }
  ) => Promise<void>;
  
  subagent_spawned: (
    event: {
      runId: string;
      childSessionKey: string;
      agentId: string;
      label?: string;
      requester?: {
        channel?: string;
        accountId?: string;
        to?: string;
        threadId?: string;
      };
      threadRequested?: boolean;
      mode?: "run" | "session";
    },
    context: {
      runId: string;
      childSessionKey: string;
      requesterSessionKey: string;
    }
  ) => Promise<void>;
  
  subagent_ended: (
    event: {
      runId: string;
      childSessionKey: string;
      outcome: "success" | "failed";
      frozenResultText?: string | null;
    },
    context: {
      runId: string;
      requesterSessionKey: string;
    }
  ) => Promise<void>;
};
```

---

## 七、错误处理与恢复

### 7.1 故障分类

**文件路径**: `src/auto-reply/reply/agent-runner-execution.ts`

```typescript
type FailoverReason =
  | "rate_limit"      // 429 Too Many Requests
  | "billing"         // 402 Payment Required
  | "auth"            // 401 Unauthorized
  | "timeout"         // 请求超时
  | "model_error"     // 模型内部错误
  | "network_error";  // 网络问题
```

### 7.2 重试策略

#### 指数退避

```typescript
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts: number;
    baseDelay: number;
    maxDelay: number;
    shouldRetry: (error: Error) => boolean;
  }
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      if (!options.shouldRetry(lastError)) {
        throw lastError;
      }
      
      // 指数退避
      const delay = Math.min(
        options.baseDelay * Math.pow(2, attempt),
        options.maxDelay
      );
      
      await sleep(delay);
    }
  }
  
  throw lastError!;
}
```

---

## 八、性能优化策略

### 8.1 缓存策略

#### 单例懒加载

```typescript
let contextEngineInstance: ContextEngine | null = null;

async function ensureContextEnginesInitialized(): Promise<ContextEngine> {
  if (!contextEngineInstance) {
    const startTime = Date.now();
    
    contextEngineInstance = await createEngine();
    
    log.info("Context engine initialized", {
      duration: Date.now() - startTime,
      engineId: contextEngineInstance.info.id,
    });
  }
  
  return contextEngineInstance;
}
```

### 8.2 流式处理

#### 分块响应

```typescript
class EmbeddedBlockChunker {
  private buffer = "";
  private chunkSize = 50;  // 字符数
  
  push(text: string): string[] {
    this.buffer += text;
    const chunks: string[] = [];
    
    while (this.buffer.length >= this.chunkSize) {
      // 在单词边界分割
      let splitIndex = this.buffer.lastIndexOf(" ", this.chunkSize);
      if (splitIndex === -1) splitIndex = this.chunkSize;
      
      chunks.push(this.buffer.slice(0, splitIndex));
      this.buffer = this.buffer.slice(splitIndex + 1);
    }
    
    return chunks;
  }
  
  flush(): string {
    const remaining = this.buffer;
    this.buffer = "";
    return remaining;
  }
}
```

---

## 九、安全机制

### 9.1 DM 配对机制

**文件路径**: `src/gateway/server.impl.ts`

#### 控制平面保护

```typescript
class GatewaySecurityManager {
  private rateLimiter = new RateLimiter({
    windowMs: 60_000,    // 1 分钟
    maxRequests: 100,    // 最多 100 次
  });
  
  async validateDM(dm: DirectMessage): Promise<ValidationResult> {
    // 1. 限流检查
    const rateLimitResult = await this.rateLimiter.check(dm.senderId);
    if (!rateLimitResult.allowed) {
      return {
        valid: false,
        reason: "rate_limited",
        retryAfter: rateLimitResult.retryAfter,
      };
    }
    
    // 2. 工具风险分级
    if (dm.toolCall) {
      const riskLevel = assessToolRisk(dm.toolCall.name);
      
      if (riskLevel === "high") {
        // 高风险工具需要审批
        const approval = await requestApproval(dm.senderId, dm.toolCall);
        if (!approval) {
          return { valid: false, reason: "approval_denied" };
        }
      }
    }
    
    // 3. 发送者身份验证
    const senderValid = await verifySenderIdentity(dm.senderId, dm.signature);
    if (!senderValid) {
      return { valid: false, reason: "invalid_signature" };
    }
    
    return { valid: true };
  }
}
```

---

## 十、实战场景

### 10.1 并行任务处理

```typescript
// 主 Agent 并行 spawn 多个 subagents
async function handleComplexResearch(task: string) {
  const [resultA, resultB, resultC] = await Promise.all([
    spawnSubagent({
      task: `Research topic A: ${task}`,
      mode: "run",
      cleanup: "delete",
    }),
    spawnSubagent({
      task: `Research topic B: ${task}`,
      mode: "run",
      cleanup: "delete",
    }),
    spawnSubagent({
      task: `Research topic C: ${task}`,
      mode: "run",
      cleanup: "delete",
    }),
  ]);
  
  // 综合结果并回复用户
  const synthesizedAnswer = synthesizeResults([
    resultA.frozenResultText,
    resultB.frozenResultText,
    resultC.frozenResultText,
  ]);
  
  return synthesizedAnswer;
}
```

### 10.2 多层次分解

```
Level 0: Main Agent (用户交互)
  ↓ spawn (depth=1)
Level 1: Orchestrator Subagent (任务分解)
  ↓ spawn (depth=2, 允许)
Level 2: Worker Subagents (具体执行)
  ↑ announce
Level 1: 汇总结果
  ↑ announce
Level 0: 最终回复用户
```

---

## 附录：关键文件索引

### 核心运行时
- `src/agents/pi-embedded-runner/run.ts` - Embedded PI Agent 主入口
- `src/agents/pi-embedded-subscribe.ts` - 模型响应流式处理
- `src/context-engine/types.ts` - 上下文引擎接口定义

### Subagent 系统
- `src/agents/subagent-registry.ts` - 注册表与生命周期管理
- `src/agents/subagent-spawn.ts` - Subagent 生成逻辑
- `src/agents/subagent-announce.ts` - 完成通知机制
- `src/agents/subagent-registry-lifecycle.ts` - 生命周期控制器
- `src/agents/subagent-registry-helpers.ts` - 辅助函数与孤儿检测

### Gateway 与基础设施
- `src/gateway/server.impl.ts` - Gateway 实现
- `src/gateway/call.ts` - Gateway RPC 调用
- `src/infra/agent-events.ts` - Agent 事件系统

### 工具与命令
- `src/agents/tools/sessions-spawn-tool.ts` - sessions_spawn 工具
- `src/agents/subagent-control.ts` - Subagent 控制工具 (steer/kill/list)

### 测试文件 (学习用例)
- `src/agents/openclaw-tools.subagents.sessions-spawn.lifecycle.test.ts`
- `src/agents/subagent-registry.lifecycle-retry-grace.e2e.test.ts`
- `src/agents/subagent-announce.format.e2e.test.ts`
- `src/agents/subagent-registry.nested.e2e.test.ts`

---

*本文档基于 OpenClaw v2026.x 版本编写，如有更新请参考最新代码。*
