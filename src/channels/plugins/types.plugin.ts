/**
 * @fileoverview Channel 插件核心类型定义
 * 
 * 本文件定义了 OpenClaw Channel 插件的完整契约（Contract）。
 * 每个 Channel 插件（如 WhatsApp, Telegram, Slack 等）都必须实现这些接口。
 * 
 * **核心概念**:
 * - **ChannelPlugin**: 主接口，定义插件的所有能力
 * - **ChannelConfigSchema**: 配置 Schema 和 UI 提示
 * - **适配器模式**: 各种 Adapter 接口对应不同的功能模块
 * 
 * **插件位置**: 所有 Channel 插件实现在 `src/channels/plugins/<id>.ts` 文件中
 * 
 * **示例结构**:
 * ```typescript
 * // src/channels/plugins/whatsapp.ts
 * import type { ChannelPlugin } from './types.plugin.js';
 * 
 * const whatsappPlugin: ChannelPlugin = {
 *   id: 'whatsapp',
 *   meta: { name: 'WhatsApp', version: '1.0.0' },
 *   capabilities: { dm: 'pairing', group: 'open' },
 *   config: { /* ... *\/ },
 *   setup: async (ctx) => { /* ... *\/ },
 *   outbound: async (ctx) => { /* ... *\/ }
 * };
 * 
 * export default whatsappPlugin;
 * ```
 * 
 * @module channels/plugins/types.plugin
 */

import type { ChannelSetupWizard } from "./setup-wizard.js";
import type {
  ChannelAuthAdapter,
  ChannelCommandAdapter,
  ChannelConfigAdapter,
  ChannelConversationBindingSupport,
  ChannelDirectoryAdapter,
  ChannelExecApprovalAdapter,
  ChannelResolverAdapter,
  ChannelElevatedAdapter,
  ChannelGatewayAdapter,
  ChannelGroupAdapter,
  ChannelHeartbeatAdapter,
  ChannelLifecycleAdapter,
  ChannelOutboundAdapter,
  ChannelPairingAdapter,
  ChannelSecurityAdapter,
  ChannelSetupAdapter,
  ChannelStatusAdapter,
  ChannelAllowlistAdapter,
  ChannelConfiguredBindingProvider,
} from "./types.adapters.js";
import type {
  ChannelAgentTool,
  ChannelAgentToolFactory,
  ChannelCapabilities,
  ChannelId,
  ChannelAgentPromptAdapter,
  ChannelMentionAdapter,
  ChannelMessageActionAdapter,
  ChannelMessagingAdapter,
  ChannelMeta,
  ChannelStreamingAdapter,
  ChannelThreadingAdapter,
} from "./types.core.js";

// ==================== 配置 UI 提示 ====================

/**
 * Channel 配置 UI 提示
 * 
 * 用于在 Control UI 中显示友好的配置界面。
 * 提供标签、帮助文本、占位符等元数据。
 * 
 * @property label - 显示标签（如 "API Key"）
 * @property help - 帮助文本（如 "从 https://xxx.com 获取"）
 * @property tags - 标签列表（用于分类和搜索）
 * @property advanced - 是否为高级选项（默认隐藏）
 * @property sensitive - 是否敏感字段（密码框显示）
 * @property placeholder - 输入框占位符
 * @property itemTemplate - 列表项模板（用于数组配置）
 * 
 * @example
 * ```typescript
 * const apiConfigHint: ChannelConfigUiHint = {
 *   label: "API Key",
 *   help: "从 WhatsApp Cloud API Dashboard 获取",
 *   sensitive: true,  // 显示为密码框
 *   placeholder: "EAABsbCS1iHgBO..."
 * };
 * 
 * const advancedConfig: ChannelConfigUiHint = {
 *   label: "自定义 Webhook URL",
 *   advanced: true,  // 折叠在高级选项中
 *   help: "仅在需要自定义 webhook 时修改"
 * };
 * ```
 */
export type ChannelConfigUiHint = {
  /** 显示标签（可选） */
  label?: string;
  /** 帮助文本（可选） */
  help?: string;
  /** 标签列表，用于分类和搜索 */
  tags?: string[];
  /** 是否为高级选项（默认 false） */
  advanced?: boolean;
  /** 是否敏感字段（默认 false，true 时显示为密码框） */
  sensitive?: boolean;
  /** 输入框占位符 */
  placeholder?: string;
  /** 列表项模板（用于数组类型的配置项） */
  itemTemplate?: unknown;
};

// ==================== 配置运行时问题 ====================

/**
 * Channel 配置运行时问题
 * 
 * 当配置验证失败时，返回的问题详情。
 * 支持路径定位、错误代码和自定义扩展字段。
 * 
 * @property path - JSON Path 数组（如 ["channels", "whatsapp", "apiKey"]）
 * @property message - 人类可读的错误消息
 * @property code - 错误代码（如 "REQUIRED", "INVALID_FORMAT"）
 * 
 * @example
 * ```typescript
 * const issue: ChannelConfigRuntimeIssue = {
 *   path: ["channels", "whatsapp", "phoneNumber"],
 *   message: "电话号码必须是 E.164 格式（如 +8613800000000）",
 *   code: "INVALID_E164_FORMAT"
 * };
 * ```
 */
export type ChannelConfigRuntimeIssue = {
  /** JSON 路径数组，定位到问题字段 */
  path?: Array<string | number>;
  /** 人类可读的错误消息 */
  message?: string;
  /** 错误代码（用于程序化处理） */
  code?: string;
} & Record<string, unknown>;

// ==================== 配置运行时解析结果 ====================

/**
 * Channel 配置运行时解析结果
 * 
 * Zod 或类似 Schema 验证库的解析结果类型。
 * 成功时返回数据，失败时返回问题列表。
 * 
 * @example
 * ```typescript
 * // 成功情况
 * const successResult: ChannelConfigRuntimeParseResult = {
 *   success: true,
 *   data: { apiKey: "xxx", phoneNumber: "+8613800000000" }
 * };
 * 
 * // 失败情况
 * const failureResult: ChannelConfigRuntimeParseResult = {
 *   success: false,
 *   issues: [
 *     { path: ["apiKey"], message: "Required", code: "REQUIRED" }
 *   ]
 * };
 * ```
 */
export type ChannelConfigRuntimeParseResult =
  | {
      /** 解析成功标志 */
      success: true;
      /** 解析后的数据 */
      data: unknown;
    }
  | {
      /** 解析失败标志 */
      success: false;
      /** 问题列表 */
      issues: ChannelConfigRuntimeIssue[];
    };

// ==================== 配置运行时 Schema ====================

/**
 * Channel 配置运行时 Schema
 * 
 * 类似于 Zod Schema 的接口，用于运行时验证。
 * 
 * @property safeParse - 安全解析方法（不抛异常）
 * 
 * @example
 * ```typescript
 * // Zod Schema 适配
 * import { z } from 'zod';
 * 
 * const configSchema = z.object({
 *   apiKey: z.string(),
 *   phoneNumber: z.string().regex(/^\+\d+$/)
 * });
 * 
 * const runtimeSchema: ChannelConfigRuntimeSchema = {
 *   safeParse: (value) => {
 *     const result = configSchema.safeParse(value);
 *     return result.success
 *       ? { success: true, data: result.data }
 *       : { success: false, issues: result.error.issues };
 *   }
 * };
 * ```
 */
export type ChannelConfigRuntimeSchema = {
  /**
   * 安全解析配置值
   * @param value - 要验证的配置对象
   * @returns 解析结果（成功或失败）
   */
  safeParse: (value: unknown) => ChannelConfigRuntimeParseResult;
};

// ==================== Channel 配置 Schema ====================

/**
 * Channel 配置 Schema（JSON Schema 风格）
 * 
 * 由 Channel 插件发布的配置描述，包含：
 * - JSON Schema 定义
 * - UI Hints（用于前端渲染）
 * - 运行时验证器（可选）
 * 
 * **作用**:
 * 1. **静态分析**: TypeScript 类型检查
 * 2. **运行时验证**: 用户输入验证
 * 3. **UI 生成**: Control UI 自动渲染配置表单
 * 
 * @property schema - JSON Schema 对象
 * @property uiHints - UI 提示（按字段名索引）
 * @property runtime - 运行时验证器（可选）
 * 
 * @example
 * ```typescript
 * const whatsappConfigSchema: ChannelConfigSchema = {
 *   schema: {
 *     type: "object",
 *     required: ["phoneNumber", "apiKey"],
 *     properties: {
 *       phoneNumber: {
 *         type: "string",
 *         pattern: "^\\+\\d+$",
 *         title: "WhatsApp 电话号码"
 *       },
 *       apiKey: {
 *         type: "string",
 *         title: "Cloud API Key"
 *       }
 *     }
 *   },
 *   uiHints: {
 *     phoneNumber: {
 *       label: "WhatsApp 号码",
 *       help: "格式：+8613800000000",
 *       placeholder: "+86..."
 *     },
 *     apiKey: {
 *       label: "API Key",
 *       sensitive: true,
 *       help: "从 Meta Developer Dashboard 获取"
 *     }
 *   }
 * };
 * ```
 */
export type ChannelConfigSchema = {
  /** JSON Schema 对象定义 */
  schema: Record<string, unknown>;
  /** UI 提示（可选），键名为字段名 */
  uiHints?: Record<string, ChannelConfigUiHint>;
  /** 运行时验证器（可选） */
  runtime?: ChannelConfigRuntimeSchema;
};

// ==================== Channel 插件主接口 ====================

/**
 * Channel 插件完整能力契约
 * 
 * 这是 Channel 插件的核心接口，定义了插件必须实现的所有能力。
 * 使用泛型支持不同类型的账号解析、探测和审计。
 * 
 * **泛型参数**:
 * - `ResolvedAccount`: 解析后的账号类型（默认 any）
 * - `Probe`: 状态探测结果类型（默认 unknown）
 * - `Audit`: 审计日志类型（默认 unknown）
 * 
 * **必需字段**:
 * - {@link id} - 插件唯一标识（如 "whatsapp", "telegram"）
 * - {@link meta} - 元信息（名称、版本、作者等）
 * - {@link capabilities} - 能力声明（DM/群组策略等）
 * - {@link config} - 配置适配器
 * 
 * **可选字段**:
 * - 各种 Adapter：按需实现（setup, pairing, security, outbound 等）
 * 
 * @example
 * ```typescript
 * // 完整的 Telegram 插件示例
 * import type { ChannelPlugin } from './types.plugin.js';
 * 
 * const telegramPlugin: ChannelPlugin<TelegramAccount, ProbeResult, AuditLog> = {
 *   // 必需字段
 *   id: 'telegram',
 *   meta: {
 *     name: 'Telegram',
 *     version: '1.0.0',
 *     author: 'OpenClaw Team'
 *   },
 *   capabilities: {
 *     dm: 'pairing',  // DM 需要配对码
 *     group: 'open'   // 群组开放
 *   },
 *   
 *   // 配置适配器
 *   config: {
 *     load: async () => { /* 加载配置 *\/ },
 *     save: async (config) => { /* 保存配置 *\/ }
 *   },
 *   
 *   // 可选：设置向导
 *   setup: async (ctx) => {
 *     const botToken = await ctx.prompt.secret('Bot Token:');
 *     return { botToken };
 *   },
 *   
 *   // 可选：发送消息
 *   outbound: async (ctx) => {
 *     await telegramBot.sendMessage(ctx.targetId, ctx.text);
 *   }
 * };
 * 
 * export default telegramPlugin;
 * ```
 */
// oxlint-disable-next-line typescript/no-explicit-any
export type ChannelPlugin<ResolvedAccount = any, Probe = unknown, Audit = unknown> = {
  // ========== 基础信息 ==========
  
  /** 插件唯一标识（如 "whatsapp", "telegram", "slack"） */
  id: ChannelId;
  
  /** 插件元信息（名称、版本、描述、图标等） */
  meta: ChannelMeta;
  
  /** 能力声明（DM 策略、群组策略、媒体支持等） */
  capabilities: ChannelCapabilities;
  
  // ========== 默认配置 ==========
  
  /** 默认配置（可选） */
  defaults?: {
    /** 队列配置 */
    queue?: {
      /** 防抖延迟（毫秒） */
      debounceMs?: number;
    };
  };
  
  // ========== 热重载 ==========
  
  /** 热重载配置（指定哪些配置变更触发重载） */
  reload?: { 
    /** 触发重载的配置前缀列表 */
    configPrefixes: string[]; 
    /** 不触发重载的前缀列表（静默忽略） */
    noopPrefixes?: string[]; 
  };
  
  // ========== 设置向导 ==========
  
  /** 交互式设置向导（可选） */
  setupWizard?: ChannelSetupWizard;
  
  // ========== 配置管理 ==========
  
  /** 配置适配器（必需）- 负责加载和保存配置 */
  config: ChannelConfigAdapter<ResolvedAccount>;
  
  /** 配置 Schema（可选）- 用于验证和 UI 生成 */
  configSchema?: ChannelConfigSchema;
  
  // ========== 核心适配器（按功能模块分类） ==========
  
  /** 设置适配器 - 初始配置引导 */
  setup?: ChannelSetupAdapter;
  
  /** 配对适配器 - DM 配对码流程 */
  pairing?: ChannelPairingAdapter;
  
  /** 安全适配器 - 访问控制和权限管理 */
  security?: ChannelSecurityAdapter<ResolvedAccount>;
  
  /** 群组适配器 - 群组管理和上下文处理 */
  groups?: ChannelGroupAdapter;
  
  /** @提及适配器 - @提及解析和处理 */
  mentions?: ChannelMentionAdapter;
  
  /** 出站适配器 - 发送消息到渠道 */
  outbound?: ChannelOutboundAdapter;
  
  /** 状态适配器 - 健康检查和审计 */
  status?: ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;
  
  // ========== Gateway 扩展 ==========
  
  /** Gateway 方法白名单（可选）- 暴露自定义 RPC 方法 */
  gatewayMethods?: string[];
  
  /** Gateway 适配器 - 扩展控制平面功能 */
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;
  
  // ========== 认证和授权 ==========
  
  /** 认证适配器 - OAuth 或登录流程 */
  auth?: ChannelAuthAdapter;
  
  /** 提权适配器 - 需要管理员权限的操作 */
  elevated?: ChannelElevatedAdapter;
  
  /** 命令适配器 - CLI 命令支持 */
  commands?: ChannelCommandAdapter;
  
  // ========== 生命周期和事件 ==========
  
  /** 生命周期适配器 - 启动/停止钩子 */
  lifecycle?: ChannelLifecycleAdapter;
  
  /** 执行审批适配器 - 命令执行审批流程 */
  execApprovals?: ChannelExecApprovalAdapter;
  
  /** 允许列表适配器 - 发送者白名单管理 */
  allowlist?: ChannelAllowlistAdapter;
  
  // ========== 绑定和路由 ==========
  
  /** 配置绑定提供者 - 会话级绑定（如 Discord 频道） */
  bindings?: ChannelConfiguredBindingProvider;
  
  /** 对话绑定支持 - 对话级别的绑定 */
  conversationBindings?: ChannelConversationBindingSupport;
  
  // ========== 高级功能 ==========
  
  /** 流式适配器 - 实时消息流（如 WebSocket） */
  streaming?: ChannelStreamingAdapter;
  
  /** 线程适配器 - 线程/话题支持（如 Discord Threads） */
  threading?: ChannelThreadingAdapter;
  
  /** 消息适配器 - 消息增强功能 */
  messaging?: ChannelMessagingAdapter;
  
  /** Agent Prompt 适配器 - 自定义 Agent 提示 */
  agentPrompt?: ChannelAgentPromptAdapter;
  
  /** 目录适配器 - 联系人/群聊目录服务 */
  directory?: ChannelDirectoryAdapter;
  
  /** 解析适配器 - ID 到对象的解析 */
  resolver?: ChannelResolverAdapter;
  
  /** 消息动作适配器 - 回复/编辑/删除等操作 */
  actions?: ChannelMessageActionAdapter;
  
  /** 心跳适配器 - 自定义心跳逻辑 */
  heartbeat?: ChannelHeartbeatAdapter;
  
  // ========== Agent 工具 ==========
  
  /**
   * Channel 拥有的 Agent 工具（可选）
   * 
   * 用于实现登录流程、账户管理等交互式操作。
   * 可以是工厂函数（动态创建）或直接的工具数组。
   */
  agentTools?: ChannelAgentToolFactory | ChannelAgentTool[];
};
