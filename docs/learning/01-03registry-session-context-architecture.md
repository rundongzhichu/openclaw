# Registry 与运行时 Session 上下文架构关系

> **本文档梳理了 OpenClaw 中 registry、运行时 session、context、tools、plugin、agent 等核心组件之间的关系**

---

## 📋 目录

- [1. 核心概念概述](#1-核心概念概述)
- [2. 架构关系图](#2-架构关系图)
- [3. SessionManager 与 Runtime Registry](#3-sessionmanager-与-runtime-registry)
- [4. Context Engine 系统](#4-context-engine-系统)
- [5. Plugin Hook 集成点](#5-plugin-hook-集成点)
- [6. Tool 执行流程](#6-tool-执行流程)
- [7. Agent 生命周期](#7-agent-生命周期)
- [8. 数据流与调用链](#8-数据流与调用链)
- [9. 典型使用场景](#9-典型使用场景)
- [10. 设计原则与最佳实践](#10-设计原则与最佳实践)

---

## 1. 核心概念概述

### 1.1 关键组件定义

| 组件 | 职责 | 来源 |
|------|------|------|
| **SessionManager** | 管理会话持久化（JSONL 文件），处理消息的读写 | `@mariozechner/pi-coding-agent` |
| **Runtime Registry** | 基于 WeakMap 的运行时状态存储，以 SessionManager 为 key | OpenClaw 自定义 |
| **Context Engine** | 上下文管理抽象层，支持插件扩展 | OpenClaw 核心 |
| **Plugin System** | 插件生态系统，提供 hook 拦截点 | OpenClaw 核心 |
| **Agent Runtime** | Pi agent 运行时，执行 LLM 推理和工具调用 | `@mariozechner/pi-coding-agent` |
| **Tools** | 内置工具和插件自定义工具 | OpenClaw + Plugins |

### 1.2 核心问题

OpenClaw 需要解决以下架构挑战：

1. **如何在第三方库（pi-coding-agent）的 SessionManager 上附加自定义运行时状态？**
2. **如何让插件能够在不修改核心代码的情况下拦截 tool 执行、session 生命周期等事件？**
3. **如何为每个 session 独立维护运行时配置（如 context pruning、compaction 策略）？**
4. **如何实现可插拔的 context engine，允许插件提供自定义的上下文管理策略？**

---

## 2. 架构关系图

### 2.1 整体架构图

```
用户交互层 → Gateway 层 → Agent Runtime 层 → Plugin System 层 → External Services
     │            │              │                    │                  │
     │            │         SessionManager        before_tool_call    LLM Providers
     │            │         Runtime Registry      after_tool_call     External APIs
     │            │         Context Engine        session_start/end
     │            │                               before_prompt_build
```

### 2.2 Session 级别状态隔离

每个 Session 拥有独立的：
- SessionManager 实例
- Runtime Registry 条目
- Context Pruning 配置
- Compaction Safeguard 配置

不同 Session 之间完全隔离，互不影响。

---

## 3. SessionManager 与 Runtime Registry

### 3.1 SessionManager 基础

**SessionManager** 来自 `@mariozechner/pi-coding-agent` 库，是会话管理的核心：

```typescript
import { SessionManager } from "@mariozechner/pi-coding-agent";

// 打开或创建会话文件
const sessionManager = SessionManager.open(sessionFile);

// 追加消息
sessionManager.appendMessage({
  role: "user",
  content: "Hello",
  timestamp: Date.now(),
});
```

**关键特性：**
- 基于 JSONL 文件的持久化
- 树状结构（通过 `id` / `parentId` 链接）
- 支持 compaction entry、custom message 等特殊类型

### 3.2 Runtime Registry 机制

**Runtime Registry** 是 OpenClaw 自定义的状态存储层，解决了在第三方对象上附加状态的问题：

#### 核心实现

[`src/agents/pi-hooks/session-manager-runtime-registry.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/pi-hooks/session-manager-runtime-registry.ts)

```typescript
export function createSessionManagerRuntimeRegistry<TValue>() {
  // Session-scoped runtime registry keyed by object identity.
  const registry = new WeakMap<object, TValue>();

  const set = (sessionManager: unknown, value: TValue | null): void => {
    if (!sessionManager || typeof sessionManager !== "object") {
      return;
    }
    const key = sessionManager;
    if (value === null) {
      registry.delete(key);
      return;
    }
    registry.set(key, value);
  };

  const get = (sessionManager: unknown): TValue | null => {
    if (!sessionManager || typeof sessionManager !== "object") {
      return null;
    }
    return registry.get(sessionManager) ?? null;
  };

  return { set, get };
}
```

#### 设计优势

| 特性 | 说明 |
|------|------|
| **WeakMap** | 自动垃圾回收，当 SessionManager 被销毁时，对应的 registry 条目自动清理 |
| **对象身份** | 以 SessionManager 实例为 key，确保不同 session 的状态完全隔离 |
| **非侵入式** | 无需修改 pi-coding-agent 的 SessionManager 类 |
| **类型安全** | TypeScript 泛型保证值的类型正确 |
| **可选性** | `get()` 返回 `null` 表示未设置，便于条件判断 |

### 3.3 注册表使用示例

#### Context Pruning Registry

[`src/agents/pi-extensions/context-pruning/runtime.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/pi-extensions/context-pruning/runtime.ts)

```typescript
export type ContextPruningRuntimeValue = {
  settings: EffectiveContextPruningSettings;
  contextWindowTokens?: number | null;
  isToolPrunable: (toolName: string) => boolean;
  lastCacheTouchAt?: number | null;
};

const registry = createSessionManagerRuntimeRegistry<ContextPruningRuntimeValue>();

export const setContextPruningRuntime = registry.set;
export const getContextPruningRuntime = registry.get;
```

#### Compaction Safeguard Registry

[`src/agents/pi-hooks/compaction-safeguard-runtime.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/pi-hooks/compaction-safeguard-runtime.ts)

```typescript
export type CompactionSafeguardRuntimeValue = {
  maxHistoryShare?: number;
  contextWindowTokens?: number;
  identifierPolicy?: AgentCompactionIdentifierPolicy;
  model?: Model<Api>;
  qualityGuardEnabled?: boolean;
  cancelReason?: string;
};

const registry = createSessionManagerRuntimeRegistry<CompactionSafeguardRuntimeValue>();

export const setCompactionSafeguardRuntime = registry.set;
export const getCompactionSafeguardRuntime = registry.get;
```

---

## 4. Context Engine 系统

### 4.1 Context Engine 接口

[`src/context-engine/types.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/context-engine/types.ts)

Context Engine 提供了统一的上下文管理接口：

```typescript
export interface ContextEngine {
  readonly info: ContextEngineInfo;
  
  // 初始化引擎状态
  bootstrap?(params: { sessionId: string; sessionKey?: string; sessionFile: string }): Promise<BootstrapResult>;
  
  // ingest 消息
  ingest(params: { sessionId: string; sessionKey?: string; message: AgentMessage }): Promise<IngestResult>;
  
  // 组装上下文
  assemble(params: { sessionId: string; messages: AgentMessage[]; tokenBudget?: number }): Promise<AssembleResult>;
  
  // 压缩上下文
  compact(params: { sessionId: string; sessionFile: string; tokenBudget?: number }): Promise<CompactResult>;
  
  // Turn 后处理
  afterTurn(params: { sessionId: string; messages: AgentMessage[] }): Promise<void>;
  
  // 清理资源
  dispose(): Promise<void>;
}
```

### 4.2 Legacy Context Engine

为了保持向后兼容，OpenClaw 提供了 `LegacyContextEngine`，包装现有的 compaction 行为：

```typescript
export class LegacyContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "legacy",
    name: "Legacy Context Engine",
    version: "1.0.0",
  };

  async ingest(_params): Promise<IngestResult> {
    return { ingested: false };  // SessionManager handles persistence
  }

  async assemble(params): Promise<AssembleResult> {
    return { messages: params.messages, estimatedTokens: 0 };
  }

  async compact(params): Promise<CompactResult> {
    return await delegateCompactionToRuntime(params);
  }

  async afterTurn(_params): Promise<void> {}
  async dispose(): Promise<void> {}
}
```

### 4.3 Context Engine Registry

[`src/context-engine/registry.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/context-engine/registry.ts)

支持按 owner（agent）注册不同的 context engine：

```typescript
// 注册 legacy engine（默认）
registerLegacyContextEngine();

// 注册自定义 engine
registerContextEngineForOwner("lossless-claw", () => new LosslessContextEngine(), "plugin");

// 解析 engine
const engine = resolveContextEngine({ owner: "main", config: cfg });
```

---

## 5. Plugin Hook 集成点

### 5.1 Hook 系统概览

OpenClaw 提供了丰富的 plugin hook 集成点：

| 类别 | Hook 名称 | 触发时机 |
|------|----------|---------|
| **Model 解析** | `before_model_resolve` | 模型解析前 |
| **Prompt 构建** | `before_prompt_build` | Prompt 构建前 |
| **Tool 执行** | `before_tool_call`, `after_tool_call` | Tool 调用前后 |
| **Tool 持久化** | `tool_result_persist` | Tool 结果写入 transcript 前 |
| **Session 生命周期** | `session_start`, `session_end` | Session 开始/结束 |
| **Subagent 管理** | `subagent_spawning`, `subagent_ended` | Subagent spawn/结束 |
| **Compaction** | `before_compaction`, `after_compaction` | Compaction 前后 |
| **消息通道** | `message_received`, `message_sending`, `message_sent` | 消息接收/发送 |

### 5.2 Before Tool Call Hook

这是最常用的 hook 之一，允许插件拦截和修改 tool 调用：

```typescript
export type PluginHookBeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};

export type PluginHookBeforeToolCallResult = {
  params?: Record<string, unknown>;  // 修改参数
  block?: boolean;                    // 阻止执行
  blockReason?: string;               // 阻止原因
  requireApproval?: {                 // 要求审批
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    timeoutBehavior?: "allow" | "deny";
  };
};
```

#### 使用示例

```typescript
api.on("before_tool_call", async (event, ctx) => {
  if (event.toolName === "exec") {
    const cmd = event.params.cmd as string;
    if (cmd.includes("rm -rf")) {
      return { block: true, blockReason: "Dangerous command blocked" };
    }
    return { params: { ...event.params, mode: "safe" } };
  }
  return undefined;
}, { priority: 10 });
```

### 5.3 Tool Result Persist Hook

在 tool 结果写入 transcript 之前触发：

```typescript
api.on("tool_result_persist", (event, ctx) => {
  // 移除敏感信息
  if (event.toolName === "read_file") {
    const text = event.message.content?.[0]?.text;
    const sanitized = text?.replace(/sk-[a-zA-Z0-9]{48}/g, "[REDACTED]");
    return {
      message: {
        ...event.message,
        content: [{ type: "text", text: sanitized }],
      },
    };
  }
  return undefined;
});
```

### 5.4 Session Lifecycle Hooks

```typescript
api.on("session_start", async (event, ctx) => {
  console.log(`Session started: ${event.sessionId}`);
  await initializeSessionResources(event.sessionId);
});

api.on("session_end", async (event, ctx) => {
  console.log(`Session ended: ${event.sessionId}, messages: ${event.messageCount}`);
  await cleanupSessionResources(event.sessionId);
});
```

---

## 6. Tool 执行流程

### 6.1 Tool 包装与 Hook 注入

[`src/agents/pi-tools.before-tool-call.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/pi-tools.before-tool-call.ts)

所有 OpenClaw-owned tools 都会经过 `wrapToolWithBeforeToolCallHook` 包装：

```typescript
export function wrapToolWithBeforeToolCallHook(tool: AnyAgentTool, opts?: {...}): AnyAgentTool {
  const originalExecute = tool.execute.bind(tool);
  
  return {
    ...tool,
    execute: async (toolCallId, params, signal, extensionContext) => {
      // 1. 运行 before_tool_call hooks
      const hookResult = await runBeforeToolCallHooks({ toolName: tool.name, params, toolCallId, ...opts });
      
      // 2. 如果 hook 返回 block，则阻止执行
      if (hookResult.blocked) {
        throw new Error(hookResult.reason);
      }
      
      // 3. 使用可能修改过的参数执行工具
      const mergedParams = mergeParams(hookResult.params, params);
      const result = await originalExecute(toolCallId, mergedParams, signal, extensionContext);
      
      // 4. 运行 after_tool_call hooks
      await runAfterToolCallHooks({ toolName: tool.name, params: mergedParams, result, toolCallId, ...opts });
      
      return result;
    },
  };
}
```

### 6.2 Tool Result Guard

[`src/agents/session-tool-result-guard-wrapper.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/session-tool-result-guard-wrapper.ts)

Tool 结果在写入 transcript 之前会经过 guard 处理：

```typescript
export function guardSessionManager(sessionManager: SessionManager, opts?: {...}): GuardedSessionManager {
  // 应用 tool_result_persist hooks
  const transform = hookRunner?.hasHooks("tool_result_persist")
    ? (message, meta) => {
        const out = hookRunner.runToolResultPersist(
          { toolName: meta.toolName, toolCallId: meta.toolCallId, message, isSynthetic: meta.isSynthetic },
          { agentId: opts?.agentId, sessionKey: opts?.sessionKey },
        );
        return out?.message ?? message;
      }
    : undefined;
  
  // 安装 guard
  const guard = installSessionToolResultGuard(sessionManager, {
    sessionKey: opts?.sessionKey,
    transformToolResultForPersistence: transform,
    allowSyntheticToolResults: opts?.allowSyntheticToolResults,
  });
  
  (sessionManager as GuardedSessionManager).flushPendingToolResults = guard.flushPendingToolResults;
  (sessionManager as GuardedSessionManager).clearPendingToolResults = guard.clearPendingToolResults;
  
  return sessionManager as GuardedSessionManager;
}
```

---

## 7. Agent 生命周期

### 7.1 Agent 启动流程

[`src/agents/pi-embedded-runner/run.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/pi-embedded-runner/run.ts)

```typescript
export async function runEmbeddedPiAgent(params: RunEmbeddedPiAgentParams): Promise<EmbeddedPiRunResult> {
  // 1. 解析工作空间和 agent 配置
  const resolvedWorkspace = await ensureAgentWorkspace({ agentDir, workspaceDir });
  const sessionAgentId = resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.config });
  
  // 2. 获取 session 文件路径
  const sessionFile = resolveSessionFilePath({ sessionId: params.sessionId, sessionKey: params.sessionKey, config: params.config });
  
  // 3. 运行 embedded attempt
  return await runEmbeddedAttempt({ ...params, sessionFile, workspaceDir: resolvedWorkspace, sessionAgentId });
}
```

### 7.2 Embedded Attempt 核心步骤

[`src/agents/pi-embedded-runner/run/attempt.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/pi-embedded-runner/run/attempt.ts)

```typescript
async function runEmbeddedAttempt(params: RunEmbeddedAttemptParams): Promise<EmbeddedPiRunResult> {
  // 1. 获取 session 写锁
  const sessionLock = await acquireSessionWriteLock({ sessionFile: params.sessionFile, maxHoldMs: ... });
  
  try {
    // 2. 修复 session 文件（如果需要）
    await repairSessionFileIfNeeded({ sessionFile: params.sessionFile });
    
    // 3. 预 warm session 文件缓存
    await prewarmSessionFile(params.sessionFile);
    
    // 4. 打开并保护 SessionManager
    const sessionManager = guardSessionManager(SessionManager.open(params.sessionFile), {
      agentId: sessionAgentId,
      sessionKey: params.sessionKey,
      inputProvenance: params.inputProvenance,
    });
    
    // 5. 跟踪 session manager 访问
    trackSessionManagerAccess(params.sessionFile);
    
    // 6. 引导 context engine
    await runAttemptContextEngineBootstrap({ ... });
    
    // 7. 准备 session manager 运行
    await prepareSessionManagerForRun({ ... });
    
    // 8. 创建 agent session
    const { session } = await createAgentSession({ ... });
    
    // 9. 应用系统提示覆盖
    applySystemPromptOverrideToSession(session, systemPromptOverride);
    
    // 10. 订阅 session 事件
    const subscription = subscribeEmbeddedPiSession({ ... });
    
    // 11. 触发 session_start hook
    await hookRunner.runSessionStart(startEvent, startCtx);
    
    // 12. 运行 agent
    const result = await session.run(params.prompt);
    
    // 13. 触发 session_end hook
    await hookRunner.runSessionEnd(endEvent, endCtx);
    
    return result;
  } finally {
    // 14. 释放 session 写锁
    await sessionLock.release();
  }
}
```

---

## 8. 数据流与调用链

### 8.1 完整请求流程

```
User Message 
  → Channel Plugin (Telegram/Slack/etc)
  → Gateway Server
  → Session Resolution
  → Message Dispatch
  → runEmbeddedPiAgent
    → ensureAgentWorkspace
    → acquireSessionWriteLock
    → SessionManager.open
    → guardSessionManager
    → Context Engine Bootstrap
    → createAgentSession
    → session_start hook
    → subscribeEmbeddedPiSession
    → session.run(prompt)
      → before_prompt_build hook
      → llm_input hook
      → LLM Provider API
      → llm_output hook
      → Tool Call?
        → Yes: before_tool_call hook → Tool Execute → after_tool_call hook → tool_result_persist hook → Write to JSONL → Next Turn
        → No: Generate Response → onBlockReply callback
    → session_end hook
    → releaseSessionWriteLock
  → Channel Plugin Response
  → User Receives Response
```

---

## 9. 典型使用场景

### 9.1 场景 1: Context Pruning（上下文修剪）

**目标**: 根据缓存 TTL 策略修剪上下文，减少 token 消耗

**实现位置**: [`src/agents/pi-extensions/context-pruning/runtime.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/pi-extensions/context-pruning/runtime.ts)

```typescript
// 1. 在 extensions.ts 中设置运行时状态
function buildContextPruningFactory(params: {...}): ExtensionFactory | undefined {
  const raw = params.cfg?.agents?.defaults?.contextPruning;
  if (raw?.mode !== "cache-ttl") return undefined;
  
  const settings = computeEffectiveSettings(raw);
  if (!settings) return undefined;
  
  // 设置运行时状态到 registry
  setContextPruningRuntime(params.sessionManager, {
    settings,
    contextWindowTokens: resolveContextWindowTokens(params),
    isToolPrunable: makeToolPrunablePredicate(settings.tools),
    dropThinkingBlocks: transcriptPolicy.dropThinkingBlocks,
    lastCacheTouchAt: readLastCacheTtlTimestamp(params.sessionManager, {...}),
  });
  
  return contextPruningExtension;
}

// 2. 在 context-pruning 扩展中读取运行时状态
export default function contextPruningExtension(pi: PiExtensionAPI) {
  pi.on("before_turn", async (event, ctx) => {
    const runtime = getContextPruningRuntime(ctx.sessionManager);
    if (!runtime) return;
    
    const { settings, contextWindowTokens, isToolPrunable } = runtime;
    
    // 执行缓存 TTL 修剪逻辑
    if (shouldPruneBasedOnCacheTTL(runtime.lastCacheTouchAt, settings.ttl)) {
      const prunedMessages = pruneExpiredToolResults(event.messages, {
        isToolPrunable,
        maxAge: settings.ttl,
      });
      return { messages: prunedMessages };
    }
  });
}
```

### 9.2 场景 2: Compaction Safeguard（压缩保护）

**目标**: 在 compaction 过程中提供质量保护和自适应 token 预算

**实现位置**: [`src/agents/pi-hooks/compaction-safeguard-runtime.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/pi-hooks/compaction-safeguard-runtime.ts)

```typescript
// 1. 在 extensions.ts 中设置 compaction safeguard 配置
if (resolveCompactionMode(params.cfg) === "safeguard") {
  const compactionCfg = params.cfg?.agents?.defaults?.compaction;
  
  setCompactionSafeguardRuntime(params.sessionManager, {
    maxHistoryShare: compactionCfg?.maxHistoryShare,
    contextWindowTokens: contextWindowInfo.tokens,
    qualityGuardEnabled: compactionCfg?.qualityGuard?.enabled ?? true,
    qualityGuardMaxRetries: compactionCfg?.qualityGuard?.maxRetries,
    model: params.model,
  });
  
  factories.push(compactionSafeguardExtension);
}

// 2. 在 compaction-safeguard 扩展中使用配置
export default function compactionSafeguardExtension(pi: PiExtensionAPI) {
  pi.on("compaction_start", async (event, ctx) => {
    const safeguard = getCompactionSafeguardRuntime(ctx.sessionManager);
    if (!safeguard) return;
    
    const { contextWindowTokens, qualityGuardEnabled, qualityGuardMaxRetries } = safeguard;
    
    // 计算自适应 token 预算
    const adaptiveBudget = calculateAdaptiveBudget({ contextWindowTokens, ... });
    
    // 启用质量保护
    if (qualityGuardEnabled) {
      event.compactionOptions = {
        ...event.compactionOptions,
        maxRetries: qualityGuardMaxRetries,
        qualityCheck: true,
      };
    }
  });
}
```

### 9.3 场景 3: Plugin 拦截 Tool 调用进行安全检查

**目标**: 在执行危险命令前进行安全检查并要求审批

```typescript
export default {
  id: "security-guard",
  register(api: PluginAPI) {
    api.on("before_tool_call", async (event, ctx) => {
      if (event.toolName !== "exec") return undefined;
      
      const cmd = event.params.cmd as string;
      
      // 检测危险命令
      const dangerousPatterns = [/rm\s+-rf\s+\//, /dd\s+if=\/dev\/zero/, /mkfs\./];
      for (const pattern of dangerousPatterns) {
        if (pattern.test(cmd)) {
          return { block: true, blockReason: `Dangerous command detected` };
        }
      }
      
      // 对 sudo 命令要求审批
      if (cmd.startsWith("sudo")) {
        return {
          requireApproval: {
            title: "Privileged Command Execution",
            description: `The agent wants to execute: ${cmd}`,
            severity: "warning",
            timeoutMs: 60000,
            timeoutBehavior: "deny",
          },
        };
      }
      
      // 对其他命令添加安全模式
      return { params: { ...event.params, mode: "safe", sandbox: true } };
    }, { priority: 100 });
  },
};
```

### 9.4 场景 4: Session 生命周期管理

**目标**: 在 session 开始和结束时执行自定义逻辑

```typescript
export default {
  id: "session-analytics",
  register(api: PluginAPI) {
    api.on("session_start", async (event, ctx) => {
      analytics.track("session_started", {
        sessionId: event.sessionId,
        sessionKey: event.sessionKey,
        resumedFrom: event.resumedFrom,
        timestamp: Date.now(),
      });
      await initializeSessionMetrics(event.sessionId);
    });
    
    api.on("session_end", async (event, ctx) => {
      analytics.track("session_ended", {
        sessionId: event.sessionId,
        messageCount: event.messageCount,
        durationMs: event.durationMs,
        reason: event.reason,
        timestamp: Date.now(),
      });
      
      const metrics = await calculateSessionMetrics(event.sessionId);
      analytics.track("session_metrics", metrics);
      await cleanupSessionMetrics(event.sessionId);
    });
  },
};
```

### 9.5 场景 5: Custom Context Engine

**目标**: 提供自定义的上下文管理策略（如 lossless-claw）

```typescript
import { registerContextEngineForOwner } from "../context-engine/registry.js";

class LosslessContextEngine implements ContextEngine {
  readonly info = { id: "lossless-claw", name: "Lossless Context Engine", version: "1.0.0" };
  
  async bootstrap(params): Promise<BootstrapResult> {
    console.log(`Bootstrapping lossless context for session ${params.sessionId}`);
    return { bootstrapped: true };
  }
  
  async ingest(params): Promise<IngestResult> {
    await storeMessageLossless(params.sessionId, params.message);
    return { ingested: true };
  }
  
  async assemble(params): Promise<AssembleResult> {
    const messages = await retrieveMessagesLossless(params.sessionId, { tokenBudget: params.tokenBudget });
    return { messages, estimatedTokens: estimateTokens(messages) };
  }
  
  async compact(params): Promise<CompactResult> {
    const summary = await generateLosslessSummary(params.sessionFile, { tokenBudget: params.tokenBudget });
    return { compacted: true, summary, tokensSaved: params.currentTokenCount ?? 0 };
  }
  
  async afterTurn(params): Promise<void> {
    await updateLosslessState(params.sessionId, { messageCount: params.messages.length });
  }
  
  async dispose(): Promise<void> {
    await cleanupLosslessState();
  }
}

// 注册 engine
registerContextEngineForOwner("lossless-claw", () => new LosslessContextEngine(), "plugin");
```

---

## 10. 设计原则与最佳实践

### 10.1 核心设计原则

#### 1. 对象身份一致性

⚠️ **重要**: Runtime Registry 依赖于 SessionManager 的对象身份，必须确保使用同一个实例：

```typescript
// ❌ 错误：使用了不同的 SessionManager 实例
const sm1 = SessionManager.open(file);
const sm2 = SessionManager.open(file);  // 新的实例！
setContextPruningRuntime(sm1, value);
getContextPruningRuntime(sm2);  // 返回 null！

// ✅ 正确：复用同一个实例
const sm = SessionManager.open(file);
setContextPruningRuntime(sm, value);
getContextPruningRuntime(sm);  // 正确返回值
```

#### 2. 空值处理

Registry 的 `get()` 方法可能返回 `null`，始终进行空值检查：

```typescript
const runtime = getContextPruningRuntime(sessionManager);
if (!runtime) {
  // 该 session 没有设置运行时状态
  return;
}
// 安全地使用 runtime
const { settings, contextWindowTokens } = runtime;
```

#### 3. 类型安全

使用 TypeScript 泛型确保类型正确：

```typescript
export type ContextPruningRuntimeValue = {
  settings: EffectiveContextPruningSettings;
  contextWindowTokens?: number | null;
  isToolPrunable: (toolName: string) => boolean;
  lastCacheTouchAt?: number | null;
};

const registry = createSessionManagerRuntimeRegistry<ContextPruningRuntimeValue>();

// TypeScript 会检查值的类型
setContextPruningRuntime(sm, {
  settings: {...},      // ✓ 符合类型定义
  invalidField: 123     // ✗ 编译错误
});
```

#### 4. 自动清理

利用 WeakMap 的自动垃圾回收特性，无需手动清理：

```typescript
// 不需要这样做
sessionManager.close();
registry.delete(sessionManager);  // ❌ 不必要

// WeakMap 会自动处理
sessionManager = null;  // 当没有引用时，registry 条目自动清理
```

### 10.2 Hook 最佳实践

#### 1. 优先级管理

合理使用 hook 优先级：

```typescript
// 高优先级：安全检查
api.on("before_tool_call", securityCheck, { priority: 100 });

// 中优先级：参数修改
api.on("before_tool_call", modifyParams, { priority: 50 });

// 低优先级：日志记录
api.on("before_tool_call", logToolCall, { priority: 0 });
```

#### 2. 快速失败

在 hook 中尽早返回，避免不必要的处理：

```typescript
api.on("before_tool_call", (event, ctx) => {
  if (event.toolName !== "exec") {
    return undefined;  // 快速返回
  }
  // 处理 exec 工具
});
```

#### 3. 错误处理

妥善处理 hook 中的错误：

```typescript
api.on("before_tool_call", async (event, ctx) => {
  try {
    const result = await checkSecurity(event.params);
    return result;
  } catch (error) {
    console.error(`Hook error: ${error.message}`);
    return undefined;  // 允许继续执行
  }
});
```

### 10.3 Performance 考虑

#### 1. 缓存 SessionManager

使用 session manager cache 减少文件 I/O：

```typescript
import { prewarmSessionFile, trackSessionManagerAccess } from "../agents/pi-embedded-runner/session-manager-cache.js";

await prewarmSessionFile(sessionFile);
const sessionManager = SessionManager.open(sessionFile);
trackSessionManagerAccess(sessionFile);
```

#### 2. 轻量级 Hook 处理

保持 hook 处理函数轻量：

```typescript
// ✅ 轻量级
api.on("before_tool_call", (event, ctx) => {
  if (event.toolName === "exec") {
    return { params: { ...event.params, mode: "safe" } };
  }
  return undefined;
});

// ❌ 重量级（避免在 hook 中执行耗时操作）
api.on("before_tool_call", async (event, ctx) => {
  const result = await heavyComputation();  // 慢
  const data = await fetchExternalAPI();    // 慢
  return result;
});
```

---

## 附录

### A. 相关文件索引

| 文件路径 | 职责 |
|---------|------|
| `src/agents/pi-hooks/session-manager-runtime-registry.ts` | Runtime Registry 核心实现 |
| `src/agents/pi-extensions/context-pruning/runtime.ts` | Context Pruning Registry |
| `src/agents/pi-hooks/compaction-safeguard-runtime.ts` | Compaction Safeguard Registry |
| `src/context-engine/types.ts` | Context Engine 接口定义 |
| `src/context-engine/registry.ts` | Context Engine Registry |
| `src/context-engine/legacy.ts` | Legacy Context Engine 实现 |
| `src/plugins/types.ts` | Plugin Hook 类型定义 |
| `src/plugins/hooks.ts` | Hook Runner 实现 |
| `src/agents/pi-tools.before-tool-call.ts` | Before Tool Call Hook 包装 |
| `src/agents/session-tool-result-guard-wrapper.ts` | Tool Result Guard |
| `src/agents/pi-embedded-runner/run/attempt.ts` | Agent 运行核心逻辑 |
| `src/auto-reply/reply/session-hooks.ts` | Session Lifecycle Hooks |

### B. 相关文档

- [Session Management Deep Dive](/reference/session-management-compaction.md)
- [Agent Loop](/concepts/agent-loop.md)
- [System Prompt](/concepts/system-prompt.md)
- [Hooks](/automation/hooks.md)
- [Plugins](/plugins/overview.md)

---

**最后更新**: 2026-05-13  
**作者**: OpenClaw Team  
**许可证**: MIT
