/**
 * @fileoverview Plugin SDK 统一导出入口
 * 
 * 本文件是 OpenClaw 插件系统的核心类型和工具的统一导出点，为插件开发者提供完整的 API 表面。
 * 
 * **设计原则**:
 * - **精简导出**: 仅包含最常用的共享类型和工具
 * - **分层导出**: Channel/Provider 辅助函数在专门的子路径或兼容层中
 * - **类型安全**: 所有导出都使用 TypeScript 类型定义
 * - **向后兼容**: 提供废弃标记以平滑迁移
 * 
 * **核心模块**:
 * 1. **Channel 插件**: 消息渠道适配器（WhatsApp, Telegram, Slack 等）
 * 2. **Provider 插件**: AI 模型提供者（OpenAI, Anthropic, Z.ai 等）
 * 3. **CLI Backend**: CLI 命令后端支持
 * 4. **上下文引擎**: Transcript 压缩和维护
 * 5. **诊断事件**: 系统监控和日志
 * 
 * **使用示例**:
 * ```typescript
 * // 创建一个 WhatsApp Channel 插件
 * import type { ChannelPlugin, ChannelSetupAdapter } from '@openclaw/plugin-sdk';
 * 
 * const plugin: ChannelPlugin = {
 *   id: 'whatsapp',
 *   setup: async (ctx) => {
 *     // 实现设置逻辑
 *   },
 *   poll: async (ctx) => {
 *     // 实现轮询逻辑
 *   }
 * };
 * 
 * export default plugin;
 * ```
 * 
 * @module plugin-sdk/index
 */

// ==================== Channel 核心类型 ====================

/**
 * Channel 账号快照
 * 
 * 用于持久化存储 Channel 的认证状态和账号信息。
 */
export type {
  ChannelAccountSnapshot,
  ChannelAgentTool,
  ChannelAgentToolFactory,
  ChannelCapabilities,
  ChannelGatewayContext,
  ChannelId,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelStatusIssue,
} from "../channels/plugins/types.js";

/**
 * Channel 配置绑定相关类型
 * 
 * 用于支持会话级别的绑定配置（如特定的对话 ID、线程 ID）。
 */
export type {
  ChannelConfiguredBindingConversationRef,
  ChannelConfiguredBindingMatch,
  ChannelConfiguredBindingProvider,
} from "../channels/plugins/types.adapters.js";

/**
 * Channel 插件基础类型
 * 
 * @property ChannelConfigSchema - 配置 Schema 定义
 * @property ChannelConfigUiHint - UI 提示（用于 Control UI）
 * @property ChannelPlugin - 插件主接口
 */
export type {
  ChannelConfigSchema,
  ChannelConfigUiHint,
  ChannelPlugin,
} from "../channels/plugins/types.plugin.js";

/**
 * Channel 设置适配器和输入
 * 
 * 用于引导用户完成 Channel 的初始配置流程。
 */
export type { ChannelSetupAdapter, ChannelSetupInput } from "../channels/plugins/types.js";

/**
 * 配置绑定核心类型
 * 
 * 定义了绑定的编译、解析和目标描述符。
 */
export type {
  ConfiguredBindingConversation,
  ConfiguredBindingResolution,
  CompiledConfiguredBinding,
  StatefulBindingTargetDescriptor,
} from "../channels/plugins/binding-types.js";

/**
 * 有状态绑定目标驱动
 * 
 * 用于管理需要长期维护状态的绑定目标（如 Discord 频道、Slack 工作区）。
 */
export type {
  StatefulBindingTargetDriver,
  StatefulBindingTargetReadyResult,
  StatefulBindingTargetResetResult,
  StatefulBindingTargetSessionResult,
} from "../channels/plugins/stateful-target-drivers.js";

/**
 * Channel 设置向导
 * 
 * 提供交互式的配置引导流程。
 */
export type {
  ChannelSetupWizard,
  ChannelSetupWizardAllowFromEntry,
} from "../channels/plugins/setup-wizard.js";

// ==================== 通用插件类型 ====================

/**
 * 通用插件 API 和工具类型
 * 
 * @property AnyAgentTool - 任意 Agent 工具
 * @property CliBackendPlugin - CLI 后端插件
 * @property MediaUnderstandingProviderPlugin - 媒体理解提供者
 * @property OpenClawPluginApi - 插件 API 接口
 * @property OpenClawPluginConfigSchema - 插件配置 Schema
 * @property PluginLogger - 插件专用 Logger
 * @property ProviderAuthContext - Provider 认证上下文
 * @property ProviderAuthResult - Provider 认证结果
 * @property ProviderRuntimeModel - Provider 运行时模型
 * @property SpeechProviderPlugin - 语音提供者插件
 */
export type {
  AnyAgentTool,
  CliBackendPlugin,
  MediaUnderstandingProviderPlugin,
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  PluginLogger,
  ProviderAuthContext,
  ProviderAuthResult,
  ProviderRuntimeModel,
  SpeechProviderPlugin,
} from "../plugins/types.js";

/**
 * 插件运行时类型
 * 
 * @property PluginRuntime - 插件运行时环境
 * @property RuntimeLogger - 运行时 Logger
 * @property SubagentRunParams - 子代理运行参数
 * @property SubagentRunResult - 子代理运行结果
 */
export type {
  PluginRuntime,
  RuntimeLogger,
  SubagentRunParams,
  SubagentRunResult,
} from "../plugins/runtime/types.js";

// ==================== 配置和环境 ====================

/**
 * OpenClaw 完整配置对象
 * 
 * 包含所有系统配置项：gateway, agents, channels, models, tools, secrets 等。
 */
export type { OpenClawConfig } from "../config/config.js";

/** @deprecated 已废弃，请使用 OpenClawConfig */
export type { OpenClawConfig as ClawdbotConfig } from "../config/config.js";

/**
 * CLI 后端配置
 * 
 * 用于配置 CLI 命令的执行环境和权限。
 */
export type { CliBackendConfig } from "../config/types.js";

// ==================== 图像生成 ====================

/** 图像生成相关工具和类型 */
export * from "./image-generation.js";

// ==================== 密钥管理 ====================

/**
 * 密钥引用类型
 * 
 * 用于在配置中安全地引用敏感值（API Key、密码等）。
 */
export type { SecretInput, SecretRef } from "../config/types.secrets.js";

// ==================== 运行时环境 ====================

/**
 * 运行时环境抽象
 * 
 * 定义了 I/O、日志、退出等底层操作的接口。
 */
export type { RuntimeEnv } from "../runtime.js";

// ==================== Hook 系统 ====================

/**
 * Hook 入口定义
 * 
 * 用于拦截和扩展系统行为（如 gateway_start, session_create）。
 */
export type { HookEntry } from "../hooks/types.js";

// ==================== 自动回复 ====================

/**
 * 回复载荷类型
 * 
 * 定义了自动回复的消息结构和元数据。
 */
export type { ReplyPayload } from "../auto-reply/types.js";

// ==================== 设置向导 ====================

/**
 * 向导提示器
 * 
 * 用于 CLI 交互式设置的提示逻辑。
 */
export type { WizardPrompter } from "../wizard/prompts.js";

// ==================== 上下文引擎 ====================

/**
 * 上下文引擎工厂
 * 
 * 用于注册自定义的 Transcript 管理策略。
 */
export type { ContextEngineFactory } from "../context-engine/registry.js";

/**
 * 诊断事件载荷
 * 
 * 用于遥测和监控系统健康状态。
 */
export type { DiagnosticEventPayload } from "../infra/diagnostic-events.js";

/**
 * 上下文引擎核心类型
 * 
 * @property ContextEngine - 上下文引擎接口
 * @property ContextEngineInfo - 引擎元信息
 * @property ContextEngineMaintenanceResult - 维护操作结果
 * @property ContextEngineRuntimeContext - 运行时上下文
 * @property TranscriptRewriteReplacement - Transcript 替换规则
 * @property TranscriptRewriteRequest - Transcript 重写请求
 * @property TranscriptRewriteResult - Transcript 重写结果
 */
export type {
  ContextEngine,
  ContextEngineInfo,
  ContextEngineMaintenanceResult,
  ContextEngineRuntimeContext,
  TranscriptRewriteReplacement,
  TranscriptRewriteRequest,
  TranscriptRewriteResult,
} from "../context-engine/types.js";

// ==================== 导出工具函数 ====================

/**
 * 空插件配置 Schema
 * 
 * 用于不需要配置的插件作为默认值。
 */
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";

/**
 * 注册上下文引擎
 * 
 * 将自定义的上下文引擎注册到系统中。
 * 
 * @example
 * ```typescript
 * registerContextEngine('my-engine', {
 *   info: { name: 'My Engine' },
 *   compact: async (transcript) => { /* ... *\/ }
 * });
 * ```
 */
export { registerContextEngine } from "../context-engine/registry.js";

/**
 * 委托压缩给运行时
 * 
 * 将 Transcript 压缩逻辑委托给运行时环境处理。
 * 适用于无状态或外部存储的场景。
 */
export { delegateCompactionToRuntime } from "../context-engine/delegate.js";

/**
 * 触发诊断事件
 * 
 * 向系统发送诊断事件用于监控和分析。
 * 
 * @example
 * ```typescript
 * onDiagnosticEvent({
 *   type: 'channel_error',
 *   channel: 'whatsapp',
 *   error: err.message
 * });
 * ```
 */
export { onDiagnosticEvent } from "../infra/diagnostic-events.js";
