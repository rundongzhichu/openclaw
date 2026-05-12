# Skill、Plugin、MCP、Tool 以及 Agent/SubAgent 启动入口和流程

本文档详细说明 OpenClaw 中 Skill、Plugin、MCP、Tool 以及 Agent/SubAgent 的启动入口和执行流程。

---

## 1. Skill 系统

### 1.1 核心文件位置

- **技能运行时**: [`src/agents/pi-embedded-runner/skills-runtime.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/pi-embedded-runner/skills-runtime.ts)
- **技能加载**: [`src/agents/skills.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/skills.ts) (loadWorkspaceSkillEntries)
- **技能安装**: [`src/agents/skills-install.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/skills-install.ts)
- **技能状态**: [`src/agents/skills-status.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/skills-status.ts)
- **技能配置解析**: [`src/agents/skills/runtime-config.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/skills/runtime-config.ts)

### 1.2 启动入口

**入口点**: Agent 执行引擎在准备阶段调用 `resolveEmbeddedRunSkillEntries()`

```typescript
// src/agents/pi-embedded-runner/skills-runtime.ts
export function resolveEmbeddedRunSkillEntries(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
  skillsSnapshot?: SkillSnapshot;
}): {
  shouldLoadSkillEntries: boolean;
  skillEntries: SkillEntry[];
}
```

### 1.3 加载流程

1. **检查快照**: 如果已有 `skillsSnapshot.resolvedSkills`，跳过重新加载
2. **解析配置**: 调用 `resolveSkillRuntimeConfig()` 获取技能运行时配置
3. **加载条目**: 调用 `loadWorkspaceSkillEntries(workspaceDir, { config, agentId })`
4. **返回结果**: 返回是否应该加载以及加载的技能条目列表

### 1.4 关键特性

- 支持工作区级别的技能管理
- 通过快照机制避免重复加载
- 支持 Agent 特定的技能配置
- 与上下文引擎集成

---

## 2. Plugin 系统

### 2.1 核心文件位置

- **插件注册表**: [`src/plugins/registry.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/plugins/registry.ts)
- **插件加载器**: [`src/plugins/loader.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/plugins/loader.ts)
- **插件 SDK**: [`packages/plugin-sdk/`](file:///Users/sunshoucai/vscodeProjects/openclaw/packages/plugin-sdk/)
- **插件命令注册**: [`src/plugins/command-registry-state.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/plugins/command-registry-state.ts)
- **示例插件**: `extensions/*/plugin.ts` 或 `extensions/*/channel-plugin-api.ts`

### 2.2 启动入口

**入口点**: Gateway 启动时加载所有已安装的插件

```
// 插件在 extensions/*/index.ts 中声明
export default {
  plugin: {
    specifier: "./api.js",
    exportName: "myPlugin",
  },
} satisfies ChannelManifest;
```

### 2.3 加载流程

1. **扫描扩展目录**: 读取 `extensions/` 目录下的所有插件
2. **解析清单**: 读取每个插件的 `index.ts` 或 `package.json` 中的 manifest
3. **动态导入**: 使用动态 import() 加载插件模块
4. **注册插件**: 调用插件的初始化函数，注册服务、工具、命令等
5. **激活钩子**: 触发 `onActivate` 生命周期钩子

### 2.4 插件类型

- **通道插件 (Channel Plugin)**: 提供消息通道（如 Telegram、Slack）
- **服务插件 (Service Plugin)**: 提供后台服务（如浏览器自动化）
- **工具插件 (Tool Plugin)**: 提供 AI 可调用的工具
- **设置插件 (Setup Plugin)**: 提供配置向导

### 2.5 关键特性

- 热插拔架构，支持运行时加载/卸载
- 标准化的插件 API (OpenClawPluginApi)
- 支持 HTTP 路由注册
- 支持后台服务生命周期管理
- 插件间隔离的执行环境

---

## 3. MCP (Model Context Protocol) 系统

### 3.1 核心文件位置

- **MCP 运行时**: [`src/agents/pi-bundle-mcp-runtime.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/pi-bundle-mcp-runtime.ts)
- **MCP 工具物化**: [`src/agents/pi-bundle-mcp-materialize.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/pi-bundle-mcp-materialize.ts)
- **MCP 传输层**: [`src/agents/mcp-transport.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/mcp-transport.ts), [`src/agents/mcp-stdio.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/mcp-stdio.ts)
- **MCP 配置**: [`src/config/mcp-config.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/config/mcp-config.ts)
- **MCP HTTP 支持**: [`src/gateway/mcp-http.runtime.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/gateway/mcp-http.runtime.ts)
- **MCP CLI**: [`src/cli/mcp-cli.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/cli/mcp-cli.ts)

### 3.2 启动入口

**入口点**: Agent 执行前调用 `materializeBundleMcpToolsForRun()`

```typescript
// src/agents/pi-bundle-mcp-materialize.ts
export async function materializeBundleMcpToolsForRun(params: {
  sessionKey: string;
  config: OpenClawConfig;
  // ... 其他参数
}): Promise<BundleMcpToolRuntime>
```

### 3.3 加载流程

1. **读取配置**: 从 `cfg.mcp.servers` 读取 MCP 服务器配置
2. **创建会话运行时**: 调用 `getOrCreateSessionMcpRuntime(sessionKey)`
3. **启动服务器**: 为每个配置的 MCP 服务器创建子进程连接
   - stdio 模式: 通过 stdin/stdout 通信
   - HTTP 模式: 通过 HTTP endpoint 通信
4. **获取工具列表**: 调用 MCP 服务器的 `tools/list` 方法
5. **转换为 AI 工具**: 将 MCP 工具包装为 Anthropic/Claude 兼容的工具格式
6. **注入到提示词**: 将工具定义添加到系统提示词中

### 3.4 MCP 服务器配置示例

```
mcp:
  servers:
    filesystem:
      command: "npx"
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
      connectionTimeoutMs: 5000
    github:
      command: "npx"
      args: ["-y", "@modelcontextprotocol/server-github"]
      env:
        GITHUB_TOKEN: "${GITHUB_TOKEN}"
```

### 3.5 关键特性

- 支持 stdio 和 HTTP 两种传输协议
- 会话级别的 MCP 运行时隔离
- 自动清理和资源回收
- 工具结果缓存和去重
- 支持环境变量注入
- 连接超时和重试机制

---

## 4. Tool 系统

### 4.1 核心文件位置

- **工具目录**: [`src/agents/tool-catalog.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/tool-catalog.ts)
- **工具创建**: `src/agents/tools/*.ts` (各种工具实现)
- **工具策略**: [`src/sandbox/tool-policy.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/sandbox/tool-policy.ts)
- **工具截断**: [`src/agents/pi-embedded-runner/tool-result-truncation.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/pi-embedded-runner/tool-result-truncation.ts)
- **内置工具**: 
  - [`sessions-spawn-tool.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/tools/sessions-spawn-tool.ts) - 子 Agent 创建
  - [`message-tool.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/tools/message-tool.ts) - 消息发送
  - [`web-fetch-tool.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/tools/web-fetch-tool.ts) - 网页抓取
  - [`exec-tool.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/tools/exec-tool.ts) - 命令执行

### 4.2 启动入口

**入口点**: Agent 执行引擎在构建提示词时组装工具列表

```typescript
// 工具在 pi-embedded-runner/run.ts 中被组装
const tools = [
  ...coreTools,      // 核心工具 (read, write, exec 等)
  ...skillTools,     // 技能提供的工具
  ...mcpTools,       // MCP 服务器提供的工具
  ...pluginTools,    // 插件提供的工具
];
```

### 4.3 加载流程

1. **基础工具**: 从 `tool-catalog.ts` 获取核心工具定义
2. **技能工具**: 从已加载的技能中提取工具定义
3. **MCP 工具**: 从活跃的 MCP 服务器获取工具列表
4. **插件工具**: 从已激活的插件中收集工具
5. **应用策略**: 根据沙箱策略过滤允许/禁止的工具
6. **序列化**: 将工具转换为 LLM 提供商所需的格式 (Anthropic/OpenAI/Google 等)

### 4.4 工具分类

- **文件系统工具**: read, write, edit, apply_patch
- **运行时工具**: exec, process, code_execution
- **网络工具**: web_search, web_fetch, x_search
- **记忆工具**: memory_search, memory_get
- **会话工具**: sessions_list, sessions_send, sessions_spawn
- **消息工具**: message (发送到不同通道)
- **自动化工具**: cron, update_plan
- **媒体工具**: image_generation, audio_transcription

### 4.5 关键特性

- 统一的工具接口 (ToolDefinition)
- 支持工具权限控制 (allow/deny 列表)
- 工具结果自动截断防止上下文溢出
- 工具调用追踪和审计
- 支持工具并行执行
- 工具错误处理和重试

---

## 5. Agent 启动流程

### 5.1 核心文件位置

- **主入口**: [`src/agents/pi-embedded-runner/run.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/pi-embedded-runner/run.ts) (100.4KB)
- **网关调度**: [`src/gateway/server-methods/agent.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/gateway/server-methods/agent.ts)
- **命令队列**: [`src/process/command-queue.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/process/command-queue.ts)
- **Lane 管理**: [`src/agents/pi-embedded-runner/lanes.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/pi-embedded-runner/lanes.ts)
- **执行计划**: [`src/agents/runtime-plan/build.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/runtime-plan/build.ts)
- **认证管理**: [`src/agents/model-auth.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/model-auth.ts)

### 5.2 启动入口

**入口点 1**: WebSocket RPC 调用 `agent` 方法

```
// src/gateway/server-methods/agent.ts
agent: async ({ params, respond, context, client }) => {
  // 1. 验证参数
  // 2. 解析会话键
  // 3. 创建会话（如果需要）
  // 4. 分发到命令队列
  dispatchAgentRunFromGateway({ ... });
}
```

**入口点 2**: 命令行调用

```
openclaw agent send --message "hello" --session-key "agents/main/sessions/abc123"
```

### 5.3 完整启动流程

#### Phase 1: 请求接收与验证

1. **接收请求**: Gateway 接收 WebSocket 或 CLI 请求
2. **参数验证**: 验证 message、agentId、sessionKey 等参数
3. **权限检查**: 检查调用者是否有权限执行操作
4. **去重检查**: 检查 idempotencyKey 避免重复执行

#### Phase 2: 会话管理

1. **解析会话键**: 从 sessionKey 提取 agentId 和 sessionId
2. **加载会话**: 从 JSONL 文件加载会话历史
3. **创建会话**: 如果是新会话，创建会话文件和元数据
4. **更新会话**: 更新 lastInteractionAt、deliveryContext 等字段
5. **会话重置**: 如果消息包含 `/reset` 或 `/new`，执行会话重置

#### Phase 3: 工作空间准备

1. **解析工作空间**: 确定 Agent 的工作空间目录
2. **加载技能**: 调用 `resolveEmbeddedRunSkillEntries()` 加载技能
3. **加载插件**: 确保相关插件已激活
4. **准备上下文**: 构建 bootstrap 文件和上下文引擎

#### Phase 4: 工具组装

1. **核心工具**: 从 tool-catalog 获取基础工具
2. **技能工具**: 添加技能提供的工具
3. **MCP 工具**: 调用 `materializeBundleMcpToolsForRun()` 启动 MCP 服务器
4. **插件工具**: 收集插件注册的工具
5. **应用策略**: 根据沙箱配置过滤工具

#### Phase 5: 模型和认证准备

1. **解析模型**: 从配置或会话中解析 provider 和 model
2. **Auth Profile**: 解析认证配置文件（API Key、OAuth 等）
3. **故障转移计划**: 构建 Auth Profile 轮换策略
4. **超时配置**: 计算运行超时时间

#### Phase 6: 命令入队

1. **选择 Lane**: 根据会话类型选择命令队列 (MAIN/SUBAGENT/CRON)
2. **创建 AbortController**: 创建可取消的执行控制器
3. **注册运行**: 在 chatAbortControllers 中注册活跃运行
4. **入队命令**: 调用 `enqueueCommandInLane()` 将命令加入队列
5. **返回接受**: 立即返回 `{ status: "accepted", runId }`

#### Phase 7: 执行循环 (在 Lane Worker 中)

1. **消费命令**: Lane worker 从队列中取出命令
2. **构建提示词**: 组装系统提示词、历史消息、工具定义
3. **调用模型**: 调用 `resolveModelAsync()` 发送请求到 LLM
4. **处理响应**: 
   - 文本响应: 流式返回给用户
   - 工具调用: 执行工具并返回结果
   - 错误处理: 根据错误类型决定是否重试
5. **上下文管理**: 
   - 检测上下文溢出
   - 触发压缩或截断
   - 维护上下文引擎
6. **重试逻辑**: 
   - Context Overflow: 压缩 → 截断 → 放弃
   - Timeout: 超时前压缩
   - Auth Error: 刷新令牌/轮换 Profile
   - Rate Limit: 轮换 Profile → 降级模型
7. **完成处理**: 
   - 保存会话历史
   - 发送交付消息（如果需要）
   - 清理 MCP 运行时
   - 发射生命周期事件

### 5.4 关键设计模式

- **状态累积模式**: 跨重试保持运行状态
- **生命周期元数据注入**: 所有退出路径设置终端元数据
- **防重复副作用保护**: 避免重试导致的数据污染
- **不可变数据模式**: 使用 structuredClone 保证一致性
- **执行追踪系统**: 记录每次尝试的详细元数据

---

## 6. Memory 记忆系统

### 6.1 核心文件位置

- **记忆核心插件**: [`extensions/memory-core/index.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/extensions/memory-core/index.ts)
- **记忆运行时**: [`extensions/memory-core/src/runtime-provider.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/extensions/memory-core/src/runtime-provider.ts)
- **记忆搜索管理器**: [`extensions/memory-core/src/memory/search-manager.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/extensions/memory-core/src/memory/search-manager.ts)
- **记忆提示词段**: [`extensions/memory-core/src/prompt-section.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/extensions/memory-core/src/prompt-section.ts)
- **记忆工具**: [`extensions/memory-core/src/tools.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/extensions/memory-core/src/tools.ts)
- **记忆 SDK**: [`src/plugin-sdk/memory-core-bundled-runtime.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/plugin-sdk/memory-core-bundled-runtime.ts)
- **记忆配置解析**: [`src/agents/memory-search.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/memory-search.ts)
- **记忆运行时集成**: [`src/plugins/memory-runtime.js`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/plugins/memory-runtime.js)

### 6.2 启动入口

**入口点 1**: Plugin 注册时激活记忆能力

```
// extensions/memory-core/index.ts
export default definePluginEntry({
  id: "memory-core",
  name: "Memory (Core)",
  kind: "memory",
  register(api) {
    // 注册内置的记忆嵌入提供者
    registerBuiltInMemoryEmbeddingProviders(api);
    
    // 注册记忆能力（包含 prompt builder、flush plan、runtime）
    api.registerMemoryCapability({
      promptBuilder: buildPromptSection,
      flushPlanResolver: buildMemoryFlushPlan,
      runtime: memoryRuntime,
      publicArtifacts: {
        listArtifacts: listMemoryCorePublicArtifacts,
      },
    });

    // 注册记忆工具
    api.registerTool(
      (ctx) => createMemorySearchTool({ config: ctx.config, agentSessionKey: ctx.sessionKey }),
      { names: ["memory_search"] }
    );
    api.registerTool(
      (ctx) => createMemoryGetTool({ config: ctx.config, agentSessionKey: ctx.sessionKey }),
      { names: ["memory_get"] }
    );
  },
});
```

**入口点 2**: Agent 执行前加载记忆搜索管理器

```
// src/plugins/memory-runtime.js
export async function getActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<{ manager: MemorySearchManager | null; error?: string }>
```

### 6.3 加载流程

#### Phase 1: Plugin 激活阶段

1. **扫描记忆插件**: Gateway 启动时扫描并加载 `memory-core` 插件
2. **注册记忆能力**: 调用 `api.registerMemoryCapability()` 注册：
   - `promptBuilder`: 构建记忆相关的系统提示词段
   - `flushPlanResolver`: 决定何时将对话内容 flush 到记忆文件
   - `runtime`: 记忆运行时接口（获取管理器、关闭连接等）
3. **注册记忆工具**: 注册 `memory_search` 和 `memory_get` 两个工具
4. **注册嵌入提供者**: 调用 `registerBuiltInMemoryEmbeddingProviders()` 注册向量嵌入适配器

#### Phase 2: Agent 执行准备阶段

1. **解析记忆配置**: 
   ````
   const resolvedMemory = resolveMemorySearchConfig(config, agentId);
   ```
   - 从 `cfg.memory` 读取记忆后端配置
   - 支持多种后端：qmd（外部二进制）、lancedb（向量数据库）、builtin（内置索引）
   - 解析同步策略（sources、sync.sessions.postCompactionForce 等）

2. **获取记忆搜索管理器**:
   ````
   const { manager } = await getActiveMemorySearchManager({
     cfg: config,
     agentId: sessionAgentId,
   });
   ```
   - 调用 `getMemorySearchManager()` 获取或创建管理器实例
   - 使用全局单例缓存避免重复创建
   - 根据配置选择后端类型

3. **初始化记忆后端**:
   
   **QMD 后端**（推荐，性能最佳）:
   ````
   // extensions/memory-core/src/memory/qmd-manager.ts
   const qmdBinary = await checkQmdBinaryAvailability({
     command: qmdResolved.command,  // 默认 "qmd"
     env: process.env,
     cwd: workspaceDir,
   });
   if (!qmdBinary.available) {
     // 降级到 builtin 后端
     return null;
   }
   const primary = await QmdMemoryManager.create({
     cfg, agentId, resolved, mode: "full", runtimeConfig
   });
   ```
   - 检查 `qmd` 二进制是否可用
   - 创建 QMD 记忆管理器（基于 SQLite + FTS5）
   - 如果不可用，降级到 builtin 后端

   **Builtin 后端**（ fallback ）:
   ````
   // extensions/memory-core/manager-runtime.ts
   const { MemoryIndexManager } = await import("./manager-runtime.js");
   return await MemoryIndexManager.get({ cfg, agentId });
   ```
   - 使用内存中的倒排索引
   - 无需外部依赖，但性能较差

4. **同步记忆索引**:
   ````
   await manager.sync({
     reason: "post-compaction",  // 或其他触发原因
     sessionFiles: [sessionFile],
   });
   ```
   - 扫描会话文件（JSONL 格式）
   - 提取关键信息（决策、偏好、TODO 等）
   - 写入记忆文件（`MEMORY.md`、`memory/*.md`）
   - 更新向量索引或全文索引

#### Phase 3: 构建系统提示词阶段

1. **调用 Prompt Builder**:
   ````
   // extensions/memory-core/src/prompt-section.ts
   export const buildPromptSection: MemoryPromptSectionBuilder = ({
     availableTools,
     citationsMode,
   }) => {
     const hasMemorySearch = availableTools.has("memory_search");
     const hasMemoryGet = availableTools.has("memory_get");
     
     if (!hasMemorySearch && !hasMemoryGet) {
       return [];  // 没有记忆工具，不添加提示词
     }
     
     // 添加工具使用指导
     let toolGuidance: string;
     if (hasMemorySearch && hasMemoryGet) {
       toolGuidance = "Before answering anything about prior work... run memory_search... then use memory_get...";
     } else if (hasMemorySearch) {
       toolGuidance = "Before answering anything about prior work... run memory_search...";
     } else {
       toolGuidance = "Before answering anything about prior work... run memory_get...";
     }
     
     const lines = ["## Memory Recall", toolGuidance];
     
     // 添加引用模式配置
     if (citationsMode === "off") {
       lines.push("Citations are disabled: do not mention file paths...");
     } else {
       lines.push("Citations: include Source: <path#line> when it helps...");
     }
     
     return lines;
   };
   ```

2. **注入到系统提示词**:
   ````
   // src/agents/pi-embedded-runner/system-prompt.ts
   const appendPrompt = buildEmbeddedSystemPrompt({
     // ... 其他参数
     includeMemorySection: true,  // 是否包含记忆部分
     memoryCitationsMode: config?.memory?.citations,  // 引用模式
     // ...
   });
   ```
   - 将记忆提示词段添加到系统提示词中
   - 指导 Agent 如何使用记忆工具
   - 配置引用格式（开启/关闭）

#### Phase 4: 运行时同步阶段

1. **压缩后强制同步**（可选）:
   ````
   // src/agents/pi-embedded-runner/compaction-hooks.ts
   async function runPostCompactionSessionMemorySync(params: {
     config?: OpenClawConfig;
     sessionKey?: string;
     sessionFile: string;
   }): Promise<void> {
     const agentId = resolveSessionAgentId({ sessionKey, config });
     const resolvedMemory = resolveMemorySearchConfig(config, agentId);
     
     // 检查是否启用 sessions 源和后压缩同步
     if (!resolvedMemory?.sources.includes("sessions")) return;
     if (!resolvedMemory.sync.sessions.postCompactionForce) return;
     
     const { manager } = await getActiveMemorySearchManager({ cfg: config, agentId });
     if (!manager?.sync) return;
     
     // 执行同步：将压缩后的会话内容写入记忆索引
     await manager.sync({
       reason: "post-compaction",
       sessionFiles: [sessionFile],
     });
   }
   ```
   - 在会话压缩完成后触发
   - 根据配置决定同步模式：`off` / `async` / `await`
   - 确保记忆索引与最新会话内容同步

2. **手动触发同步**:
   - 通过 CLI 命令：`openclaw memory sync`
   - 通过工具调用：`memory_search` 自动触发懒加载同步
   - 通过定时任务：配置的 cron job

### 6.4 记忆工具使用流程

#### memory_search 工具

**调用示例**:
```
{
  name: "memory_search",
  arguments: {
    query: "用户之前提到的项目部署方案",
    limit: 10,
    sources: ["sessions", "memory_files"]
  }
}
```

**执行流程**:
1. **接收查询**: Agent 调用 `memory_search` 工具
2. **获取管理器**: 从缓存中获取 `MemorySearchManager`
3. **执行搜索**:
   ````
   const results = await manager.search({
     query,
     limit,
     sources,
     agentId,
   });
   ```
4. **返回结果**: 
   ````
   [
     {
       path: "memory/2026-05-10.md",
       startLine: 15,
       endLine: 20,
       score: 0.92,
       snippet: "部署到 AWS ECS，使用 Fargate...",
       source: "memory"
     },
     // ...
   ]
   ```
5. **注入上下文**: 将搜索结果作为工具结果返回给 Agent

#### memory_get 工具

**调用示例**:
```
{
  name: "memory_get",
  arguments: {
    path: "memory/2026-05-10.md",
    lines: [15, 16, 17, 18, 19, 20]
  }
}
```

**执行流程**:
1. **接收请求**: Agent 调用 `memory_get` 工具
2. **读取文件**: 从工作空间读取指定的记忆文件
3. **提取行**: 提取指定行范围的内容
4. **返回内容**: 返回完整的文本片段

### 6.5 记忆后端架构

```
┌─────────────────────────────────────────────────────────────┐
│                   Memory Core Plugin                         │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │         Memory Capability Registration               │  │
│  │  - promptBuilder (buildPromptSection)                │  │
│  │  - flushPlanResolver (buildMemoryFlushPlan)          │  │
│  │  - runtime (getMemorySearchManager, closeAll...)     │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Memory Tools                             │  │
│  │  - memory_search: 语义搜索 + 全文检索                 │  │
│  │  - memory_get: 精确读取指定文件行                     │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│            Memory Search Manager (Singleton Cache)          │
│                                                              │
│  Identity Key = agentId + backend_config + workspace_dir    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  QMD Backend (Primary, Recommended)                  │  │
│  │  - Binary: qmd (external)                            │  │
│  │  - Storage: SQLite + FTS5                            │  │
│  │  - Features: 全文检索、高性能、持久化                 │  │
│  │  - Fallback: → Builtin if qmd unavailable            │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Builtin Backend (Fallback)                          │  │
│  │  - Implementation: MemoryIndexManager                │  │
│  │  - Storage: In-memory inverted index                 │  │
│  │  - Features: 无需外部依赖、轻量级                     │  │
│  │  - Limitations: 重启后丢失、性能较低                  │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  LanceDB Backend (Optional, Vector Search)           │  │
│  │  - Extension: memory-lancedb                         │  │
│  │  - Storage: LanceDB vector database                  │  │
│  │  - Features: 向量相似度搜索、大规模数据               │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│              Memory Sync Pipeline                            │
│                                                              │
│  Trigger Sources:                                            │
│  ├─ Post-Compaction (会话压缩后)                            │
│  ├─ Manual CLI (openclaw memory sync)                       │
│  ├─ Lazy Load (memory_search 首次调用)                      │
│  └─ Cron Job (定时任务)                                     │
│                                                              │
│  Sync Process:                                               │
│  1. Scan session files (JSONL)                              │
│  2. Extract key information:                                │
│     ├─ Decisions (决策)                                     │
│     ├─ Preferences (偏好)                                   │
│     ├─ TODOs (待办事项)                                     │
│     ├─ Facts (事实信息)                                     │
│     └─ Patterns (模式识别)                                  │
│  3. Write to memory files:                                  │
│     ├─ MEMORY.md (主记忆文件)                               │
│     └─ memory/*.md (分类记忆文件)                           │
│  4. Update index:                                           │
│     ├─ Full-text index (FTS5)                               │
│     └─ Vector embeddings (if enabled)                       │
└─────────────────────────────────────────────────────────────┘
```

### 6.6 关键特性

- **多后端支持**: QMD（推荐）、Builtin（fallback）、LanceDB（向量搜索）
- **全局单例缓存**: 基于 identity key 缓存管理器实例，避免重复创建
- **自动降级**: QMD 不可用时自动降级到 builtin 后端
- **智能同步**: 支持 post-compaction、manual、lazy、cron 多种同步触发方式
- **工具集成**: `memory_search` 和 `memory_get` 无缝集成到 Agent 工具链
- **提示词指导**: 自动生成记忆工具使用指导并注入系统提示词
- **引用模式**: 支持开启/关闭文件路径和行号引用
- **会话索引**: 自动从会话历史中提取关键信息并建立索引
- **压缩后同步**: 会话压缩后强制同步，确保记忆与最新状态一致

### 6.7 配置示例

```
memory:
  # 后端配置
  backend: "qmd"  # qmd | lancedb | builtin
  
  # QMD 后端配置
  qmd:
    command: "qmd"  # qmd 二进制路径
    indexPath: ".openclaw/memory/qmd"  # 索引存储路径
  
  # 同步配置
  sync:
    sessions:
      postCompactionForce: true  # 压缩后强制同步
      mode: "async"  # off | async | await
  
  # 搜索配置
  search:
    sources: ["sessions", "memory_files"]  # 搜索源
    defaultLimit: 10  # 默认返回数量
  
  # 引用配置
  citations: "on"  # on | off
  
  # 嵌入配置（用于向量搜索）
  embeddings:
    provider: "openai"  # openai | ollama | etc.
    model: "text-embedding-3-small"
    dimension: 1536
```

### 6.8 记忆 Flush 机制

**Flush Plan Resolver**: 决定何时将对话内容写入记忆文件

```
// extensions/memory-core/src/flush-plan.ts
export function buildMemoryFlushPlan(params: {
  sessionKey: string;
  config: OpenClawConfig;
  messages: AgentMessage[];
}): MemoryFlushPlan {
  // 分析消息内容，判断是否需要 flush
  // 返回 flush 计划：哪些消息应该写入记忆
}
```

**触发条件**:
- 检测到决策声明（"我决定..."、"我们将..."）
- 检测到偏好表达（"我喜欢..."、"我更倾向于..."）
- 检测到 TODO 创建（"我需要..."、"待办..."）
- 检测到重要事实（"关键是..."、"注意..."）
- 会话结束时批量 flush

---

## 7. SubAgent 启动流程

### 7.1 核心文件位置

- **Spawn 入口**: [`src/agents/subagent-spawn.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/subagent-spawn.ts) (40.4KB)
- **注册表**: [`src/agents/subagent-registry.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/subagent-registry.ts) (37.8KB)
- **公告机制**: [`src/agents/subagent-announce.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/subagent-announce.ts) (21.6KB)
- **控制接口**: [`src/agents/subagent-control.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/subagent-control.ts) (24.3KB)
- **深度管理**: [`src/agents/subagent-depth.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/subagent-depth.ts)
- **能力解析**: [`src/agents/subagent-capabilities.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/subagent-capabilities.ts)

### 7.2 启动入口

**入口点 1**: 通过 `sessions_spawn` 工具调用

```
// 用户在对话中调用 sessions_spawn 工具
{
  name: "sessions_spawn",
  arguments: {
    task: "分析这个代码库的结构",
    agentId: "coder",
    mode: "isolated",
    sandbox: "non-main"
  }
}
```

**入口点 2**: 编程方式调用

```
import { spawnSubagent } from "./subagent-spawn";

const result = await spawnSubagent({
  task: "执行代码审查",
  agentId: "reviewer",
  context: {
    agentSessionKey: "agents/main/sessions/xyz789"
  }
});
```

### 7.3 完整启动流程

#### Phase 1: 前置检查

1. **深度限制检查**: 
   - 获取当前会话的 spawnDepth
   - 检查是否超过最大深度（默认 3）
   - 防止无限递归
2. **并发限制检查**:
   - 统计父 Agent 的活跃子 Agent 数量
   - 检查是否超过每 Agent 最大子 Agent 数（默认值可配置）
3. **权限检查**:
   - 检查 requester 是否有权限 spawn subagent
   - 验证 allowAgents 配置白名单
   
   ````
   const allowAgents =
     resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ??
     cfg?.agents?.defaults?.subagents?.allowAgents ??
     [];
   ```

#### Phase 2: 会话创建

1. **生成会话键**: 
   - 创建唯一的 sessionKey: `agents/{agentId}/sessions/{uuid}`
   - 标记为 subagent 会话
2. **Fork 父会话**:
   - 调用 `forkSessionFromParent()` 复制父会话的关键信息
   - 继承 deliveryContext、groupId、groupChannel 等
   - 设置 spawnedBy 指向父会话
3. **初始化会话存储**:
   - 创建会话 JSONL 文件
   - 写入初始元数据 (sessionId, spawnDepth, spawnedBy)
   - 注册到 subagent registry

#### Phase 3: 上下文准备

1. **解析工作空间**:
   - 确定子 Agent 的工作空间目录
   - 支持从父会话继承或显式指定
2. **构建系统提示词**:
   - 调用 `buildSubagentSystemPrompt()`
   - 注入任务描述、父会话上下文
   - 添加子 Agent 特定的指令
3. **附件处理**:
   - 如果有 attachments，调用 `materializeSubagentAttachments()`
   - 将附件内容写入工作空间
   - 生成挂载路径引用

#### Phase 4: 模型和资源配置

1. **解析模型计划**:
   - 调用 `resolveSubagentModelAndThinkingPlan()`
   - 支持从父会话继承或独立配置
   - 解析 thinking level、provider、model
2. **超时配置**:
   - 计算运行超时时间
   - 默认 60 秒，可配置
3. **沙箱配置**:
   - 解析 sandbox mode (non-main / always / never)
   - 配置资源限制（CPU、内存）

#### Phase 5: 执行启动

1. **注册运行**:
   - 调用 `registerSubagentRun()` 注册到 registry
   - 跟踪活跃运行数量
2. **入队命令**:
   - 选择 AGENT_LANE_SUBAGENT 队列
   - 调用 `enqueueCommandInLane()` 入队
3. **异步执行**:
   - 不等待子 Agent 完成
   - 立即返回 `{ sessionKey, accepted: true }`

#### Phase 6: 子 Agent 执行 (独立 Lane Worker)

1. **消费命令**: SUBAGENT Lane worker 取出命令
2. **执行 Agent**: 复用主 Agent 的执行引擎 ([`pi-embedded-runner/run.ts`](file:///Users/sunshoucai/vscodeProjects/openclaw/src/agents/pi-embedded-runner/run.ts))
   - 加载技能、插件、MCP 工具
   - 构建提示词、调用模型
   - 处理工具调用
3. **结果公告**:
   - 执行完成后，调用 `announceSubagentResult()`
   - 将结果发送回父会话
   - 支持重试和退避策略
4. **清理**:
   - 根据 cleanup 配置决定删除或保留会话
   - 从 registry 注销
   - 释放资源

#### Phase 7: 父会话接收结果

1. **接收公告**: 父会话收到子 Agent 的结果消息
2. **注入上下文**: 将子 Agent 的输出作为工具结果注入到父会话
3. **继续执行**: 父 Agent 基于子 Agent 的结果继续执行

### 7.4 关键特性

- **嵌套支持**: 最多 3 层嵌套 (main → subagent → sub-subagent)
- **资源隔离**: 每个子 Agent 有独立的会话、工作空间、Lane 队列
- **自动清理**: 执行完成后自动清理临时资源
- **公告机制**: 通过可靠的消息传递将结果返回父会话
- **并发控制**: 限制每个 Agent 的子 Agent 数量
- **持久化恢复**: 重启后可以从 registry 恢复活跃的子 Agent
- **深度限制**: 防止无限递归和栈溢出
- **沙箱隔离**: 非主会话默认在沙箱中执行

### 7.5 配置示例

```
agents:
  defaults:
    subagents:
      maxSpawnDepth: 3                    # 最大嵌套深度
      maxChildrenPerAgent: 5              # 每个 Agent 的最大子 Agent 数
      allowAgents: ["*"]                  # 允许 spawn 的 Agent 白名单
      defaultCleanup: "delete"            # 默认清理策略
      defaultSandbox: "non-main"          # 默认沙箱模式
      timeoutSeconds: 60                  # 默认超时时间
```

---

## 8. 组件交互关系图

```
┌─────────────────────────────────────────────────────────────┐
│                     Gateway (WebSocket/CLI)                  │
│  接收用户请求 → 验证参数 → 解析会话 → 分发到命令队列          │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│                  Command Queue (Lane System)                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │  MAIN    │  │ SUBAGENT │  │  CRON    │  │  ACP     │   │
│  │  Lane    │  │  Lane    │  │  Lane    │  │  Lane    │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
└───────┼─────────────┼─────────────┼─────────────┼──────────┘
        │             │             │             │
        ▼             ▼             ▼             ▼
┌─────────────────────────────────────────────────────────────┐
│              Agent Execution Engine (run.ts)                 │
│                                                              │
│  Phase 1: 准备工作                                           │
│  ├─ 加载 Skills (skills-runtime.ts)                         │
│  ├─ 激活 Plugins (plugin registry)                          │
│  ├─ 启动 MCP Servers (pi-bundle-mcp-runtime.ts)             │
│  ├─ 初始化 Memory (memory-core plugin + search manager)     │
│  └─ 组装 Tools (tool-catalog + skill + mcp + plugin + memory)│
│                                                              │
│  Phase 2: 执行循环                                           │
│  ├─ 构建提示词 (system + history + tools + memory section)  │
│  ├─ 调用模型 (resolveModelAsync)                            │
│  ├─ 处理响应 (text / tool_calls)                            │
│  ├─ 执行工具 (exec / read / write / memory_search...)       │
│  └─ 上下文管理 (compact / truncate)                         │
│                                                              │
│  Phase 3: 完成处理                                           │
│  ├─ 保存会话历史                                             │
│  ├─ 发送交付消息                                             │
│  ├─ 清理 MCP 运行时                                          │
│  ├─ 同步记忆索引 (post-compaction sync)                     │
│  └─ 发射生命周期事件                                         │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   │ sessions_spawn 工具调用
                   ▼
┌─────────────────────────────────────────────────────────────┐
│                SubAgent Spawn (subagent-spawn.ts)            │
│                                                              │
│  Phase 1: 前置检查                                           │
│  ├─ 深度限制检查 (max depth = 3)                            │
│  ├─ 并发限制检查 (max children per agent)                   │
│  └─ 权限检查 (allowAgents whitelist)                        │
│                                                              │
│  Phase 2: 会话创建                                           │
│  ├─ 生成唯一 sessionKey                                     │
│  ├─ Fork 父会话上下文                                        │
│  └─ 初始化会话存储                                           │
│                                                              │
│  Phase 3: 执行启动                                           │
│  ├─ 注册到 subagent registry                                │
│  ├─ 入队到 SUBAGENT Lane                                    │
│  └─ 异步执行（不阻塞父 Agent）                               │
│                                                              │
│  Phase 4: 结果公告                                           │
│  ├─ 子 Agent 执行完成                                        │
│  ├─ announceSubagentResult() 发送结果                       │
│  └─ 父会话接收并注入上下文                                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 9. 关键技术要点

### 9.1 可选链和空值合并的使用

在配置解析中广泛使用 TypeScript 的可选链 (`?.`) 和空值合并 (`??`) 运算符：

```
// 优先级降级策略
const allowAgents =
  resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ??  // 第一优先级：Agent 特定配置
  cfg?.agents?.defaults?.subagents?.allowAgents ??                      // 第二优先级：全局默认配置
  [];                                                                    // 兜底：空数组
```

- **`?.` (可选链)**: 安全访问可能为 null/undefined 的嵌套属性
- **`??` (空值合并)**: 仅在值为 null/undefined 时使用默认值（区别于 `||`）

### 9.2 Lane 队列隔离

不同类型的任务在不同的 Lane 队列中执行，确保并发控制和执行隔离：

- **MAIN**: 主 Agent 会话
- **SUBAGENT**: 子 Agent 会话
- **CRON**: 定时任务
- **ACP**: ACP 协议会话

### 9.3 会话键格式

```
agents/{agentId}/sessions/{sessionId}
```

- agentId: Agent 标识符（如 "main", "coder", "reviewer"）
- sessionId: UUID 或自定义 ID

### 9.4 工具权限控制

通过沙箱策略控制工具访问：

```yaml
sandbox:
  tools:
    allow: ["read", "write", "exec"]
    deny: ["process", "code_execution"]
```

### 9.5 上下文管理三级恢复

1. **Level 1**: 显式压缩历史记录
2. **Level 2**: 截断大型工具结果
3. **Level 3**: 返回用户友好错误提示

### 9.6 记忆系统单例缓存

记忆搜索管理器使用全局单例缓存，基于 identity key 避免重复创建：

```typescript
Identity Key = agentId + backend_config + workspace_dir
```

- 相同配置的 Agent 共享同一个记忆管理器实例
- 配置变更时自动失效并重新创建
- 支持优雅关闭和资源释放

---

## 10. 相关文档

- [`docs/automation/tasks.md`](file:///Users/sunshoucai/vscodeProjects/openclaw/docs/automation/tasks.md) - 任务系统文档
- [`docs/automation/taskflow.md`](file:///Users/sunshoucai/vscodeProjects/openclaw/docs/automation/taskflow.md) - TaskFlow 文档
- [`docs/learning/任务编排机制详解.md`](file:///Users/sunshoucai/vscodeProjects/openclaw/docs/learning/任务编排机制详解.md) - 详细机制说明
- [`docs/learning/skills-loading.md`](file:///Users/sunshoucai/vscodeProjects/openclaw/docs/learning/skills-loading.md) - Skills 加载机制
- [`docs/learning/tools-mechanism.md`](file:///Users/sunshoucai/vscodeProjects/openclaw/docs/learning/tools-mechanism.md) - Tools 机制详解
- [`docs/learning/插件原理.md`](file:///Users/sunshoucai/vscodeProjects/openclaw/docs/learning/插件原理.md) - 插件系统原理
- [`docs/learning/memory-system-architecture.md`](file:///Users/sunshoucai/vscodeProjects/openclaw/docs/learning/memory-system-architecture.md) - 记忆系统架构详解

---

**文档版本**: 1.1  
**最后更新**: 2026-05-12  
**维护者**: OpenClaw Team  
**更新内容**: 新增 Memory 记忆系统完整章节，包括加载机制、后端架构、工具使用流程等
