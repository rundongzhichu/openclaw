/**
 * @fileoverview OpenClaw 网关服务器核心实现
 * 
 * 本文件实现了 OpenClaw 系统的核心控制平面 - Gateway 服务器。
 * Gateway 是整个系统的大脑，负责：
 * - WebSocket RPC 通信处理
 * - HTTP 服务 (Control UI, WebChat)
 * - 通道管理 (WhatsApp, Telegram, Slack 等 20+ 种渠道)
 * - 会话管理 (Session)
 * - Agent 运行时协调
 * - 插件系统引导
 * - Cron 定时任务
 * - Tailscale 网络暴露
 * 
 * @module gateway/server
 */

import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/runs.js";
import { registerSkillsChangeListener } from "../agents/skills/refresh.js";
import { initSubagentRegistry } from "../agents/subagent-registry.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import type { CanvasHostServer } from "../canvas-host/server.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { formatCliCommand } from "../cli/command-format.js";
import { createDefaultDeps } from "../cli/deps.js";
import { isRestartEnabled } from "../config/commands.js";
import {
  type ConfigFileSnapshot,
  type OpenClawConfig,
  applyConfigOverrides,
  isNixMode,
  loadConfig,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { clearAgentRunContext, onAgentEvent } from "../infra/agent-events.js";
import {
  ensureControlUiAssetsBuilt,
  isPackageProvenControlUiRootSync,
  resolveControlUiRootOverrideSync,
  resolveControlUiRootSync,
} from "../infra/control-ui-assets.js";
import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import { logAcceptedEnvOption } from "../infra/env.js";
import { createExecApprovalForwarder } from "../infra/exec-approval-forwarder.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import { startHeartbeatRunner, type HeartbeatRunner } from "../infra/heartbeat-runner.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import {
  detectPluginInstallPathIssue,
  formatPluginInstallPathIssue,
} from "../infra/plugin-install-path-warnings.js";
import { setGatewaySigusr1RestartPolicy, setPreRestartDeferralCheck } from "../infra/restart.js";
import {
  primeRemoteSkillsCache,
  refreshRemoteBinsForConnectedNodes,
  setSkillsRemoteRegistry,
} from "../infra/skills-remote.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { scheduleGatewayUpdate检查 } from "../infra/update-startup.js";
import { startDiagnosticHeartbeat, stopDiagnosticHeartbeat } from "../logging/diagnostic.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import { resolveConfiguredDeferredChannelPluginIds } from "../plugins/channel-plugin-ids.js";
import { getGlobalHookRunner, runGlobalGatewayStopSafely } from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { getTotalQueueSize } from "../process/command-queue.js";
import type { RuntimeEnv } from "../runtime.js";
import type { CommandSecretAssignment } from "../secrets/command-config.js";
import {
  GATEWAY_AUTH_SURFACE_PATHS,
  evaluateGatewayAuthSurfaceStates,
} from "../secrets/runtime-gateway-auth-surfaces.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
  resolveCommandSecretsFromActiveRuntimeSnapshot,
} from "../secrets/runtime.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { runSetupWizard } from "../wizard/setup.js";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import { startGatewayConfigReloader } from "./config-reload.js";
import type { ControlUiRootState } from "./control-ui.js";
import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "./events.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { startGatewayModelPricingRefresh } from "./model-pricing-cache.js";
import { NodeRegistry } from "./node-registry.js";
import { createChannelManager } from "./server-channels.js";
import {
  createAgentEventHandler,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat.js";
import { createGatewayCloseHandler } from "./server-close.js";
import { buildGatewayCronService } from "./server-cron.js";
import { startGatewayDiscovery } from "./server-discovery-runtime.js";
import { applyGatewayLaneConcurrency } from "./server-lanes.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import { GATEWAY_EVENTS, listGatewayMethods } from "./server-methods-list.js";
import { coreGatewayHandlers } from "./server-methods.js";
import { createExecApprovalHandlers } from "./server-methods/exec-approval.js";
import { safeParseJson } from "./server-methods/nodes.helpers.js";
import { createPluginApprovalHandlers } from "./server-methods/plugin-approval.js";
import { createSecretsHandlers } from "./server-methods/secrets.js";
import { hasConnectedMobileNode } from "./server-mobile-nodes.js";
import { loadGatewayModelCatalog } from "./server-model-catalog.js";
import { createNodeSubscriptionManager } from "./server-node-subscriptions.js";
import {
  loadGatewayStartupPlugins,
  reloadDeferredGatewayPlugins,
} from "./server-plugin-bootstrap.js";
import { setFallbackGatewayContextResolver } from "./server-plugins.js";
import { createGatewayReloadHandlers } from "./server-reload-handlers.js";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";
import { createGatewayRuntimeState } from "./server-runtime-state.js";
import { resolveSessionKeyForRun } from "./server-session-key.js";
import { logGatewayStartup } from "./server-startup-log.js";
import { runStartupMatrixMigration } from "./server-startup-matrix-migration.js";
import { startGatewaySidecars } from "./server-startup.js";
import { startGatewayTailscaleExposure } from "./server-tailscale.js";
import { createWizardSessionTracker } from "./server-wizard-sessions.js";
import { attachGatewayWsHandlers } from "./server-ws-runtime.js";
import {
  getHealthCache,
  getHealthVersion,
  getPresenceVersion,
  incrementPresenceVersion,
  refreshGatewayHealthSnapshot,
} from "./server/health-state.js";
import { resolveHookClientIpConfig } from "./server/hooks.js";
import { createReadinessChecker } from "./server/readiness.js";
import { loadGatewayTlsRuntime } from "./server/tls.js";
import { resolveSessionKeyForTranscriptFile } from "./session-transcript-key.js";
import {
  attachOpenClawTranscriptMeta,
  loadGatewaySessionRow,
  loadSessionEntry,
  readSessionMessages,
} from "./session-utils.js";
import {
  ensureGatewayStartupAuth,
  mergeGatewayAuthConfig,
  mergeGatewayTailscaleConfig,
} from "./startup-auth.js";
import { maybeSeedControlUiAllowedOriginsAtStartup } from "./startup-control-ui-origins.js";

export { __resetModelCatalogCacheForTest } from "./server-model-catalog.js";

ensureOpenClawCliOnPath();

const MAX_MEDIA_TTL_HOURS = 24 * 7;

function resolveMediaCleanupTtlMs(ttlHoursRaw: number): number {
  const ttlHours = Math.min(Math.max(ttlHoursRaw, 1), MAX_MEDIA_TTL_HOURS);
  const ttlMs = ttlHours * 60 * 60_000;
  if (!Number.isFinite(ttlMs) || !Number.isSafeInteger(ttlMs)) {
    throw new Error(`Invalid media.ttlHours: ${String(ttlHoursRaw)}`);
  }
  return ttlMs;
}

const log = createSubsystemLogger("gateway");
const logCanvas = log.child("canvas");
const logDiscovery = log.child("discovery");
const logTailscale = log.child("tailscale");
const logChannels = log.child("channels");

let cachedChannelRuntime: ReturnType<typeof createPluginRuntime>["channel"] | null = null;

function getChannelRuntime() {
  cachedChannelRuntime ??= createPluginRuntime().channel;
  return cachedChannelRuntime;
}
const logHealth = log.child("health");
const logCron = log.child("cron");
const logReload = log.child("reload");
const logHooks = log.child("hooks");
const logPlugins = log.child("plugins");
const logWsControl = log.child("ws");
const logSecrets = log.child("secrets");
const gatewayRuntime = runtimeForLogger(log);
const canvasRuntime = runtimeForLogger(logCanvas);

type AuthRateLimitConfig = Parameters<typeof createAuthRateLimiter>[0];

/**
 * 创建网关认证速率限制器
 * 
 * 根据配置创建两种速率限制器：
 * 1. **标准限制器**: 遵循配置的豁免策略（如 loopback 豁免）
 * 2. **浏览器限制器**: 强制不豁免 loopback，用于限制来自浏览器的 WebSocket 认证尝试
 * 
 * @param rateLimitConfig - 认证速率限制配置
 * @returns 包含两个限制器的对象
 * 
 * @example
 * // 使用示例
 * const limiters = createGatewayAuthRateLimiters({
 *   mode: "token",
 *   maxAttempts: 5,
 *   windowMs: 60000,
 *   exemptLoopback: true  // 标准限制器会豁免本地回环
 * });
 * 
 * // limiters.rateLimiter - 标准限制器（可能豁免 loopback）
 * // limiters.browserRateLimiter - 浏览器限制器（绝不豁免 loopback）
 */
function createGatewayAuthRateLimiters(rateLimitConfig: AuthRateLimitConfig | undefined): {
  rateLimiter?: AuthRateLimiter;
  browserRateLimiter: AuthRateLimiter;
} {
  // 如果提供了配置，创建标准速率限制器；否则保持未定义
  const rateLimiter = rateLimitConfig ? createAuthRateLimiter(rateLimitConfig) : undefined;
  
  // 浏览器来源的 WebSocket 认证尝试始终使用非豁免的 loopback 限制
  // 这是为了防止浏览器端的暴力破解攻击，即使是本地请求也要限流
  const browserRateLimiter = createAuthRateLimiter({
    ...rateLimitConfig,
    exemptLoopback: false,  // 强制禁用 loopback 豁免
  });
  
  return { rateLimiter, browserRateLimiter };
}

/**
 * 记录网关认证表面诊断信息
 * 
 * 分析并记录所有认证相关配置的状态（active/inactive），
 * 帮助开发者了解哪些认证方式已激活，哪些被忽略。
 * 
 * **执行逻辑**:
 * 1. 评估所有认证表面的状态（基于配置、默认值、环境变量）
 * 2. 收集 inactive 的 secret 引用警告
 * 3. 遍历所有认证表面路径，检查其激活状态
 * 4. 记录详细日志，包括 inactive 原因
 * 
 * @param prepared - 预处理的配置和警告信息
 * 
 * @example
 * // 日志输出示例：
 * // [SECRETS_GATEWAY_AUTH_SURFACE] gateway.auth.token is active. Using env OPENCLAW_TOKEN
 * // [SECRETS_GATEWAY_AUTH_SURFACE] gateway.auth.password is inactive. Ignored because token is active
 */
function logGatewayAuthSurfaceDiagnostics(prepared: {
  sourceConfig: OpenClawConfig;
  warnings: Array<{ code: string; path: string; message: string }>;
}): void {
  // 步骤 1: 评估所有认证表面的状态
  const states = evaluateGatewayAuthSurfaceStates({
    config: prepared.sourceConfig,
    defaults: prepared.sourceConfig.secrets?.defaults,
    env: process.env,  // 检查环境变量覆盖
  });
  
  // 步骤 2: 构建 inactive 警告映射表
  const inactiveWarnings = new Map<string, string>();
  for (const warning of prepared.warnings) {
    if (warning.code !== "SECRETS_REF_IGNORED_INACTIVE_SURFACE") {
      continue;  // 只关注 inactive surface 的警告
    }
    inactiveWarnings.set(warning.path, warning.message);
  }
  
  // 步骤 3: 遍历所有认证表面路径，记录状态
  for (const path of GATEWAY_AUTH_SURFACE_PATHS) {
    const state = states[path];
    if (!state.hasSecretRef) {
      continue;  // 没有 secret 引用，跳过
    }
    
    // 标记激活状态
    const stateLabel = state.active ? "active" : "inactive";
    
    // 优先使用 inactive 警告详情，否则使用状态原因
    const inactiveDetails =
      !state.active && inactiveWarnings.get(path) ? inactiveWarnings.get(path) : undefined;
    const details = inactiveDetails ?? state.reason;
    
    // 步骤 4: 输出诊断日志
    logSecrets.info(`[SECRETS_GATEWAY_AUTH_SURFACE] ${path} is ${stateLabel}. ${details}`);
  }
}

/**
 * 应用网关认证覆盖以进行启动前检查
 * 
 * 在启动 auth 持久化任何东西之前，快速失败（fail-fast）检查必需的 secret 引用是否已解析。
 * 通过合并用户提供的覆盖配置来准备启动前的配置快照。
 * 
 * **类型安全技巧**: 使用 `Pick<T, K>` 工具类型仅提取需要的字段，避免传递整个大对象
 * 
 * @param config - 当前配置对象
 * @param overrides - 认证和 Tailscale 覆盖配置
 * @returns 合并后的新配置对象（不可变模式）
 * 
 * @example
 * // 使用示例
 * const preflightConfig = applyGatewayAuthOverridesForStartupPreflight(
 *   runtimeConfig,
 *   {
 *     auth: { mode: "token", token: "override-token" },
 *     tailscale: { mode: "serve" }
 *   }
 * );
 */
function applyGatewayAuthOverridesForStartupPreflight(
  config: OpenClawConfig,
  overrides: Pick<GatewayServerOptions, "auth" | "tailscale">,
): OpenClawConfig {
  // 如果没有覆盖，直接返回原配置（性能优化）
  if (!overrides.auth && !overrides.tailscale) {
    return config;
  }
  
  // 使用扩展运算符深度合并配置
  // 注意：这里只合并 gateway.auth 和 gateway.tailscale，其他配置保持不变
  return {
    ...config,
    gateway: {
      ...config.gateway,
      // 合并 auth 配置（用户覆盖优先）
      auth: mergeGatewayAuthConfig(config.gateway?.auth, overrides.auth),
      // 合并 tailscale 配置（用户覆盖优先）
      tailscale: mergeGatewayTailscaleConfig(config.gateway?.tailscale, overrides.tailscale),
    },
  };
}

/**
 * 断言有效的网关启动配置快照
 * 
 * 在启动流程早期验证配置有效性，如果无效则抛出详细错误信息，
 * 包含修复提示（运行 doctor 命令）。
 * 
 * **防御性编程**: 在关键操作前验证输入，尽早失败以避免后续复杂错误
 * 
 * @param snapshot - 配置文件快照
 * @param options - 可选参数，控制是否包含 doctor 提示
 * 
 * @throws Error 当配置无效时抛出，包含详细的错误信息和修复建议
 * 
 * @example
 * // 正常情况：直接返回
 * assertValidGatewayStartupConfigSnapshot(validSnapshot);
 * 
 * // 异常情况：抛出错误
 * // Error: Invalid config at ~/.openclaw/config.json.
 * // - gateway.port must be a number between 1 and 65535
 * // - agents.list is required
 * // Run "openclaw doctor" to repair, then retry.
 */
function assertValidGatewayStartupConfigSnapshot(
  snapshot: ConfigFileSnapshot,
  options: { includeDoctorHint?: boolean } = {},
): void {
  // 如果配置有效，直接返回（守卫模式）
  if (snapshot.valid) {
    return;
  }
  
  // 格式化配置问题列表
  const issues =
    snapshot.issues.length > 0
      ? formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }).join("\n")
      : "Unknown validation issue.";
  
  // 根据选项决定是否添加 doctor 命令提示
  const doctorHint = options.includeDoctorHint
    ? `\nRun "${formatCliCommand("openclaw doctor")}" to repair, then retry.`
    : "";
  
  // 抛出包含完整上下文的错误
  throw new Error(`Invalid config at ${snapshot.path}.\n${issues}${doctorHint}`);
}

/**
 * 准备网关启动配置
 * 
 * 这是网关启动的核心配置处理函数，负责：
 * 1. 验证配置快照有效性
 * 2. 执行启动前检查（secret 引用解析）
 * 3. 确保认证引导配置
 * 4. 激活运行时 secrets
 * 
 * **异步流程控制**: 使用多阶段配置处理确保每个步骤都可回滚
 * 
 * @param params - 参数对象
 * @param params.configSnapshot - 配置文件快照
 * @param params.runtimeConfig - 运行时配置（已应用环境变量覆盖）
 * @param params.authOverride - 可选的认证覆盖
 * @param params.tailscaleOverride - 可选的 Tailscale 覆盖
 * @param params.activateRuntimeSecrets - 激活运行时 secrets 的函数
 * 
 * @returns 完整的认证引导配置和激活后的运行时配置
 * 
 * @example
 * // 使用示例
 * const startupConfig = await prepareGatewayStartupConfig({
 *   configSnapshot: snapshot,
 *   runtimeConfig: runtimeCfg,
 *   activateRuntimeSecrets: async (config, opts) => {
 *     if (opts.activate) {
 *       await activateSecretsRuntimeSnapshot(config);
 *     }
 *     return { config };
 *   }
 * });
 * 
 * // startupConfig.cfg 包含最终可用于启动的配置
 */
async function prepareGatewayStartupConfig(params: {
  configSnapshot: ConfigFileSnapshot;
  // Keep startup auth/runtime behavior aligned with loadConfig(), which applies
  // runtime overrides beyond the raw on-disk snapshot.
  runtimeConfig: OpenClawConfig;
  authOverride?: GatewayServerOptions["auth"];
  tailscaleOverride?: GatewayServerOptions["tailscale"];
  activateRuntimeSecrets: (
    config: OpenClawConfig,
    options: { reason: "startup"; activate: boolean },
  ) => Promise<{ config: OpenClawConfig }>;
}): Promise<Awaited<ReturnType<typeof ensureGatewayStartupAuth>>> {
  // 步骤 1: 验证配置快照（失败则立即抛出）
  assertValidGatewayStartupConfigSnapshot(params.configSnapshot);

  // 步骤 2: 启动前检查 - 在不激活 secrets 的情况下验证引用
  // 目的：在持久化任何东西之前快速失败
  const startupPreflightConfig = applyGatewayAuthOverridesForStartupPreflight(
    params.runtimeConfig,
    {
      auth: params.authOverride,
      tailscale: params.tailscaleOverride,
    },
  );
  
  // 预检查：不激活 secrets，只验证引用是否存在
  await params.activateRuntimeSecrets(startupPreflightConfig, {
    reason: "startup",
    activate: false,  // 仅验证，不激活
  });

  // 步骤 3: 确保认证引导配置（可能需要生成默认 token/password）
  const authBootstrap = await ensureGatewayStartupAuth({
    cfg: params.runtimeConfig,
    env: process.env,
    authOverride: params.authOverride,
    tailscaleOverride: params.tailscaleOverride,
    persist: true,  // 持久化生成的认证凭据
  });
  
  // 步骤 4: 应用认证覆盖到运行时启动配置
  const runtimeStartupConfig = applyGatewayAuthOverridesForStartupPreflight(authBootstrap.cfg, {
    auth: params.authOverride,
    tailscale: params.tailscaleOverride,
  });
  
  // 步骤 5: 激活运行时 secrets（真正加载到内存）
  const activatedConfig = (
    await params.activateRuntimeSecrets(runtimeStartupConfig, {
      reason: "startup",
      activate: true,  // 真正激活
    })
  ).config;
  
  // 返回完整的启动配置（包含认证引导信息和激活后的配置）
  return {
    ...authBootstrap,
    cfg: activatedConfig,
  };
}

export type GatewayServer = {
  close: (opts?: { reason?: string; restartExpectedMs?: number | null }) => Promise<void>;
};

export type GatewayServerOptions = {
  /**
   * Bind address policy for the Gateway WebSocket/HTTP server.
   * - loopback: 127.0.0.1
   * - lan: 0.0.0.0
   * - tailnet: bind only to the Tailscale IPv4 address (100.64.0.0/10)
   * - auto: prefer loopback, else LAN
   */
  bind?: import("../config/config.js").GatewayBindMode;
  /**
   * Advanced override for the bind host, bypassing bind resolution.
   * Prefer `bind` unless you really need a specific address.
   */
  host?: string;
  /**
   * If false, do not serve the browser Control UI.
   * Default: config `gateway.controlUi.enabled` (or true when absent).
   */
  controlUiEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/chat/completions`.
   * Default: config `gateway.http.endpoints.chatCompletions.enabled` (or false when absent).
   */
  openAiChatCompletionsEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/responses` (OpenResponses API).
   * Default: config `gateway.http.endpoints.responses.enabled` (or false when absent).
   */
  openResponsesEnabled?: boolean;
  /**
   * Override gateway auth configuration (merges with config).
   */
  auth?: import("../config/config.js").GatewayAuthConfig;
  /**
   * Override gateway Tailscale exposure configuration (merges with config).
   */
  tailscale?: import("../config/config.js").GatewayTailscaleConfig;
  /**
   * Test-only: allow canvas host startup even when NODE_ENV/VITEST would disable it.
   */
  allowCanvasHostInTests?: boolean;
  /**
   * Test-only: override the setup wizard runner.
   */
  wizardRunner?: (
    opts: import("../commands/onboard-types.js").OnboardOptions,
    runtime: import("../runtime.js").RuntimeEnv,
    prompter: import("../wizard/prompts.js").WizardPrompter,
  ) => Promise<void>;
};

/**
 * 启动网关服务器 ⭐⭐⭐ 核心入口函数
 * 
 * **核心功能**:
 * 启动 OpenClaw Gateway 服务器，完成所有初始化流程并返回运行中的服务器实例。
 * 
 * **完整启动流程**（20+ 个关键步骤）:
 * ```text
 * 阶段 1: 环境初始化与配置加载
 * 1.1 设置环境变量 (OPENCLAW_GATEWAY_PORT, OPENCLAW_RAW_STREAM)
 * 1.2 读取配置快照并处理遗留迁移
 * 1.3 验证配置有效性
 * 1.4 自动启用插件（applyPluginAutoEnable）
 * 
 * 阶段 2: 密钥系统激活
 * 2.1 创建密钥激活锁（runWithSecretsActivationLock）
 * 2.2 准备密钥运行时快照（prepareSecretsRuntimeSnapshot）
 * 2.3 激活密钥并记录诊断日志
 * 2.4 处理降级和恢复场景（SECRETS_RELOADER_DEGRADED/RECOVERED）
 * 
 * 阶段 3: 认证引导
 * 3.1 应用配置覆盖（applyConfigOverrides）
 * 3.2 准备网关启动认证（prepareGatewayStartupConfig）
 * 3.3 自动生成 Token（如果缺失）
 * 3.4 启用诊断心跳（如果开启）
 * 3.5 设置 SIGUSR1 重启策略
 * 
 * 阶段 4: 启动时迁移与检查
 * 4.1 播种 Control UI 允许来源（maybeSeedControlUiAllowedOriginsAtStartup）
 * 4.2 运行矩阵迁移（runStartupMatrixMigration）
 * 4.3 检测 Matrix 插件安装路径问题
 * 
 * 阶段 5: 插件系统初始化
 * 5.1 初始化子代理注册表（initSubagentRegistry）
 * 5.2 应用插件自动启用
 * 5.3 解析默认 Agent ID 和工作区目录
 * 5.4 延迟配置的 Channel 插件 ID
 * 5.5 加载网关启动插件（loadGatewayStartupPlugins）
 * 5.6 创建 Channel 日志和运行时环境
 * 
 * 阶段 6: 运行时配置解析
 * 6.1 解析网关运行时配置（resolveGatewayRuntimeConfig）
 * 6.2 提取绑定主机、端口、认证、TLS 等配置
 * 6.3 解析 Hook 客户端 IP 配置
 * 6.4 加载 TLS 运行时（loadGatewayTlsRuntime）
 * 
 * 阶段 7: 速率限制器创建
 * 7.1 创建认证速率限制器（createGatewayAuthRateLimiters）
 * 7.2 创建浏览器专用限制器（防止暴力破解）
 * 
 * 阶段 8: Control UI 状态解析
 * 8.1 检查自定义根路径覆盖
 * 8.2 确保 UI 资源已构建
 * 8.3 解析 UI 根路径状态（bundled/resolved/missing/invalid）
 * 
 * 阶段 9: Wizard 会话跟踪
 * 9.1 创建 Wizard 会话跟踪器
 * 9.2 查找运行中的 Wizard
 * 9.3 清理过期 Wizard 会话
 * 
 * 阶段 10: Channel 管理器创建
 * 10.1 创建 Channel 管理器（createChannelManager）
 * 10.2 注入配置加载器和日志系统
 * 10.3 创建就绪检查器（createReadinessChecker）
 * 
 * 阶段 11: 网关运行时状态创建
 * 11.1 创建 HTTP 服务器和 WebSocket 服务器
 * 11.2 初始化广播系统
 * 11.3 设置聊天运行状态管理
 * 11.4 创建工具事件接收者列表
 * 
 * 阶段 12: 节点注册表初始化
 * 12.1 创建节点注册表（NodeRegistry）
 * 12.2 设置设备管理和连接跟踪
 * 
 * 阶段 13: 执行审批管理器
 * 13.1 创建执行审批管理器（ExecApprovalManager）
 * 13.2 设置审批转发器
 * 
 * 阶段 14: 模型定价缓存刷新
 * 14.1 启动模型定价缓存刷新（startGatewayModelPricingRefresh）
 * 
 * 阶段 15: 通道健康监控
 * 15.1 启动通道健康监控器（startChannelHealthMonitor）
 * 
 * 阶段 16: 网关发现服务
 * 16.1 启动网关发现（startGatewayDiscovery）
 * 16.2 远程技能缓存预热
 * 16.3 刷新远程 bin 文件
 * 
 * 阶段 17: 网关侧车服务
 * 17.1 启动网关侧车（startGatewaySidecars）
 * 
 * 阶段 18: Tailscale 网络暴露
 * 18.1 启动 Tailscale 暴露（startGatewayTailscaleExposure）
 * 
 * 阶段 19: WebSocket 处理器附加
 * 19.1 附加 WebSocket 处理器（attachGatewayWsHandlers）
 * 19.2 注册所有网关方法
 * 
 * 阶段 20: 启动日志与定时任务
 * 20.1 记录网关启动信息（logGatewayStartup）
 * 20.2 启动网关维护定时器
 * 20.3 启动配置重载器
 * 20.4 启动 Cron 服务
 * 
 * 返回：运行中的 Gateway 服务器实例
 * ```
 * 
 * **安全特性**:
 * - 密钥激活锁：避免并发激活冲突
 * - 降级模式：密钥失败时保持最后已知良好状态
 * - 速率限制：防止暴力破解攻击
 * - TLS 支持：HTTPS/WSS 加密通信
 * - Tailscale：安全的私有网络暴露
 * 
 * **使用示例**:
 * ```typescript
 * // 场景 1: 基本启动（默认端口 18789）
 * const gateway = await startGatewayServer();
 * console.log(`Gateway running on port 18789`);
 * 
 * // 场景 2: 自定义端口和选项
 * const gateway = await startGatewayServer(18790, {
 *   host: '0.0.0.0',
 *   bind: 'localhost',
 *   controlUiEnabled: true,
 *   auth: { mode: 'token', token: 'my-secret-token' }
 * });
 * 
 * // 场景 3: 测试最小化网关
 * process.env.VITEST = '1';
 * process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = '1';
 * const gateway = await startGatewayServer(18789, { minimal: true });
 * ```
 * 
 * @param port - 网关监听端口（默认 18789）
 * @param opts - 网关服务器选项
 * @param opts.host - 绑定主机地址
 * @param opts.bind - 绑定接口
 * @param opts.auth - 认证配置覆盖
 * @param opts.tailscale - Tailscale 配置覆盖
 * @param opts.controlUiEnabled - 是否启用 Control UI
 * @param opts.openAiChatCompletionsEnabled - 是否启用 OpenAI Chat Completions
 * @param opts.openResponsesEnabled - 是否启用 Open Responses
 * @param opts.wizardRunner - 自定义 Wizard 运行器
 * @returns Promise<GatewayServer> 运行中的网关服务器实例
 */
export async function startGatewayServer(
  /** 网关监听端口（默认 18789） */
  port = 18789,
  /** 网关服务器选项 */
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  // 快速路径：最小化测试网关检测
  const minimalTestGateway =
    process.env.VITEST === "1" && process.env.OPENCLAW_TEST_MINIMAL_GATEWAY === "1";

  // ========== 阶段 1: 环境初始化 ==========
  
  // 确保所有默认端口派生（browser/canvas）看到实际运行时端口
  process.env.OPENCLAW_GATEWAY_PORT = String(port);
  
  // 记录接受的环境变量选项
  logAcceptedEnvOption({
    key: "OPENCLAW_RAW_STREAM",
    description: "raw stream logging enabled",
  });
  logAcceptedEnvOption({
    key: "OPENCLAW_RAW_STREAM_PATH",
    description: "raw stream log path override",
  });

  // ========== 阶段 2: 配置加载与迁移 ==========
  
  let configSnapshot = await readConfigFileSnapshot();
  
  // 处理遗留配置迁移
  if (configSnapshot.legacyIssues.length > 0) {
    if (isNixMode) {
      throw new Error(
        "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.",
      );
    }
    const { config: migrated, changes } = migrateLegacyConfig(configSnapshot.parsed);
    if (!migrated) {
      log.warn(
        "gateway: legacy config entries detected but no auto-migration changes were produced; continuing with validation.",
      );
    } else {
      await writeConfigFile(migrated);
      if (changes.length > 0) {
        log.info(
          `gateway: migrated legacy config entries:\n${changes
            .map((entry) => `- ${entry}`)
            .join("\n")}`,
        );
      }
    }
  }

  // 重新读取配置快照
  configSnapshot = await readConfigFileSnapshot();
  if (configSnapshot.exists) {
    assertValidGatewayStartupConfigSnapshot(configSnapshot, { includeDoctorHint: true });
  }

  // ========== 阶段 3: 插件自动启用 ==========
  
  const autoEnable = applyPluginAutoEnable({ config: configSnapshot.config, env: process.env });
  if (autoEnable.changes.length > 0) {
    try {
      await writeConfigFile(autoEnable.config);
      configSnapshot = await readConfigFileSnapshot();
      assertValidGatewayStartupConfigSnapshot(configSnapshot);
      log.info(
        `gateway: auto-enabled plugins:\n${autoEnable.changes
          .map((entry) => `- ${entry}`)
          .join("\n")}`,
      );
    } catch (err) {
      log.warn(`gateway: failed to persist plugin auto-enable changes: ${String(err)}`);
    }
  }

  // ========== 阶段 4: 密钥系统激活（带锁机制）==========
  
  let secretsDegraded = false;
  
  // 发送密钥状态事件的辅助函数
  const emitSecretsStateEvent = (
    code: "SECRETS_RELOADER_DEGRADED" | "SECRETS_RELOADER_RECOVERED",
    message: string,
    cfg: OpenClawConfig,
  ) => {
    enqueueSystemEvent(`[${code}] ${message}`, {
      sessionKey: resolveMainSessionKey(cfg),
      contextKey: code,
    });
  };
  
  // 密钥激活尾调用 Promise 链
  let secretsActivationTail: Promise<void> = Promise.resolve();
  
  // 带锁的密钥激活操作（避免并发冲突）
  const runWithSecretsActivationLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = secretsActivationTail.then(operation, operation);
    secretsActivationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  };
  
  // 激活运行时密钥的核心函数
  const activateRuntimeSecrets = async (
    config: OpenClawConfig,
    params: { reason: "startup" | "reload" | "restart-check"; activate: boolean },
  ) =>
    await runWithSecretsActivationLock(async () => {
      try {
        // 准备密钥运行时快照
        const prepared = await prepareSecretsRuntimeSnapshot({ config });
        
        if (params.activate) {
          // 激活快照并记录诊断日志
          activateSecretsRuntimeSnapshot(prepared);
          logGatewayAuthSurfaceDiagnostics(prepared);
        }
        
        // 记录所有警告
        for (const warning of prepared.warnings) {
          logSecrets.warn(`[${warning.code}] ${warning.message}`);
        }
        
        // 处理恢复场景
        if (secretsDegraded) {
          const recoveredMessage =
            "Secret resolution recovered; runtime remained on last-known-good during the outage.";
          logSecrets.info(`[SECRETS_RELOADER_RECOVERED] ${recoveredMessage}`);
          emitSecretsStateEvent("SECRETS_RELOADER_RECOVERED", recoveredMessage, prepared.config);
        }
        
        secretsDegraded = false;
        return prepared;
      } catch (err) {
        const details = String(err);
        
        // 处理降级场景
        if (!secretsDegraded) {
          logSecrets.error(`[SECRETS_RELOADER_DEGRADED] ${details}`);
          
          if (params.reason !== "startup") {
            emitSecretsStateEvent(
              "SECRETS_RELOADER_DEGRADED",
              `Secret resolution failed; runtime remains on last-known-good snapshot. ${details}`,
              config,
            );
          }
        } else {
          logSecrets.warn(`[SECRETS_RELOADER_DEGRADED] ${details}`);
        }
        
        secretsDegraded = true;
        
        // 启动时失败直接抛出异常
        if (params.reason === "startup") {
          throw new Error(`Startup failed: required secrets are unavailable. ${details}`, {
            cause: err,
          });
        }
        
        throw err;
      }
    });

  // ========== 阶段 5: 认证引导 ==========
  
  let cfgAtStart: OpenClawConfig;
  const startupRuntimeConfig = applyConfigOverrides(configSnapshot.config);
  const authBootstrap = await prepareGatewayStartupConfig({
    configSnapshot,
    runtimeConfig: startupRuntimeConfig,
    authOverride: opts.auth,
    tailscaleOverride: opts.tailscale,
    activateRuntimeSecrets,
  });
  cfgAtStart = authBootstrap.cfg;
  if (authBootstrap.generatedToken) {
    if (authBootstrap.persistedGeneratedToken) {
      log.info(
        "Gateway auth token was missing. Generated a new token and saved it to config (gateway.auth.token).",
      );
    } else {
      log.warn(
        "Gateway auth token was missing. Generated a runtime token for this startup without changing config; restart will generate a different token. Persist one with `openclaw config set gateway.auth.mode token` and `openclaw config set gateway.auth.token <token>`.",
      );
    }
  }
  const diagnosticsEnabled = isDiagnosticsEnabled(cfgAtStart);
  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat();
  }
  setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(cfgAtStart) });
  setPreRestartDeferralCheck(
    () => getTotalQueueSize() + getTotalPendingReplies() + getActiveEmbeddedRunCount(),
  );
  // Unconditional startup migration: seed gateway.controlUi.allowedOrigins for existing
  // non-loopback installs that upgraded to v2026.2.26+ without required origins.
  cfgAtStart = await maybeSeedControlUiAllowedOriginsAtStartup({
    config: cfgAtStart,
    writeConfig: writeConfigFile,
    log,
  });
  await runStartupMatrixMigration({
    cfg: cfgAtStart,
    env: process.env,
    log,
  });
  const matrixInstallPathIssue = await detectPluginInstallPathIssue({
    pluginId: "matrix",
    install: cfgAtStart.plugins?.installs?.matrix,
  });
  if (matrixInstallPathIssue) {
    const lines = formatPluginInstallPathIssue({
      issue: matrixInstallPathIssue,
      pluginLabel: "Matrix",
      defaultInstallCommand: "openclaw plugins install @openclaw/matrix",
      repoInstallCommand: "openclaw plugins install ./extensions/matrix",
      formatCommand: formatCliCommand,
    });
    log.warn(
      `gateway: matrix install path warning:\n${lines.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }

  // ========== 阶段 6: 插件系统初始化 ==========
  
  initSubagentRegistry();
  const gatewayPluginConfigAtStart = applyPluginAutoEnable({
    config: cfgAtStart,
    env: process.env,
  }).config;
  const defaultAgentId = resolveDefaultAgentId(gatewayPluginConfigAtStart);
  const defaultWorkspaceDir = resolveAgentWorkspaceDir(gatewayPluginConfigAtStart, defaultAgentId);
  const deferredConfiguredChannelPluginIds = minimalTestGateway
    ? []
    : resolveConfiguredDeferredChannelPluginIds({
        config: gatewayPluginConfigAtStart,
        workspaceDir: defaultWorkspaceDir,
        env: process.env,
      });
  const baseMethods = listGatewayMethods();
  const emptyPluginRegistry = createEmptyPluginRegistry();
  let pluginRegistry = emptyPluginRegistry;
  let baseGatewayMethods = baseMethods;
  if (!minimalTestGateway) {
    ({ pluginRegistry, gatewayMethods: baseGatewayMethods } = loadGatewayStartupPlugins({
      cfg: gatewayPluginConfigAtStart,
      workspaceDir: defaultWorkspaceDir,
      log,
      coreGatewayHandlers,
      baseMethods,
      preferSetupRuntimeForChannelPlugins: deferredConfiguredChannelPluginIds.length > 0,
    }));
  } else {
    setActivePluginRegistry(emptyPluginRegistry);
  }
  const channelLogs = Object.fromEntries(
    listChannelPlugins().map((plugin) => [plugin.id, logChannels.child(plugin.id)]),
  ) as Record<ChannelId, ReturnType<typeof createSubsystemLogger>>;
  const channelRuntimeEnvs = Object.fromEntries(
    Object.entries(channelLogs).map(([id, logger]) => [id, runtimeForLogger(logger)]),
  ) as unknown as Record<ChannelId, RuntimeEnv>;
  const channelMethods = listChannelPlugins().flatMap((plugin) => plugin.gatewayMethods ?? []);
  const gatewayMethods = Array.from(new Set([...baseGatewayMethods, ...channelMethods]));
  let pluginServices: PluginServicesHandle | null = null;

  // ========== 阶段 7: 运行时配置解析 ==========
  
  const runtimeConfig = await resolveGatewayRuntimeConfig({
    cfg: cfgAtStart,
    port,
    bind: opts.bind,
    host: opts.host,
    controlUiEnabled: opts.controlUiEnabled,
    openAiChatCompletionsEnabled: opts.openAiChatCompletionsEnabled,
    openResponsesEnabled: opts.openResponsesEnabled,
    auth: opts.auth,
    tailscale: opts.tailscale,
  });
  const {
    bindHost,
    controlUiEnabled,
    openAiChatCompletionsEnabled,
    openAiChatCompletionsConfig,
    openResponsesEnabled,
    openResponsesConfig,
    strictTransportSecurityHeader,
    controlUiBasePath,
    controlUiRoot: controlUiRootOverride,
    resolvedAuth,
    tailscaleConfig,
    tailscaleMode,
  } = runtimeConfig;
  let hooksConfig = runtimeConfig.hooksConfig;
  let hookClientIpConfig = resolveHookClientIpConfig(cfgAtStart);
  const canvasHostEnabled = runtimeConfig.canvasHostEnabled;

  // ========== 阶段 8: 速率限制器创建 ==========
  
  // Create auth rate limiters used by connect/auth flows.
  const rateLimitConfig = cfgAtStart.gateway?.auth?.rateLimit;
  const { rateLimiter: authRateLimiter, browserRateLimiter: browserAuthRateLimiter } =
    createGatewayAuthRateLimiters(rateLimitConfig);

  // ========== 阶段 9: Control UI 状态解析 ==========
  
  let controlUiRootState: ControlUiRootState | undefined;
  if (controlUiRootOverride) {
    const resolvedOverride = resolveControlUiRootOverrideSync(controlUiRootOverride);
    const resolvedOverridePath = path.resolve(controlUiRootOverride);
    controlUiRootState = resolvedOverride
      ? { kind: "resolved", path: resolvedOverride }
      : { kind: "invalid", path: resolvedOverridePath };
    if (!resolvedOverride) {
      log.warn(`gateway: controlUi.root not found at ${resolvedOverridePath}`);
    }
  } else if (controlUiEnabled) {
    let resolvedRoot = resolveControlUiRootSync({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });
    if (!resolvedRoot) {
      const ensureResult = await ensureControlUiAssetsBuilt(gatewayRuntime);
      if (!ensureResult.ok && ensureResult.message) {
        log.warn(`gateway: ${ensureResult.message}`);
      }
      resolvedRoot = resolveControlUiRootSync({
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
        cwd: process.cwd(),
      });
    }
    controlUiRootState = resolvedRoot
      ? {
          kind: isPackageProvenControlUiRootSync(resolvedRoot, {
            moduleUrl: import.meta.url,
            argv1: process.argv[1],
            cwd: process.cwd(),
          })
            ? "bundled"
            : "resolved",
          path: resolvedRoot,
        }
      : { kind: "missing" };
  }

  // ========== 阶段 10: Wizard 会话跟踪 ==========
  
  const wizardRunner = opts.wizardRunner ?? runSetupWizard;
  const { wizardSessions, findRunningWizard, purgeWizardSession } = createWizardSessionTracker();

  // ========== 阶段 11: Channel 管理器创建 ==========
  
  const deps = createDefaultDeps();
  let canvasHostServer: CanvasHostServer | null = null;
  const gatewayTls = await loadGatewayTlsRuntime(cfgAtStart.gateway?.tls, log.child("tls"));
  if (cfgAtStart.gateway?.tls?.enabled && !gatewayTls.enabled) {
    throw new Error(gatewayTls.error ?? "gateway tls: failed to enable");
  }
  const serverStartedAt = Date.now();
  const channelManager = createChannelManager({
    loadConfig: () =>
      applyPluginAutoEnable({
        config: loadConfig(),
        env: process.env,
      }).config,
    channelLogs,
    channelRuntimeEnvs,
    resolveChannelRuntime: getChannelRuntime,
  });
  const getReadiness = createReadinessChecker({
    channelManager,
    startedAt: serverStartedAt,
  });

  // ========== 阶段 12: 网关运行时状态创建 ==========
  
  const {
    canvasHost,
    releasePluginRouteRegistry,
    httpServer,
    httpServers,
    httpBindHosts,
    wss,
    preauthConnectionBudget,
    clients,
    broadcast,
    broadcastToConnIds,
    agentRunSeq,
    dedupe,
    chatRunState,
    chatRunBuffers,
    chatDeltaSentAt,
    chatDeltaLastBroadcastLen,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
    toolEventRecipients,
  } = await createGatewayRuntimeState({
    cfg: cfgAtStart,
    bindHost,
    port,
    controlUiEnabled,
    controlUiBasePath,
    controlUiRoot: controlUiRootState,
    openAiChatCompletionsEnabled,
    openAiChatCompletionsConfig,
    openResponsesEnabled,
    openResponsesConfig,
    strictTransportSecurityHeader,
    resolvedAuth,
    rateLimiter: authRateLimiter,
    gatewayTls,
    hooksConfig: () => hooksConfig,
    getHookClientIpConfig: () => hookClientIpConfig,
    pluginRegistry,
    pinChannelRegistry: !minimalTestGateway,
    deps,
    canvasRuntime,
    canvasHostEnabled,
    allowCanvasHostInTests: opts.allowCanvasHostInTests,
    logCanvas,
    log,
    logHooks,
    logPlugins,
    getReadiness,
  });
  let bonjourStop: (() => Promise<void>) | null = null;
  const noopInterval = () => setInterval(() => {}, 1 << 30);
  let tickInterval = noopInterval();
  let healthInterval = noopInterval();
  let dedupeCleanup = noopInterval();
  let mediaCleanup: ReturnType<typeof setInterval> | null = null;
  let heartbeatRunner: HeartbeatRunner = {
    stop: () => {},
    updateConfig: () => {},
  };
  let stopGatewayUpdateCheck = () => {};
  let tailscaleCleanup: (() => Promise<void>) | null = null;
  let skillsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const skillsRefreshDelayMs = 30_000;
  let skillsChangeUnsub = () => {};
  let channelHealthMonitor: ReturnType<typeof startChannelHealthMonitor> | null = null;
  let stopModelPricingRefresh = () => {};
  let configReloader: { stop: () => Promise<void> } = { stop: async () => {} };
  const closeOnStartupFailure = async () => {
    if (diagnosticsEnabled) {
      stopDiagnosticHeartbeat();
    }
    if (skillsRefreshTimer) {
      clearTimeout(skillsRefreshTimer);
      skillsRefreshTimer = null;
    }
    skillsChangeUnsub();
    authRateLimiter?.dispose();
    browserAuthRateLimiter.dispose();
    stopModelPricingRefresh();
    channelHealthMonitor?.stop();
    clearSecretsRuntimeSnapshot();
    await createGatewayCloseHandler({
      bonjourStop,
      tailscaleCleanup,
      canvasHost,
      canvasHostServer,
      releasePluginRouteRegistry,
      stopChannel,
      pluginServices,
      cron,
      heartbeatRunner,
      updateCheckStop: stopGatewayUpdateCheck,
      nodePresenceTimers,
      broadcast,
      tickInterval,
      healthInterval,
      dedupeCleanup,
      mediaCleanup,
      agentUnsub,
      heartbeatUnsub,
      transcriptUnsub,
      lifecycleUnsub,
      chatRunState,
      clients,
      configReloader,
      wss,
      httpServer,
      httpServers,
    })({ reason: "gateway startup failed" });
  };
  const nodeRegistry = new NodeRegistry();
  const nodePresenceTimers = new Map<string, ReturnType<typeof setInterval>>();
  const nodeSubscriptions = createNodeSubscriptionManager();
  const sessionEventSubscribers = createSessionEventSubscriberRegistry();
  const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
  const nodeSendEvent = (opts: { nodeId: string; event: string; payloadJSON?: string | null }) => {
    const payload = safeParseJson(opts.payloadJSON ?? null);
    nodeRegistry.sendEvent(opts.nodeId, opts.event, payload);
  };
  const nodeSendToSession = (sessionKey: string, event: string, payload: unknown) =>
    nodeSubscriptions.sendToSession(sessionKey, event, payload, nodeSendEvent);
  const nodeSendToAllSubscribed = (event: string, payload: unknown) =>
    nodeSubscriptions.sendToAllSubscribed(event, payload, nodeSendEvent);
  const nodeSubscribe = nodeSubscriptions.subscribe;
  const nodeUnsubscribe = nodeSubscriptions.unsubscribe;
  const nodeUnsubscribeAll = nodeSubscriptions.unsubscribeAll;
  const broadcastVoiceWakeChanged = (triggers: string[]) => {
    broadcast("voicewake.changed", { triggers }, { dropIfSlow: true });
  };
  const hasMobileNodeConnected = () => hasConnectedMobileNode(nodeRegistry);
  applyGatewayLaneConcurrency(cfgAtStart);

  let cronState = buildGatewayCronService({
    cfg: cfgAtStart,
    deps,
    broadcast,
  });
  let { cron, storePath: cronStorePath } = cronState;

  const { getRuntimeSnapshot, startChannels, startChannel, stopChannel, markChannelLoggedOut } =
    channelManager;
  let agentUnsub: (() => void) | null = null;
  let heartbeatUnsub: (() => void) | null = null;
  let transcriptUnsub: (() => void) | null = null;
  let lifecycleUnsub: (() => void) | null = null;
  try {
    if (!minimalTestGateway) {
      const machineDisplayName = await getMachineDisplayName();
      const discovery = await startGatewayDiscovery({
        machineDisplayName,
        port,
        gatewayTls: gatewayTls.enabled
          ? { enabled: true, fingerprintSha256: gatewayTls.fingerprintSha256 }
          : undefined,
        wideAreaDiscoveryEnabled: cfgAtStart.discovery?.wideArea?.enabled === true,
        wideAreaDiscoveryDomain: cfgAtStart.discovery?.wideArea?.domain,
        tailscaleMode,
        mdnsMode: cfgAtStart.discovery?.mdns?.mode,
        logDiscovery,
      });
      bonjourStop = discovery.bonjourStop;
    }

    if (!minimalTestGateway) {
      setSkillsRemoteRegistry(nodeRegistry);
      void primeRemoteSkillsCache();
    }
    // Debounce skills-triggered node probes to avoid feedback loops and rapid-fire invokes.
    // Skills changes can happen in bursts (e.g., file watcher events), and each probe
    // takes time to complete. A 30-second delay ensures we batch changes together.
    skillsChangeUnsub = minimalTestGateway
      ? () => {}
      : registerSkillsChangeListener((event) => {
          if (event.reason === "remote-node") {
            return;
          }
          if (skillsRefreshTimer) {
            clearTimeout(skillsRefreshTimer);
          }
          skillsRefreshTimer = setTimeout(() => {
            skillsRefreshTimer = null;
            const latest = loadConfig();
            void refreshRemoteBinsForConnectedNodes(latest);
          }, skillsRefreshDelayMs);
        });

    if (!minimalTestGateway) {
      ({ tickInterval, healthInterval, dedupeCleanup, mediaCleanup } =
        startGatewayMaintenanceTimers({
          broadcast,
          nodeSendToAllSubscribed,
          getPresenceVersion,
          getHealthVersion,
          refreshGatewayHealthSnapshot,
          logHealth,
          dedupe,
          chatAbortControllers,
          chatRunState,
          chatRunBuffers,
          chatDeltaSentAt,
          chatDeltaLastBroadcastLen,
          removeChatRun,
          agentRunSeq,
          nodeSendToSession,
          ...(typeof cfgAtStart.media?.ttlHours === "number"
            ? { mediaCleanupTtlMs: resolveMediaCleanupTtlMs(cfgAtStart.media.ttlHours) }
            : {}),
        }));
    }

    agentUnsub = minimalTestGateway
      ? null
      : onAgentEvent(
          createAgentEventHandler({
            broadcast,
            broadcastToConnIds,
            nodeSendToSession,
            agentRunSeq,
            chatRunState,
            resolveSessionKeyForRun,
            clearAgentRunContext,
            toolEventRecipients,
            sessionEventSubscribers,
          }),
        );

    heartbeatUnsub = minimalTestGateway
      ? null
      : onHeartbeatEvent((evt) => {
          broadcast("heartbeat", evt, { dropIfSlow: true });
        });

    transcriptUnsub = minimalTestGateway
      ? null
      : onSessionTranscriptUpdate((update) => {
          const sessionKey =
            update.sessionKey ?? resolveSessionKeyForTranscriptFile(update.sessionFile);
          if (!sessionKey || update.message === undefined) {
            return;
          }
          const connIds = new Set<string>();
          for (const connId of sessionEventSubscribers.getAll()) {
            connIds.add(connId);
          }
          for (const connId of sessionMessageSubscribers.get(sessionKey)) {
            connIds.add(connId);
          }
          if (connIds.size === 0) {
            return;
          }
          const { entry, storePath } = loadSessionEntry(sessionKey);
          const messageSeq = entry?.sessionId
            ? readSessionMessages(entry.sessionId, storePath, entry.sessionFile).length
            : undefined;
          const sessionRow = loadGatewaySessionRow(sessionKey);
          const sessionSnapshot = sessionRow
            ? {
                session: sessionRow,
                updatedAt: sessionRow.updatedAt ?? undefined,
                sessionId: sessionRow.sessionId,
                kind: sessionRow.kind,
                channel: sessionRow.channel,
                subject: sessionRow.subject,
                groupChannel: sessionRow.groupChannel,
                space: sessionRow.space,
                chatType: sessionRow.chatType,
                origin: sessionRow.origin,
                spawnedBy: sessionRow.spawnedBy,
                spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
                forkedFromParent: sessionRow.forkedFromParent,
                spawnDepth: sessionRow.spawnDepth,
                subagentRole: sessionRow.subagentRole,
                subagentControlScope: sessionRow.subagentControlScope,
                label: sessionRow.label,
                displayName: sessionRow.displayName,
                deliveryContext: sessionRow.deliveryContext,
                parentSessionKey: sessionRow.parentSessionKey,
                childSessions: sessionRow.childSessions,
                thinkingLevel: sessionRow.thinkingLevel,
                fastMode: sessionRow.fastMode,
                verboseLevel: sessionRow.verboseLevel,
                reasoningLevel: sessionRow.reasoningLevel,
                elevatedLevel: sessionRow.elevatedLevel,
                sendPolicy: sessionRow.sendPolicy,
                systemSent: sessionRow.systemSent,
                abortedLastRun: sessionRow.abortedLastRun,
                inputTokens: sessionRow.inputTokens,
                outputTokens: sessionRow.outputTokens,
                lastChannel: sessionRow.lastChannel,
                lastTo: sessionRow.lastTo,
                lastAccountId: sessionRow.lastAccountId,
                lastThreadId: sessionRow.lastThreadId,
                totalTokens: sessionRow.totalTokens,
                totalTokensFresh: sessionRow.totalTokensFresh,
                contextTokens: sessionRow.contextTokens,
                estimatedCostUsd: sessionRow.estimatedCostUsd,
                responseUsage: sessionRow.responseUsage,
                modelProvider: sessionRow.modelProvider,
                model: sessionRow.model,
                status: sessionRow.status,
                startedAt: sessionRow.startedAt,
                endedAt: sessionRow.endedAt,
                runtimeMs: sessionRow.runtimeMs,
              }
            : {};
          const message = attachOpenClawTranscriptMeta(update.message, {
            ...(typeof update.messageId === "string" ? { id: update.messageId } : {}),
            ...(typeof messageSeq === "number" ? { seq: messageSeq } : {}),
          });
          broadcastToConnIds(
            "session.message",
            {
              sessionKey,
              message,
              ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
              ...(typeof messageSeq === "number" ? { messageSeq } : {}),
              ...sessionSnapshot,
            },
            connIds,
            { dropIfSlow: true },
          );

          const sessionEventConnIds = sessionEventSubscribers.getAll();
          if (sessionEventConnIds.size > 0) {
            broadcastToConnIds(
              "sessions.changed",
              {
                sessionKey,
                phase: "message",
                ts: Date.now(),
                ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
                ...(typeof messageSeq === "number" ? { messageSeq } : {}),
                ...sessionSnapshot,
              },
              sessionEventConnIds,
              { dropIfSlow: true },
            );
          }
        });

    lifecycleUnsub = minimalTestGateway
      ? null
      : onSessionLifecycleEvent((event) => {
          const connIds = sessionEventSubscribers.getAll();
          if (connIds.size === 0) {
            return;
          }
          const sessionRow = loadGatewaySessionRow(event.sessionKey);
          broadcastToConnIds(
            "sessions.changed",
            {
              sessionKey: event.sessionKey,
              reason: event.reason,
              parentSessionKey: event.parentSessionKey,
              label: event.label,
              displayName: event.displayName,
              ts: Date.now(),
              ...(sessionRow
                ? {
                    updatedAt: sessionRow.updatedAt ?? undefined,
                    sessionId: sessionRow.sessionId,
                    kind: sessionRow.kind,
                    channel: sessionRow.channel,
                    subject: sessionRow.subject,
                    groupChannel: sessionRow.groupChannel,
                    space: sessionRow.space,
                    chatType: sessionRow.chatType,
                    origin: sessionRow.origin,
                    spawnedBy: sessionRow.spawnedBy,
                    spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
                    forkedFromParent: sessionRow.forkedFromParent,
                    spawnDepth: sessionRow.spawnDepth,
                    subagentRole: sessionRow.subagentRole,
                    subagentControlScope: sessionRow.subagentControlScope,
                    label: event.label ?? sessionRow.label,
                    displayName: event.displayName ?? sessionRow.displayName,
                    deliveryContext: sessionRow.deliveryContext,
                    parentSessionKey: event.parentSessionKey ?? sessionRow.parentSessionKey,
                    childSessions: sessionRow.childSessions,
                    thinkingLevel: sessionRow.thinkingLevel,
                    fastMode: sessionRow.fastMode,
                    verboseLevel: sessionRow.verboseLevel,
                    reasoningLevel: sessionRow.reasoningLevel,
                    elevatedLevel: sessionRow.elevatedLevel,
                    sendPolicy: sessionRow.sendPolicy,
                    systemSent: sessionRow.systemSent,
                    abortedLastRun: sessionRow.abortedLastRun,
                    inputTokens: sessionRow.inputTokens,
                    outputTokens: sessionRow.outputTokens,
                    lastChannel: sessionRow.lastChannel,
                    lastTo: sessionRow.lastTo,
                    lastAccountId: sessionRow.lastAccountId,
                    lastThreadId: sessionRow.lastThreadId,
                    totalTokens: sessionRow.totalTokens,
                    totalTokensFresh: sessionRow.totalTokensFresh,
                    contextTokens: sessionRow.contextTokens,
                    estimatedCostUsd: sessionRow.estimatedCostUsd,
                    responseUsage: sessionRow.responseUsage,
                    modelProvider: sessionRow.modelProvider,
                    model: sessionRow.model,
                    status: sessionRow.status,
                    startedAt: sessionRow.startedAt,
                    endedAt: sessionRow.endedAt,
                    runtimeMs: sessionRow.runtimeMs,
                  }
                : {}),
            },
            connIds,
            { dropIfSlow: true },
          );
        });

    if (!minimalTestGateway) {
      heartbeatRunner = startHeartbeatRunner({ cfg: cfgAtStart });
    }

    const healthCheckMinutes = cfgAtStart.gateway?.channelHealthCheckMinutes;
    const healthCheckDisabled = healthCheckMinutes === 0;
    const staleEventThresholdMinutes = cfgAtStart.gateway?.channelStaleEventThresholdMinutes;
    const maxRestartsPerHour = cfgAtStart.gateway?.channelMaxRestartsPerHour;
    channelHealthMonitor = healthCheckDisabled
      ? null
      : startChannelHealthMonitor({
          channelManager,
          checkIntervalMs: (healthCheckMinutes ?? 5) * 60_000,
          ...(staleEventThresholdMinutes != null && {
            staleEventThresholdMs: staleEventThresholdMinutes * 60_000,
          }),
          ...(maxRestartsPerHour != null && { maxRestartsPerHour }),
        });

    if (!minimalTestGateway) {
      void cron.start().catch((err) => logCron.error(`failed to start: ${String(err)}`));
    }

    stopModelPricingRefresh =
      !minimalTestGateway && process.env.VITEST !== "1"
        ? startGatewayModelPricingRefresh({ config: cfgAtStart })
        : () => {};

    // Recover pending outbound deliveries from previous crash/restart.
    if (!minimalTestGateway) {
      void (async () => {
        const { recoverPendingDeliveries } = await import("../infra/outbound/delivery-queue.js");
        const { deliverOutboundPayloads } = await import("../infra/outbound/deliver.js");
        const logRecovery = log.child("delivery-recovery");
        await recoverPendingDeliveries({
          deliver: deliverOutboundPayloads,
          log: logRecovery,
          cfg: cfgAtStart,
        });
      })().catch((err) => log.error(`Delivery recovery failed: ${String(err)}`));
    }

    const execApprovalManager = new ExecApprovalManager();
    const execApprovalForwarder = createExecApprovalForwarder();
    const execApprovalHandlers = createExecApprovalHandlers(execApprovalManager, {
      forwarder: execApprovalForwarder,
    });
    const pluginApprovalManager = new ExecApprovalManager<
      import("../infra/plugin-approvals.js").PluginApprovalRequestPayload
    >();
    const pluginApprovalHandlers = createPluginApprovalHandlers(pluginApprovalManager, {
      forwarder: execApprovalForwarder,
    });
    const secretsHandlers = createSecretsHandlers({
      reloadSecrets: async () => {
        const active = getActiveSecretsRuntimeSnapshot();
        if (!active) {
          throw new Error("Secrets runtime snapshot is not active.");
        }
        const prepared = await activateRuntimeSecrets(active.sourceConfig, {
          reason: "reload",
          activate: true,
        });
        return { warningCount: prepared.warnings.length };
      },
      resolveSecrets: async ({ commandName, targetIds }) => {
        const { assignments, diagnostics, inactiveRefPaths } =
          resolveCommandSecretsFromActiveRuntimeSnapshot({
            commandName,
            targetIds: new Set(targetIds),
          });
        if (assignments.length === 0) {
          return { assignments: [] as CommandSecretAssignment[], diagnostics, inactiveRefPaths };
        }
        return { assignments, diagnostics, inactiveRefPaths };
      },
    });

    const canvasHostServerPort = (canvasHostServer as CanvasHostServer | null)?.port;

    const gatewayRequestContext: import("./server-methods/types.js").GatewayRequestContext = {
      deps,
      cron,
      cronStorePath,
      execApprovalManager,
      pluginApprovalManager,
      loadGatewayModelCatalog,
      getHealthCache,
      refreshHealthSnapshot: refreshGatewayHealthSnapshot,
      logHealth,
      logGateway: log,
      incrementPresenceVersion,
      getHealthVersion,
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      nodeSendToAllSubscribed,
      nodeSubscribe,
      nodeUnsubscribe,
      nodeUnsubscribeAll,
      hasConnectedMobileNode: hasMobileNodeConnected,
      hasExecApprovalClients: (excludeConnId?: string) => {
        for (const gatewayClient of clients) {
          if (excludeConnId && gatewayClient.connId === excludeConnId) {
            continue;
          }
          const scopes = Array.isArray(gatewayClient.connect.scopes)
            ? gatewayClient.connect.scopes
            : [];
          if (scopes.includes("operator.admin") || scopes.includes("operator.approvals")) {
            return true;
          }
        }
        return false;
      },
      disconnectClientsForDevice: (deviceId: string, opts?: { role?: string }) => {
        for (const gatewayClient of clients) {
          if (gatewayClient.connect.device?.id !== deviceId) {
            continue;
          }
          if (opts?.role && gatewayClient.connect.role !== opts.role) {
            continue;
          }
          try {
            gatewayClient.socket.close(4001, "device removed");
          } catch {
            /* ignore */
          }
        }
      },
      nodeRegistry,
      agentRunSeq,
      chatAbortControllers,
      chatAbortedRuns: chatRunState.abortedRuns,
      chatRunBuffers: chatRunState.buffers,
      chatDeltaSentAt: chatRunState.deltaSentAt,
      chatDeltaLastBroadcastLen: chatRunState.deltaLastBroadcastLen,
      addChatRun,
      removeChatRun,
      subscribeSessionEvents: sessionEventSubscribers.subscribe,
      unsubscribeSessionEvents: sessionEventSubscribers.unsubscribe,
      subscribeSessionMessageEvents: sessionMessageSubscribers.subscribe,
      unsubscribeSessionMessageEvents: sessionMessageSubscribers.unsubscribe,
      unsubscribeAllSessionEvents: (connId: string) => {
        sessionEventSubscribers.unsubscribe(connId);
        sessionMessageSubscribers.unsubscribeAll(connId);
      },
      getSessionEventSubscriberConnIds: sessionEventSubscribers.getAll,
      registerToolEventRecipient: toolEventRecipients.add,
      dedupe,
      wizardSessions,
      findRunningWizard,
      purgeWizardSession,
      getRuntimeSnapshot,
      startChannel,
      stopChannel,
      markChannelLoggedOut,
      wizardRunner,
      broadcastVoiceWakeChanged,
    };

    // Register a lazy fallback for plugin subagent dispatch in non-WS paths
    // (Telegram polling, WhatsApp, etc.) so later runtime swaps can expose the
    // current gateway context without relying on a startup snapshot.
    setFallbackGatewayContextResolver(() => gatewayRequestContext);

    attachGatewayWsHandlers({
      wss,
      clients,
      preauthConnectionBudget,
      port,
      gatewayHost: bindHost ?? undefined,
      canvasHostEnabled: Boolean(canvasHost),
      canvasHostServerPort,
      resolvedAuth,
      rateLimiter: authRateLimiter,
      browserRateLimiter: browserAuthRateLimiter,
      gatewayMethods,
      events: GATEWAY_EVENTS,
      logGateway: log,
      logHealth,
      logWsControl,
      extraHandlers: {
        ...pluginRegistry.gatewayHandlers,
        ...execApprovalHandlers,
        ...pluginApprovalHandlers,
        ...secretsHandlers,
      },
      broadcast,
      context: gatewayRequestContext,
    });
    logGatewayStartup({
      cfg: cfgAtStart,
      bindHost,
      bindHosts: httpBindHosts,
      port,
      tlsEnabled: gatewayTls.enabled,
      log,
      isNixMode,
    });
    stopGatewayUpdateCheck = minimalTestGateway
      ? () => {}
      : scheduleGatewayUpdateCheck({
          cfg: cfgAtStart,
          log,
          isNixMode,
          onUpdateAvailableChange: (updateAvailable) => {
            const payload: GatewayUpdateAvailableEventPayload = { updateAvailable };
            broadcast(GATEWAY_EVENT_UPDATE_AVAILABLE, payload, { dropIfSlow: true });
          },
        });
    tailscaleCleanup = minimalTestGateway
      ? null
      : await startGatewayTailscaleExposure({
          tailscaleMode,
          resetOnExit: tailscaleConfig.resetOnExit,
          port,
          controlUiBasePath,
          logTailscale,
        });

    if (!minimalTestGateway) {
      if (deferredConfiguredChannelPluginIds.length > 0) {
        ({ pluginRegistry } = reloadDeferredGatewayPlugins({
          cfg: gatewayPluginConfigAtStart,
          workspaceDir: defaultWorkspaceDir,
          log,
          coreGatewayHandlers,
          baseMethods,
          logDiagnostics: false,
        }));
      }
      ({ pluginServices } = await startGatewaySidecars({
        cfg: gatewayPluginConfigAtStart,
        pluginRegistry,
        defaultWorkspaceDir,
        deps,
        startChannels,
        log,
        logHooks,
        logChannels,
      }));
    }

    // Run gateway_start plugin hook (fire-and-forget)
    if (!minimalTestGateway) {
      const hookRunner = getGlobalHookRunner();
      if (hookRunner?.hasHooks("gateway_start")) {
        void hookRunner.runGatewayStart({ port }, { port }).catch((err) => {
          log.warn(`gateway_start hook failed: ${String(err)}`);
        });
      }
    }

    configReloader = minimalTestGateway
      ? { stop: async () => {} }
      : (() => {
          const { applyHotReload, requestGatewayRestart } = createGatewayReloadHandlers({
            deps,
            broadcast,
            getState: () => ({
              hooksConfig,
              hookClientIpConfig,
              heartbeatRunner,
              cronState,
              channelHealthMonitor,
            }),
            setState: (nextState) => {
              hooksConfig = nextState.hooksConfig;
              hookClientIpConfig = nextState.hookClientIpConfig;
              heartbeatRunner = nextState.heartbeatRunner;
              cronState = nextState.cronState;
              cron = cronState.cron;
              cronStorePath = cronState.storePath;
              channelHealthMonitor = nextState.channelHealthMonitor;
            },
            startChannel,
            stopChannel,
            logHooks,
            logChannels,
            logCron,
            logReload,
            createHealthMonitor: (opts: {
              checkIntervalMs: number;
              staleEventThresholdMs?: number;
              maxRestartsPerHour?: number;
            }) =>
              startChannelHealthMonitor({
                channelManager,
                checkIntervalMs: opts.checkIntervalMs,
                ...(opts.staleEventThresholdMs != null && {
                  staleEventThresholdMs: opts.staleEventThresholdMs,
                }),
                ...(opts.maxRestartsPerHour != null && {
                  maxRestartsPerHour: opts.maxRestartsPerHour,
                }),
              }),
          });

          return startGatewayConfigReloader({
            initialConfig: cfgAtStart,
            readSnapshot: readConfigFileSnapshot,
            onHotReload: async (plan, nextConfig) => {
              const previousSnapshot = getActiveSecretsRuntimeSnapshot();
              const prepared = await activateRuntimeSecrets(nextConfig, {
                reason: "reload",
                activate: true,
              });
              try {
                await applyHotReload(plan, prepared.config);
              } catch (err) {
                if (previousSnapshot) {
                  activateSecretsRuntimeSnapshot(previousSnapshot);
                } else {
                  clearSecretsRuntimeSnapshot();
                }
                throw err;
              }
            },
            onRestart: async (plan, nextConfig) => {
              await activateRuntimeSecrets(nextConfig, {
                reason: "restart-check",
                activate: false,
              });
              requestGatewayRestart(plan, nextConfig);
            },
            log: {
              info: (msg) => logReload.info(msg),
              warn: (msg) => logReload.warn(msg),
              error: (msg) => logReload.error(msg),
            },
            watchPath: configSnapshot.path,
          });
        })();
  } catch (err) {
    await closeOnStartupFailure();
    throw err;
  }

  const close = createGatewayCloseHandler({
    bonjourStop,
    tailscaleCleanup,
    canvasHost,
    canvasHostServer,
    releasePluginRouteRegistry,
    stopChannel,
    pluginServices,
    cron,
    heartbeatRunner,
    updateCheckStop: stopGatewayUpdateCheck,
    nodePresenceTimers,
    broadcast,
    tickInterval,
    healthInterval,
    dedupeCleanup,
    mediaCleanup,
    agentUnsub,
    heartbeatUnsub,
    transcriptUnsub,
    lifecycleUnsub,
    chatRunState,
    clients,
    configReloader,
    wss,
    httpServer,
    httpServers,
  });

  return {
    close: async (opts) => {
      // Run gateway_stop plugin hook before shutdown
      await runGlobalGatewayStopSafely({
        event: { reason: opts?.reason ?? "gateway stopping" },
        ctx: { port },
        onError: (err) => log.warn(`gateway_stop hook failed: ${String(err)}`),
      });
      if (diagnosticsEnabled) {
        stopDiagnosticHeartbeat();
      }
      if (skillsRefreshTimer) {
        clearTimeout(skillsRefreshTimer);
        skillsRefreshTimer = null;
      }
      skillsChangeUnsub();
      authRateLimiter?.dispose();
      browserAuthRateLimiter.dispose();
      stopModelPricingRefresh();
      channelHealthMonitor?.stop();
      clearSecretsRuntimeSnapshot();
      await close(opts);
    },
  };
}
