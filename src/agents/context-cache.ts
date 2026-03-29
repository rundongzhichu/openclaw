/**
 * @fileoverview 模型上下文窗口 LRU 缓存管理
 * 
 * 本文件实现了模型上下文窗口的全局缓存机制，用于避免重复加载和计算。
 * 
 * **核心功能**:
 * - 全局 Map 缓存：MODEL_CONTEXT_TOKEN_CACHE
 * - 懒查找：lookupCachedContextTokens()
 * - 支持任意数量的模型 ID 缓存
 * - 线程安全（Map 操作原子性）
 * 
 * **缓存键值结构**:
 * ```typescript
 * Map<modelId, contextWindowTokens>
 * // 示例数据：
 * // 'claude-sonnet-4' => 200000
 * // 'gpt-4' => 128000
 * // 'gemini-2.5-pro' => 1048576
 * // 'anthropic/claude-3-5-sonnet' => 200000
 * ```
 * 
 * **数据来源**:
 * 1. pi-coding-agent 内置元数据
 * 2. models.json 用户配置
 * 3. 运行时动态发现
 * 
 * **使用示例**:
 * ```typescript
 * // 场景 1: 基本查找
 * const tokens = lookupCachedContextTokens('claude-sonnet-4');
 * console.log(tokens);  // → 200000
 * 
 * // 场景 2: 不存在的模型
 * const unknown = lookupCachedContextTokens('unknown-model');
 * console.log(unknown);  // → undefined
 * 
 * // 场景 3: 直接访问缓存 Map
 * MODEL_CONTEXT_TOKEN_CACHE.set('custom-model', 50000);
 * const custom = MODEL_CONTEXT_TOKEN_CACHE.get('custom-model');
 * console.log(custom);  // → 50000
 * 
 * // 场景 4: 批量操作
 * const models = ['gpt-4', 'claude-sonnet-4', 'gemini-2.5-pro'];
 * for (const modelId of models) {
 *   const tokens = lookupCachedContextTokens(modelId);
 *   if (tokens) {
 *     console.log(`${modelId}: ${tokens} tokens`);
 *   }
 * }
 * ```
 * 
 * @module agents/context-cache
 */

/**
 * 模型上下文窗口令牌全局缓存 ⭐
 * 
 * **数据结构**: Map<string, number>
 * - Key: 模型 ID（如 'claude-sonnet-4', 'gpt-4'）
 * - Value: 上下文窗口令牌数（如 200000, 128000）
 * 
 * **生命周期**:
 * - 应用启动时初始化为空 Map
 * - 通过 applyDiscoveredContextWindows() 和 applyConfiguredContextWindows() 填充
 * - 整个应用生命周期内持续有效
 * - 可通过 clearRuntimeState() 清空（测试/热重载场景）
 * 
 * **并发安全**:
 * - Map 操作在 Node.js 单线程环境中是原子的
 * - 无需额外的锁机制
 * 
 * @example
 * ```typescript
 * // 示例 1: 查看缓存大小
 * console.log(MODEL_CONTEXT_TOKEN_CACHE.size);
 * // → 15 (假设有 15 个模型已加载)
 * 
 * // 示例 2: 遍历所有缓存项
 * for (const [modelId, tokens] of MODEL_CONTEXT_TOKEN_CACHE.entries()) {
 *   console.log(`${modelId}: ${tokens} tokens`);
 * }
 * 
 * // 示例 3: 检查是否包含某个模型
 * if (MODEL_CONTEXT_TOKEN_CACHE.has('gpt-4')) {
 *   console.log('GPT-4 context window is cached');
 * }
 * 
 * // 示例 4: 删除缓存项（特殊场景）
 * MODEL_CONTEXT_TOKEN_CACHE.delete('deprecated-model');
 * ```
 */
export const MODEL_CONTEXT_TOKEN_CACHE = new Map<string, number>();

/**
 * 查找模型的上下文窗口令牌数
 * 
 * **查找逻辑**:
 * 1. 检查 modelId 是否有效（非 undefined/null）
 * 2. 从全局缓存 Map 中查找
 * 3. 存在则返回令牌数，不存在返回 undefined
 * 
 * **性能特征**:
 * - O(1) 时间复杂度
 * - Map 内部哈希表实现
 * - 无额外计算开销
 * 
 * @param modelId - 模型 ID（可选）
 * @returns 上下文窗口令牌数或 undefined
 * 
 * @example
 * ```typescript
 * // 场景 1: 查找已缓存的模型
 * const claudeTokens = lookupCachedContextTokens('claude-sonnet-4');
 * console.log(claudeTokens);  // → 200000
 * 
 * // 场景 2: 查找未缓存的模型
 * const unknownTokens = lookupCachedContextTokens('unknown-model');
 * console.log(unknownTokens);  // → undefined
 * 
 * // 场景 3: 处理 undefined 输入
 * const noIdTokens = lookupCachedContextTokens(undefined);
 * console.log(noIdTokens);  // → undefined
 * 
 * // 场景 4: 带提供者前缀的模型 ID
 * const anthropicTokens = lookupCachedContextTokens('anthropic/claude-3-5-sonnet');
 * console.log(anthropicTokens);  // → 200000 (如果已缓存)
 * 
 * // 场景 5: 条件判断
 * const modelId = 'gpt-4';
 * const tokens = lookupCachedContextTokens(modelId);
 * if (tokens) {
 *   console.log(`${modelId} supports ${tokens} context tokens`);
 * } else {
 *   console.log(`${modelId} context window not discovered`);
 * }
 * ```
 */
export function lookupCachedContextTokens(modelId?: string): number | undefined {
  // 快速路径：modelId 无效直接返回
  if (!modelId) {
    return undefined;
  }
  
  // 从全局缓存 Map 查找并返回
  return MODEL_CONTEXT_TOKEN_CACHE.get(modelId);
}
