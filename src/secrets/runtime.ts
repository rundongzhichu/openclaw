/**
 * @fileoverview Secrets 运行时管理系统
 * 
 * 本文件实现了 OpenClaw 系统的密钥（Secrets）运行时管理核心逻辑。
 * 
 * **核心职责**:
 * - SecretRef 引用解析（从各种来源解析敏感值）
 * - Auth Profile Store 加载和管理
 * - 配置中的密钥赋值收集
 * - Web Tools 元数据解析
 * - 运行时快照管理（支持热重载）
 * - 环境变量合并和继承
 * - Agent 目录发现和解析
 * 
 * **密钥来源**:
 * 1. **环境变量**: `process.env` 或自定义环境
 * 2. **Auth Profiles**: `~/.openclaw/auth-profiles.json`
 * 3. **配置引用**: `config.json` 中的 `$ref:env.*` 或 `$ref:secret.*`
 * 4. **Web Tools**: 内置 Web 工具的认证信息
 * 
 * **运行时快照**:
 * ```text
 * PreparedSecretsRuntimeSnapshot {
 *   sourceConfig: OpenClawConfig,      // 原始配置
 *   config: OpenClawConfig,            // 解析后的配置
 *   authStores: AuthProfileStore[],    // 认证存储列表
 *   warnings: SecretResolverWarning[], // 解析警告
 *   webTools: RuntimeWebToolsMetadata  // Web 工具元数据
 * }
 * ```
 * 
 * **使用示例**:
 * ```typescript
 * // 1. 准备运行时快照
 * const snapshot = await prepareSecretsRuntimeSnapshot({
 *   config: loadedConfig,
 *   env: process.env,
 *   agentDirs: ['~/.openclaw/agents/default']
 * });
 * 
 * // 2. 激活快照（全局可用）
 * activateSecretsRuntimeSnapshot(snapshot, {
 *   env: process.env,
 *   loadAuthStore: (agentDir) => loadAuthProfileStore(agentDir)
 * });
 * 
 * // 3. 解析命令所需的密钥
 * const secrets = resolveCommandSecretsFromActiveRuntimeSnapshot([
 *   { command: 'browser', requiresAuth: true }
 * ]);
 * 
 * // 4. 监听配置变更自动刷新
 * setRuntimeConfigSnapshotRefreshHandler(async (newConfig) => {
 *   const newSnapshot = await prepareSecretsRuntimeSnapshot({
 *     config: newConfig
 *   });
 *   activateSecretsRuntimeSnapshot(newSnapshot, refreshContext);
 * });
 * ```
 * 
 * @module secrets/runtime
 */

import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { migrateLegacyConfig } from "../config/legacy-migrate.js";
import { resolveUserPath } from "../utils.js";
import {
  collectCommandSecretAssignmentsFromSnapshot,
  type CommandSecretAssignment,
} from "./command-config.js";
import { resolveSecretRefValues } from "./resolve.js";
import { collectAuthStoreAssignments } from "./runtime-auth-collectors.js";
import { collectConfigAssignments } from "./runtime-config-collectors.js";
import {
  applyResolvedAssignments,
  createResolverContext,
  type SecretResolverWarning,
} from "./runtime-shared.js";
import { resolveRuntimeWebTools, type RuntimeWebToolsMetadata } from "./runtime-web-tools.js";

export type { SecretResolverWarning } from "./runtime-shared.js";

export type PreparedSecretsRuntimeSnapshot = {
  sourceConfig: OpenClawConfig;
  config: OpenClawConfig;
  authStores: Array<{ agentDir: string; store: AuthProfileStore }>;
  warnings: SecretResolverWarning[];
  webTools: RuntimeWebToolsMetadata;
};

type SecretsRuntimeRefreshContext = {
  env: Record<string, string | undefined>;
  explicitAgentDirs: string[] | null;
  loadAuthStore: (agentDir?: string) => AuthProfileStore;
};

/**
 * 运行时路径环境变量键列表
 * 
 * 这些环境变量用于解析用户路径和配置目录。
 * 在合并环境时会优先保留这些值。
 */
const RUNTIME_PATH_ENV_KEYS = [
  "HOME",           // Unix/Linux/macOS 用户主目录
  "USERPROFILE",    // Windows 用户主目录
  "HOMEDRIVE",      // Windows 主驱动器（如 C:）
  "HOMEPATH",       // Windows 主目录路径（如 \Users\Username）
  "OPENCLAW_HOME",  // OpenClaw 自定义主目录
  "OPENCLAW_STATE_DIR",     // OpenClaw 状态数据目录
  "OPENCLAW_CONFIG_PATH",   // OpenClaw 配置文件路径
  "OPENCLAW_AGENT_DIR",     // OpenClaw Agent 目录
  "PI_CODING_AGENT_DIR",    // 兼容旧版 Agent 目录名
  "OPENCLAW_TEST_FAST",     // 测试模式标志
] as const;

/** 当前激活的 Secrets 运行时快照 */
let activeSnapshot: PreparedSecretsRuntimeSnapshot | null = null;

/** 当前激活的刷新上下文（用于热重载） */
let activeRefreshContext: SecretsRuntimeRefreshContext | null = null;

/**
 * 预准备快照到刷新上下文的弱引用映射
 * 
 * 使用 WeakMap 的原因：
 * - 避免内存泄漏（快照被 GC 时自动清理映射）
 * - 保持快照和上下文的一一对应关系
 */
const preparedSnapshotRefreshContext = new WeakMap<
  PreparedSecretsRuntimeSnapshot,
  SecretsRuntimeRefreshContext
>();

/**
 * 深度克隆快照对象
 * 
 * 使用 structuredClone 保证深拷贝，避免引用共享导致的状态污染。
 * 
 * @param snapshot - 要克隆的快照对象
 * @returns 克隆后的新快照
 */
function cloneSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: structuredClone(snapshot.sourceConfig),
    config: structuredClone(snapshot.config),
    authStores: snapshot.authStores.map((entry) => ({
      agentDir: entry.agentDir,
      store: structuredClone(entry.store),
    })),
    warnings: snapshot.warnings.map((warning) => ({ ...warning })),
    webTools: structuredClone(snapshot.webTools),
  };
}

/**
 * 克隆刷新上下文
 * 
 * 浅拷贝环境对象，深拷贝数组，保持函数引用。
 * 
 * @param context - 要克隆的刷新上下文
 * @returns 克隆后的新上下文
 */
function cloneRefreshContext(context: SecretsRuntimeRefreshContext): SecretsRuntimeRefreshContext {
  return {
    env: { ...context.env },
    explicitAgentDirs: context.explicitAgentDirs ? [...context.explicitAgentDirs] : null,
    loadAuthStore: context.loadAuthStore,  // 函数引用保持不变
  };
}

/**
 * 清空 Secrets 运行时状态
 * 
 * **清理内容**:
 * - 激活的快照
 * - 刷新上下文
 * - 配置快照刷新处理器
 * - 配置运行时快照
 * - Auth Profile Store 快照
 * 
 * **用途**:
 * - 测试环境重置
 * - 热重载前的清理
 * - 错误恢复
 */
function clearActiveSecretsRuntimeState(): void {
  activeSnapshot = null;
  activeRefreshContext = null;
  setRuntimeConfigSnapshotRefreshHandler(null);
  clearRuntimeConfigSnapshot();
  clearRuntimeAuthProfileStoreSnapshots();
}

/**
 * 收集候选 Agent 目录列表
 * 
 * **收集策略**:
 * 1. 默认 Agent 目录（`resolveOpenClawAgentDir`）
 * 2. 配置中定义的所有 Agent 目录
 * 3. 去重处理
 * 
 * @param config - OpenClaw 配置对象
 * @param env - 环境变量（默认 process.env）
 * @returns Agent 目录路径数组
 * 
 * @example
 * ```typescript
 * const dirs = collectCandidateAgentDirs(config);
 * // → [
 * //      '/Users/user/.openclaw/agents/default',
 * //      '/Users/user/.openclaw/agents/coder',
 * //      '/Users/user/.openclaw/agents/researcher'
 * //    ]
 * ```
 */
function collectCandidateAgentDirs(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const dirs = new Set<string>();
  
  // 添加默认 Agent 目录
  dirs.add(resolveUserPath(resolveOpenClawAgentDir(env), env));
  
  // 添加配置中定义的所有 Agent 目录
  for (const agentId of listAgentIds(config)) {
    dirs.add(resolveUserPath(resolveAgentDir(config, agentId, env), env));
  }
  
  return [...dirs];  // 转数组并去重
}

/**
 * 解析刷新时的 Agent 目录列表
 * 
 * **合并逻辑**:
 * 1. 从配置推导的目录列表
 * 2. 显式指定的目录列表（如果有）
 * 3. 合并并去重
 * 
 * **优先级**: 显式指定 > 配置推导
 * 
 * @param config - OpenClaw 配置对象
 * @param context - 刷新上下文
 * @returns 合并后的 Agent 目录列表
 */
function resolveRefreshAgentDirs(
  config: OpenClawConfig,
  context: SecretsRuntimeRefreshContext,
): string[] {
  // 从配置推导
  const configDerived = collectCandidateAgentDirs(config, context.env);
  
  // 如果没有显式指定，直接返回配置推导结果
  if (!context.explicitAgentDirs || context.explicitAgentDirs.length === 0) {
    return configDerived;
  }
  
  // 合并显式指定和配置推导，去重
  return [...new Set([...context.explicitAgentDirs, ...configDerived])];
}

/**
 * 合并 Secrets 运行时环境变量
 * 
 * **合并策略**:
 * 1. 以传入的 env 为基础（或使用 process.env）
 * 2. 遍历 RUNTIME_PATH_ENV_KEYS
 * 3. 如果 env 中缺少某个 key，从 process.env 补充
 * 4. 已存在的值不会被覆盖（env 优先）
 * 
 * **设计目的**:
 * - 保证路径相关环境变量的完整性
 * - 允许自定义环境覆盖系统环境
 * - 避免意外丢失关键路径信息
 * 
 * @param env - 自定义环境（可选，默认使用 process.env）
 * @returns 合并后的环境对象
 * 
 * @example
 * ```typescript
 * // 情况 1: 不传参数，使用 process.env
 * const merged1 = mergeSecretsRuntimeEnv(undefined);
 * // → { HOME: '/Users/user', PATH: '...', ... }
 * 
 * // 情况 2: 传入自定义环境
 * const customEnv = { OPENCLAW_HOME: '/custom/path' };
 * const merged2 = mergeSecretsRuntimeEnv(customEnv);
 * // → { OPENCLAW_HOME: '/custom/path', HOME: '/Users/user', ... }
 * 
 * // 情况 3: 自定义环境与系统环境冲突（自定义优先）
 * const customEnv2 = { HOME: '/override/path' };
 * const merged3 = mergeSecretsRuntimeEnv(customEnv2);
 * // → { HOME: '/override/path' }  // 不会被 process.env.HOME 覆盖
 * ```
 */
function mergeSecretsRuntimeEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  // 以传入环境为基础（或 process.env）
  const merged = { ...(env ?? process.env) } as Record<string, string | undefined>;
  
  // 补充缺失的路径相关环境变量
  for (const key of RUNTIME_PATH_ENV_KEYS) {
    if (merged[key] !== undefined) {
      continue;  // 已存在，跳过
    }
    
    const processValue = process.env[key];
    if (processValue !== undefined) {
      merged[key] = processValue;  // 从 process.env 补充
    }
  }
  
  return merged;
}

/**
 * 准备 Secrets 运行时快照
 * 
 * **核心流程**:
 * ```text
 * 1. 合并环境变量 → mergeSecretsRuntimeEnv()
 * 2. 克隆原始配置（保留副本）
 * 3. 迁移遗留配置（如有需要）
 * 4. 创建解析上下文 → createResolverContext()
 * 5. 收集配置中的 SecretRef 赋值 → collectConfigAssignments()
 * 6. 收集所有 Agent 目录的 Auth Stores → collectAuthStoreAssignments()
 * 7. 批量解析 SecretRef 引用 → resolveSecretRefValues()
 * 8. 应用解析结果 → applyResolvedAssignments()
 * 9. 构建并返回快照
 * ```
 * 
 * **参数说明**:
 * - `config`: OpenClaw 配置对象
 * - `env`: 自定义环境变量（可选，默认 process.env）
 * - `agentDirs`: 显式指定的 Agent 目录列表（可选）
 * - `loadAuthStore`: Auth Store 加载函数（可选，有默认实现）
 * 
 * **返回值**:
 * - `PreparedSecretsRuntimeSnapshot`: 包含完整解析后的配置、Auth Stores、警告等
 * 
 * @param params - 参数对象
 * @returns Promise<PreparedSecretsRuntimeSnapshot>
 * 
 * @example
 * ```typescript
 * // 场景 1: 基本用法
 * const snapshot1 = await prepareSecretsRuntimeSnapshot({
 *   config: loadedConfig
 * });
 * console.log(snapshot1.config.secrets);  // 已解析的配置
 * console.log(snapshot1.authStores);      // Auth Store 列表
 * 
 * // 场景 2: 自定义环境
 * const snapshot2 = await prepareSecretsRuntimeSnapshot({
 *   config: loadedConfig,
 *   env: {
 *     ...process.env,
 *     OPENCLAW_HOME: '/custom/path',
 *     CUSTOM_API_KEY: 'xxx'
 *   }
 * });
 * 
 * // 场景 3: 显式指定 Agent 目录
 * const snapshot3 = await prepareSecretsRuntimeSnapshot({
 *   config: loadedConfig,
 *   agentDirs: [
 *     '~/.openclaw/agents/default',
 *     '~/projects/my-agent'
 *   ]
 * });
 * 
 * // 场景 4: 自定义 Auth Store 加载器（测试用）
 * const mockLoadAuthStore = (agentDir?: string) => ({
 *   profiles: [],
 *   lastGoodProfile: null
 * });
 * const snapshot4 = await prepareSecretsRuntimeSnapshot({
 *   config: loadedConfig,
 *   loadAuthStore: mockLoadAuthStore
 * });
 * ```
 */
export async function prepareSecretsRuntimeSnapshot(params: {
  /** OpenClaw 配置对象 */
  config: OpenClawConfig;
  /** 自定义环境变量（可选） */
  env?: NodeJS.ProcessEnv;
  /** 显式指定的 Agent 目录列表（可选） */
  agentDirs?: string[];
  /** Auth Store 加载函数（可选） */
  loadAuthStore?: (agentDir?: string) => AuthProfileStore;
}): Promise<PreparedSecretsRuntimeSnapshot> {
  // 步骤 1: 合并环境变量
  const runtimeEnv = mergeSecretsRuntimeEnv(params.env);
  
  // 步骤 2: 克隆原始配置（保留未修改的副本）
  const sourceConfig = structuredClone(params.config);
  
  // 步骤 3: 迁移遗留配置并克隆
  const resolvedConfig = structuredClone(
    migrateLegacyConfig(params.config).config ?? params.config,
  );
  
  // 步骤 4: 创建解析上下文
  const context = createResolverContext({
    sourceConfig,
    env: runtimeEnv,
  });
  
  // 步骤 5: 收集配置中的 SecretRef 赋值
  collectConfigAssignments({
    config: resolvedConfig,
    context,
  });
  
  // 步骤 6: 确定 Auth Store 加载器（使用默认或自定义）
  const loadAuthStore = params.loadAuthStore ?? loadAuthProfileStoreForSecretsRuntime;
  
  // 步骤 7: 收集候选 Agent 目录
  const candidateDirs = params.agentDirs?.length
    ? [...new Set(params.agentDirs.map((entry) => resolveUserPath(entry, runtimeEnv)))]
    : collectCandidateAgentDirs(resolvedConfig, runtimeEnv);
  
  // 步骤 8: 遍历所有 Agent 目录，加载 Auth Stores 并收集赋值
  const authStores: Array<{ agentDir: string; store: AuthProfileStore }> = [];
  for (const agentDir of candidateDirs) {
    const store = structuredClone(loadAuthStore(agentDir));
    collectAuthStoreAssignments({
      store,
      context,
      agentDir,
    });
    authStores.push({ agentDir, store });
  }
  
  // 步骤 9: 批量解析所有 SecretRef 引用
  if (context.assignments.length > 0) {
    const refs = context.assignments.map((assignment) => assignment.ref);
    const resolved = await resolveSecretRefValues(refs, {
      config: sourceConfig,
      env: context.env,
      cache: context.cache,
    });
    
    // 步骤 10: 应用解析结果到配置和 Auth Stores
    applyResolvedAssignments({
      assignments: context.assignments,
      resolved,
    });
  }
  
  // 步骤 11: 构建最终快照对象
  const snapshot = {
    sourceConfig,
    config: resolvedConfig,
    authStores,
    warnings: context.warnings,
    webTools: resolveRuntimeWebTools(sourceConfig, runtimeEnv),
  };
  
  return snapshot;
}

/**
 * 激活 Secrets 运行时快照
 * 
 * **核心流程**:
 * ```text
 * 1. 克隆快照对象
 * 2. 确定刷新上下文
 * 3. 设置配置快照
 * 4. 替换 Auth Profile Store 快照
 * 5. 更新全局状态
 * 6. 设置配置快照刷新处理器
 * ```
 * 
 * **参数说明**:
 * - `snapshot`: 要激活的 Secrets 运行时快照
 * - `refreshContext`: 刷新上下文（可选，默认使用当前环境）
 * 
 * **用途**:
 * - 初始化 Secrets 运行时
 * - 热重载时更新状态
 * 
 * @param snapshot - Secrets 运行时快照
 * @param refreshContext - 刷新上下文（可选）
 * 
 * @example
 * ```typescript
 * // 场景 1: 基本用法
 * const snapshot = await prepareSecretsRuntimeSnapshot({
 *   config: loadedConfig
 * });
 * activateSecretsRuntimeSnapshot(snapshot);
 * 
 * // 场景 2: 自定义刷新上下文
 * const customContext = {
 *   env: {
 *     ...process.env,
 *     OPENCLAW_HOME: '/custom/path'
 *   },
 *   explicitAgentDirs: [
 *     '~/.openclaw/agents/default',
 *     '~/projects/my-agent'
 *   ],
 *   loadAuthStore: mockLoadAuthStore
 * };
 * activateSecretsRuntimeSnapshot(snapshot, customContext);
 * ```
 */
export function activateSecretsRuntimeSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): void {
  const next = cloneSnapshot(snapshot);
  const refreshContext =
    preparedSnapshotRefreshContext.get(snapshot) ??
    activeRefreshContext ??
    ({
      env: { ...process.env } as Record<string, string | undefined>,
      explicitAgentDirs: null,
      loadAuthStore: loadAuthProfileStoreForSecretsRuntime,
    } satisfies SecretsRuntimeRefreshContext);
  setRuntimeConfigSnapshot(next.config, next.sourceConfig);
  replaceRuntimeAuthProfileStoreSnapshots(next.authStores);
  activeSnapshot = next;
  activeRefreshContext = cloneRefreshContext(refreshContext);
  setRuntimeConfigSnapshotRefreshHandler({
    refresh: async ({ sourceConfig }) => {
      if (!activeSnapshot || !activeRefreshContext) {
        return false;
      }
      const refreshed = await prepareSecretsRuntimeSnapshot({
        config: sourceConfig,
        env: activeRefreshContext.env,
        agentDirs: resolveRefreshAgentDirs(sourceConfig, activeRefreshContext),
        loadAuthStore: activeRefreshContext.loadAuthStore,
      });
      activateSecretsRuntimeSnapshot(refreshed);
      return true;
    },
  });
}

/**
 * 获取当前激活的 Secrets 运行时快照
 * 
 * **返回值**:
 * - `PreparedSecretsRuntimeSnapshot`: 当前激活的快照对象
 * - `null`: 如果没有激活的快照
 * 
 * **用途**:
 * - 读取当前运行时状态
 * - 调试和测试
 * 
 * @returns 当前激活的 Secrets 运行时快照或 null
 * 
 * @example
 * ```typescript
 * const snapshot = getActiveSecretsRuntimeSnapshot();
 * if (snapshot) {
 *   console.log(snapshot.config.secrets);
 * }
 * ```
 */
export function getActiveSecretsRuntimeSnapshot(): PreparedSecretsRuntimeSnapshot | null {
  if (!activeSnapshot) {
    return null;
  }
  const snapshot = cloneSnapshot(activeSnapshot);
  if (activeRefreshContext) {
    preparedSnapshotRefreshContext.set(snapshot, cloneRefreshContext(activeRefreshContext));
  }
  return snapshot;
}

/**
 * 获取当前激活的 Web Tools 元数据
 * 
 * **返回值**:
 * - `RuntimeWebToolsMetadata`: 当前激活的 Web Tools 元数据
 * - `null`: 如果没有激活的快照
 * 
 * **用途**:
 * - 读取当前 Web Tools 的认证信息
 * - 调试和测试
 * 
 * @returns 当前激活的 Web Tools 元数据或 null
 * 
 * @example
 * ```typescript
 * const webTools = getActiveRuntimeWebToolsMetadata();
 * if (webTools) {
 *   console.log(webTools['openai'].apiKey);
 * }
 * ```
 */
export function getActiveRuntimeWebToolsMetadata(): RuntimeWebToolsMetadata | null {
  if (!activeSnapshot) {
    return null;
  }
  return structuredClone(activeSnapshot.webTools);
}

/**
 * 解析命令所需的密钥
 * 
 * **核心流程**:
 * ```text
 * 1. 检查是否有激活的快照
 * 2. 收集命令所需的 SecretRef 赋值
 * 3. 返回解析结果
 * ```
 * 
 * **参数说明**:
 * - `commandName`: 命令名称
 * - `targetIds`: 目标 ID 集合
 * 
 * **返回值**:
 * - `assignments`: 解析后的 SecretRef 赋值数组
 * - `diagnostics`: 诊断信息数组
 * - `inactiveRefPaths`: 未激活的 SecretRef 路径数组
 * 
 * **用途**:
 * - 在命令执行前解析所需的密钥
 * - 支持动态密钥解析
 * 
 * @param params - 参数对象
 * @returns 解析结果对象
 * 
 * @example
 * ```typescript
 * const secrets = resolveCommandSecretsFromActiveRuntimeSnapshot({
 *   commandName: 'browser',
 *   targetIds: new Set(['default'])
 * });
 * console.log(secrets.assignments);
 * ```
 */
export function resolveCommandSecretsFromActiveRuntimeSnapshot(params: {
  commandName: string;
  targetIds: ReadonlySet<string>;
}): { assignments: CommandSecretAssignment[]; diagnostics: string[]; inactiveRefPaths: string[] } {
  if (!activeSnapshot) {
    throw new Error("Secrets runtime snapshot is not active.");
  }
  if (params.targetIds.size === 0) {
    return { assignments: [], diagnostics: [], inactiveRefPaths: [] };
  }
  const inactiveRefPaths = [
    ...new Set(
      activeSnapshot.warnings
        .filter((warning) => warning.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE")
        .map((warning) => warning.path),
    ),
  ];
  const resolved = collectCommandSecretAssignmentsFromSnapshot({
    sourceConfig: activeSnapshot.sourceConfig,
    resolvedConfig: activeSnapshot.config,
    commandName: params.commandName,
    targetIds: params.targetIds,
    inactiveRefPaths: new Set(inactiveRefPaths),
  });
  return {
    assignments: resolved.assignments,
    diagnostics: resolved.diagnostics,
    inactiveRefPaths,
  };
}

/**
 * 清空 Secrets 运行时快照
 * 
 * **用途**:
 * - 测试环境重置
 * - 热重载前的清理
 * - 错误恢复
 * 
 * @example
 * ```typescript
 * clearSecretsRuntimeSnapshot();
 * ```
 */
export function clearSecretsRuntimeSnapshot(): void {
  clearActiveSecretsRuntimeState();
}
