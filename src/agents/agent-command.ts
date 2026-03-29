/**
 * @fileoverview Agent 命令执行模块
 * 
 * 本文件实现了 `openclaw agent` CLI 命令的核心逻辑，负责：
 * - 解析用户输入的消息和参数
 * - 准备 Agent 执行上下文 (会话、工作空间、超时等)
 * - 调用 Gateway RPC 执行 Agent
 * - 处理流式响应输出
 * - 管理 ACP (Agent Control Plane) 会话
 * - 支持子代理孵化 (spawn subagent)
 * - 处理思考级别 (thinking level) 和详细程度 (verbose)
 * 
 * 主要函数:
 * - {@link agentCommand} - Agent 命令入口函数
 * - {@link prepareAgentCommandExecution} - 准备执行上下文
 * - {@link agentCommandInternal} - 内部执行逻辑
 * 
 * @module agents/agent-command
 */

import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { resolveAcpAgentPolicyError, resolveAcpDispatchPolicyError } from "../acp/policy.js";
import { toAcpRuntimeError } from "../acp/runtime/errors.js";
import { resolveAcpSessionCwd } from "../acp/runtime/session-identifiers.js";
import {
  formatThinkingLevels,
  formatXHighModelHint,
  normalizeThinkLevel,
  normalizeVerboseLevel,
  supportsXHighThinking,
  type VerboseLevel,
} from "../auto-reply/thinking.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveCommandSecretRefsViaGateway } from "../cli/command-secret-gateway.js";
import { getAgentRuntimeCommandSecretTargetIds } from "../cli/command-secret-targets.js";
import { type CliDeps, createDefaultDeps } from "../cli/deps.js";
import {
  loadConfig,
  readConfigFileSnapshotForWrite,
  setRuntimeConfigSnapshot,
} from "../config/config.js";
import { resolveAgentIdFromSessionKey, type SessionEntry } from "../config/sessions.js";
import { resolveSessionTranscriptFile } from "../config/sessions/transcript.js";
import {
  clearAgentRunContext,
  emitAgentEvent,
  registerAgentRunContext,
} from "../infra/agent-events.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { getRemoteSkillEligibility } from "../infra/skills-remote.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { applyVerboseOverride } from "../sessions/level-overrides.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { resolveMessageChannel } from "../utils/message-channel.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveEffectiveModelFallbacks,
  resolveSessionAgentId,
  resolveAgentSkillsFilter,
  resolveAgentWorkspaceDir,
} from "./agent-scope.js";
import { ensureAuthProfileStore } from "./auth-profiles.js";
import { clearSessionAuthProfileOverride } from "./auth-profiles/session-override.js";
import {
  buildAcpResult,
  createAcpVisibleTextAccumulator,
  emitAcpAssistantDelta,
  emitAcpLifecycleEnd,
  emitAcpLifecycleError,
  emitAcpLifecycleStart,
  persistAcpTurnTranscript,
  persistSessionEntry as persistSessionEntryBase,
  prependInternalEventContext,
  runAgentAttempt,
} from "./command/attempt-execution.js";
import { deliverAgentCommandResult } from "./command/delivery.js";
import { resolveAgentRunContext } from "./command/run-context.js";
import { updateSessionStoreAfterAgentRun } from "./command/session-store.js";
import { resolveSession } from "./command/session.js";
import type { AgentCommandIngressOpts, AgentCommandOpts } from "./command/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { loadModelCatalog } from "./model-catalog.js";
import { runWithModelFallback } from "./model-fallback.js";
import {
  buildAllowedModelSet,
  modelKey,
  normalizeModelRef,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolveThinkingDefault,
} from "./model-selection.js";
import { buildWorkspaceSkillSnapshot } from "./skills.js";
import { getSkillsSnapshotVersion } from "./skills/refresh.js";
import { normalizeSpawnedRunMetadata } from "./spawned-context.js";
import { resolveAgentTimeoutMs } from "./timeout.js";
import { ensureAgentWorkspace } from "./workspace.js";

const log = createSubsystemLogger("agents/agent-command");

type PersistSessionEntryParams = {
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath: string;
  entry: SessionEntry;
};

type OverrideFieldClearedByDelete =
  | "providerOverride"
  | "modelOverride"
  | "authProfileOverride"
  | "authProfileOverrideSource"
  | "authProfileOverrideCompactionCount"
  | "fallbackNoticeSelectedModel"
  | "fallbackNoticeActiveModel"
  | "fallbackNoticeReason"
  | "claudeCliSessionId";

const OVERRIDE_FIELDS_CLEARED_BY_DELETE: OverrideFieldClearedByDelete[] = [
  "providerOverride",
  "modelOverride",
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
  "fallbackNoticeSelectedModel",
  "fallbackNoticeActiveModel",
  "fallbackNoticeReason",
  "claudeCliSessionId",
];

const OVERRIDE_VALUE_MAX_LENGTH = 256;

/**
 * 持久化会话条目到磁盘
 * 
 * 将会话状态保存到文件系统，支持会话恢复和跨进程共享。
 * 使用 `persistSessionEntryBase` 底层函数，自动清理被删除的覆盖字段。
 * 
 * **数据一致性**: 通过 `clearedFields` 确保删除某些配置时，
 * 对应的派生字段也被同步清理，防止脏数据残留。
 * 
 * @param params - 持久化参数
 * @param params.sessionStore - 会话存储对象（内存中的映射表）
 * @param params.sessionKey - 会话键（唯一标识符）
 * @param params.storePath - 存储文件路径
 * @param params.entry - 要保存的会话条目
 * 
 * @example
 * // 使用示例
 * await persistSessionEntry({
 *   sessionStore: store,
 *   sessionKey: "agent:main:session123",
 *   storePath: "~/.openclaw/sessions/main.json",
 *   entry: {
 *     createdAt: Date.now(),
 *     lastActivityAt: Date.now(),
 *     messageCount: 42,
 *     // ... 其他字段
 *   }
 * });
 */
async function persistSessionEntry(params: PersistSessionEntryParams): Promise<void> {
  // 调用底层持久化函数，传入预定义的清理字段列表
  await persistSessionEntryBase({
    ...params,
    // 这些字段在删除时会被自动清空，保持数据一致性
    clearedFields: OVERRIDE_FIELDS_CLEARED_BY_DELETE,
  });
}

/**
 * 检查字符串是否包含控制字符
 * 
 * 控制字符（ASCII 0x00-0x1F 和 0x7F-0x9F）在用户输入中通常是不合法的，
 * 可能导致终端显示异常或安全问题。此函数用于输入验证。
 * 
 * **Unicode 处理技巧**: 使用 `codePointAt(0)` 而非 `charCodeAt(0)`，
 * 因为前者支持完整的 Unicode 码点（包括代理对），后者只能处理 BMP 平面。
 * 
 * @param value - 要检查的字符串
 * @returns 如果包含控制字符返回 true，否则返回 false
 * 
 * @example
 * containsControlCharacters("hello")     // false
 * containsControlCharacters("hello\u0000") // true (包含 NULL)
 * containsControlCharacters("test\u001b")  // true (包含 ESC)
 */
function containsControlCharacters(value: string): boolean {
  // 遍历每个字符（支持 Unicode 代理对）
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;  // 跳过无效字符
    }
    
    // 检查是否在控制字符范围内：
    // 0x00-0x1F: C0 控制字符（NULL, SOH, STX, ..., US）
    // 0x7F-0x9F: C1 控制字符（DEL, DCS, XON, XOFF, ...）
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/**
 * 规范化显式覆盖输入
 * 
 * 对用户提供的 provider/model 覆盖参数进行严格验证和规范化：
 * 1. 去除首尾空白
 * 2. 检查非空
 * 3. 检查长度限制（防止过长输入）
 * 4. 检查控制字符（防止注入攻击）
 * 
 * **安全最佳实践**: 所有外部输入都应经过类似的严格验证
 * 
 * @param raw - 原始输入字符串
 * @param kind - 覆盖类型（"provider" 或 "model"）
 * @returns 规范化后的字符串
 * 
 * @throws Error 当输入无效时抛出具体错误信息
 * 
 * @example
 * // 正常情况
 * normalizeExplicitOverrideInput("  gpt-4  ", "model")  
 * // 返回："gpt-4"
 * 
 * // 异常情况
 * normalizeExplicitOverrideInput("", "provider")  
 * // 抛出："Provider override must be non-empty."
 * 
 * normalizeExplicitOverrideInput("a".repeat(300), "model")  
 * // 抛出："Model override exceeds 256 characters."
 */
function normalizeExplicitOverrideInput(raw: string, kind: "provider" | "model"): string {
  // 步骤 1: 去除空白
  const trimmed = raw.trim();
  const label = kind === "provider" ? "Provider" : "Model";
  
  // 步骤 2: 检查非空
  if (!trimmed) {
    throw new Error(`${label} override must be non-empty.`);
  }
  
  // 步骤 3: 检查长度（防御 DoS 攻击）
  if (trimmed.length > OVERRIDE_VALUE_MAX_LENGTH) {
    throw new Error(`${label} override exceeds ${String(OVERRIDE_VALUE_MAX_LENGTH)} characters.`);
  }
  
  // 步骤 4: 检查控制字符（防御注入攻击）
  if (containsControlCharacters(trimmed)) {
    throw new Error(`${label} override contains invalid control characters.`);
  }
  
  // 返回验证通过的干净输入
  return trimmed;
}

/**
 * 准备 Agent 命令执行上下文
 * 
 * 这是 `openclaw agent` 命令的核心预处理函数，负责：
 * 1. 验证输入参数（消息、会话选择器）
 * 2. 加载并解析配置（包括 secret 引用）
 * 3. 规范化派生元数据（spawnedBy, groupId 等）
 * 4. 验证 agent ID 覆盖
 * 5. 解析模型和推理级别配置
 * 6. 处理 verbose 级别
 * 7. 计算超时时间
 * 8. 确定会话键和工作空间
 * 
 * **返回值模式**: 返回一个包含所有必要上下文的对象，
 * 避免后续函数需要传递大量参数。
 * 
 * @param opts - Agent 命令选项
 * @param opts.message - 用户消息
 * @param opts.to - 目标 E.164 号码
 * @param opts.sessionId - 会话 ID
 * @param opts.sessionKey - 完整会话键
 * @param opts.agentId - Agent ID 覆盖
 * @param opts.thinking - 推理级别
 * @param opts.verbose - 详细程度
 * @param opts.spawnedBy - 派生源元数据
 * @param opts.senderIsOwner - 发送者是否为所有者
 * @param runtime - 运行时环境（提供日志等功能）
 * 
 * @returns 准备好的执行上下文，包含：
 * - body: 处理后的消息体
 * - cfg: 解析后的配置对象
 * - sessionKey: 确定的会话键
 * - workspaceDir: 工作空间路径
 * - timeoutMs: 超时毫秒数
 * - 等等...
 * 
 * @throws Error 当参数无效时抛出具体错误
 * 
 * @example
 * // 使用示例
 * const ctx = await prepareAgentCommandExecution({
 *   message: "Hello, analyze this repo",
 *   agentId: "main",
 *   thinking: "high",
 *   senderIsOwner: true,
 * }, defaultRuntime);
 * 
 * // ctx.body - 包含内部事件上下文的消息
 * // ctx.cfg - 完整的运行时配置
 * // ctx.sessionKey - "agent:main:session-xxx"
 * // ctx.workspaceDir - "/Users/xxx/.openclaw/agents/main"
 * // ctx.timeoutMs - 300000 (5 分钟)
 */
async function prepareAgentCommandExecution(
  opts: AgentCommandOpts & { senderIsOwner: boolean },
  runtime: RuntimeEnv,
) {
  // ========== 阶段 1: 基础参数验证 ==========
  
  // 提取并验证消息
  const message = opts.message ?? "";
  if (!message.trim()) {
    throw new Error("Message (--message) is required");
  }
  
  // 前置内部事件上下文到消息体（用于追踪消息来源）
  const body = prependInternalEventContext(message, opts.internalEvents);
  
  // 验证会话选择器（至少提供一个）
  if (!opts.to && !opts.sessionId && !opts.sessionKey && !opts.agentId) {
    throw new Error("Pass --to <E.164>, --session-id, or --agent to choose a session");
  }

  // ========== 阶段 2: 加载配置 ==========
  
  // 首先尝试从磁盘读取最新配置（写操作需要最新快照）
  const loadedRaw = loadConfig();
  const sourceConfig = await (async () => {
    try {
      const { snapshot } = await readConfigFileSnapshotForWrite();
      if (snapshot.valid) {
        return snapshot.resolved;  // 返回已解析的配置文件
      }
    } catch {
      // 当无法获取源快照时，回退到运行时加载的配置
      // 这种降级策略确保命令在非关键情况下仍能继续
    }
    return loadedRaw;
  })();
  
  // 解析 secret 引用（通过网关 RPC 从密钥管理工具获取真实值）
  const { resolvedConfig: cfg, diagnostics } = await resolveCommandSecretRefsViaGateway({
    config: loadedRaw,
    commandName: "agent",  // 用于选择正确的 secret 分配规则
    targetIds: getAgentRuntimeCommandSecretTargetIds(),  // 目标 secret ID 列表
  });
  
  // 设置运行时配置快照（全局状态）
  setRuntimeConfigSnapshot(cfg, sourceConfig);
  
  // 记录 secret 解析诊断信息
  for (const entry of diagnostics) {
    runtime.log(`[secrets] ${entry}`);
  }

  // ========== 阶段 3: 规范化派生元数据 ==========
  
  // 规范化 spawnedBy 相关字段（支持多种来源格式）
  const normalizedSpawned = normalizeSpawnedRunMetadata({
    spawnedBy: opts.spawnedBy,
    groupId: opts.groupId,
    groupChannel: opts.groupChannel,
    groupSpace: opts.groupSpace,
    workspaceDir: opts.workspaceDir,
  });

  // ========== 阶段 4: 验证 Agent ID 覆盖 ==========
  
  // 规范化 agent ID（去除空白、转小写）
  const agentIdOverrideRaw = opts.agentId?.trim();
  const agentIdOverride = agentIdOverrideRaw ? normalizeAgentId(agentIdOverrideRaw) : undefined;
  
  if (agentIdOverride) {
    // 检查 agent ID 是否存在于配置中
    const knownAgents = listAgentIds(cfg);
    if (!knownAgents.includes(agentIdOverride)) {
      throw new Error(
        `Unknown agent id "${agentIdOverrideRaw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`,
      );
    }
  }
  
  // 检查 agent ID 与会话键的一致性（防止误用）
  if (agentIdOverride && opts.sessionKey) {
    const sessionAgentId = resolveAgentIdFromSessionKey(opts.sessionKey);
    if (sessionAgentId !== agentIdOverride) {
      throw new Error(
        `Agent id "${agentIdOverrideRaw}" does not match session key agent "${sessionAgentId}".`,
      );
    }
  }

  // ========== 阶段 5: 解析模型和推理配置 ==========
  
  // 获取默认 agent 配置
  const agentCfg = cfg.agents?.defaults;
  
  // 解析配置的模型引用（考虑 fallback 链）
  const configuredModel = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  
  // 生成推理级别提示信息（用于错误提示）
  const thinkingLevelsHint = formatThinkingLevels(configuredModel.provider, configuredModel.model);

  // 规范化推理级别参数
  const thinkOverride = normalizeThinkLevel(opts.thinking);
  const thinkOnce = normalizeThinkLevel(opts.thinkingOnce);
  
  // 验证推理级别有效性
  if (opts.thinking && !thinkOverride) {
    throw new Error(`Invalid thinking level. Use one of: ${thinkingLevelsHint}.`);
  }
  if (opts.thinkingOnce && !thinkOnce) {
    throw new Error(`Invalid one-shot thinking level. Use one of: ${thinkingLevelsHint}.`);
  }

  // ========== 阶段 6: 处理 verbose 级别 ==========
  
  const verboseOverride = normalizeVerboseLevel(opts.verbose);
  if (opts.verbose && !verboseOverride) {
    throw new Error('Invalid verbose level. Use "on", "full", or "off".');
  }

  // ========== 阶段 7: 计算超时时间 ==========
  
  const laneRaw = typeof opts.lane === "string" ? opts.lane.trim() : "";
  const isSubagentLane = laneRaw === String(AGENT_LANE_SUBAGENT);
  const timeoutSecondsRaw =
    opts.timeout !== undefined
      ? Number.parseInt(String(opts.timeout), 10)
      : isSubagentLane
        ? 0
        : undefined;
  if (
    timeoutSecondsRaw !== undefined &&
    (Number.isNaN(timeoutSecondsRaw) || timeoutSecondsRaw < 0)
  ) {
    throw new Error("--timeout must be a non-negative integer (seconds; 0 means no timeout)");
  }
  const timeoutMs = resolveAgentTimeoutMs({
    cfg,
    overrideSeconds: timeoutSecondsRaw,
  });

  // ========== 阶段 8: 确定会话键和工作空间 ==========
  
  const sessionResolution = resolveSession({
    cfg,
    to: opts.to,
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    agentId: agentIdOverride,
  });

  const {
    sessionId,
    sessionKey,
    sessionEntry: sessionEntryRaw,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
  } = sessionResolution;
  const sessionAgentId =
    agentIdOverride ??
    resolveSessionAgentId({
      sessionKey: sessionKey ?? opts.sessionKey?.trim(),
      config: cfg,
    });
  const outboundSession = buildOutboundSessionContext({
    cfg,
    agentId: sessionAgentId,
    sessionKey,
  });
  // Internal callers (for example subagent spawns) may pin workspace inheritance.
  const workspaceDirRaw =
    normalizedSpawned.workspaceDir ?? resolveAgentWorkspaceDir(cfg, sessionAgentId);
  const agentDir = resolveAgentDir(cfg, sessionAgentId);
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap,
  });
  const workspaceDir = workspace.dir;
  const runId = opts.runId?.trim() || sessionId;
  const acpManager = getAcpSessionManager();
  const acpResolution = sessionKey
    ? acpManager.resolveSession({
        cfg,
        sessionKey,
      })
    : null;

  return {
    body,
    cfg,
    normalizedSpawned,
    agentCfg,
    thinkOverride,
    thinkOnce,
    verboseOverride,
    timeoutMs,
    sessionId,
    sessionKey,
    sessionEntry: sessionEntryRaw,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
    sessionAgentId,
    outboundSession,
    workspaceDir,
    agentDir,
    runId,
    acpManager,
    acpResolution,
  };
}

async function agentCommandInternal(
  opts: AgentCommandOpts & { senderIsOwner: boolean },
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  const prepared = await prepareAgentCommandExecution(opts, runtime);
  const {
    body,
    cfg,
    normalizedSpawned,
    agentCfg,
    thinkOverride,
    thinkOnce,
    verboseOverride,
    timeoutMs,
    sessionId,
    sessionKey,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
    sessionAgentId,
    outboundSession,
    workspaceDir,
    agentDir,
    runId,
    acpManager,
    acpResolution,
  } = prepared;
  let sessionEntry = prepared.sessionEntry;

  try {
    if (opts.deliver === true) {
      const sendPolicy = resolveSendPolicy({
        cfg,
        entry: sessionEntry,
        sessionKey,
        channel: sessionEntry?.channel,
        chatType: sessionEntry?.chatType,
      });
      if (sendPolicy === "deny") {
        throw new Error("send blocked by session policy");
      }
    }

    if (acpResolution?.kind === "stale") {
      throw acpResolution.error;
    }

    if (acpResolution?.kind === "ready" && sessionKey) {
      const startedAt = Date.now();
      registerAgentRunContext(runId, {
        sessionKey,
      });
      emitAcpLifecycleStart({ runId, startedAt });

      const visibleTextAccumulator = createAcpVisibleTextAccumulator();
      let stopReason: string | undefined;
      try {
        const dispatchPolicyError = resolveAcpDispatchPolicyError(cfg);
        if (dispatchPolicyError) {
          throw dispatchPolicyError;
        }
        const acpAgent = normalizeAgentId(
          acpResolution.meta.agent || resolveAgentIdFromSessionKey(sessionKey),
        );
        const agentPolicyError = resolveAcpAgentPolicyError(cfg, acpAgent);
        if (agentPolicyError) {
          throw agentPolicyError;
        }

        await acpManager.runTurn({
          cfg,
          sessionKey,
          text: body,
          mode: "prompt",
          requestId: runId,
          signal: opts.abortSignal,
          onEvent: (event) => {
            if (event.type === "done") {
              stopReason = event.stopReason;
              return;
            }
            if (event.type !== "text_delta") {
              return;
            }
            if (event.stream && event.stream !== "output") {
              return;
            }
            if (!event.text) {
              return;
            }
            const visibleUpdate = visibleTextAccumulator.consume(event.text);
            if (!visibleUpdate) {
              return;
            }
            emitAcpAssistantDelta({
              runId,
              text: visibleUpdate.text,
              delta: visibleUpdate.delta,
            });
          },
        });
      } catch (error) {
        const acpError = toAcpRuntimeError({
          error,
          fallbackCode: "ACP_TURN_FAILED",
          fallbackMessage: "ACP turn failed before completion.",
        });
        emitAcpLifecycleError({
          runId,
          message: acpError.message,
        });
        throw acpError;
      }

      emitAcpLifecycleEnd({ runId });

      const finalTextRaw = visibleTextAccumulator.finalizeRaw();
      const finalText = visibleTextAccumulator.finalize();
      try {
        sessionEntry = await persistAcpTurnTranscript({
          body,
          finalText: finalTextRaw,
          sessionId,
          sessionKey,
          sessionEntry,
          sessionStore,
          storePath,
          sessionAgentId,
          threadId: opts.threadId,
          sessionCwd: resolveAcpSessionCwd(acpResolution.meta) ?? workspaceDir,
        });
      } catch (error) {
        log.warn(
          `ACP transcript persistence failed for ${sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const result = buildAcpResult({
        payloadText: finalText,
        startedAt,
        stopReason,
        abortSignal: opts.abortSignal,
      });
      const payloads = result.payloads;

      return await deliverAgentCommandResult({
        cfg,
        deps,
        runtime,
        opts,
        outboundSession,
        sessionEntry,
        result,
        payloads,
      });
    }

    let resolvedThinkLevel = thinkOnce ?? thinkOverride ?? persistedThinking;
    const resolvedVerboseLevel =
      verboseOverride ?? persistedVerbose ?? (agentCfg?.verboseDefault as VerboseLevel | undefined);

    if (sessionKey) {
      registerAgentRunContext(runId, {
        sessionKey,
        verboseLevel: resolvedVerboseLevel,
      });
    }

    const needsSkillsSnapshot = isNewSession || !sessionEntry?.skillsSnapshot;
    const skillsSnapshotVersion = getSkillsSnapshotVersion(workspaceDir);
    const skillFilter = resolveAgentSkillsFilter(cfg, sessionAgentId);
    const skillsSnapshot = needsSkillsSnapshot
      ? buildWorkspaceSkillSnapshot(workspaceDir, {
          config: cfg,
          eligibility: { remote: getRemoteSkillEligibility() },
          snapshotVersion: skillsSnapshotVersion,
          skillFilter,
        })
      : sessionEntry?.skillsSnapshot;

    if (skillsSnapshot && sessionStore && sessionKey && needsSkillsSnapshot) {
      const current = sessionEntry ?? {
        sessionId,
        updatedAt: Date.now(),
      };
      const next: SessionEntry = {
        ...current,
        sessionId,
        updatedAt: Date.now(),
        skillsSnapshot,
      };
      await persistSessionEntry({
        sessionStore,
        sessionKey,
        storePath,
        entry: next,
      });
      sessionEntry = next;
    }

    // Persist explicit /command overrides to the session store when we have a key.
    if (sessionStore && sessionKey) {
      const entry = sessionStore[sessionKey] ??
        sessionEntry ?? { sessionId, updatedAt: Date.now() };
      const next: SessionEntry = { ...entry, sessionId, updatedAt: Date.now() };
      if (thinkOverride) {
        next.thinkingLevel = thinkOverride;
      }
      applyVerboseOverride(next, verboseOverride);
      await persistSessionEntry({
        sessionStore,
        sessionKey,
        storePath,
        entry: next,
      });
      sessionEntry = next;
    }

    const configuredDefaultRef = resolveDefaultModelForAgent({
      cfg,
      agentId: sessionAgentId,
    });
    const { provider: defaultProvider, model: defaultModel } = normalizeModelRef(
      configuredDefaultRef.provider,
      configuredDefaultRef.model,
    );
    let provider = defaultProvider;
    let model = defaultModel;
    const hasAllowlist = agentCfg?.models && Object.keys(agentCfg.models).length > 0;
    const hasStoredOverride = Boolean(
      sessionEntry?.modelOverride || sessionEntry?.providerOverride,
    );
    const explicitProviderOverride =
      typeof opts.provider === "string"
        ? normalizeExplicitOverrideInput(opts.provider, "provider")
        : undefined;
    const explicitModelOverride =
      typeof opts.model === "string"
        ? normalizeExplicitOverrideInput(opts.model, "model")
        : undefined;
    const hasExplicitRunOverride = Boolean(explicitProviderOverride || explicitModelOverride);
    if (hasExplicitRunOverride && opts.allowModelOverride !== true) {
      throw new Error("Model override is not authorized for this caller.");
    }
    const needsModelCatalog = hasAllowlist || hasStoredOverride || hasExplicitRunOverride;
    let allowedModelKeys = new Set<string>();
    let allowedModelCatalog: Awaited<ReturnType<typeof loadModelCatalog>> = [];
    let modelCatalog: Awaited<ReturnType<typeof loadModelCatalog>> | null = null;
    let allowAnyModel = false;

    if (needsModelCatalog) {
      modelCatalog = await loadModelCatalog({ config: cfg });
      const allowed = buildAllowedModelSet({
        cfg,
        catalog: modelCatalog,
        defaultProvider,
        defaultModel,
        agentId: sessionAgentId,
      });
      allowedModelKeys = allowed.allowedKeys;
      allowedModelCatalog = allowed.allowedCatalog;
      allowAnyModel = allowed.allowAny ?? false;
    }

    if (sessionEntry && sessionStore && sessionKey && hasStoredOverride) {
      const entry = sessionEntry;
      const overrideProvider = sessionEntry.providerOverride?.trim() || defaultProvider;
      const overrideModel = sessionEntry.modelOverride?.trim();
      if (overrideModel) {
        const normalizedOverride = normalizeModelRef(overrideProvider, overrideModel);
        const key = modelKey(normalizedOverride.provider, normalizedOverride.model);
        if (!allowAnyModel && !allowedModelKeys.has(key)) {
          const { updated } = applyModelOverrideToSessionEntry({
            entry,
            selection: { provider: defaultProvider, model: defaultModel, isDefault: true },
          });
          if (updated) {
            await persistSessionEntry({
              sessionStore,
              sessionKey,
              storePath,
              entry,
            });
          }
        }
      }
    }

    const storedProviderOverride = sessionEntry?.providerOverride?.trim();
    const storedModelOverride = sessionEntry?.modelOverride?.trim();
    if (storedModelOverride) {
      const candidateProvider = storedProviderOverride || defaultProvider;
      const normalizedStored = normalizeModelRef(candidateProvider, storedModelOverride);
      const key = modelKey(normalizedStored.provider, normalizedStored.model);
      if (allowAnyModel || allowedModelKeys.has(key)) {
        provider = normalizedStored.provider;
        model = normalizedStored.model;
      }
    }
    const providerForAuthProfileValidation = provider;
    if (hasExplicitRunOverride) {
      const explicitRef = explicitModelOverride
        ? explicitProviderOverride
          ? normalizeModelRef(explicitProviderOverride, explicitModelOverride)
          : parseModelRef(explicitModelOverride, provider)
        : explicitProviderOverride
          ? normalizeModelRef(explicitProviderOverride, model)
          : null;
      if (!explicitRef) {
        throw new Error("Invalid model override.");
      }
      const explicitKey = modelKey(explicitRef.provider, explicitRef.model);
      if (!allowAnyModel && !allowedModelKeys.has(explicitKey)) {
        throw new Error(
          `Model override "${sanitizeForLog(explicitRef.provider)}/${sanitizeForLog(explicitRef.model)}" is not allowed for agent "${sessionAgentId}".`,
        );
      }
      provider = explicitRef.provider;
      model = explicitRef.model;
    }
    if (sessionEntry) {
      const authProfileId = sessionEntry.authProfileOverride;
      if (authProfileId) {
        const entry = sessionEntry;
        const store = ensureAuthProfileStore();
        const profile = store.profiles[authProfileId];
        if (!profile || profile.provider !== providerForAuthProfileValidation) {
          if (sessionStore && sessionKey) {
            await clearSessionAuthProfileOverride({
              sessionEntry: entry,
              sessionStore,
              sessionKey,
              storePath,
            });
          }
        }
      }
    }

    if (!resolvedThinkLevel) {
      let catalogForThinking = modelCatalog ?? allowedModelCatalog;
      if (!catalogForThinking || catalogForThinking.length === 0) {
        modelCatalog = await loadModelCatalog({ config: cfg });
        catalogForThinking = modelCatalog;
      }
      resolvedThinkLevel = resolveThinkingDefault({
        cfg,
        provider,
        model,
        catalog: catalogForThinking,
      });
    }
    if (resolvedThinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
      const explicitThink = Boolean(thinkOnce || thinkOverride);
      if (explicitThink) {
        throw new Error(`Thinking level "xhigh" is only supported for ${formatXHighModelHint()}.`);
      }
      resolvedThinkLevel = "high";
      if (sessionEntry && sessionStore && sessionKey && sessionEntry.thinkingLevel === "xhigh") {
        const entry = sessionEntry;
        entry.thinkingLevel = "high";
        entry.updatedAt = Date.now();
        await persistSessionEntry({
          sessionStore,
          sessionKey,
          storePath,
          entry,
        });
      }
    }
    let sessionFile: string | undefined;
    if (sessionStore && sessionKey) {
      const resolvedSessionFile = await resolveSessionTranscriptFile({
        sessionId,
        sessionKey,
        sessionStore,
        storePath,
        sessionEntry,
        agentId: sessionAgentId,
        threadId: opts.threadId,
      });
      sessionFile = resolvedSessionFile.sessionFile;
      sessionEntry = resolvedSessionFile.sessionEntry;
    }
    if (!sessionFile) {
      const resolvedSessionFile = await resolveSessionTranscriptFile({
        sessionId,
        sessionKey: sessionKey ?? sessionId,
        storePath,
        sessionEntry,
        agentId: sessionAgentId,
        threadId: opts.threadId,
      });
      sessionFile = resolvedSessionFile.sessionFile;
      sessionEntry = resolvedSessionFile.sessionEntry;
    }

    const startedAt = Date.now();
    let lifecycleEnded = false;

    let result: Awaited<ReturnType<typeof runAgentAttempt>>;
    let fallbackProvider = provider;
    let fallbackModel = model;
    try {
      const runContext = resolveAgentRunContext(opts);
      const messageChannel = resolveMessageChannel(
        runContext.messageChannel,
        opts.replyChannel ?? opts.channel,
      );
      const spawnedBy = normalizedSpawned.spawnedBy ?? sessionEntry?.spawnedBy;
      // Keep fallback candidate resolution centralized so session model overrides,
      // per-agent overrides, and default fallbacks stay consistent across callers.
      const effectiveFallbacksOverride = resolveEffectiveModelFallbacks({
        cfg,
        agentId: sessionAgentId,
        hasSessionModelOverride: Boolean(storedModelOverride),
      });

      // Track model fallback attempts so retries on an existing session don't
      // re-inject the original prompt as a duplicate user message.
      let fallbackAttemptIndex = 0;
      const fallbackResult = await runWithModelFallback({
        cfg,
        provider,
        model,
        runId,
        agentDir,
        fallbacksOverride: effectiveFallbacksOverride,
        run: (providerOverride, modelOverride, runOptions) => {
          const isFallbackRetry = fallbackAttemptIndex > 0;
          fallbackAttemptIndex += 1;
          return runAgentAttempt({
            providerOverride,
            modelOverride,
            cfg,
            sessionEntry,
            sessionId,
            sessionKey,
            sessionAgentId,
            sessionFile,
            workspaceDir,
            body,
            isFallbackRetry,
            resolvedThinkLevel,
            timeoutMs,
            runId,
            opts,
            runContext,
            spawnedBy,
            messageChannel,
            skillsSnapshot,
            resolvedVerboseLevel,
            agentDir,
            authProfileProvider: providerForAuthProfileValidation,
            sessionStore,
            storePath,
            allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
            onAgentEvent: (evt) => {
              // Track lifecycle end for fallback emission below.
              if (
                evt.stream === "lifecycle" &&
                typeof evt.data?.phase === "string" &&
                (evt.data.phase === "end" || evt.data.phase === "error")
              ) {
                lifecycleEnded = true;
              }
            },
          });
        },
      });
      result = fallbackResult.result;
      fallbackProvider = fallbackResult.provider;
      fallbackModel = fallbackResult.model;
      if (!lifecycleEnded) {
        const stopReason = result.meta.stopReason;
        if (stopReason && stopReason !== "end_turn") {
          console.error(`[agent] run ${runId} ended with stopReason=${stopReason}`);
        }
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: {
            phase: "end",
            startedAt,
            endedAt: Date.now(),
            aborted: result.meta.aborted ?? false,
            stopReason,
          },
        });
      }
    } catch (err) {
      if (!lifecycleEnded) {
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: {
            phase: "error",
            startedAt,
            endedAt: Date.now(),
            error: String(err),
          },
        });
      }
      throw err;
    }

    // Update token+model fields in the session store.
    if (sessionStore && sessionKey) {
      await updateSessionStoreAfterAgentRun({
        cfg,
        contextTokensOverride: agentCfg?.contextTokens,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: provider,
        defaultModel: model,
        fallbackProvider,
        fallbackModel,
        result,
      });
    }

    const payloads = result.payloads ?? [];
    return await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts,
      outboundSession,
      sessionEntry,
      result,
      payloads,
    });
  } finally {
    clearAgentRunContext(runId);
  }
}

export async function agentCommand(
  opts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  return await agentCommandInternal(
    {
      ...opts,
      // agentCommand is the trusted-operator entrypoint used by CLI/local flows.
      // Ingress callers must opt into owner semantics explicitly via
      // agentCommandFromIngress so network-facing paths cannot inherit this default by accident.
      senderIsOwner: opts.senderIsOwner ?? true,
      // Local/CLI callers are trusted by default for per-run model overrides.
      allowModelOverride: opts.allowModelOverride ?? true,
    },
    runtime,
    deps,
  );
}

export async function agentCommandFromIngress(
  opts: AgentCommandIngressOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  if (typeof opts.senderIsOwner !== "boolean") {
    // HTTP/WS ingress must declare the trust level explicitly at the boundary.
    // This keeps network-facing callers from silently picking up the local trusted default.
    throw new Error("senderIsOwner must be explicitly set for ingress agent runs.");
  }
  if (typeof opts.allowModelOverride !== "boolean") {
    throw new Error("allowModelOverride must be explicitly set for ingress agent runs.");
  }
  return await agentCommandInternal(
    {
      ...opts,
      senderIsOwner: opts.senderIsOwner,
      allowModelOverride: opts.allowModelOverride,
    },
    runtime,
    deps,
  );
}
