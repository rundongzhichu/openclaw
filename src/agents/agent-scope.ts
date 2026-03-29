/**
 * @fileoverview Agent 工作空间与作用域管理
 * 
 * 本文件实现了 OpenClaw 系统中 Agent 工作空间（Workspace）和作用域（Scope）的核心管理逻辑。
 * 
 * **核心职责**:
 * - Agent ID 解析和标准化
 * - Agent 配置条目管理（list, ids, default）
 * - 会话级别的 Agent 路由
 * - 工作空间目录解析
 * - Agent 模型回退值解析
 * - Skill 过滤器标准化
 * 
 * **关键概念**:
 * - **Agent**: OpenClaw 中的 AI 代理实例，每个 Agent 有独立的工作空间和配置
 * - **Workspace**: Agent 的工作目录，包含配置文件、技能、缓存等
 * - **Session Key**: 会话标识符，格式如 `{channel}:{targetId}[:{threadId}]`
 * - **Default Agent**: 默认 Agent，当未指定时使用
 * 
 * **Agent 配置结构**:
 * ```typescript
 * interface AgentEntry {
 *   id: string;              // Agent 唯一标识
 *   name?: string;           // 显示名称
 *   workspace?: string;      // 工作空间路径
 *   agentDir?: string;       // Agent 目录（用于扩展）
 *   model?: ModelConfig;     // 模型配置
 *   skills?: SkillsConfig;   // 技能配置
 *   memorySearch?: boolean;  // 是否启用记忆搜索
 *   humanDelay?: number;     // 人类延迟（毫秒）
 *   heartbeat?: HeartbeatConfig;
 *   identity?: IdentityConfig;
 *   groupChat?: GroupChatConfig;
 *   subagents?: SubagentsConfig;
 *   sandbox?: SandboxConfig;
 *   tools?: ToolsConfig;
 * }
 * ```
 * 
 * **使用示例**:
 * ```typescript
 * // 列出所有 Agent
 * const agents = listAgentEntries(config);
 * const agentIds = listAgentIds(config);
 * 
 * // 解析默认 Agent
 * const defaultId = resolveDefaultAgentId(config);
 * 
 * // 解析会话的 Agent
 * const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
 *   sessionKey: 'whatsapp:+8613800000000',
 *   config
 * });
 * 
 * // 解析 Agent 工作空间目录
 * const workspaceDir = resolveAgentWorkspaceDir({
 *   agentId: 'default',
 *   config
 * });
 * ```
 * 
 * @module agents/agent-scope
 */

import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { normalizeSkillFilter } from "./skills/filter.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

let log: ReturnType<typeof createSubsystemLogger> | null = null;

function getLog(): ReturnType<typeof createSubsystemLogger> {
  log ??= createSubsystemLogger("agent-scope");
  return log;
}

/** Strip null bytes from paths to prevent ENOTDIR errors. */
function stripNullBytes(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\0/g, "");
}

export { resolveAgentIdFromSessionKey };

/** Agent 配置条目类型（从 OpenClawConfig 中提取） */
type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

/**
 * 解析后的 Agent 配置类型
 * 
 * 这是 AgentEntry 的标准化版本，所有字段都有明确的类型定义。
 */
type ResolvedAgentConfig = {
  /** Agent 显示名称 */
  name?: string;
  /** 工作空间路径（支持环境变量和 ~） */
  workspace?: string;
  /** Agent 目录（用于扩展和插件） */
  agentDir?: string;
  /** 模型配置（provider、model ID、参数等） */
  model?: AgentEntry["model"];
  /** 默认思考模式配置 */
  thinkingDefault?: AgentEntry["thinkingDefault"];
  /** 默认推理模式配置 */
  reasoningDefault?: AgentEntry["reasoningDefault"];
  /** 默认快速模式配置 */
  fastModeDefault?: AgentEntry["fastModeDefault"];
  /** 技能配置（允许列表、工作区技能等） */
  skills?: AgentEntry["skills"];
  /** 记忆搜索配置 */
  memorySearch?: AgentEntry["memorySearch"];
  /** 人类延迟（模拟人类打字延迟，毫秒） */
  humanDelay?: AgentEntry["humanDelay"];
  /** 心跳配置（定期健康检查） */
  heartbeat?: AgentEntry["heartbeat"];
  /** 身份配置（头像、昵称等） */
  identity?: AgentEntry["identity"];
  /** 群聊配置（群组策略、@提及规则等） */
  groupChat?: AgentEntry["groupChat"];
  /** 子代理配置（并发限制、深度限制等） */
  subagents?: AgentEntry["subagents"];
  /** 沙箱配置（Docker、权限隔离等） */
  sandbox?: AgentEntry["sandbox"];
  /** 工具配置（允许的工具集、策略等） */
  tools?: AgentEntry["tools"];
};

/** 是否已警告过多个默认 Agent */
let defaultAgentWarned = false;

/**
 * 列出所有 Agent 配置条目
 * 
 * 从完整配置中提取 agents.list 数组，并进行类型过滤。
 * 返回有效的 Agent 条目（排除 null/undefined/非对象）。
 * 
 * @param cfg - OpenClaw 完整配置对象
 * @returns Agent 条目数组，如果未配置则返回空数组
 * 
 * @example
 * ```typescript
 * const config: OpenClawConfig = {
 *   agents: {
 *     list: [
 *       { id: 'default', model: { provider: 'openai', model: 'gpt-4' } },
 *       { id: 'coder', model: { provider: 'anthropic', model: 'claude-sonnet-4' } }
 *     ]
 *   }
 * };
 * 
 * const agents = listAgentEntries(config);
 * // → [{ id: 'default', ... }, { id: 'coder', ... }]
 * ```
 */
export function listAgentEntries(cfg: OpenClawConfig): AgentEntry[] {
  const list = cfg.agents?.list;
  if (!Array.isArray(list)) {
    return [];
  }
  // 类型过滤：只保留有效的对象条目
  return list.filter((entry): entry is AgentEntry => Boolean(entry && typeof entry === "object"));
}

/**
 * 列出所有 Agent ID（去重后）
 * 
 * 提取所有配置的 Agent ID，进行标准化和去重处理。
 * 如果没有配置任何 Agent，返回默认的 ["default"]。
 * 
 * **处理流程**:
 * 1. 调用 listAgentEntries 获取所有条目
 * 2. 如果没有条目，返回 [DEFAULT_AGENT_ID]
 * 3. 遍历所有条目，标准化 ID 并去重
 * 4. 返回去重后的 ID 列表
 * 
 * @param cfg - OpenClaw 完整配置对象
 * @returns Agent ID 数组（已去重和标准化）
 * 
 * @example
 * ```typescript
 * const config: OpenClawConfig = {
 *   agents: {
 *     list: [
 *       { id: 'default' },
 *       { id: 'Coder' },  // 会被标准化为 'coder'
 *       { id: 'DEFAULT' } // 会被标准化为 'default'（去重）
 *     ]
 *   }
 * };
 * 
 * const ids = listAgentIds(config);
 * // → ['default', 'coder']
 * ```
 */
export function listAgentIds(cfg: OpenClawConfig): string[] {
  const agents = listAgentEntries(cfg);
  if (agents.length === 0) {
    return [DEFAULT_AGENT_ID];
  }
  
  const seen = new Set<string>();
  const ids: string[] = [];
  
  for (const entry of agents) {
    const id = normalizeAgentId(entry?.id);
    if (seen.has(id)) {
      continue;  // 跳过重复的 ID
    }
    seen.add(id);
    ids.push(id);
  }
  
  return ids.length > 0 ? ids : [DEFAULT_AGENT_ID];
}

/**
 * 解析默认 Agent ID
 * 
 * **优先级规则**:
 * 1. 配置中明确标记 `default: true` 的 Agent
 * 2. 配置列表中的第一个 Agent
 * 3. 系统内置默认值 "default"
 * 
 * **边界情况处理**:
 * - 多个 Agent 标记为 default：选择第一个，并输出警告日志
 * - 没有配置 Agent：返回 DEFAULT_AGENT_ID
 * - ID 为空或无效：回退到 DEFAULT_AGENT_ID
 * 
 * @param cfg - OpenClaw 完整配置对象
 * @returns 默认 Agent ID（已标准化）
 * 
 * @example
 * ```typescript
 * // 情况 1: 有明确标记 default 的 Agent
 * const config1 = {
 *   agents: {
 *     list: [
 *       { id: 'assistant' },
 *       { id: 'main', default: true },  // ← 这个会被选中
 *       { id: 'backup', default: true } // 会被忽略
 *     ]
 *   }
 * };
 * resolveDefaultAgentId(config1);  // → 'main'
 * 
 * // 情况 2: 没有配置 Agent
 * const config2 = {};
 * resolveDefaultAgentId(config2);  // → 'default'
 * ```
 */
export function resolveDefaultAgentId(cfg: OpenClawConfig): string {
  const agents = listAgentEntries(cfg);
  if (agents.length === 0) {
    return DEFAULT_AGENT_ID;
  }
  
  // 筛选标记为 default 的 Agent
  const defaults = agents.filter((agent) => agent?.default);
  
  // 多个 default 时的警告
  if (defaults.length > 1 && !defaultAgentWarned) {
    defaultAgentWarned = true;
    getLog().warn("Multiple agents marked default=true; using the first entry as default.");
  }
  
  // 选择第一个 default 或第一个 Agent
  const chosen = (defaults[0] ?? agents[0])?.id?.trim();
  return normalizeAgentId(chosen || DEFAULT_AGENT_ID);
}

/**
 * 解析会话的 Agent ID
 * 
 * **决策优先级**:
 * 1. 显式指定的 agentId 参数（最高优先级）
 * 2. Session Key 中包含的 agentId（如 `agent:coder:whatsapp:...`）
 * 3. 默认 Agent ID（兜底）
 * 
 * **返回值说明**:
 * - `defaultAgentId`: 系统默认的 Agent ID
 * - `sessionAgentId`: 当前会话实际使用的 Agent ID
 * 
 * @param params - 参数对象
 * @param params.sessionKey - 会话标识符（可选）
 * @param params.config - OpenClaw 配置对象（可选）
 * @param params.agentId - 显式指定的 Agent ID（可选）
 * @returns 包含 defaultAgentId 和 sessionAgentId 的对象
 * 
 * @example
 * ```typescript
 * // 情况 1: 显式指定 Agent
 * resolveSessionAgentIds({
 *   agentId: 'coder',
 *   sessionKey: 'whatsapp:+8613800000000'
 * });
 * // → { defaultAgentId: 'default', sessionAgentId: 'coder' }
 * 
 * // 情况 2: Session Key 中包含 Agent
 * resolveSessionAgentIds({
 *   sessionKey: 'agent:coder:whatsapp:+8613800000000'
 * });
 * // → { defaultAgentId: 'default', sessionAgentId: 'coder' }
 * 
 * // 情况 3: 完全未指定
 * resolveSessionAgentIds({});
 * // → { defaultAgentId: 'default', sessionAgentId: 'default' }
 * ```
 */
export function resolveSessionAgentIds(params: {
  sessionKey?: string;
  config?: OpenClawConfig;
  agentId?: string;
}): {
  defaultAgentId: string;
  sessionAgentId: string;
} {
  // 解析默认 Agent
  const defaultAgentId = resolveDefaultAgentId(params.config ?? {});
  
  // 处理显式指定的 agentId
  const explicitAgentIdRaw =
    typeof params.agentId === "string" ? params.agentId.trim().toLowerCase() : "";
  const explicitAgentId = explicitAgentIdRaw ? normalizeAgentId(explicitAgentIdRaw) : null;
  
  // 解析 Session Key
  const sessionKey = params.sessionKey?.trim();
  const normalizedSessionKey = sessionKey ? sessionKey.toLowerCase() : undefined;
  const parsed = normalizedSessionKey ? parseAgentSessionKey(normalizedSessionKey) : null;
  
  // 确定最终使用的 Agent ID
  const sessionAgentId =
    explicitAgentId ??  // 优先使用显式指定
    (parsed?.agentId ? normalizeAgentId(parsed.agentId) : defaultAgentId);  // 否则使用默认
  
  return { defaultAgentId, sessionAgentId };
}

/**
 * 解析会话的 Agent ID（简化版本）
 * 
 * 只返回 sessionAgentId，适用于只需要单个值的场景。
 * 
 * @param params - 参数对象（同 resolveSessionAgentIds）
 * @returns 会话使用的 Agent ID
 * 
 * @see {@link resolveSessionAgentIds} - 完整版本，返回两个 ID
 */
export function resolveSessionAgentId(params: {
  sessionKey?: string;
  config?: OpenClawConfig;
}): string {
  return resolveSessionAgentIds(params).sessionAgentId;
}

/**
 * 查找特定 Agent 的配置条目
 * 
 * 内部辅助函数，不直接导出。
 * 
 * @param cfg - OpenClaw 配置对象
 * @param agentId - 要查找的 Agent ID
 * @returns 匹配的 Agent 条目，未找到返回 undefined
 */
function resolveAgentEntry(cfg: OpenClawConfig, agentId: string): AgentEntry | undefined {
  const id = normalizeAgentId(agentId);
  return listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === id);
}

/**
 * 解析 Agent 配置（标准化版本）
 * 
 * 将原始 AgentEntry 转换为标准化的 ResolvedAgentConfig。
 * 确保所有字段都有明确的类型定义和默认值处理。
 * 
 * **处理流程**:
 * 1. 标准化 Agent ID
 * 2. 查找对应的 AgentEntry
 * 3. 提取并验证每个字段
 * 4. 返回标准化配置
 * 
 * @param cfg - OpenClaw 完整配置对象
 * @param agentId - 要解析的 Agent ID
 * @returns 标准化 Agent 配置，未找到返回 undefined
 * 
 * @example
 * ```typescript
 * const config: OpenClawConfig = {
 *   agents: {
 *     list: [{
 *       id: 'coder',
 *       name: '代码助手',
 *       workspace: '~/agents/coder',
 *       model: { provider: 'anthropic', model: 'claude-sonnet-4' },
 *       skills: { allowed: ['bash', 'read', 'edit'] }
 *     }]
 *   }
 * };
 * 
 * const agentConfig = resolveAgentConfig(config, 'coder');
 * // → {
 * //      name: '代码助手',
 * //      workspace: '~/agents/coder',
 * //      model: { provider: 'anthropic', model: 'claude-sonnet-4' },
 * //      skills: { allowed: ['bash', 'read', 'edit'] }
 * //    }
 * ```
 */
export function resolveAgentConfig(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedAgentConfig | undefined {
  const id = normalizeAgentId(agentId);
  const entry = resolveAgentEntry(cfg, id);
  if (!entry) {
    return undefined;
  }
  
  // 逐字段提取和验证
  return {
    name: typeof entry.name === "string" ? entry.name : undefined,
    workspace: typeof entry.workspace === "string" ? entry.workspace : undefined,
    agentDir: typeof entry.agentDir === "string" ? entry.agentDir : undefined,
    model:
      typeof entry.model === "string" || (entry.model && typeof entry.model === "object")
        ? entry.model
        : undefined,
    thinkingDefault: entry.thinkingDefault,
    reasoningDefault: entry.reasoningDefault,
    fastModeDefault: entry.fastModeDefault,
    skills: Array.isArray(entry.skills) ? entry.skills : undefined,
    memorySearch: entry.memorySearch,
    humanDelay: entry.humanDelay,
    heartbeat: entry.heartbeat,
    identity: entry.identity,
    groupChat: entry.groupChat,
    subagents: typeof entry.subagents === "object" && entry.subagents ? entry.subagents : undefined,
    sandbox: entry.sandbox,
    tools: entry.tools,
  };
}

/**
 * 解析 Agent 的技能过滤器
 * 
 * **处理流程**:
 * 1. 调用 resolveAgentConfig 获取标准化配置
 * 2. 提取 skills 字段
 * 3. 调用 normalizeSkillFilter 进行标准化
 * 4. 返回标准化后的技能过滤器
 * 
 * @param cfg - OpenClaw 完整配置对象
 * @param agentId - 要解析的 Agent ID
 * @returns 标准化后的技能过滤器，未找到返回 undefined
 * 
 * @example
 * ```typescript
 * const config: OpenClawConfig = {
 *   agents: {
 *     list: [{
 *       id: 'coder',
 *       skills: { allowed: ['bash', 'read', 'edit'] }
 *     }]
 *   }
 * };
 * 
 * const skills = resolveAgentSkillsFilter(config, 'coder');
 * // → ['bash', 'read', 'edit']
 * ```
 */
export function resolveAgentSkillsFilter(
  cfg: OpenClawConfig,
  agentId: string,
): string[] | undefined {
  return normalizeSkillFilter(resolveAgentConfig(cfg, agentId)?.skills);
}

/**
 * 解析模型的主模型 ID
 * 
 * **处理流程**:
 * 1. 如果输入是字符串，去除前后空格并返回
 * 2. 如果输入是对象，提取 primary 字段并去除前后空格
 * 3. 其他情况返回 undefined
 * 
 * @param raw - 输入值（可以是字符串或对象）
 * @returns 主模型 ID，未找到返回 undefined
 * 
 * @example
 * ```typescript
 * resolveModelPrimary('gpt-4');  // → 'gpt-4'
 * resolveModelPrimary({ primary: 'gpt-4' });  // → 'gpt-4'
 * resolveModelPrimary({});  // → undefined
 * ```
 */
function resolveModelPrimary(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed || undefined;
  }
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const primary = (raw as { primary?: unknown }).primary;
  if (typeof primary !== "string") {
    return undefined;
  }
  const trimmed = primary.trim();
  return trimmed || undefined;
}

/**
 * 解析 Agent 的显式主模型 ID
 * 
 * **处理流程**:
 * 1. 调用 resolveAgentConfig 获取标准化配置
 * 2. 提取 model 字段
 * 3. 调用 resolveModelPrimary 进行标准化
 * 4. 返回标准化后的主模型 ID
 * 
 * @param cfg - OpenClaw 完整配置对象
 * @param agentId - 要解析的 Agent ID
 * @returns 显式主模型 ID，未找到返回 undefined
 * 
 * @example
 * ```typescript
 * const config: OpenClawConfig = {
 *   agents: {
 *     list: [{
 *       id: 'coder',
 *       model: { provider: 'anthropic', model: 'claude-sonnet-4' }
 *     }]
 *   }
 * };
 * 
 * const model = resolveAgentExplicitModelPrimary(config, 'coder');
 * // → 'claude-sonnet-4'
 * ```
 */
export function resolveAgentExplicitModelPrimary(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  const raw = resolveAgentConfig(cfg, agentId)?.model;
  return resolveModelPrimary(raw);
}

/**
 * 解析 Agent 的有效主模型 ID
 * 
 * **处理流程**:
 * 1. 调用 resolveAgentExplicitModelPrimary 获取显式主模型 ID
 * 2. 如果未找到，调用 resolveModelPrimary 获取默认主模型 ID
 * 3. 返回最终的主模型 ID
 * 
 * @param cfg - OpenClaw 完整配置对象
 * @param agentId - 要解析的 Agent ID
 * @returns 有效主模型 ID，未找到返回 undefined
 * 
 * @example
 * ```typescript
 * const config: OpenClawConfig = {
 *   agents: {
 *     list: [{
 *       id: 'coder',
 *       model: { provider: 'anthropic', model: 'claude-sonnet-4' }
 *     }]
 *   }
 * };
 * 
 * const model = resolveAgentEffectiveModelPrimary(config, 'coder');
 * // → 'claude-sonnet-4'
 * ```
 */
export function resolveAgentEffectiveModelPrimary(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  return (
    resolveAgentExplicitModelPrimary(cfg, agentId) ??
    resolveModelPrimary(cfg.agents?.defaults?.model)
  );
}

// Backward-compatible alias. Prefer explicit/effective helpers at new call sites.
export function resolveAgentModelPrimary(cfg: OpenClawConfig, agentId: string): string | undefined {
  return resolveAgentExplicitModelPrimary(cfg, agentId);
}

/**
 * 解析 Agent 的模型回退列表覆盖
 * 
 * **处理流程**:
 * 1. 调用 resolveAgentConfig 获取标准化配置
 * 2. 提取 model 字段
 * 3. 如果 model 是字符串或未定义，返回 undefined
 * 4. 如果 model 对象中包含 fallbacks 字段，返回该字段
 * 5. 其他情况返回 undefined
 * 
 * @param cfg - OpenClaw 完整配置对象
 * @param agentId - 要解析的 Agent ID
 * @returns 模型回退列表覆盖，未找到返回 undefined
 * 
 * @example
 * ```typescript
 * const config: OpenClawConfig = {
 *   agents: {
 *     list: [{
 *       id: 'coder',
 *       model: { provider: 'anthropic', model: 'claude-sonnet-4', fallbacks: ['gpt-4'] }
 *     }]
 *   }
 * };
 * 
 * const fallbacks = resolveAgentModelFallbacksOverride(config, 'coder');
 * // → ['gpt-4']
 * ```
 */
export function resolveAgentModelFallbacksOverride(
  cfg: OpenClawConfig,
  agentId: string,
): string[] | undefined {
  const raw = resolveAgentConfig(cfg, agentId)?.model;
  if (!raw || typeof raw === "string") {
    return undefined;
  }
  // Important: treat an explicitly provided empty array as an override to disable global fallbacks.
  if (!Object.hasOwn(raw, "fallbacks")) {
    return undefined;
  }
  return Array.isArray(raw.fallbacks) ? raw.fallbacks : undefined;
}

/**
 * 解析回退 Agent ID
 * 
 * **处理流程**:
 * 1. 如果显式指定了 agentId，去除前后空格并标准化
 * 2. 如果未指定 agentId，调用 resolveAgentIdFromSessionKey 从 Session Key 中解析
 * 3. 返回最终的 Agent ID
 * 
 * @param params - 参数对象
 * @param params.agentId - 显式指定的 Agent ID（可选）
 * @param params.sessionKey - 会话标识符（可选）
 * @returns 回退 Agent ID（已标准化）
 * 
 * @example
 * ```typescript
 * resolveFallbackAgentId({
 *   agentId: 'coder',
 *   sessionKey: 'whatsapp:+8613800000000'
 * });
 * // → 'coder'
 * 
 * resolveFallbackAgentId({
 *   sessionKey: 'agent:coder:whatsapp:+8613800000000'
 * });
 * // → 'coder'
 * ```
 */
export function resolveFallbackAgentId(params: {
  agentId?: string | null;
  sessionKey?: string | null;
}): string {
  const explicitAgentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
  if (explicitAgentId) {
    return normalizeAgentId(explicitAgentId);
  }
  return resolveAgentIdFromSessionKey(params.sessionKey);
}

/**
 * 解析运行时的模型回退列表覆盖
 * 
 * **处理流程**:
 * 1. 如果未提供 cfg，返回 undefined
 * 2. 调用 resolveFallbackAgentId 获取回退 Agent ID
 * 3. 调用 resolveAgentModelFallbacksOverride 获取模型回退列表覆盖
 * 4. 返回最终的模型回退列表覆盖
 * 
 * @param params - 参数对象
 * @param params.cfg - OpenClaw 完整配置对象（可选）
 * @param params.agentId - 显式指定的 Agent ID（可选）
 * @param params.sessionKey - 会话标识符（可选）
 * @returns 运行时的模型回退列表覆盖，未找到返回 undefined
 * 
 * @example
 * ```typescript
 * const config: OpenClawConfig = {
 *   agents: {
 *     list: [{
 *       id: 'coder',
 *       model: { provider: 'anthropic', model: 'claude-sonnet-4', fallbacks: ['gpt-4'] }
 *     }]
 *   }
 * };
 * 
 * const fallbacks = resolveRunModelFallbacksOverride({
 *   cfg: config,
 *   agentId: 'coder',
 *   sessionKey: 'whatsapp:+8613800000000'
 * });
 * // → ['gpt-4']
 * ```
 */
export function resolveRunModelFallbacksOverride(params: {
  cfg: OpenClawConfig | undefined;
  agentId?: string | null;
  sessionKey?: string | null;
}): string[] | undefined {
  if (!params.cfg) {
    return undefined;
  }
  return resolveAgentModelFallbacksOverride(
    params.cfg,
    resolveFallbackAgentId({ agentId: params.agentId, sessionKey: params.sessionKey }),
  );
}

/**
 * 检查是否配置了模型回退列表
 * 
 * **处理流程**:
 * 1. 调用 resolveRunModelFallbacksOverride 获取运行时的模型回退列表覆盖
 * 2. 如果未找到，调用 resolveAgentModelFallbackValues 获取默认模型回退列表
 * 3. 返回最终的模型回退列表长度是否大于 0
 * 
 * @param params - 参数对象
 * @param params.cfg - OpenClaw 完整配置对象（可选）
 * @param params.agentId - 显式指定的 Agent ID（可选）
 * @param params.sessionKey - 会话标识符（可选）
 * @returns 是否配置了模型回退列表
 * 
 * @example
 * ```typescript
 * const config: OpenClawConfig = {
 *   agents: {
 *     list: [{
 *       id: 'coder',
 *       model: { provider: 'anthropic', model: 'claude-sonnet-4', fallbacks: ['gpt-4'] }
 *     }]
 *   }
 * };
 * 
 * const hasFallbacks = hasConfiguredModelFallbacks({
 *   cfg: config,
 *   agentId: 'coder',
 *   sessionKey: 'whatsapp:+8613800000000'
 * });
 * // → true
 * ```
 */
export function hasConfiguredModelFallbacks(params: {
  cfg: OpenClawConfig | undefined;
  agentId?: string | null;
  sessionKey?: string | null;
}): boolean {
  const fallbacksOverride = resolveRunModelFallbacksOverride(params);
  const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.model);
  return (fallbacksOverride ?? defaultFallbacks).length > 0;
}

/**
 * 解析有效的模型回退列表
 * 
 * **处理流程**:
 * 1. 调用 resolveAgentModelFallbacksOverride 获取 Agent 的模型回退列表覆盖
 * 2. 如果 hasSessionModelOverride 为 false，返回 Agent 的模型回退列表覆盖
 * 3. 如果 hasSessionModelOverride 为 true，调用 resolveAgentModelFallbackValues 获取默认模型回退列表
 * 4. 返回最终的模型回退列表
 * 
 * @param params - 参数对象
 * @param params.cfg - OpenClaw 完整配置对象
 * @param params.agentId - 要解析的 Agent ID
 * @param params.hasSessionModelOverride - 是否有会话级别的模型覆盖
 * @returns 有效的模型回退列表，未找到返回 undefined
 * 
 * @example
 * ```typescript
 * const config: OpenClawConfig = {
 *   agents: {
 *     list: [{
 *       id: 'coder',
 *       model: { provider: 'anthropic', model: 'claude-sonnet-4', fallbacks: ['gpt-4'] }
 *     }]
 *   }
 * };
 * 
 * const fallbacks = resolveEffectiveModelFallbacks({
 *   cfg: config,
 *   agentId: 'coder',
 *   hasSessionModelOverride: false
 * });
 * // → ['gpt-4']
 * ```
 */
export function resolveEffectiveModelFallbacks(params: {
  cfg: OpenClawConfig;
  agentId: string;
  hasSessionModelOverride: boolean;
}): string[] | undefined {
  const agentFallbacksOverride = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
  if (!params.hasSessionModelOverride) {
    return agentFallbacksOverride;
  }
  const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
  return agentFallbacksOverride ?? defaultFallbacks;
}

/**
 * 解析 Agent 的工作空间目录
 * 
 * **处理流程**:
 * 1. 标准化 Agent ID
 * 2. 调用 resolveAgentConfig 获取标准化配置
 * 3. 提取 workspace 字段
 * 4. 如果 workspace 存在，去除前后空格并调用 resolveUserPath 进行路径解析
 * 5. 如果 workspace 不存在，检查是否为默认 Agent
 * 6. 如果是默认 Agent，检查配置中的默认 workspace
 * 7. 如果配置中没有默认 workspace，调用 resolveDefaultAgentWorkspaceDir 获取默认目录
 * 8. 如果不是默认 Agent，调用 resolveStateDir 获取状态目录，并拼接 `workspace-${id}`
 * 9. 返回最终的工作空间目录
 * 
 * @param cfg - OpenClaw 完整配置对象
 * @param agentId - 要解析的 Agent ID
 * @returns Agent 的工作空间目录
 * 
 * @example
 * ```typescript
 * const config: OpenClawConfig = {
 *   agents: {
 *     list: [{
 *       id: 'coder',
 *       workspace: '~/agents/coder'
 *     }]
 *   }
 * };
 * 
 * const workspaceDir = resolveAgentWorkspaceDir(config, 'coder');
 * // → '/Users/username/agents/coder'
 * ```
 */
export function resolveAgentWorkspaceDir(cfg: OpenClawConfig, agentId: string) {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
  if (configured) {
    return stripNullBytes(resolveUserPath(configured));
  }
  const defaultAgentId = resolveDefaultAgentId(cfg);
  if (id === defaultAgentId) {
    const fallback = cfg.agents?.defaults?.workspace?.trim();
    if (fallback) {
      return stripNullBytes(resolveUserPath(fallback));
    }
    return stripNullBytes(resolveDefaultAgentWorkspaceDir(process.env));
  }
  const stateDir = resolveStateDir(process.env);
  return stripNullBytes(path.join(stateDir, `workspace-${id}`));
}

/**
 * 规范化路径用于比较
 * 
 * **处理流程**:
 * 1. 调用 stripNullBytes 去除路径中的 null 字节
 * 2. 调用 resolveUserPath 解析路径中的用户目录
 * 3. 调用 path.resolve 获取绝对路径
 * 4. 尝试调用 fs.realpathSync.native 获取真实路径（处理符号链接）
 * 5. 如果获取失败，保持原始路径
 * 6. 如果平台是 Windows，将路径转换为小写
 * 7. 返回最终的规范化路径
 * 
 * @param input - 输入路径
 * @returns 规范化后的路径
 * 
 * @example
 * ```typescript
 * normalizePathForComparison('~/agents/coder');
 * // → '/Users/username/agents/coder'
 * ```
 */
function normalizePathForComparison(input: string): string {
  const resolved = path.resolve(stripNullBytes(resolveUserPath(input)));
  let normalized = resolved;
  // Prefer realpath when available to normalize aliases/symlinks (for example /tmp -> /private/tmp)
  // and canonical path case without forcing case-folding on case-sensitive macOS volumes.
  try {
    normalized = fs.realpathSync.native(resolved);
  } catch {
    // Keep lexical path for non-existent directories.
  }
  if (process.platform === "win32") {
    return normalized.toLowerCase();
  }
  return normalized;
}

/**
 * 检查候选路径是否在根路径内
 * 
 * **处理流程**:
 * 1. 调用 path.relative 获取相对路径
 * 2. 如果相对路径为空，返回 true
 * 3. 如果相对路径不以 ".." 开头且不是绝对路径，返回 true
 * 4. 其他情况返回 false
 * 
 * @param candidatePath - 候选路径
 * @param rootPath - 根路径
 * @returns 是否在根路径内
 * 
 * @example
 * ```typescript
 * isPathWithinRoot('/Users/username/agents/coder', '/Users/username/agents');
 * // → true
 * 
 * isPathWithinRoot('/Users/username/agents/coder', '/Users/username/other');
 * // → false
 * ```
 */
function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 解析包含指定工作空间路径的 Agent ID 列表
 * 
 * **处理流程**:
 * 1. 调用 normalizePathForComparison 规范化工作空间路径
 * 2. 调用 listAgentIds 获取所有 Agent ID
 * 3. 遍历所有 ID，调用 resolveAgentWorkspaceDir 获取工作空间目录
 * 4. 调用 isPathWithinRoot 检查工作空间目录是否包含指定路径
 * 5. 如果包含，记录 ID、工作空间目录和顺序
 * 6. 按工作空间目录长度降序排序，相同长度按顺序排序
 * 7. 返回最终的 ID 列表
 * 
 * @param cfg - OpenClaw 完整配置对象
 * @param workspacePath - 工作空间路径
 * @returns 包含指定工作空间路径的 Agent ID 列表
 * 
 * @example
 * ```typescript
 * const config: OpenClawConfig = {
 *   agents: {
 *     list: [{
 *       id: 'coder',
 *       workspace: '~/agents/coder'
 *     }]
 *   }
 * };
 * 
 * const ids = resolveAgentIdsByWorkspacePath(config, '/Users/username/agents/coder');
 * // → ['coder']
 * ```
 */
export function resolveAgentIdsByWorkspacePath(
  cfg: OpenClawConfig,
  workspacePath: string,
): string[] {
  const normalizedWorkspacePath = normalizePathForComparison(workspacePath);
  const ids = listAgentIds(cfg);
  const matches: Array<{ id: string; workspaceDir: string; order: number }> = [];

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const workspaceDir = normalizePathForComparison(resolveAgentWorkspaceDir(cfg, id));
    if (!isPathWithinRoot(normalizedWorkspacePath, workspaceDir)) {
      continue;
    }
    matches.push({ id, workspaceDir, order: index });
  }

  matches.sort((left, right) => {
    const workspaceLengthDelta = right.workspaceDir.length - left.workspaceDir.length;
    if (workspaceLengthDelta !== 0) {
      return workspaceLengthDelta;
    }
    return left.order - right.order;
  });

  return matches.map((entry) => entry.id);
}

/**
 * 解析包含指定工作空间路径的 Agent ID
 * 
 * **处理流程**:
 * 1. 调用 resolveAgentIdsByWorkspacePath 获取包含指定路径的 Agent ID 列表
 * 2. 返回列表中的第一个 ID
 * 3. 如果列表为空，返回 undefined
 * 
 * @param cfg - OpenClaw 完整配置对象
 * @param workspacePath - 工作空间路径
 * @returns 包含指定工作空间路径的 Agent ID，未找到返回 undefined
 * 
 * @example
 * ```typescript
 * const config: OpenClawConfig = {
 *   agents: {
 *     list: [{
 *       id: 'coder',
 *       workspace: '~/agents/coder'
 *     }]
 *   }
 * };
 * 
 * const id = resolveAgentIdByWorkspacePath(config, '/Users/username/agents/coder');
 * // → 'coder'
 * ```
 */
export function resolveAgentIdByWorkspacePath(
  cfg: OpenClawConfig,
  workspacePath: string,
): string | undefined {
  return resolveAgentIdsByWorkspacePath(cfg, workspacePath)[0];
}

/**
 * 解析 Agent 的目录
 * 
 * **处理流程**:
 * 1. 标准化 Agent ID
 * 2. 调用 resolveAgentConfig 获取标准化配置
 * 3. 提取 agentDir 字段
 * 4. 如果 agentDir 存在，去除前后空格并调用 resolveUserPath 进行路径解析
 * 5. 如果 agentDir 不存在，调用 resolveStateDir 获取状态目录，并拼接 `agents/${id}/agent`
 * 6. 返回最终的 Agent 目录
 * 
 * @param cfg - OpenClaw 完整配置对象
 * @param agentId - 要解析的 Agent ID
 * @param env - 环境变量对象（可选，默认为 process.env）
 * @returns Agent 的目录
 * 
 * @example
 * ```typescript
 * const config: OpenClawConfig = {
 *   agents: {
 *     list: [{
 *       id: 'coder',
 *       agentDir: '~/agents/coder'
 *     }]
 *   }
 * };
 * 
 * const agentDir = resolveAgentDir(config, 'coder');
 * // → '/Users/username/agents/coder'
 * ```
 */
export function resolveAgentDir(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.agentDir?.trim();
  if (configured) {
    return resolveUserPath(configured, env);
  }
  const root = resolveStateDir(env);
  return path.join(root, "agents", id, "agent");
}
