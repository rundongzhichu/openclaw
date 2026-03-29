/**
 * @fileoverview OpenClaw 内部 Hook 系统核心实现
 * 
 * 本文件实现了 OpenClaw 系统的完整内部 Hook 机制，提供事件驱动的扩展点。
 * 
 * **核心功能**:
 * - 事件注册和注销（支持通配符匹配）
 * - Hook 触发和执行（支持异步处理器）
 * - 错误隔离（单个 handler 失败不影响其他 handler）
 * - 类型安全的事件上下文定义
 * - 生命周期钩子管理
 * 
 * **Hook 类型**:
 * - `command` - CLI 命令相关（command:new, command:completed）
 * - `session` - 会话生命周期（session:created, session:closed）
 * - `agent` - Agent 运行时（agent:bootstrap, agent:start）
 * - `gateway` - 网关控制（gateway:startup, gateway:shutdown）
 * - `message` - 消息处理（message:received, message:sent, message:transcribed）
 * 
 * **设计模式**:
 * - **观察者模式**: 事件发布/订阅机制
 * - **责任链模式**: 多个 handler 按顺序执行
 * - **策略模式**: 不同类型事件使用不同的上下文
 * 
 * **使用示例**:
 * ```typescript
 * // 1. 注册 Hook Handler
 * registerInternalHook('message:received', async (event) => {
 *   console.log(`收到来自 ${event.context.from} 的消息：${event.context.content}`);
 *   // 可以在这里进行日志记录、权限检查等
 * });
 * 
 * // 2. 注册通用类型 Hook（监听所有 message 事件）
 * registerInternalHook('message', async (event) => {
 *   console.log(`消息事件：${event.action}`);
 * });
 * 
 * // 3. 触发 Hook
 * await triggerInternalHook({
 *   type: 'message',
 *   action: 'received',
 *   context: {
 *     from: '+8613800000000',
 *     content: 'Hello',
 *     channelId: 'whatsapp'
 *   }
 * });
 * 
 * // 4. 检查是否有监听器
 * if (hasInternalHookListeners('message', 'received')) {
 *   await triggerInternalHook(event);
 * }
 * ```
 * 
 * @module hooks/internal-hooks
 */
/**
 * Hook system for OpenClaw agent events
 *
 * Provides an extensible event-driven hook system for agent events
 * like command processing, session lifecycle, etc.
 */

import type { WorkspaceBootstrapFile } from "../agents/workspace.js";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { SessionsPatchParams } from "../gateway/protocol/index.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type InternalHookEventType = "command" | "session" | "agent" | "gateway" | "message";

export type AgentBootstrapHookContext = {
  workspaceDir: string;
  bootstrapFiles: WorkspaceBootstrapFile[];
  cfg?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
};

export type AgentBootstrapHookEvent = InternalHookEvent & {
  type: "agent";
  action: "bootstrap";
  context: AgentBootstrapHookContext;
};

export type GatewayStartupHookContext = {
  cfg?: OpenClawConfig;
  deps?: CliDeps;
  workspaceDir?: string;
};

export type GatewayStartupHookEvent = InternalHookEvent & {
  type: "gateway";
  action: "startup";
  context: GatewayStartupHookContext;
};

// ============================================================================
// Message Hook Events
// ============================================================================

export type MessageReceivedHookContext = {
  /** Sender identifier (e.g., phone number, user ID) */
  from: string;
  /** Message content */
  content: string;
  /** Unix timestamp when the message was received */
  timestamp?: number;
  /** Channel identifier (e.g., "telegram", "whatsapp") */
  channelId: string;
  /** Provider account ID for multi-account setups */
  accountId?: string;
  /** Conversation/chat ID */
  conversationId?: string;
  /** Message ID from the provider */
  messageId?: string;
  /** Additional provider-specific metadata */
  metadata?: Record<string, unknown>;
};

export type MessageReceivedHookEvent = InternalHookEvent & {
  type: "message";
  action: "received";
  context: MessageReceivedHookContext;
};

export type MessageSentHookContext = {
  /** Recipient identifier */
  to: string;
  /** Message content */
  content: string;
  /** Whether the message was sent successfully */
  success: boolean;
  /** Error message if sending failed */
  error?: string;
  /** Channel identifier (e.g., "telegram", "whatsapp") */
  channelId: string;
  /** Provider account ID for multi-account setups */
  accountId?: string;
  /** Conversation/chat ID */
  conversationId?: string;
  /** Message ID returned by the provider */
  messageId?: string;
  /** Whether this message was sent in a group/channel context */
  isGroup?: boolean;
  /** Group or channel identifier, if applicable */
  groupId?: string;
};

export type MessageSentHookEvent = InternalHookEvent & {
  type: "message";
  action: "sent";
  context: MessageSentHookContext;
};

type MessageEnrichedBodyHookContext = {
  /** Sender identifier (e.g., phone number, user ID) */
  from?: string;
  /** Recipient identifier */
  to?: string;
  /** Original raw message body (e.g., "🎤 [Audio]") */
  body?: string;
  /** Enriched body shown to the agent, including transcript */
  bodyForAgent?: string;
  /** Unix timestamp when the message was received */
  timestamp?: number;
  /** Channel identifier (e.g., "telegram", "whatsapp") */
  channelId: string;
  /** Conversation/chat ID */
  conversationId?: string;
  /** Message ID from the provider */
  messageId?: string;
  /** Sender user ID */
  senderId?: string;
  /** Sender display name */
  senderName?: string;
  /** Sender username */
  senderUsername?: string;
  /** Provider name */
  provider?: string;
  /** Surface name */
  surface?: string;
  /** Path to the media file that was transcribed */
  mediaPath?: string;
  /** MIME type of the media */
  mediaType?: string;
};

export type MessageTranscribedHookContext = MessageEnrichedBodyHookContext & {
  /** The transcribed text from audio */
  transcript: string;
};

export type MessageTranscribedHookEvent = InternalHookEvent & {
  type: "message";
  action: "transcribed";
  context: MessageTranscribedHookContext;
};

export type MessagePreprocessedHookContext = MessageEnrichedBodyHookContext & {
  /** Transcribed audio text, if the message contained audio */
  transcript?: string;
  /** Whether this message was sent in a group/channel context */
  isGroup?: boolean;
  /** Group or channel identifier, if applicable */
  groupId?: string;
};

export type MessagePreprocessedHookEvent = InternalHookEvent & {
  type: "message";
  action: "preprocessed";
  context: MessagePreprocessedHookContext;
};

export type SessionPatchHookContext = {
  sessionEntry: SessionEntry;
  patch: SessionsPatchParams;
  cfg: OpenClawConfig;
};

export type SessionPatchHookEvent = InternalHookEvent & {
  type: "session";
  action: "patch";
  context: SessionPatchHookContext;
};

export interface InternalHookEvent {
  /** The type of event (command, session, agent, gateway, etc.) */
  type: InternalHookEventType;
  /** The specific action within the type (e.g., 'new', 'reset', 'stop') */
  action: string;
  /** The session key this event relates to */
  sessionKey: string;
  /** Additional context specific to the event */
  context: Record<string, unknown>;
  /** Timestamp when the event occurred */
  timestamp: Date;
  /** Messages to send back to the user (hooks can push to this array) */
  messages: string[];
}

/**
 * Hook 处理器类型定义
 * 
 * Hook handler 是一个异步或同步函数，接收事件对象作为参数。
 * Handler 可以修改事件的 messages 数组来向用户发送消息。
 * 
 * @param event - 触发的事件对象
 * @returns Promise<void> 或 void（支持异步和同步 handler）
 * 
 * @example
 * ```typescript
 * // 同步 handler
 * const syncHandler: InternalHookHandler = (event) => {
 *   console.log(`事件类型：${event.type}, 动作：${event.action}`);
 * };
 * 
 * // 异步 handler
 * const asyncHandler: InternalHookHandler = async (event) => {
 *   await saveToDatabase(event.context);
 *   event.messages.push("操作已完成");
 * };
 * ```
 */
export type InternalHookHandler = (event: InternalHookEvent) => Promise<void> | void;

/**
 * Hook Handler 注册表（按事件键索引）
 * 
 * **为什么使用 globalThis 单例**:
 * - Bundler 可能会将模块分割成多个 chunk
 * - 不同 chunk 中的模块实例是隔离的
 * - 使用 globalThis 确保所有 chunk 共享同一个 handlers Map
 * - 避免 handler 在一个 chunk 注册，在另一个 chunk 触发时找不到
 * 
 * **数据结构**:
 * ```typescript
 * Map<
 *   string,                    // 事件键（如 'command:new'）
 *   InternalHookHandler[]      // handler 数组（按注册顺序）
 * >
 * ```
 * 
 * **示例**:
 * ```typescript
 * handlers = Map(3) {
 *   'command' => [handler1, handler2],
 *   'command:new' => [handler3],
 *   'message:received' => [handler4, handler5]
 * }
 * ```
 */
const INTERNAL_HOOK_HANDLERS_KEY = Symbol.for("openclaw.internalHookHandlers");
const handlers = resolveGlobalSingleton<Map<string, InternalHookHandler[]>>(
  INTERNAL_HOOK_HANDLERS_KEY,
  () => new Map<string, InternalHookHandler[]>(),
);

/** 创建子系统日志记录器 */
const log = createSubsystemLogger("internal-hooks");

/**
 * 注册 Hook Handler
 * 
 * **注册策略**:
 * - 支持通用事件类型（如 'command'）- 监听该类型的所有事件
 * - 支持特定事件:动作组合（如 'command:new'）- 只监听特定事件
 * - 同一事件可以注册多个 handler，按注册顺序执行
 * 
 * **执行顺序**:
 * 1. 先执行通用类型 handler（如 'command'）
 * 2. 再执行特定事件 handler（如 'command:new'）
 * 
 * @param eventKey - 事件键，格式为 `type` 或 `type:action`
 * @param handler - 要注册的 handler 函数
 * 
 * @example
 * ```typescript
 * // 场景 1: 监听所有 command 事件
 * registerInternalHook('command', async (event) => {
 *   console.log(`Command 事件：${event.action}`);
 *   // 这个 handler 会被 command:new, command:reset 等所有 command 事件触发
 * });
 * 
 * // 场景 2: 只监听 /new 命令
 * registerInternalHook('command:new', async (event) => {
 *   await saveSessionToMemory(event);
 *   event.messages.push("会话已保存");
 * });
 * 
 * // 场景 3: 多个 handler 按顺序执行
 * registerInternalHook('message:received', async (event) => {
 *   console.log("Handler 1: 收到消息");
 * });
 * 
 * registerInternalHook('message:received', async (event) => {
 *   console.log("Handler 2: 处理消息");
 * });
 * // 触发时，两个 handler 会按顺序依次执行
 * ```
 */
export function registerInternalHook(eventKey: string, handler: InternalHookHandler): void {
  // 如果事件键不存在，初始化为空数组
  if (!handlers.has(eventKey)) {
    handlers.set(eventKey, []);
  }
  
  // 将 handler 添加到数组末尾（保持注册顺序）
  handlers.get(eventKey)!.push(handler);
}

/**
 * 注销 Hook Handler
 * 
 * **用途**:
 * - 清理不再需要的 handler（如插件卸载时）
 * - 测试环境中的清理工作
 * - 动态调整 hook 行为
 * 
 * **注意事项**:
 * - 只移除匹配的 handler，不影响其他 handler
 * - 如果 handler 数组变为空，会自动删除该事件键
 * - 多次注销同一个 handler 不会产生错误
 * 
 * @param eventKey - 事件键
 * @param handler - 要移除的 handler 函数
 * 
 * @example
 * ```typescript
 * // 注册 handler
 * const myHandler = async (event) => {
 *   console.log('处理事件');
 * };
 * 
 * registerInternalHook('command:new', myHandler);
 * 
 * // ... 一段时间后，注销 handler
 * unregisterInternalHook('command:new', myHandler);
 * 
 * // 再次触发时，myHandler 不会再被调用
 * ```
 */
export function unregisterInternalHook(eventKey: string, handler: InternalHookHandler): void {
  const eventHandlers = handlers.get(eventKey);
  if (!eventHandlers) {
    return;  // 事件键不存在，直接返回
  }
  
  // 查找 handler 的索引
  const index = eventHandlers.indexOf(handler);
  if (index !== -1) {
    // 从数组中移除
    eventHandlers.splice(index, 1);
  }
  
  // 清理空数组，避免内存泄漏
  if (eventHandlers.length === 0) {
    handlers.delete(eventKey);
  }
}

/**
 * 清空所有已注册的 Hook
 * 
 * **主要用途**:
 * - 测试环境重置（每个测试用例前清空）
 * - 热重载时重新注册
 * - 调试和诊断
 * 
 * **警告**:
 * - 此操作会移除所有 handler，包括系统内置的
 * - 生产环境慎用
 * 
 * @example
 * ```typescript
 * // 测试前清空所有 hooks
 * beforeEach(() => {
 *   clearInternalHooks();
 * });
 * 
 * // 重新注册测试专用的 hooks
 * registerInternalHook('command:test', testHandler);
 * ```
 */
export function clearInternalHooks(): void {
  handlers.clear();
}

/**
 * 获取所有已注册的事件键
 * 
 * **用途**:
 * - 调试：查看当前有哪些事件被监听
 * - 诊断：分析 hook 系统的活动状态
 * - 文档生成：自动列出可用的 hook 事件
 * 
 * @returns 事件键数组（如 ['command', 'command:new', 'message:received']）
 * 
 * @example
 * ```typescript
 * const keys = getRegisteredEventKeys();
 * console.log('已注册的事件:', keys);
 * // → 已注册的事件：['command', 'command:new', 'message:received']
 * ```
 */
export function getRegisteredEventKeys(): string[] {
  return Array.from(handlers.keys());
}

/**
 * 检查是否有特定事件的监听器
 * 
 * **检查逻辑**:
 * 1. 检查通用类型监听器（如 'message'）
 * 2. 检查特定事件监听器（如 'message:received'）
 * 3. 只要有一个就返回 true
 * 
 * **优化用途**:
 * - 避免触发没有监听器的事件（性能优化）
 * - 条件性执行某些逻辑
 * 
 * @param type - 事件类型（如 'message'）
 * @param action - 事件动作（如 'received'）
 * @returns 是否存在监听器
 * 
 * @example
 * ```typescript
 * // 性能优化：只在有监听器时才触发
 * if (hasInternalHookListeners('message', 'received')) {
 *   await triggerInternalHook({
 *     type: 'message',
 *     action: 'received',
 *     context: { /* ... *\/ }
 *   });
 * } else {
 *   // 跳过触发，节省资源
 * }
 * ```
 */
export function hasInternalHookListeners(type: InternalHookEventType, action: string): boolean {
  // 检查通用类型监听器 OR 特定事件监听器
  return (
    (handlers.get(type)?.length ?? 0) > 0 || 
    (handlers.get(`${type}:${action}`)?.length ?? 0) > 0
  );
}

/**
 * 触发 Hook 事件
 * 
 * **执行流程**:
 * ```text
 * 1. 检查是否有监听器 → hasInternalHookListeners()
 * 2. 如果没有，直接返回（快速路径）
 * 3. 获取通用类型 handler（如 'command'）
 * 4. 获取特定事件 handler（如 'command:new'）
 * 5. 合并 handler 列表（通用在前，特定在后）
 * 6. 按顺序执行每个 handler
 * 7. 捕获并记录错误（不影响其他 handler）
 * ```
 * 
 * **错误处理**:
 * - 每个 handler 独立执行，一个失败不影响其他
 * - 错误会被记录到日志系统
 * - 不会抛出异常给调用者（fire-and-forget 模式）
 * 
 * **消息传递**:
 * - handler 可以通过 `event.messages.push()` 添加反馈消息
 * - 调用者可以收集这些消息并展示给用户
 * 
 * @param event - 要触发的事件对象
 * @returns Promise<void>（总是成功，handler 的错误已被内部捕获）
 * 
 * @example
 * ```typescript
 * // 示例 1: 触发 command:new 事件
 * await triggerInternalHook({
 *   type: 'command',
 *   action: 'new',
 *   sessionKey: 'whatsapp:+8613800000000',
 *   context: {
 *     command: '/new',
 *     args: ['project-name'],
 *     cwd: '/Users/user/projects'
 *   },
 *   timestamp: new Date(),
 *   messages: []  // handler 可以向这里添加消息
 * });
 * 
 * // 示例 2: 触发 message:received 事件（带音频转写）
 * await triggerInternalHook({
 *   type: 'message',
 *   action: 'received',
 *   sessionKey: 'telegram:user123',
 *   context: {
 *     from: '+8613800000000',
 *     content: '🎤 [Audio]',
 *     channelId: 'telegram',
 *     transcript: '帮我查一下明天的天气'  // handler 可以读取转写文本
 *   },
 *   timestamp: new Date(),
 *   messages: []
 * });
 * 
 * // 示例 3: 收集 handler 的反馈消息
 * const event = {
 *   type: 'gateway',
 *   action: 'startup',
 *   sessionKey: '',
 *   context: { cfg: config, deps: cliDeps },
 *   timestamp: new Date(),
 *   messages: []
 * };
 * 
 * await triggerInternalHook(event);
 * 
 * // 检查 handler 是否有反馈消息
 * if (event.messages.length > 0) {
 *   console.log('Hook 反馈:', event.messages);
 * }
 * ```
 */
export async function triggerInternalHook(event: InternalHookEvent): Promise<void> {
  // 快速路径：没有监听器时直接返回
  if (!hasInternalHookListeners(event.type, event.action)) {
    return;
  }
  
  // 获取通用类型 handler
  const typeHandlers = handlers.get(event.type) ?? [];
  
  // 获取特定事件 handler
  const specificHandlers = handlers.get(`${event.type}:${event.action}`) ?? [];
  
  // 合并 handler 列表（通用在前，确保先执行）
  const allHandlers = [...typeHandlers, ...specificHandlers];
  
  // 按注册顺序执行每个 handler
  for (const handler of allHandlers) {
    try {
      await handler(event);
    } catch (err) {
      // 错误处理：记录日志但不中断其他 handler
      log.error(`Hook handler error for ${event.type}:${event.action}:`, err);
    }
  }
}

/**
 * 创建一个 Hook 事件对象
 * 
 * **用途**:
 * - 简化事件对象的创建
 * - 确保所有字段都有默认值
 * - 减少样板代码
 * 
 * **字段说明**:
 * - `type`: 事件类型（如 'command'）
 * - `action`: 事件动作（如 'new'）
 * - `sessionKey`: 会话键（如 'whatsapp:+8613800000000'）
 * - `context`: 事件上下文对象
 * - `timestamp`: 事件发生的时间戳（自动填充）
 * - `messages`: 反馈消息数组（初始为空）
 * 
 * @param type - 事件类型
 * @param action - 事件动作
 * @param sessionKey - 会话键
 * @param context - 事件上下文对象
 * @returns 事件对象
 * 
 * @example
 * ```typescript
 * const event = createInternalHookEvent(
 *   'message',
 *   'received',
 *   'telegram:user123',
 *   {
 *     from: '+8613800000000',
 *     content: 'Hello',
 *     channelId: 'telegram'
 *   }
 * );
 * 
 * await triggerInternalHook(event);
 * ```
 */
export function createInternalHookEvent(
  type: InternalHookEventType,
  action: string,
  sessionKey: string,
  context: Record<string, unknown> = {},
): InternalHookEvent {
  return {
    type,
    action,
    sessionKey,
    context,
    timestamp: new Date(),
    messages: [],
  };
}

function isHookEventTypeAndAction(
  event: InternalHookEvent,
  type: InternalHookEventType,
  action: string,
): boolean {
  return event.type === type && event.action === action;
}

function getHookContext<T extends Record<string, unknown>>(
  event: InternalHookEvent,
): Partial<T> | null {
  const context = event.context as Partial<T> | null;
  if (!context || typeof context !== "object") {
    return null;
  }
  return context;
}

function hasStringContextField<T extends Record<string, unknown>>(
  context: Partial<T>,
  key: keyof T,
): boolean {
  return typeof context[key] === "string";
}

function hasBooleanContextField<T extends Record<string, unknown>>(
  context: Partial<T>,
  key: keyof T,
): boolean {
  return typeof context[key] === "boolean";
}

export function isAgentBootstrapEvent(event: InternalHookEvent): event is AgentBootstrapHookEvent {
  if (!isHookEventTypeAndAction(event, "agent", "bootstrap")) {
    return false;
  }
  const context = getHookContext<AgentBootstrapHookContext>(event);
  if (!context) {
    return false;
  }
  if (!hasStringContextField(context, "workspaceDir")) {
    return false;
  }
  return Array.isArray(context.bootstrapFiles);
}

export function isGatewayStartupEvent(event: InternalHookEvent): event is GatewayStartupHookEvent {
  if (!isHookEventTypeAndAction(event, "gateway", "startup")) {
    return false;
  }
  return Boolean(getHookContext<GatewayStartupHookContext>(event));
}

export function isMessageReceivedEvent(
  event: InternalHookEvent,
): event is MessageReceivedHookEvent {
  if (!isHookEventTypeAndAction(event, "message", "received")) {
    return false;
  }
  const context = getHookContext<MessageReceivedHookContext>(event);
  if (!context) {
    return false;
  }
  return hasStringContextField(context, "from") && hasStringContextField(context, "channelId");
}

export function isMessageSentEvent(event: InternalHookEvent): event is MessageSentHookEvent {
  if (!isHookEventTypeAndAction(event, "message", "sent")) {
    return false;
  }
  const context = getHookContext<MessageSentHookContext>(event);
  if (!context) {
    return false;
  }
  return (
    hasStringContextField(context, "to") &&
    hasStringContextField(context, "channelId") &&
    hasBooleanContextField(context, "success")
  );
}

export function isMessageTranscribedEvent(
  event: InternalHookEvent,
): event is MessageTranscribedHookEvent {
  if (!isHookEventTypeAndAction(event, "message", "transcribed")) {
    return false;
  }
  const context = getHookContext<MessageTranscribedHookContext>(event);
  if (!context) {
    return false;
  }
  return (
    hasStringContextField(context, "transcript") && hasStringContextField(context, "channelId")
  );
}

export function isMessagePreprocessedEvent(
  event: InternalHookEvent,
): event is MessagePreprocessedHookEvent {
  if (!isHookEventTypeAndAction(event, "message", "preprocessed")) {
    return false;
  }
  const context = getHookContext<MessagePreprocessedHookContext>(event);
  if (!context) {
    return false;
  }
  return hasStringContextField(context, "channelId");
}

export function isSessionPatchEvent(event: InternalHookEvent): event is SessionPatchHookEvent {
  if (!isHookEventTypeAndAction(event, "session", "patch")) {
    return false;
  }
  const context = getHookContext<SessionPatchHookContext>(event);
  if (!context) {
    return false;
  }
  return (
    typeof context.patch === "object" &&
    context.patch !== null &&
    typeof context.cfg === "object" &&
    context.cfg !== null &&
    typeof context.sessionEntry === "object" &&
    context.sessionEntry !== null
  );
}
