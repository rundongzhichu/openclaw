# Gateway 模块详细结构说明

本文档详细说明 `src/gateway/` 目录下所有文件的功能和作用。Gateway 是 OpenClaw 的核心控制平面，负责 WebSocket 服务器、会话管理、认证授权、插件系统等核心功能。

## 📊 总体统计

- **总文件数**: 342 个 TypeScript 文件（不含测试文件）
- **子目录**: 9 个
  - `protocol/` - 协议定义
  - `server/` - 服务器核心实现
  - `server-methods/` - RPC 方法处理器
  - `voiceclaw-realtime/` - 实时语音处理
  - 其他为根目录文件

---

## 🗂️ 文件分类详解

### 1️⃣ 核心入口文件 (Core Entry Points)

#### `server.ts`
- **作用**: Gateway 服务器的公共 API 导出
- **功能**: 
  - 导出 `startGatewayServer` 函数
  - 提供类型定义 `GatewayServer`, `GatewayServerOptions`
  - 懒加载实现模块以优化启动速度

#### `server.impl.ts` (938 行)
- **作用**: Gateway 服务器的核心实现
- **功能**:
  - 启动 WebSocket 服务器
  - 初始化所有子系统（通道、插件、Cron、会话等）
  - 配置加载和热重载
  - 健康检查和状态管理
  - 信号处理（SIGUSR1 重启）
  - 媒体清理定时任务
  - 诊断心跳

**关键函数**:
- `startGatewayServer()` - 主启动函数
- `createGatewayStartupTrace()` - 启动性能追踪
- `resolveMediaCleanupTtlMs()` - 媒体清理 TTL 计算

---

### 2️⃣ 认证授权模块 (Authentication & Authorization)

#### 核心认证文件

| 文件名 | 功能描述 |
|--------|---------|
| `auth.ts` | 认证主模块 - 解析网关认证配置 |
| `auth-config-utils.ts` | 认证配置工具函数 |
| `auth-install-policy.ts` | 认证安装策略 |
| `auth-mode-policy.ts` | 认证模式策略（token/shared/device） |
| `auth-rate-limit.ts` | 认证速率限制器 |
| `auth-resolve.ts` | 认证解析逻辑 |
| `auth-surface-resolution.ts` | 认证表面解析 |
| `auth-token-resolution.ts` | Token 认证解析 |

#### 连接认证

| 文件名 | 功能描述 |
|--------|---------|
| `connection-auth.ts` | WebSocket 连接认证处理 |
| `device-auth.ts` | 设备认证管理 |
| `shared-auth.test-helpers.ts` | 共享认证测试辅助 |
| `server-shared-auth-generation.ts` | 共享认证会话生成 |

#### 控制平面安全

| 文件名 | 功能描述 |
|--------|---------|
| `control-plane-audit.ts` | 控制平面审计日志 |
| `control-plane-rate-limit.ts` | 控制平面速率限制 |

---

### 3️⃣ WebSocket 连接管理 (WebSocket Connection Management)

#### 位于 `server/ws-connection/` 子目录

| 文件名 | 功能描述 |
|--------|---------|
| `auth-context.ts` | WebSocket 认证上下文 |
| `auth-messages.ts` | 认证消息协议 |
| `connect-policy.ts` | 连接策略管理 |
| `handshake-auth-helpers.ts` | 握手认证辅助函数 |
| `message-handler.ts` | WebSocket 消息处理器 |
| `unauthorized-flood-guard.ts` | 未授权洪水攻击防护 |

#### 根目录 WS 相关文件

| 文件名 | 功能描述 |
|--------|---------|
| `server-ws-runtime.ts` | WebSocket 运行时管理 |
| `ws-log.ts` | WebSocket 日志记录 |
| `ws-logging.ts` | WebSocket 日志系统 |
| `server/ws-types.ts` | WebSocket 类型定义 |
| `server/ws-shared-generation.ts` | 共享会话生成 |
| `server/ws-connection.ts` | WebSocket 连接抽象 |

---

### 4️⃣ 服务器启动流程 (Server Startup)

#### 启动阶段文件

| 文件名 | 功能描述 |
|--------|---------|
| `server-startup.ts` | 主启动流程编排 |
| `server-startup-early.ts` | 早期启动阶段（日志、配置） |
| `server-startup-config.ts` | 启动配置加载 |
| `server-startup-plugins.ts` | 插件启动引导 |
| `server-startup-memory.ts` | 内存系统启动 |
| `server-startup-session-migration.ts` | 会话迁移处理 |
| `server-startup-unavailable-methods.ts` | 不可用方法注册 |
| `server-startup-post-attach.ts` | 附加后启动阶段 |
| `server-startup-log.ts` | 启动日志记录 |

#### 启动相关服务

| 文件名 | 功能描述 |
|--------|---------|
| `startup-auth.ts` | 启动时认证初始化 |
| `startup-control-ui-origins.ts` | Control UI 源初始化 |
| `startup-tasks.ts` | 启动任务调度 |
| `boot.ts` | 引导程序 |

---

### 5️⃣ 服务器运行时管理 (Runtime Management)

#### 运行时状态和服务

| 文件名 | 功能描述 |
|--------|---------|
| `server-runtime-state.ts` | 运行时状态管理 |
| `server-runtime-services.ts` | 运行时服务激活 |
| `server-runtime-config.ts` | 运行时配置解析 |
| `server-runtime-handles.ts` | 运行时句柄管理 |
| `server-runtime-subscriptions.ts` | 事件订阅管理 |

#### 网络运行时

| 文件名 | 功能描述 |
|--------|---------|
| `server-network-runtime.ts` | 网络运行时（HTTP/WS 监听） |
| `server-tailscale.ts` | Tailscale 集成 |

#### 健康检查

| 文件名 | 功能描述 |
|--------|---------|
| `server/health-state.ts` | 健康状态缓存和版本管理 |
| `server/readiness.ts` | 就绪检查器 |
| `channel-health-monitor.ts` | 通道健康监控 |
| `channel-health-policy.ts` | 通道健康策略 |

---

### 6️⃣ RPC 方法处理器 (Server Methods)

位于 `server-methods/` 子目录，包含所有 WebSocket RPC 方法的实现。

#### 核心方法

| 文件名 | 功能描述 |
|--------|---------|
| `sessions.ts` | 会话管理方法（list, get, create, delete） |
| `sessions.runtime.ts` | 会话运行时操作 |
| `send.ts` | 发送消息方法 |
| `tools-catalog.ts` | 工具目录查询 |
| `tools-effective.ts` | 有效工具解析 |
| `tools-effective.runtime.ts` | 工具运行时解析 |

#### Agent 相关

| 文件名 | 功能描述 |
|--------|---------|
| `agent.ts` | Agent 管理方法 |
| `agent-list.ts` | Agent 列表管理 |
| `agent-prompt.ts` | Agent Prompt 管理 |
| `subagent-followup.test-helpers.ts` | 子代理跟进测试辅助 |

#### 节点和设备

| 文件名 | 功能描述 |
|--------|---------|
| `nodes.ts` | 节点管理方法 |
| `nodes.helpers.ts` | 节点辅助函数 |
| `nodes.handlers.invoke-result.ts` | 节点调用结果处理 |
| `nodes-pending.ts` | 待处理节点请求 |
| `native-hook-relay.ts` | 原生钩子中继 |

#### 配置和凭证

| 文件名 | 功能描述 |
|--------|---------|
| `config.ts` | 配置管理方法 |
| `secrets.ts` | 密钥管理方法 |
| `credentials.ts` | 凭证管理 |
| `credential-planner.ts` | 凭证规划器 |
| `credentials-secret-inputs.ts` | 密钥输入处理 |

#### 插件和技能

| 文件名 | 功能描述 |
|--------|---------|
| `plugins.ts` | 插件管理方法 |
| `plugin-approval.ts` | 插件审批流程 |
| `skills.ts` | Skills 管理方法 |

#### 语音和通话

| 文件名 | 功能描述 |
|--------|---------|
| `talk.ts` | Talk 语音方法 |
| `voicewake.ts` | Voice Wake 唤醒词 |
| `voicewake-routing.ts` | Voice Wake 路由 |
| `tts.ts` | TTS 文本转语音 |
| `call.ts` | 通话管理 |
| `call.runtime.ts` | 通话运行时 |

#### Canvas 和媒体

| 文件名 | 功能描述 |
|--------|---------|
| `canvas.ts` | Canvas 画布方法 |
| `canvas-capability.ts` | Canvas 能力检查 |
| `canvas-documents.ts` | Canvas 文档管理 |

#### Web 和控制 UI

| 文件名 | 功能描述 |
|--------|---------|
| `web.ts` | Web 相关方法 |
| `control-ui.ts` | Control UI 服务 |
| `control-ui-contract.ts` | Control UI 契约 |
| `control-ui-routing.ts` | Control UI 路由 |
| `control-ui-csp.ts` | CSP 内容安全策略 |
| `control-ui-http-utils.ts` | HTTP 工具函数 |
| `control-ui-links.ts` | UI 链接管理 |
| `control-ui-shared.ts` | 共享 UI 逻辑 |

#### 其他方法

| 文件名 | 功能描述 |
|--------|---------|
| `system.ts` | 系统信息查询 |
| `usage.ts` | 使用统计 |
| `update.ts` | 更新检查 |
| `wizard.ts` | 向导流程 |
| `push.ts` | 推送通知 |
| `record-shared.ts` | 录音共享 |
| `restart-request.ts` | 重启请求 |
| `validation.ts` | 数据验证 |
| `types.ts` | 方法类型定义 |
| `shared-types.ts` | 共享类型 |

---

### 7️⃣ 会话管理 (Session Management)

#### 会话核心文件

| 文件名 | 功能描述 |
|--------|---------|
| `session-store-key.ts` | 会话存储键管理 |
| `session-lifecycle-state.ts` | 会话生命周期状态 |
| `session-history-state.ts` | 会话历史状态 |
| `session-transcript-key.ts` | 会话转录键 |
| `session-preview.test-helpers.ts` | 会话预览测试辅助 |

#### 会话归档和压缩

| 文件名 | 功能描述 |
|--------|---------|
| `session-archive.fs.ts` | 会话归档文件系统操作 |
| `session-archive.runtime.ts` | 会话归档运行时 |
| `session-compaction-checkpoints.ts` | 会话压缩检查点 |
| `session-transcript-files.fs.ts` | 转录文件系统操作 |

#### 会话操作

| 文件名 | 功能描述 |
|--------|---------|
| `session-reset-service.ts` | 会话重置服务 |
| `session-kill-http.ts` | HTTP 会话终止 |
| `session-subagent-reactivation.ts` | 子代理重新激活 |
| `session-subagent-reactivation.runtime.ts` | 重新激活运行时 |
| `sessions-patch.ts` | 会话补丁应用 |
| `sessions-resolve.ts` | 会话解析 |
| `sessions-history-http.ts` | 会话历史 HTTP API |

#### 会话工具

| 文件名 | 功能描述 |
|--------|---------|
| `session-utils.ts` | 会话工具函数 |
| `session-utils.fs.ts` | 文件系统会话工具 |
| `session-utils.types.ts` | 会话工具类型 |
| `server-session-key.ts` | 服务器会话键 |
| `server-session-events.ts` | 会话事件 |

#### CLI 会话历史

| 文件名 | 功能描述 |
|--------|---------|
| `cli-session-history.ts` | CLI 会话历史主模块 |
| `cli-session-history.merge.ts` | 会话历史合并 |
| `cli-session-history.claude.ts` | Claude 会话历史 |

---

### 8️⃣ 聊天和消息处理 (Chat & Message Handling)

| 文件名 | 功能描述 |
|--------|---------|
| `chat-abort.ts` | 聊天中止处理 |
| `chat-attachments.ts` | 聊天附件管理 |
| `chat-display-projection.ts` | 聊天显示投影 |
| `chat-sanitize.ts` | 聊天内容净化 |
| `control-reply-text.ts` | 控制回复文本 |

---

### 9️⃣ 客户端管理 (Client Management)

| 文件名 | 功能描述 |
|--------|---------|
| `client.ts` | 客户端抽象和管理 |
| `client-bootstrap.ts` | 客户端引导流程 |

---

### 🔟 配置管理 (Configuration Management)

| 文件名 | 功能描述 |
|--------|---------|
| `config-reload.ts` | 配置热重载 |
| `config-reload-plan.ts` | 重载计划制定 |
| `config-recovery-notice.ts` | 配置恢复通知 |
| `server-reload-handlers.ts` | 重载处理器 |

---

### 1️⃣1️⃣ 通道管理 (Channel Management)

| 文件名 | 功能描述 |
|--------|---------|
| `channel-status-patches.ts` | 通道状态补丁 |
| `server-channels.ts` | 通道管理器创建 |

---

### 1️⃣2️⃣ Cron 定时任务 (Cron Scheduler)

| 文件名 | 功能描述 |
|--------|---------|
| `server-cron.ts` | Cron 服务构建和管理 |

---

### 1️⃣3️⃣ 服务器关闭和清理 (Server Shutdown)

| 文件名 | 功能描述 |
|--------|---------|
| `server-close.ts` | 关闭处理器和前奏 |
| `server/close-reason.ts` | 关闭原因截断 |

---

### 1️⃣4️⃣ 模型目录 (Model Catalog)

| 文件名 | 功能描述 |
|--------|---------|
| `server-model-catalog.ts` | 模型目录加载和缓存 |

---

### 1️⃣5️⃣ 插件系统 (Plugin System)

| 文件名 | 功能描述 |
|--------|---------|
| `server-plugins.ts` | 插件上下文解析器 |
| `server-plugin-bootstrap.ts` | 插件引导 |

#### 插件 HTTP 路由 (server/plugins-http/)

| 文件名 | 功能描述 |
|--------|---------|
| `route-auth.ts` | 路由认证 |
| `route-match.ts` | 路由匹配 |
| `path-context.ts` | 路径上下文 |
| `plugins-http.ts` | 插件 HTTP 服务 |

---

### 1️⃣6️⃣ 节点事件 (Node Events)

| 文件名 | 功能描述 |
|--------|---------|
| `server-node-events.ts` | 节点事件管理 |
| `server-node-events.runtime.ts` | 节点事件运行时 |
| `server-node-events-types.ts` | 节点事件类型 |
| `server-node-subscriptions.ts` | 节点订阅 |
| `server-mobile-nodes.ts` | 移动节点管理 |

---

### 1️⃣7️⃣ 实时语音 (VoiceClaw Realtime)

位于 `voiceclaw-realtime/` 子目录

| 文件名 | 功能描述 |
|--------|---------|
| `gemini-live.ts` | Gemini 实时流处理 |
| `instructions.ts` | 实时指令管理 |
| `paths.ts` | 实时路径配置 |
| `session.ts` | 实时会话管理 |
| `tool-runtime.ts` | 工具运行时 |
| `tools.ts` | 实时工具集 |
| `types.ts` | 类型定义 |
| `upgrade.ts` | WebSocket 升级处理 |

---

### 1️⃣8️⃣ 助手身份 (Assistant Identity)

| 文件名 | 功能描述 |
|--------|---------|
| `assistant-identity.ts` | 助手身份管理 |

---

### 1️⃣9️⃣ Agent 事件和文本 (Agent Events)

| 文件名 | 功能描述 |
|--------|---------|
| `agent-event-assistant-text.ts` | Agent 事件助手文本 |

---

### 2️⃣0️⃣ 连接详情 (Connection Details)

| 文件名 | 功能描述 |
|--------|---------|
| `connection-details.ts` | 连接详情管理 |

---

### 2️⃣1️⃣ 设备元数据 (Device Metadata)

| 文件名 | 功能描述 |
|--------|---------|
| `device-metadata-normalization.ts` | 设备元数据标准化 |

---

### 2️⃣2️⃣ MCP 协议支持 (MCP Protocol)

| 文件名 | 功能描述 |
|--------|---------|
| `mcp-http.ts` | MCP HTTP 环回服务器 |

---

### 2️⃣3️⃣ 工具调用 (Tools Invoke)

| 文件名 | 功能描述 |
|--------|---------|
| `tools-invoke-http.ts` | 工具调用 HTTP API |
| `tool-resolution.ts` | 工具解析 |

---

### 2️⃣4️⃣ 服务器辅助处理器 (Aux Handlers)

| 文件名 | 功能描述 |
|--------|---------|
| `server-aux-handlers.ts` | 辅助处理器创建 |

---

### 2️⃣5️⃣ 服务器车道并发 (Lanes Concurrency)

| 文件名 | 功能描述 |
|--------|---------|
| `server-lanes.ts` | 车道并发控制 |

---

### 2️⃣6️⃣ 服务器实时状态 (Live State)

| 文件名 | 功能描述 |
|--------|---------|
| `server-live-state.ts` | 实时状态管理 |

---

### 2️⃣7️⃣ 服务器方法列表 (Methods List)

| 文件名 | 功能描述 |
|--------|---------|
| `server-methods-list.ts` | 网关事件和方法列表 |
| `server-methods.ts` | 核心网关处理器 |

---

### 2️⃣8️⃣ 服务器请求上下文 (Request Context)

| 文件名 | 功能描述 |
|--------|---------|
| `server-request-context.ts` | 请求上下文创建 |

---

### 2️⃣9️⃣ 服务器重启哨兵 (Restart Sentinel)

| 文件名 | 功能描述 |
|--------|---------|
| `server-restart-sentinel.ts` | 重启哨兵监控 |

---

### 3️⃣0️⃣ 服务器共享工具 (Shared Utils)

| 文件名 | 功能描述 |
|--------|---------|
| `server-shared.ts` | 共享工具函数 |
| `server-utils.ts` | 服务器工具函数 |

---

### 3️⃣1️⃣ 向导会话 (Wizard Sessions)

| 文件名 | 功能描述 |
|--------|---------|
| `server-wizard-sessions.ts` | 向导会话跟踪器 |

---

### 3️⃣2️⃣ 服务器钩子 (Hooks)

| 文件名 | 功能描述 |
|--------|---------|
| `server/hooks.ts` | 钩子客户端 IP 配置 |

---

### 3️⃣3️⃣ TLS 支持 (TLS)

| 文件名 | 功能描述 |
|--------|---------|
| `server/tls.ts` | TLS 运行时加载 |

---

### 3️⃣4️⃣ 服务器存在事件 (Presence Events)

| 文件名 | 功能描述 |
|--------|---------|
| `server/presence-events.ts` | 存在事件管理 |

---

### 3️⃣5️⃣ 预授权连接预算 (Preauth Budget)

| 文件名 | 功能描述 |
|--------|---------|
| `server/preauth-connection-budget.ts` | 预授权连接预算控制 |

---

### 3️⃣6️⃣ 插件路由运行时范围 (Plugin Route Scopes)

| 文件名 | 功能描述 |
|--------|---------|
| `server/plugin-route-runtime-scopes.ts` | 插件路由运行时范围 |

---

### 3️⃣7️⃣ HTTP 认证 (HTTP Auth)

| 文件名 | 功能描述 |
|--------|---------|
| `server/http-auth.ts` | HTTP 认证处理 |
| `server/http-listen.ts` | HTTP 监听管理 |

---

### 3️⃣8️⃣ 协议定义 (Protocol)

位于 `protocol/` 和 `protocol/schema/` 子目录

---

### 3️⃣9️⃣ 测试辅助文件 (Test Helpers)

大量以 `test-helpers.` 开头的文件，用于单元测试和集成测试：

| 文件名 | 功能描述 |
|--------|---------|
| `test-helpers.ts` | 通用测试辅助 |
| `test-helpers.server.ts` | 服务器测试辅助 |
| `test-helpers.config-runtime.ts` | 配置运行时测试辅助 |
| `test-helpers.e2e.ts` | E2E 测试辅助 |
| `test-helpers.mocks.ts` | Mock 对象 |
| `test-helpers.openai-mock.ts` | OpenAI Mock |
| `test-helpers.speech.ts` | 语音测试辅助 |
| `test-helpers.channels.ts` | 通道测试辅助 |
| `test-helpers.plugin-registry.ts` | 插件注册表测试辅助 |
| `test-helpers.runtime-state.ts` | 运行时状态测试辅助 |
| `test-helpers.agent-results.ts` | Agent 结果测试辅助 |
| `test-helpers.config-snapshots.ts` | 配置快照测试辅助 |
| `talk.test-helpers.ts` | Talk 测试辅助 |
| `device-authz.test-helpers.ts` | 设备授权测试辅助 |
| `session-preview.test-helpers.ts` | 会话预览测试辅助 |

---

### 4️⃣0️⃣ 测试工具和 Mock (Test Utilities)

| 文件名 | 功能描述 |
|--------|---------|
| `test-http-response.ts` | HTTP 响应测试工具 |
| `test-openai-responses-model.ts` | OpenAI 响应模型测试 |
| `test-temp-config.ts` | 临时配置测试 |
| `test-with-server.ts` | 带服务器的测试 |
| `server.e2e-ws-harness.ts` | E2E WS 测试 harness |
| `server.e2e-registry-helpers.ts` | E2E 注册表辅助 |

---

### 4️⃣1️⃣ 认证测试套件 (Auth Test Suites)

| 文件名 | 功能描述 |
|--------|---------|
| `server.auth.shared.ts` | 共享认证测试 |
| `server.auth.modes.suite.ts` | 认证模式测试套件 |
| `server.auth.default-token.suite.ts` | 默认 Token 测试套件 |
| `server.auth.control-ui.suite.ts` | Control UI 认证测试套件 |

---

### 4️⃣2️⃣ 服务器测试辅助 (Server Test Utils)

位于 `server/__tests__/` 子目录

| 文件名 | 功能描述 |
|--------|---------|
| `test-utils.ts` | 服务器测试工具 |

---

### 4️⃣3️⃣ 其他文件

| 文件名 | 功能描述 |
|--------|---------|
| `server.agent.gateway-server-agent.mocks.ts` | Agent Mock |

---

## 🔄 核心工作流程

### 1. 服务器启动流程

```
startGatewayServer()
    ↓
[server-startup-early.ts] - 早期初始化（日志、环境检查）
    ↓
[server-startup-config.ts] - 加载配置
    ↓
[server-startup-plugins.ts] - 引导插件
    ↓
[server-startup-memory.ts] - 初始化记忆系统
    ↓
[server-startup.ts] - 主启动流程
    ├── 创建运行时状态
    ├── 启动网络运行时（HTTP/WS 监听）
    ├── 附加 WebSocket 处理器
    ├── 激活计划服务（Cron、健康检查等）
    └── 启动诊断心跳
    ↓
[server-startup-post-attach.ts] - 附加后清理
```

### 2. WebSocket 连接流程

```
客户端连接 ws://localhost:18789
    ↓
[server/http-listen.ts] - HTTP 服务器接收
    ↓
[server/tls.ts] - TLS 处理（如果启用）
    ↓
[server/ws-connection.ts] - 创建 WS 连接
    ↓
[server/ws-connection/handshake-auth-helpers.ts] - 握手认证
    ↓
[connection-auth.ts] - 验证 Token/Shared/Device 认证
    ↓
[auth-rate-limit.ts] - 速率限制检查
    ↓
[server/ws-connection/message-handler.ts] - 注册消息处理器
    ↓
连接就绪，可以接收 RPC 调用
```

### 3. RPC 方法调用流程

```
客户端发送 { method: "sessions.list", params: {...} }
    ↓
[server/ws-connection/message-handler.ts] - 接收消息
    ↓
[server-methods.ts] - 路由到对应处理器
    ↓
[server-methods/sessions.ts] - 执行 sessions.list
    ↓
[server-runtime-state.ts] - 访问运行时状态
    ↓
返回结果给客户端
```

### 4. 配置热重载流程

```
配置文件修改 (~/.openclaw/openclaw.json)
    ↓
[config-reload.ts] - 检测配置变化
    ↓
[config-reload-plan.ts] - 制定重载计划
    ↓
[server-reload-handlers.ts] - 执行重载
    ├── 重新加载通道配置
    ├── 重新加载插件配置
    ├── 更新认证配置
    └── 广播配置更新事件
    ↓
[config-recovery-notice.ts] - 发送恢复通知（如果需要）
```

---

## 📌 关键设计模式

### 1. 懒加载 (Lazy Loading)
- `server.ts` 使用动态 import 延迟加载 `server.impl.ts`
- 优化启动速度和内存占用

### 2. 运行时状态管理 (Runtime State)
- `server-runtime-state.ts` 集中管理所有运行时状态
- 包括：会话、通道、插件、节点、健康状态等

### 3. 事件订阅 (Event Subscription)
- `server-runtime-subscriptions.ts` 管理 WebSocket 事件订阅
- 支持按频道、会话、类型过滤

### 4. 认证策略 (Auth Strategy)
- 支持三种认证模式：Token、Shared、Device
- `auth-mode-policy.ts` 定义认证策略
- `auth-rate-limit.ts` 防止暴力破解

### 5. 健康检查 (Health Check)
- `server/health-state.ts` 维护健康状态缓存
- 定期刷新，避免频繁计算
- 版本号机制确保缓存一致性

---

## 🎯 核心概念

### Gateway Server
- **职责**: 整个系统的控制中心
- **端口**: 默认 18789
- **协议**: WebSocket + JSON-RPC
- **功能**: 
  - 会话管理
  - 通道路由
  - Agent 协调
  - 插件管理
  - 配置热重载
  - 健康监控

### Runtime State
- **定义**: 运行时状态的集中存储
- **包含**:
  - 活跃会话
  - 通道实例
  - 插件注册表
  - 节点连接
  - 健康指标
  - 认证令牌

### RPC Methods
- **格式**: JSON-RPC 2.0
- **示例**:
  ```json
  {
    "jsonrpc": "2.0",
    "method": "sessions.list",
    "params": {},
    "id": 1
  }
  ```

### Authentication Modes
1. **Token**: 基于 JWT token 的认证
2. **Shared**: 共享密钥认证（简化模式）
3. **Device**: 设备配对认证（最安全）

---

## 📚 学习建议

### 入门路径
1. 阅读 `server.ts` 和 `server.impl.ts` 了解整体架构
2. 查看 `server-runtime-state.ts` 理解状态管理
3. 研究 `server-methods/sessions.ts` 学习 RPC 方法实现
4. 分析 `connection-auth.ts` 理解认证流程

### 进阶主题
1. **插件系统**: `server-plugins.ts`, `server-plugin-bootstrap.ts`
2. **WebSocket 优化**: `server/ws-connection/message-handler.ts`
3. **配置热重载**: `config-reload.ts`
4. **健康监控**: `channel-health-monitor.ts`

---

## 🔍 常见问题排查

### Gateway 无法启动
- 检查 `server-startup.ts` 日志
- 查看端口占用：`lsof -i :18789`
- 检查配置文件：`~/.openclaw/openclaw.json`

### WebSocket 连接失败
- 检查 `connection-auth.ts` 认证配置
- 查看 `auth-rate-limit.ts` 是否触发限流
- 检查防火墙规则

### RPC 方法调用超时
- 检查 `server-methods/` 对应方法的实现
- 查看 `server-runtime-state.ts` 状态是否正常
- 检查网络延迟

### 配置重载不生效
- 检查 `config-reload.ts` 监听器
- 查看 `server-reload-handlers.ts` 执行日志
- 确认文件格式正确

---

## 📊 文件统计

- **核心实现**: ~50 个文件
- **RPC 方法**: ~40 个文件
- **认证授权**: ~15 个文件
- **会话管理**: ~20 个文件
- **测试辅助**: ~30 个文件
- **工具函数**: ~20 个文件
- **其他**: ~167 个文件

---

**最后更新**: 2026-04-28  
**文档版本**: 1.0
