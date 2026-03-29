/**
 * @fileoverview 会话生命周期事件管理
 * 
 * 本文件实现了 OpenClaw 系统中会话（Session）生命周期的事件发布/订阅机制。
 * 
 * **核心功能**:
 * - 会话生命周期事件定义（创建、销毁、重启等）
 * - 事件监听器注册和注销
 * - 事件广播（支持多个监听器）
 * - 错误隔离（单个监听器失败不影响其他）
 * 
 * **生命周期事件类型**:
 * - `created` - 会话创建
 * - `started` - 会话启动
 * - `stopped` - 会话停止
 * - `destroyed` - 会话销毁
 * - `restarted` - 会话重启
 * - `paused` - 会话暂停
 * - `resumed` - 会话恢复
 * 
 * **设计模式**:
 * - **观察者模式**: 基于 Set 的监听器集合
 * - **发布/订阅**: emit 事件到所有注册的监听器
 * - **错误隔离**: try-catch 保护，避免单个监听器失败影响全局
 * 
 * **使用示例**:
 * ```typescript
 * // 1. 注册监听器
 * const unsubscribe = onSessionLifecycleEvent((event) => {
 *   console.log(`会话 ${event.sessionKey} 发生事件：${event.reason}`);
 *   
 *   if (event.reason === 'created') {
 *     console.log(`新会话创建，标签：${event.label}`);
 *   }
 * });
 * 
 * // 2. 触发事件
 * emitSessionLifecycleEvent({
 *   sessionKey: 'whatsapp:+8613800000000',
 *   reason: 'created',
 *   label: 'WhatsApp 主会话',
 *   displayName: '张三'
 * });
 * 
 * // 3. 取消订阅
 * unsubscribe();
 * 
 * // 4. 带父会话的场景（子代理）
 * emitSessionLifecycleEvent({
 *   sessionKey: 'subagent:task-123',
 *   reason: 'started',
 *   parentSessionKey: 'whatsapp:+8613800000000'  // 关联到主会话
 * });
 * ```
 * 
 * @module sessions/session-lifecycle-events
 */

/**
 * 会话生命周期事件对象
 * 
 * 描述会话在生命周期中发生的重要变化。
 * 
 * @property sessionKey - 会话唯一标识符（格式：`{channel}:{targetId}[:{threadId}]`）
 * @property reason - 事件原因/类型（如 "created", "destroyed", "restarted"）
 * @property parentSessionKey - 父会话键（可选，用于子代理场景）
 * @property label - 会话标签（可选，人类可读的描述）
 * @property displayName - 显示名称（可选，用于 UI 展示）
 * 
 * @example
 * ```typescript
 * // 基础事件
 * const event1: SessionLifecycleEvent = {
 *   sessionKey: 'telegram:user123',
 *   reason: 'created'
 * };
 * 
 * // 完整事件（带元数据）
 * const event2: SessionLifecycleEvent = {
 *   sessionKey: 'whatsapp:+8613800000000',
 *   reason: 'started',
 *   label: 'VIP 客户咨询',
 *   displayName: '李四（上海）'
 * };
 * 
 * // 子代理事件（关联父会话）
 * const event3: SessionLifecycleEvent = {
 *   sessionKey: 'subagent:research-task-456',
 *   reason: 'spawned',
 *   parentSessionKey: 'slack:C1234567890',  // 来自 Slack 群组的请求
 *   label: '市场研究子任务'
 * };
 * ```
 */
export type SessionLifecycleEvent = {
  /** 会话唯一标识符 */
  sessionKey: string;
  /** 事件原因/类型 */
  reason: string;
  /** 父会话键（子代理场景下使用） */
  parentSessionKey?: string;
  /** 会话标签（人类可读的描述） */
  label?: string;
  /** 显示名称（用于 UI 展示） */
  displayName?: string;
};

/**
 * 会话生命周期监听器函数类型
 * 
 * @param event - 会话生命周期事件对象
 * @returns void（不支持异步）
 */
type SessionLifecycleListener = (event: SessionLifecycleEvent) => void;

/**
 * 全局监听器集合
 * 
 * 使用 Set 数据结构保证：
 * - 监听器不重复
 * - O(1) 时间复杂度的添加/删除
 * - 遍历效率高
 */
const SESSION_LIFECYCLE_LISTENERS = new Set<SessionLifecycleListener>();

/**
 * 注册会话生命周期事件监听器
 * 
 * **用途**:
 * - 监听会话的创建、销毁、重启等状态变化
 * - 执行副作用操作（如日志记录、资源清理、通知发送）
 * - 调试和诊断（追踪会话历史）
 * 
 * **返回取消订阅函数**:
 * - 调用返回值可以取消监听
 * - 建议在组件卸载或插件卸载时调用
 * 
 * **错误处理**:
 * - 监听器执行错误会被捕获（见 emitSessionLifecycleEvent）
 * - 不会影响其他监听器的执行
 * 
 * @param listener - 监听器函数
 * @returns 取消订阅函数（调用后移除该监听器）
 * 
 * @example
 * ```typescript
 * // 场景 1: 记录所有会话事件
 * const unsubscribe1 = onSessionLifecycleEvent((event) => {
 *   console.log(`[${new Date().toISOString()}] ${event.sessionKey}: ${event.reason}`);
 * });
 * 
 * // 场景 2: 只关注会话创建
 * const unsubscribe2 = onSessionLifecycleEvent((event) => {
 *   if (event.reason === 'created') {
 *     logger.info(`新会话创建：${event.sessionKey}`, {
 *       label: event.label,
 *       displayName: event.displayName
 *     });
 *   }
 * });
 * 
 * // 场景 3: 子代理追踪
 * const unsubscribe3 = onSessionLifecycleEvent((event) => {
 *   if (event.parentSessionKey) {
 *     // 记录子代理与其父会话的关联
 *     trackSubagentRelationship({
 *       parent: event.parentSessionKey,
 *       child: event.sessionKey,
 *       reason: event.reason
 *     });
 *   }
 * });
 * 
 * // 取消订阅（在清理时调用）
 * unsubscribe1();
 * unsubscribe2();
 * unsubscribe3();
 * ```
 */
export function onSessionLifecycleEvent(listener: SessionLifecycleListener): () => void {
  // 添加到监听器集合
  SESSION_LIFECYCLE_LISTENERS.add(listener);
  
  // 返回取消订阅函数
  return () => {
    SESSION_LIFECYCLE_LISTENERS.delete(listener);
  };
}

/**
 * 触发会话生命周期事件
 * 
 * **执行流程**:
 * 1. 遍历所有已注册的监听器
 * 2. 依次调用每个监听器（同步执行）
 * 3. 捕获并忽略监听器抛出的错误（best-effort）
 * 4. 继续执行下一个监听器
 * 
 * **特点**:
 * - **同步执行**: 监听器按注册顺序依次执行
 * - **错误隔离**: 单个监听器失败不影响其他监听器
 * - **无返回值**: fire-and-forget 模式
 * 
 * **注意事项**:
 * - 监听器不应抛出异常（会被静默忽略）
 * - 如需异步操作，请在监听器内部自行处理
 * - 大量监听器可能阻塞事件循环
 * 
 * @param event - 要触发的会话生命周期事件
 * 
 * @example
 * ```typescript
 * // 场景 1: 会话创建时触发
 * emitSessionLifecycleEvent({
 *   sessionKey: 'whatsapp:+8613800000000',
 *   reason: 'created',
 *   label: '新用户咨询'
 * });
 * 
 * // 场景 2: 会话销毁前触发（用于清理资源）
 * emitSessionLifecycleEvent({
 *   sessionKey: 'telegram:group-123',
 *   reason: 'destroyed',
 *   label: '群组会话结束'
 * });
 * 
 * // 场景 3: 子代理启动（关联父会话）
 * emitSessionLifecycleEvent({
 *   sessionKey: 'subagent:task-abc',
 *   reason: 'started',
 *   parentSessionKey: 'discord:channel-xyz',
 *   label: '图像生成任务'
 * });
 * 
 * // 场景 4: 会话重启
 * emitSessionLifecycleEvent({
 *   sessionKey: 'slack:C1234567890',
 *   reason: 'restarted',
 *   label: '配置变更导致重启'
 * });
 * ```
 */
export function emitSessionLifecycleEvent(event: SessionLifecycleEvent): void {
  // 遍历所有监听器并依次调用
  for (const listener of SESSION_LIFECYCLE_LISTENERS) {
    try {
      // 同步执行监听器
      listener(event);
    } catch {
      // Best-effort 模式：忽略监听器错误，继续执行下一个
      // 这样设计是为了避免单个监听器失败导致整个事件系统崩溃
    }
  }
}
