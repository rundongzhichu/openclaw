/**
 * @fileoverview Agent 上下文窗口管理
 * 
 * 本文件实现了 OpenClaw 系统中 AI 模型的上下文窗口（Context Window）发现、缓存和应用逻辑。
 * 
 * **核心职责**:
 * - 自动发现模型上下文窗口（从 pi-coding-agent、配置等来源）
 * - LRU 缓存管理（避免重复加载）
 * - 多提供者上下文窗口合并（取最小值策略）
 * - 配置驱动的上下文窗口覆盖
 * - 延迟加载和重试机制
 * 
 * **上下文窗口来源**:
 * 1. **pi-coding-agent 内置元数据**: 默认模型上下文窗口定义
 * 2. **models.json 配置**: 用户自定义模型配置
 * 3. **环境变量**: OPENCLAW_* 相关变量
 * 4. **CLI 参数**: --context-window 等运行时覆盖
 * 
 * **缓存策略**:
 * ```typescript
 * Map<modelId, contextWindowTokens>
 * // 示例：
 * // 'claude-sonnet-4' => 200000
 * // 'gpt-4' => 128000
 * // 'gemini-2.5-pro' => 1048576
 * ```
 * 
 * **冲突解决**:
 * - 同一模型在不同提供者下有不同上下文窗口时，采用**最小值策略**
 * - 原因：避免高估导致 compaction 延迟和上下文溢出
 * 
 * **使用示例**:
 * ```typescript
 * // 场景 1: 解析特定模型的上下文窗口
 * const tokens = resolveContextTokensForModel({
 *   modelId: 'claude-sonnet-4',
 *   provider: 'anthropic'
 * });
 * console.log(tokens);  // → 200000
 * 
 * // 场景 2: 应用发现的上下文窗口到缓存
 * applyDiscoveredContextWindows({
 *   cache: MODEL_CONTEXT_TOKEN_CACHE,
 *   models: [{ id: 'gpt-4', contextWindow: 128000 }]
 * });
 * 
 * // 场景 3: 应用配置中的上下文窗口
 * applyConfiguredContextWindows({
 *   cache: MODEL_CONTEXT_TOKEN_CACHE,
 *   modelsConfig: {
 *     providers: {
 *       anthropic: {
 *         models: [{ id: 'custom-claude', contextWindow: 250000 }]
 *       }
 *     }
 *   }
 * });
 * ```
 * 
 * @module agents/context
 */

// Lazy-load pi-coding-agent model metadata so we can infer context windows when
// the agent reports a model id. This includes custom models.json entries.

import path from "node:path";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { computeBackoff, type BackoffPolicy } from "../infra/backoff.js";
import { consumeRootOptionToken, FLAG_TERMINATOR } from "../infra/cli-root-options.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { lookupCachedContextTokens, MODEL_CONTEXT_TOKEN_CACHE } from "./context-cache.js";
import { normalizeProviderId } from "./model-selection.js";

type ModelEntry = { id: string; contextWindow?: number };
type ModelRegistryLike = {
  getAvailable?: () => ModelEntry[];
  getAll: () => ModelEntry[];
};
type ConfigModelEntry = { id?: string; contextWindow?: number };
type ProviderConfigEntry = { models?: ConfigModelEntry[] };
type ModelsConfig = { providers?: Record<string, ProviderConfigEntry | undefined> };
type AgentModelEntry = { params?: Record<string, unknown> };

/**
 * Anthropic 1M token 上下文窗口模型前缀
 * 
 * 这些模型支持超大上下文（1,048,576 tokens），需要特殊处理。
 */
const ANTHROPIC_1M_MODEL_PREFIXES = ["claude-opus-4", "claude-sonnet-4"] as const;

/**
 * Anthropic 超大上下文窗口令牌数（1M tokens）
 * 
 * 值为 1,048,576 tokens，用于 claude-opus-4 和 claude-sonnet-4 等模型。
 */
export const ANTHROPIC_CONTEXT_1M_TOKENS = 1_048_576;

/**
 * 配置加载重试策略
 * 
 * 使用指数退避算法，避免频繁重试导致性能问题。
 * 
 * **参数说明**:
 * - `initialMs`: 初始延迟 1 秒
 * - `maxMs`: 最大延迟 60 秒
 * - `factor`: 退避因子 2（每次翻倍）
 * - `jitter`: 随机抖动 0（确定性退避）
 * 
 * **重试序列**: 1s → 2s → 4s → 8s → 16s → 32s → 60s (cap)
 */
const CONFIG_LOAD_RETRY_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0,
};

/**
 * 应用发现的上下文窗口到缓存
 * 
 * **核心逻辑**:
 * 1. 遍历所有发现的模型条目
 * 2. 验证 model.id 和 contextWindow 有效性
 * 3. 对于重复的 model ID，采用**最小值策略**
 * 
 * **为什么使用最小值策略**:
 * - 同一模型可能在不同提供者下有不同的上下文窗口定义
 * - 缓存用于显示路径和运行时路径（flush thresholds、session context-token persistence）
 * - 高估会导致 compaction 延迟，进而引发上下文溢出错误
 * - 保守估计更安全，已知活跃提供者可调用 resolveContextTokensForModel
 * 
 * @param params - 参数对象
 * @param params.cache - 目标缓存 Map
 * @param params.models - 模型条目数组
 * 
 * @example
 * ```typescript
 * // 场景 1: 应用 pi-coding-agent 发现的模型
 * applyDiscoveredContextWindows({
 *   cache: MODEL_CONTEXT_TOKEN_CACHE,
 *   models: [
 *     { id: 'gpt-4', contextWindow: 128000 },
 *     { id: 'claude-sonnet-4', contextWindow: 200000 }
 *   ]
 * });
 * 
 * // 场景 2: 处理冲突（取最小值）
 * applyDiscoveredContextWindows({
 *   cache: MODEL_CONTEXT_TOKEN_CACHE,
 *   models: [
 *     { id: 'claude-sonnet-4', contextWindow: 200000 },  // anthropic
 *     { id: 'claude-sonnet-4', contextWindow: 180000 }   // vertex
 *   ]
 * });
 * // → cache.get('claude-sonnet-4') === 180000
 * ```
 */
export function applyDiscoveredContextWindows(params: {
  /** 目标缓存 Map */
  cache: Map<string, number>;
  /** 模型条目数组 */
  models: ModelEntry[];
}) {
  for (const model of params.models) {
    // 跳过无效条目
    if (!model?.id) {
      continue;
    }
    
    // 解析并验证上下文窗口值
    const contextWindow =
      typeof model.contextWindow === "number" ? Math.trunc(model.contextWindow) : undefined;
    if (!contextWindow || contextWindow <= 0) {
      continue;
    }
    
    const existing = params.cache.get(model.id);
    
    // 最小值策略：保留较小的上下文窗口
    // 原因：避免高估导致 compaction 延迟和上下文溢出
    if (existing === undefined || contextWindow < existing) {
      params.cache.set(model.id, contextWindow);
    }
  }
}

/**
 * 应用配置中的上下文窗口到缓存
 * 
 * **处理流程**:
 * 1. 读取 modelsConfig.providers 配置
 * 2. 遍历所有提供者配置
 * 3. 提取每个提供者的 models 列表
 * 4. 将有效的 contextWindow 写入缓存
 * 
 * **优先级**: 配置覆盖 > 自动发现
 * 
 * @param params - 参数对象
 * @param params.cache - 目标缓存 Map
 * @param params.modelsConfig - 模型配置对象（可选）
 * 
 * @example
 * ```typescript
 * // 场景 1: 应用自定义模型配置
 * const customConfig: ModelsConfig = {
 *   providers: {
 *     anthropic: {
 *       models: [
 *         { id: 'custom-claude', contextWindow: 250000 },
 *         { id: 'claude-sonnet-4', contextWindow: 190000 }  // 覆盖默认值
 *       ]
 *     },
 *     openai: {
 *       models: [
 *         { id: 'gpt-4-turbo', contextWindow: 150000 }
 *       ]
 *     }
 *   }
 * };
 * 
 * applyConfiguredContextWindows({
 *   cache: MODEL_CONTEXT_TOKEN_CACHE,
 *   modelsConfig: customConfig
 * });
 * 
 * // 结果：cache 中包含自定义的上下文窗口定义
 * ```
 */
export function applyConfiguredContextWindows(params: {
  /** 目标缓存 Map */
  cache: Map<string, number>;
  /** 模型配置对象 */
  modelsConfig: ModelsConfig | undefined;
}) {
  const providers = params.modelsConfig?.providers;
  
  // 验证 providers 是否为有效对象
  if (!providers || typeof providers !== "object") {
    return;
  }
  
  // 遍历所有提供者
  for (const provider of Object.values(providers)) {
    // 跳过没有 models 数组的提供者
    if (!Array.isArray(provider?.models)) {
      continue;
    }
    
    // 遍历该提供者的所有模型
    for (const model of provider.models) {
      const modelId = typeof model?.id === "string" ? model.id : undefined;
      const contextWindow =
        typeof model?.contextWindow === "number" ? model.contextWindow : undefined;
      
      // 验证 modelId 和 contextWindow 有效性
      if (!modelId || !contextWindow || contextWindow <= 0) {
        continue;
      }
      
      // 写入缓存（配置优先级最高，直接覆盖）
      params.cache.set(modelId, contextWindow);
    }
  }
}

/** 全局配置加载 Promise（单例模式，避免重复加载） */
let loadPromise: Promise<void> | null = null;

/** 已加载的配置缓存（避免重复解析） */
let configuredConfig: OpenClawConfig | undefined;

/** 配置加载失败次数（用于退避计算） */
let configLoadFailures = 0;

/** 下次允许尝试加载的时间戳（毫秒） */
let nextConfigLoadAttemptAtMs = 0;

/** models-config.runtime.js 模块的动态导入 Promise（懒加载） */
let modelsConfigRuntimePromise: Promise<typeof import("./models-config.runtime.js")> | undefined;

/**
 * 懒加载 models-config.runtime.js 模块
 * 
 * 使用 Promise 单例模式，确保只加载一次。
 * 
 * @returns models-config.runtime.js 模块的 Promise
 */
function loadModelsConfigRuntime() {
  modelsConfigRuntimePromise ??= import("./models-config.runtime.js");
  return modelsConfigRuntimePromise;
}

/**
 * 判断是否为 OpenClaw CLI 进程
 * 
 * **检测逻辑**:
 * 检查 argv[1] 的文件名是否为以下之一：
 * - `openclaw`
 * - `openclaw.mjs`
 * - `entry.js`
 * - `entry.mjs`
 * 
 * **用途**:
 * - 避免在非 CLI 环境中执行预热逻辑
 * - 插件 SDK 共享此模块时不触发意外的 warmup
 * 
 * @param argv - 进程参数（默认 process.argv）
 * @returns 是否为 OpenClaw CLI 进程
 * 
 * @example
 * ```typescript
 * // CLI 环境
 * isLikelyOpenClawCliProcess(['node', '/path/to/openclaw', 'agent']);
 * // → true
 * 
 * // 插件测试环境
 * isLikelyOpenClawCliProcess(['node', '/path/to/plugin-test.js']);
 * // → false
 * ```
 */
function isLikelyOpenClawCliProcess(argv: string[] = process.argv): boolean {
  const entryBasename = path
    .basename(argv[1] ?? "")
    .trim()
    .toLowerCase();
  return (
    entryBasename === "openclaw" ||
    entryBasename === "openclaw.mjs" ||
    entryBasename === "entry.js" ||
    entryBasename === "entry.mjs"
  );
}

/**
 * 从进程参数中提取命令路径
 * 
 * **提取逻辑**:
 * 1. 跳过 argv[0] (Node 路径) 和 argv[1] (脚本路径)
 * 2. 过滤掉根选项（如 --profile, --container）
 * 3. 收集前两个非选项参数（primary command 和 subcommand）
 * 4. 遇到 FLAG_TERMINATOR 停止
 * 
 * **示例**:
 * ```text
 * ['node', 'openclaw', '--profile', 'dev', 'agent', '--message', 'Hi']
 * → ['agent']
 * 
 * ['node', 'openclaw', 'gateway', '--port', '18789']
 * → ['gateway']
 * 
 * ['node', 'openclaw', 'config', 'show']
 * → ['config', 'show']
 * ```
 * 
 * @param argv - 进程参数
 * @returns 命令路径标记数组（最多 2 个）
 */
function getCommandPathFromArgv(argv: string[]): string[] {
  const args = argv.slice(2);  // 跳过 Node 和脚本路径
  const tokens: string[] = [];
  
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    
    // 遇到空参数或终止符，停止
    if (!arg || arg === FLAG_TERMINATOR) {
      break;
    }
    
    // 尝试消耗根选项（如 --profile dev）
    const consumed = consumeRootOptionToken(args, i);
    if (consumed > 0) {
      i += consumed - 1;  // 跳过选项及其参数
      continue;
    }
    
    // 跳过其他标志
    if (arg.startsWith("-")) {
      continue;
    }
    
    // 收集命令标记
    tokens.push(arg);
    
    // 最多收集 2 个（primary + subcommand）
    if (tokens.length >= 2) {
      break;
    }
  }
  
  return tokens;
}

/**
 * 跳过预热的主要命令列表
 * 
 * 这些命令不需要立即加载上下文窗口缓存，可以延迟加载以提升启动速度。
 * 
 * **分类**:
 * - **维护类**: backup, update, health, status
 * - **配置类**: config, directory, plugins, secrets
 * - **诊断类**: doctor, logs, webhooks
 * - **工具类**: completion, hooks, gateway
 */
const SKIP_EAGER_WARMUP_PRIMARY_COMMANDS = new Set([
  "backup",       // 备份操作
  "completion",   // Shell 补全生成
  "config",       // 配置管理
  "directory",    // 目录查询
  "doctor",       // 系统诊断
  "gateway",      // 网关启动
  "health",       // 健康检查
  "hooks",        // Hook 管理
  "logs",         // 日志查看
  "plugins",      // 插件管理
  "secrets",      // 密钥管理
  "status",       // 状态查询
  "update",       // 版本更新
  "webhooks",     // Webhook 管理
]);

/**
 * 判断是否应该预热上下文窗口缓存
 * 
 * **决策逻辑**:
 * 1. 首先检查是否为 OpenClaw CLI 进程
 * 2. 提取 primary command
 * 3. 如果 primary command 不在跳过列表中，则进行预热
 * 
 * **为什么需要预热**:
 * - 避免首次调用时的延迟
 * - 提前加载 models.json 和配置
 * - 提升用户体验
 * 
 * **为什么某些命令跳过**:
 * - 这些命令通常是维护/诊断性质
 * - 不涉及 Agent 运行，不需要上下文窗口信息
 * - 延迟加载可加快启动速度
 * 
 * @param argv - 进程参数（默认 process.argv）
 * @returns 是否应该预热
 * 
 * @example
 * ```typescript
 * // 需要预热的命令
 * shouldEagerWarmContextWindowCache(['node', 'openclaw', 'agent']);
 * // → true
 * 
 * shouldEagerWarmContextWindowCache(['node', 'openclaw', 'gateway']);
 * // → false (在跳过列表中)
 * 
 * // 非 CLI 环境
 * shouldEagerWarmContextWindowCache(['node', 'test-script.js']);
 * // → false
 * ```
 */
function shouldEagerWarmContextWindowCache(argv: string[] = process.argv): boolean {
  // 门控 1: 必须是真正的 OpenClaw CLI 进程
  if (!isLikelyOpenClawCliProcess(argv)) {
    return false;
  }
  
  // 门控 2: 提取 primary command
  const [primary] = getCommandPathFromArgv(argv);
  
  // 门控 3: 检查是否在跳过列表中
  return Boolean(primary) && !SKIP_EAGER_WARMUP_PRIMARY_COMMANDS.has(primary);
}

/**
 * 预热配置中的上下文窗口
 * 
 * **执行逻辑**:
 * 1. 检查是否已有缓存配置（有则直接返回）
 * 2. 检查是否到达重试时间（未到则跳过）
 * 3. 尝试加载配置
 * 4. 应用配置中的上下文窗口到缓存
 * 5. 成功则重置失败计数，失败则计算退避时间
 * 
 * **重试机制**:
 * - 失败时使用指数退避
 * - 避免频繁重试拖慢系统
 * 
 * @returns 加载的配置对象（失败则返回 undefined）
 */
function primeConfiguredContextWindows(): OpenClawConfig | undefined {
  // 快速路径：已有缓存配置
  if (configuredConfig) {
    return configuredConfig;
  }
  
  // 快速路径：未到重试时间
  if (Date.now() < nextConfigLoadAttemptAtMs) {
    return undefined;
  }
  
  try {
    // 步骤 1: 加载配置
    const cfg = loadConfig();
    
    // 步骤 2: 应用配置中的上下文窗口
    applyConfiguredContextWindows({
      cache: MODEL_CONTEXT_TOKEN_CACHE,
      modelsConfig: cfg.models as ModelsConfig | undefined,
    });
    
    // 步骤 3: 缓存配置对象
    configuredConfig = cfg;
    
    // 步骤 4: 重置失败计数
    configLoadFailures = 0;
    nextConfigLoadAttemptAtMs = 0;
    
    return cfg;
  } catch {
    // 失败处理：增加失败计数，计算退避时间
    configLoadFailures += 1;
    const backoffMs = computeBackoff(CONFIG_LOAD_RETRY_POLICY, configLoadFailures);
    nextConfigLoadAttemptAtMs = Date.now() + backoffMs;
    
    // 留空缓存，等待下次重试
    return undefined;
  }
}

/**
 * 确保上下文窗口缓存已加载
 * 
 * **加载策略**:
 * - 单例模式：loadPromise 确保只加载一次
 * - 懒加载：首次调用时才真正加载
 * - 容错处理：任何步骤失败都不影响整体流程
 * 
 * **加载顺序**:
 * 1. 确保 models.json 存在
 * 2. 发现 pi-coding-agent 中的模型
 * 3. 应用发现的上下文窗口
 * 4. 应用配置覆盖
 * 
 * @returns Promise<void>
 */
function ensureContextWindowCacheLoaded(): Promise<void> {
  // 快速路径：已有加载 Promise
  if (loadPromise) {
    return loadPromise;
  }

  // 预热配置
  const cfg = primeConfiguredContextWindows();
  if (!cfg) {
    return Promise.resolve();
  }

  loadPromise = (async () => {
    // 步骤 1: 确保 models.json 存在
    try {
      await (await loadModelsConfigRuntime()).ensureOpenClawModelsJson(cfg);
    } catch {
      // 继续最佳努力的发现和覆盖
    }

    // 步骤 2: 发现 pi-coding-agent 中的模型
    try {
      const { discoverAuthStorage, discoverModels } =
        await import("./pi-model-discovery-runtime.js");
      const agentDir = resolveOpenClawAgentDir();
      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir) as unknown as ModelRegistryLike;
      const models =
        typeof modelRegistry.getAvailable === "function"
          ? modelRegistry.getAvailable()
          : modelRegistry.getAll();
      
      // 步骤 3: 应用发现的上下文窗口
      applyDiscoveredContextWindows({
        cache: MODEL_CONTEXT_TOKEN_CACHE,
        models,
      });
    } catch {
      // 模型发现失败时，仅使用配置覆盖
    }

    // 步骤 4: 应用配置覆盖
    applyConfiguredContextWindows({
      cache: MODEL_CONTEXT_TOKEN_CACHE,
      modelsConfig: cfg.models as ModelsConfig | undefined,
    });
  })().catch(() => {
    // 保持查找的最佳努力模式
  });
  
  return loadPromise;
}

/**
 * 重置上下文窗口缓存（仅供测试使用）
 * 
 * **用途**:
 * - 单元测试中清理全局状态
 * - 确保测试之间的隔离性
 * 
 * **重置内容**:
 * - 加载 Promise
 * - 配置缓存
 * - 失败计数器
 * - 重试时间戳
 * - 运行时模块 Promise
 * - 上下文令牌缓存 Map
 */
export function resetContextWindowCacheForTest(): void {
  loadPromise = null;
  configuredConfig = undefined;
  configLoadFailures = 0;
  nextConfigLoadAttemptAtMs = 0;
  modelsConfigRuntimePromise = undefined;
  MODEL_CONTEXT_TOKEN_CACHE.clear();
}

/**
 * 查找模型的上下文令牌数
 * 
 * **查找策略**:
 * - 同步模式：仅读取已加载的配置覆盖
 * - 异步模式：触发后台加载，但不阻塞当前查找
 * 
 * **使用场景**:
 * - `allowAsyncLoad=false`: 只读调用者（如状态显示），不应触发后台加载
 * - `allowAsyncLoad=true` (默认): 按需触发加载，最佳努力查找
 * 
 * @param modelId - 模型 ID
 * @param options - 选项对象
 * @param options.allowAsyncLoad - 是否允许异步加载（默认 true）
 * @returns 上下文令牌数，未找到则返回 undefined
 * 
 * @example
 * ```typescript
 * // 场景 1: 允许异步加载（默认）
 * const tokens = lookupContextTokens('claude-sonnet-4');
 * 
 * // 场景 2: 仅同步查找
 * const tokens = lookupContextTokens('gpt-4', { allowAsyncLoad: false });
 * ```
 */
export function lookupContextTokens(
  modelId?: string,
  options?: { allowAsyncLoad?: boolean },
): number | undefined {
  if (!modelId) {
    return undefined;
  }
  
  if (options?.allowAsyncLoad === false) {
    // 只读调用者需要同步的配置覆盖，但不应启动后台模型发现或 models.json 写入
    primeConfiguredContextWindows();
  } else {
    // 最佳努力：按需触发加载，但不阻塞查找
    void ensureContextWindowCacheLoaded();
  }
  
  return lookupCachedContextTokens(modelId);
}

if (shouldEagerWarmContextWindowCache()) {
  // Keep startup warmth for the real CLI, but avoid import-time side effects
  // when this module is pulled in through library/plugin-sdk surfaces.
  void ensureContextWindowCacheLoaded();
}

/**
 * 解析配置中的模型参数
 * 
 * **查找逻辑**:
 * 1. 从 cfg.agents.defaults.models 中查找
 * 2. 构建 provider/model 键（小写、去空格）
 * 3. 匹配配置的 key
 * 4. 返回 params 对象
 * 
 * @param cfg - OpenClaw 配置对象
 * @param provider - 提供者 ID
 * @param model - 模型 ID
 * @returns 模型参数对象，未找到则返回 undefined
 * 
 * @example
 * ```typescript
 * // 配置示例:
 * // agents.defaults.models: {
 * //   "anthropic/claude-sonnet-4": { params: { context1m: true } }
 * // }
 * 
 * const params = resolveConfiguredModelParams(cfg, 'anthropic', 'claude-sonnet-4');
 * // → { context1m: true }
 * ```
 */
function resolveConfiguredModelParams(
  cfg: OpenClawConfig | undefined,
  provider: string,
  model: string,
): Record<string, unknown> | undefined {
  const models = cfg?.agents?.defaults?.models;
  if (!models) {
    return undefined;
  }
  const key = `${provider}/${model}`.trim().toLowerCase();
  for (const [rawKey, entry] of Object.entries(models)) {
    if (rawKey.trim().toLowerCase() === key) {
      const params = (entry as AgentModelEntry | undefined)?.params;
      return params && typeof params === "object" ? params : undefined;
    }
  }
  return undefined;
}

/**
 * 解析提供者 - 模型引用
 * 
 * **解析逻辑**:
 * 1. 如果提供了独立的 provider 参数，直接使用
 * 2. 否则从 model 字符串中提取（格式：`provider/model`）
 * 3. 规范化提供者 ID
 * 
 * **输入格式**:
 * - 独立参数：`{ provider: 'anthropic', model: 'claude-sonnet-4' }`
 * - 合并字符串：`{ model: 'anthropic/claude-sonnet-4' }`
 * 
 * @param params - 参数对象
 * @param params.provider - 提供者 ID（可选）
 * @param params.model - 模型 ID（可选，可包含 provider 前缀）
 * @returns 规范化的 { provider, model } 对象，解析失败则返回 undefined
 * 
 * @example
 * ```typescript
 * // 场景 1: 独立参数
 * resolveProviderModelRef({ provider: 'anthropic', model: 'claude-sonnet-4' });
 * // → { provider: 'anthropic', model: 'claude-sonnet-4' }
 * 
 * // 场景 2: 合并字符串
 * resolveProviderModelRef({ model: 'openai/gpt-4' });
 * // → { provider: 'openai', model: 'gpt-4' }
 * 
 * // 场景 3: 无效输入
 * resolveProviderModelRef({ model: 'gpt-4' });  // 缺少 provider
 * // → undefined
 * ```
 */
function resolveProviderModelRef(params: {
  provider?: string;
  model?: string;
}): { provider: string; model: string } | undefined {
  const modelRaw = params.model?.trim();
  if (!modelRaw) {
    return undefined;
  }
  
  const providerRaw = params.provider?.trim();
  if (providerRaw) {
    // 使用独立提供的 provider
    const provider = normalizeProviderId(providerRaw);
    if (!provider) {
      return undefined;
    }
    return { provider, model: modelRaw };
  }
  
  // 从 model 字符串中提取 provider
  const slash = modelRaw.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const provider = normalizeProviderId(modelRaw.slice(0, slash));
  const model = modelRaw.slice(slash + 1).trim();
  if (!provider || !model) {
    return undefined;
  }
  return { provider, model };
}

/**
 * 解析配置中特定提供者 + 模型的上下文窗口覆盖
 * 
 * **设计目的**:
 * 直接从配置中查找，不经过共享发现缓存，避免缓存键空间冲突。
 * 
 * **问题背景**:
 * - "provider/model" 合成键可能与原始斜杠模型 ID 重叠
 * - 例如：OpenRouter 的 "google/gemini-2.5-pro" 作为原始目录条目存储
 * 
 * **查找顺序**:
 * 1. 精确匹配（区分大小写，无别名扩展）
 * 2. 规范化后备（覆盖别名键，如 "z.ai" → "zai"）
 * 
 * @param cfg - OpenClaw 配置对象
 * @param provider - 提供者 ID
 * @param model - 模型 ID
 * @returns 上下文窗口令牌数，未找到则返回 undefined
 */
function resolveConfiguredProviderContextWindow(
  cfg: OpenClawConfig | undefined,
  provider: string,
  model: string,
): number | undefined {
  const providers = (cfg?.models as ModelsConfig | undefined)?.providers;
  if (!providers) {
    return undefined;
  }

  /**
   * 查找上下文窗口的内部函数
   * 
   * 镜像 pi-embedded-runner/model.ts 中的查找顺序：先精确匹配，后规范化后备。
   * 防止因 Object.entries 迭代顺序导致的别名冲突。
   * 
   * @param matchProviderId - 提供者 ID 匹配函数
   * @returns 上下文窗口令牌数，未找到则返回 undefined
   */
  function findContextWindow(matchProviderId: (id: string) => boolean): number | undefined {
    for (const [providerId, providerConfig] of Object.entries(providers!)) {
      if (!matchProviderId(providerId)) {
        continue;
      }
      if (!Array.isArray(providerConfig?.models)) {
        continue;
      }
      for (const m of providerConfig.models) {
        if (
          typeof m?.id === "string" &&
          m.id === model &&
          typeof m?.contextWindow === "number" &&
          m.contextWindow > 0
        ) {
          return m.contextWindow;
        }
      }
    }
    return undefined;
  }

  // 步骤 1: 精确匹配（不区分大小写，无别名扩展）
  const exactResult = findContextWindow((id) => id.trim().toLowerCase() === provider.toLowerCase());
  if (exactResult !== undefined) {
    return exactResult;
  }

  // 步骤 2: 规范化后备：覆盖别名键（如 "z.ai" → "zai"）
  const normalizedProvider = normalizeProviderId(provider);
  return findContextWindow((id) => normalizeProviderId(id) === normalizedProvider);
}

/**
 * 判断是否为 Anthropic 1M token 模型
 * 
 * **检测逻辑**:
 * 1. 检查提供者是否为 "anthropic"
 * 2. 规范化模型 ID（小写、去除路径前缀）
 * 3. 检查是否以 1M 模型前缀开头
 * 
 * **支持的模型**:
 * - claude-opus-4-*
 * - claude-sonnet-4-*
 * 
 * @param provider - 提供者 ID
 * @param model - 模型 ID
 * @returns 是否为 1M token 模型
 * 
 * @example
 * ```typescript
 * isAnthropic1MModel('anthropic', 'claude-sonnet-4-20240101');
 * // → true
 * 
 * isAnthropic1MModel('anthropic', 'vertex/claude-opus-4');
 * // → true (自动提取最后一部分)
 * 
 * isAnthropic1MModel('openai', 'gpt-4');
 * // → false
 * ```
 */
function isAnthropic1MModel(provider: string, model: string): boolean {
  if (provider !== "anthropic") {
    return false;
  }
  const normalized = model.trim().toLowerCase();
  // 提取模型 ID 的最后一部分（处理路径前缀）
  const modelId = normalized.includes("/")
    ? (normalized.split("/").at(-1) ?? normalized)
    : normalized;
  return ANTHROPIC_1M_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

/**
 * 解析模型的上下文令牌数
 * 
 * **核心功能**:
 * 综合多种来源解析模型的上下文窗口，按优先级返回最准确的值。
 * 
 * **查找顺序**:
 * 1. **显式覆盖**: `contextTokensOverride` 参数优先
 * 2. **1M 模型检测**: Anthropic 超大上下文模型特殊处理
 * 3. **配置直接扫描**: 仅当显式提供 provider 时（避免跨提供者误判）
 * 4. **提供者限定缓存键**: `provider/model` 格式优先于裸键
 * 5. **裸键回退**: 直接使用 model ID 查找
 * 6. **隐式提供者限定**: 最后尝试推断的 provider/model 组合
 * 7. **最终回退**: `fallbackContextTokens` 参数
 * 
 * **关键设计**:
 * - 区分显式 provider 和推断 provider，避免 OpenRouter 等场景的误判
 * - 提供者限定键优先，确保获取正确的提供者特定窗口
 * - 支持异步加载，但不阻塞查找
 * 
 * @param params - 参数对象
 * @param params.cfg - OpenClaw 配置对象（可选）
 * @param params.provider - 提供者 ID（可选）
 * @param params.model - 模型 ID（可选）
 * @param params.contextTokensOverride - 显式覆盖的上下文令牌数（优先级最高）
 * @param params.fallbackContextTokens - 回退值（所有查找失败时使用）
 * @param params.allowAsyncLoad - 是否允许异步加载（默认 true）
 * @returns 上下文令牌数，未找到且无回退值则返回 undefined
 * 
 * @example
 * ```typescript
 * // 场景 1: 显式覆盖
 * resolveContextTokensForModel({
 *   model: 'claude-sonnet-4',
 *   provider: 'anthropic',
 *   contextTokensOverride: 180000
 * });
 * // → 180000
 * 
 * // 场景 2: Anthropic 1M 模型
 * resolveContextTokensForModel({
 *   cfg: { agents: { defaults: { models: {
 *     'anthropic/claude-sonnet-4': { params: { context1m: true } }
 *   }}}},
 *   model: 'claude-sonnet-4',
 *   provider: 'anthropic'
 * });
 * // → 1048576
 * 
 * // 场景 3: 配置覆盖
 * resolveContextTokensForModel({
 *   cfg: { models: { providers: {
 *     anthropic: { models: [{ id: 'claude-sonnet-4', contextWindow: 190000 }] }
 *   }}},
 *   model: 'claude-sonnet-4',
 *   provider: 'anthropic'
 * });
 * // → 190000
 * 
 * // 场景 4: 带回退值
 * resolveContextTokensForModel({
 *   model: 'unknown-model',
 *   fallbackContextTokens: 128000
 * });
 * // → 128000
 * ```
 */
export function resolveContextTokensForModel(params: {
  /** OpenClaw 配置对象 */
  cfg?: OpenClawConfig;
  /** 提供者 ID */
  provider?: string;
  /** 模型 ID */
  model?: string;
  /** 显式覆盖的上下文令牌数 */
  contextTokensOverride?: number;
  /** 回退值 */
  fallbackContextTokens?: number;
  /** 是否允许异步加载 */
  allowAsyncLoad?: boolean;
}): number | undefined {
  // 优先级 1: 显式覆盖
  if (typeof params.contextTokensOverride === "number" && params.contextTokensOverride > 0) {
    return params.contextTokensOverride;
  }

  // 解析 provider/model 引用
  const ref = resolveProviderModelRef({
    provider: params.provider,
    model: params.model,
  });
  
  if (ref) {
    // 优先级 2: 检查 Anthropic 1M 模型
    const modelParams = resolveConfiguredModelParams(params.cfg, ref.provider, ref.model);
    if (modelParams?.context1m === true && isAnthropic1MModel(ref.provider, ref.model)) {
      return ANTHROPIC_CONTEXT_1M_TOKENS;
    }
    
    // 优先级 3: 配置直接扫描（仅当显式提供 provider 时）
    // 原因：当 provider 从 model 字符串推断时（如 "google/gemini-2.5-pro"），
    // 实际模型可能属于不同的提供者（如 OpenRouter 会话）。
    // 此时扫描 cfg.models.providers.google 会返回 Google 的配置窗口，
    // 导致 OpenRouter 会话的上下文限制误报。
    if (params.provider) {
      const configuredWindow = resolveConfiguredProviderContextWindow(
        params.cfg,
        ref.provider,
        ref.model,
      );
      if (configuredWindow !== undefined) {
        return configuredWindow;
      }
    }
  }

  // 优先级 4: 提供者限定缓存键（仅当显式提供 provider 且 model 不含斜杠时）
  // 发现条目存储在限定 ID 下（如 "google-gemini-cli/gemini-3.1-pro-preview" → 1M），
  // 而裸键可能持有跨提供者最小值（128k）。
  // 返回限定条目可为 /status 和 session context-token persistence 提供正确的提供者特定窗口。
  if (params.provider && ref && !ref.model.includes("/")) {
    const qualifiedResult = lookupContextTokens(
      `${normalizeProviderId(ref.provider)}/${ref.model}`,
      { allowAsyncLoad: params.allowAsyncLoad },
    );
    if (qualifiedResult !== undefined) {
      return qualifiedResult;
    }
  }

  // 优先级 5: 裸键回退
  // 对于仅含 model 且含斜杠的调用（如 "google/gemini-2.5-pro"），
  // 这本身就是原始发现缓存键。
  const bareResult = lookupContextTokens(params.model, {
    allowAsyncLoad: params.allowAsyncLoad,
  });
  if (bareResult !== undefined) {
    return bareResult;
  }

  // 优先级 6: 隐式提供者限定（最后尝试）
  // 确保推断的 provider/model 对（如 model="google-gemini-cli/gemini-3.1-pro"）
  // 仍能找到存储在该限定 ID 下的发现条目。
  if (!params.provider && ref && !ref.model.includes("/")) {
    const qualifiedResult = lookupContextTokens(
      `${normalizeProviderId(ref.provider)}/${ref.model}`,
      { allowAsyncLoad: params.allowAsyncLoad },
    );
    if (qualifiedResult !== undefined) {
      return qualifiedResult;
    }
  }

  // 优先级 7: 回退值
  return params.fallbackContextTokens;
}
