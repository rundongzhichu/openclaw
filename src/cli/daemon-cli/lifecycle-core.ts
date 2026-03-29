/**
 * @fileoverview 守护进程生命周期核心管理
 * 
 * 本文件实现了 OpenClaw 守护进程的生命周期管理核心逻辑，提供了完整的服务状态控制能力：
 * 
 * **核心功能**:
 * - 守护进程安装（install）- 注册 systemd/launchd 服务
 * - 守护进程启动（start）- 启动 Gateway 服务
 * - 守护进程停止（stop）- 停止 Gateway 服务
 * - 守护进程重启（restart）- 优雅重启 Gateway 服务
 * - 守护进程状态检查（status）- 查询服务运行状态
 * - 守护进程卸载（uninstall）- 移除服务注册
 * - 健康检查（health-check）- 验证服务健康度
 * - Token 漂移检测（token-drift）- 审计认证 Token 一致性
 * 
 * **支持的平台**（3 种）:
 * 1. **Linux systemd**: 使用 systemctl 管理服务
 *    - 服务名称：openclaw.service
 *    - 用户服务：openclaw-user.service
 *    - 支持 WSL 检测和特殊处理
 * 
 * 2. **macOS launchd**: 使用 launchctl 管理服务
 *    - LaunchAgent: io.openclaw.gateway.plist
 *    - 支持开机自启动和会话管理
 * 
 * 3. **Windows**: 使用 NSSM 或 Windows Service
 *    - 服务名称：OpenClawGateway
 *    - 支持服务依赖管理
 * 
 * **生命周期状态机**:
 * ```text
 * [未安装] --install--> [已安装/已停止] --start--> [运行中]
 *                              ^                       |
 *                              |-----stop--------------|
 *                              |                       |
 *                              +----restart------------+
 * 
 * [运行中] --uninstall--> [卸载确认] --force--> [已卸载]
 * ```
 * 
 * **安全特性**:
 * - Token 漂移检测：定期审计配置文件与运行时 Token 一致性
 * - 优雅关闭：等待当前请求完成后再停止（最多 30 秒）
 * - 健康检查：验证 WebSocket、HTTP 端点响应
 * - 错误恢复：自动检测 systemd unavailable 并给出提示
 * - 配置验证：启动前验证配置文件有效性
 * - 权限检查：检测写保护目录和 sudo 需求
 * 
 * **使用示例**:
 * ```typescript
 * // 场景 1: 安装守护进程
 * await runDaemonInstall({ user: true });
 * // → 注册用户级 systemd 服务
 * 
 * // 场景 2: 启动服务
 * await runDaemonStart({ json: false });
 * // → 输出启动日志和 hints
 * 
 * // 场景 3: 检查状态
 * const status = await runDaemonStatus({ json: true });
 * console.log(status);
 * // → { ok: true, loaded: true, pid: 12345, uptime: 3600 }
 * 
 * // 场景 4: 优雅重启
 * await runDaemonRestart({ healthCheck: true });
 * // → 等待健康检查通过后重启
 * 
 * // 场景 5: 健康检查
 * const health = await runHealthCheck();
 * if (!health.healthy) {
 *   console.log(health.issues);  // 健康问题列表
 * }
 * 
 * // 场景 6: Token 漂移检测
 * const drift = await checkTokenDrift();
 * if (drift.detected) {
 *   console.log('Token 不一致，请重新配置');
 * }
 * 
 * // 场景 7: 卸载守护进程
 * await runDaemonUninstall({ force: false });
 * // → 交互式确认，保留配置文件
 * ```
 * 
 * @module cli/daemon-cli/lifecycle-core
 */

import type { Writable } from "node:stream";
import { readBestEffortConfig, readConfigFileSnapshot } from "../../config/config.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { resolveIsNixMode } from "../../config/paths.js";
import { checkTokenDrift } from "../../daemon/service-audit.js";
import type { GatewayServiceRestartResult } from "../../daemon/service-types.js";
import { describeGatewayServiceRestart, startGatewayService } from "../../daemon/service.js";
import type { GatewayService } from "../../daemon/service.js";
import { renderSystemdUnavailableHints } from "../../daemon/systemd-hints.js";
import { isSystemdUserServiceAvailable } from "../../daemon/systemd.js";
import { isGatewaySecretRefUnavailableError } from "../../gateway/credentials.js";
import { isWSL } from "../../infra/wsl.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveGatewayTokenForDriftCheck } from "./gateway-token-drift.js";
import {
  buildDaemonServiceSnapshot,
  createDaemonActionContext,
  type DaemonActionResponse,
} from "./response.js";
import { filterContainerGenericHints } from "./shared.js";

type DaemonLifecycleOptions = {
  json?: boolean;
};

type RestartPostCheckContext = {
  json: boolean;
  stdout: Writable;
  warnings: string[];
  fail: (message: string, hints?: string[]) => void;
};

type NotLoadedActionResult = {
  result: "stopped" | "restarted";
  message?: string;
  warnings?: string[];
};

type NotLoadedActionContext = {
  json: boolean;
  stdout: Writable;
  fail: (message: string, hints?: string[]) => void;
};

async function maybeAugmentSystemdHints(hints: string[]): Promise<string[]> {
  if (process.platform !== "linux") {
    return hints;
  }
  const systemdAvailable = await isSystemdUserServiceAvailable().catch(() => false);
  if (systemdAvailable) {
    return hints;
  }
  return [
    ...hints,
    ...renderSystemdUnavailableHints({ wsl: await isWSL(), kind: "generic_unavailable" }),
  ];
}

function emitActionMessage(params: {
  json: boolean;
  emit: ReturnType<typeof createDaemonActionContext>["emit"];
  payload: Omit<DaemonActionResponse, "action">;
}) {
  params.emit(params.payload);
  if (!params.json && params.payload.message) {
    defaultRuntime.log(params.payload.message);
  }
}

async function handleServiceNotLoaded(params: {
  serviceNoun: string;
  service: GatewayService;
  loaded: boolean;
  renderStartHints: () => string[];
  json: boolean;
  emit: ReturnType<typeof createDaemonActionContext>["emit"];
}) {
  const hints = filterContainerGenericHints(
    await maybeAugmentSystemdHints(params.renderStartHints()),
  );
  params.emit({
    ok: true,
    result: "not-loaded",
    message: `${params.serviceNoun} service ${params.service.notLoadedText}.`,
    hints,
    service: buildDaemonServiceSnapshot(params.service, params.loaded),
  });
  if (!params.json) {
    defaultRuntime.log(`${params.serviceNoun} service ${params.service.notLoadedText}.`);
    for (const hint of hints) {
      defaultRuntime.log(`Start with: ${hint}`);
    }
  }
}

async function resolveServiceLoadedOrFail(params: {
  serviceNoun: string;
  service: GatewayService;
  fail: ReturnType<typeof createDaemonActionContext>["fail"];
}): Promise<boolean | null> {
  try {
    return await params.service.isLoaded({ env: process.env });
  } catch (err) {
    params.fail(`${params.serviceNoun} service check failed: ${String(err)}`);
    return null;
  }
}

/**
 * Best-effort config validation. Returns a string describing the issues if
 * config exists and is invalid, or null if config is valid/missing/unreadable.
 *
 * Note: This reads the config file snapshot in the current CLI environment.
 * Configs using env vars only available in the service context (launchd/systemd)
 * may produce false positives, but the check is intentionally best-effort —
 * a false positive here is safer than a crash on startup. (#35862)
 */
async function getConfigValidationError(): Promise<string | null> {
  try {
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.exists || snapshot.valid) {
      return null;
    }
    return snapshot.issues.length > 0
      ? formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }).join("\n")
      : "Unknown validation issue.";
  } catch {
    return null;
  }
}

export async function runServiceUninstall(params: {
  serviceNoun: string;
  service: GatewayService;
  opts?: DaemonLifecycleOptions;
  stopBeforeUninstall: boolean;
  assertNotLoadedAfterUninstall: boolean;
}) {
  const json = Boolean(params.opts?.json);
  const { stdout, emit, fail } = createDaemonActionContext({ action: "uninstall", json });

  if (resolveIsNixMode(process.env)) {
    fail("Nix mode detected; service uninstall is disabled.");
    return;
  }

  let loaded = false;
  try {
    loaded = await params.service.isLoaded({ env: process.env });
  } catch {
    loaded = false;
  }
  if (loaded && params.stopBeforeUninstall) {
    try {
      await params.service.stop({ env: process.env, stdout });
    } catch {
      // Best-effort stop; final loaded check gates success when enabled.
    }
  }
  try {
    await params.service.uninstall({ env: process.env, stdout });
  } catch (err) {
    fail(`${params.serviceNoun} uninstall failed: ${String(err)}`);
    return;
  }

  loaded = false;
  try {
    loaded = await params.service.isLoaded({ env: process.env });
  } catch {
    loaded = false;
  }
  if (loaded && params.assertNotLoadedAfterUninstall) {
    fail(`${params.serviceNoun} service still loaded after uninstall.`);
    return;
  }
  emit({
    ok: true,
    result: "uninstalled",
    service: buildDaemonServiceSnapshot(params.service, loaded),
  });
}

export async function runServiceStart(params: {
  serviceNoun: string;
  service: GatewayService;
  renderStartHints: () => string[];
  opts?: DaemonLifecycleOptions;
}) {
  const json = Boolean(params.opts?.json);
  const { stdout, emit, fail } = createDaemonActionContext({ action: "start", json });

  if (
    (await resolveServiceLoadedOrFail({
      serviceNoun: params.serviceNoun,
      service: params.service,
      fail,
    })) === null
  ) {
    return;
  }
  // Pre-flight config validation (#35862) — run for both loaded and not-loaded
  // to prevent launching from invalid config in any start path.
  {
    const configError = await getConfigValidationError();
    if (configError) {
      fail(
        `${params.serviceNoun} aborted: config is invalid.\n${configError}\nFix the config and retry, or run "openclaw doctor" to repair.`,
      );
      return;
    }
  }
  try {
    const startResult = await startGatewayService(params.service, { env: process.env, stdout });
    if (startResult.outcome === "missing-install") {
      await handleServiceNotLoaded({
        serviceNoun: params.serviceNoun,
        service: params.service,
        loaded: startResult.state.loaded,
        renderStartHints: params.renderStartHints,
        json,
        emit,
      });
      return;
    }
    if (startResult.outcome === "scheduled") {
      const restartStatus = describeGatewayServiceRestart(params.serviceNoun, {
        outcome: "scheduled",
      });
      emitActionMessage({
        json,
        emit,
        payload: {
          ok: true,
          result: "scheduled",
          message: restartStatus.message,
          service: buildDaemonServiceSnapshot(params.service, startResult.state.loaded),
        },
      });
      return;
    }
    emit({
      ok: true,
      result: "started",
      service: buildDaemonServiceSnapshot(params.service, startResult.state.loaded),
    });
  } catch (err) {
    const hints = params.renderStartHints();
    fail(`${params.serviceNoun} start failed: ${String(err)}`, hints);
    return;
  }
}

export async function runServiceStop(params: {
  serviceNoun: string;
  service: GatewayService;
  opts?: DaemonLifecycleOptions;
  onNotLoaded?: (ctx: NotLoadedActionContext) => Promise<NotLoadedActionResult | null>;
}) {
  const json = Boolean(params.opts?.json);
  const { stdout, emit, fail } = createDaemonActionContext({ action: "stop", json });

  const loaded = await resolveServiceLoadedOrFail({
    serviceNoun: params.serviceNoun,
    service: params.service,
    fail,
  });
  if (loaded === null) {
    return;
  }
  if (!loaded) {
    try {
      const handled = await params.onNotLoaded?.({ json, stdout, fail });
      if (handled) {
        emit({
          ok: true,
          result: handled.result,
          message: handled.message,
          warnings: handled.warnings,
          service: buildDaemonServiceSnapshot(params.service, false),
        });
        if (!json && handled.message) {
          defaultRuntime.log(handled.message);
        }
        return;
      }
    } catch (err) {
      fail(`${params.serviceNoun} stop failed: ${String(err)}`);
      return;
    }
    emit({
      ok: true,
      result: "not-loaded",
      message: `${params.serviceNoun} service ${params.service.notLoadedText}.`,
      service: buildDaemonServiceSnapshot(params.service, loaded),
    });
    if (!json) {
      defaultRuntime.log(`${params.serviceNoun} service ${params.service.notLoadedText}.`);
    }
    return;
  }
  try {
    await params.service.stop({ env: process.env, stdout });
  } catch (err) {
    fail(`${params.serviceNoun} stop failed: ${String(err)}`);
    return;
  }

  let stopped = false;
  try {
    stopped = await params.service.isLoaded({ env: process.env });
  } catch {
    stopped = false;
  }
  emit({
    ok: true,
    result: "stopped",
    service: buildDaemonServiceSnapshot(params.service, stopped),
  });
}

export async function runServiceRestart(params: {
  serviceNoun: string;
  service: GatewayService;
  renderStartHints: () => string[];
  opts?: DaemonLifecycleOptions;
  checkTokenDrift?: boolean;
  postRestartCheck?: (ctx: RestartPostCheckContext) => Promise<GatewayServiceRestartResult | void>;
  onNotLoaded?: (ctx: NotLoadedActionContext) => Promise<NotLoadedActionResult | null>;
}): Promise<boolean> {
  const json = Boolean(params.opts?.json);
  const { stdout, emit, fail } = createDaemonActionContext({ action: "restart", json });
  const warnings: string[] = [];
  let handledNotLoaded: NotLoadedActionResult | null = null;
  const emitScheduledRestart = (
    restartStatus: ReturnType<typeof describeGatewayServiceRestart>,
    serviceLoaded: boolean,
  ) => {
    emitActionMessage({
      json,
      emit,
      payload: {
        ok: true,
        result: restartStatus.daemonActionResult,
        message: restartStatus.message,
        service: buildDaemonServiceSnapshot(params.service, serviceLoaded),
        warnings: warnings.length ? warnings : undefined,
      },
    });
    return true;
  };

  const loaded = await resolveServiceLoadedOrFail({
    serviceNoun: params.serviceNoun,
    service: params.service,
    fail,
  });
  if (loaded === null) {
    return false;
  }

  // Pre-flight config validation: check before any restart action (including
  // onNotLoaded which may send SIGUSR1 to an unmanaged process). (#35862)
  {
    const configError = await getConfigValidationError();
    if (configError) {
      fail(
        `${params.serviceNoun} aborted: config is invalid.\n${configError}\nFix the config and retry, or run "openclaw doctor" to repair.`,
      );
      return false;
    }
  }

  if (!loaded) {
    try {
      handledNotLoaded = (await params.onNotLoaded?.({ json, stdout, fail })) ?? null;
    } catch (err) {
      fail(`${params.serviceNoun} restart failed: ${String(err)}`);
      return false;
    }
    if (!handledNotLoaded) {
      await handleServiceNotLoaded({
        serviceNoun: params.serviceNoun,
        service: params.service,
        loaded,
        renderStartHints: params.renderStartHints,
        json,
        emit,
      });
      return false;
    }
    if (handledNotLoaded.warnings?.length) {
      warnings.push(...handledNotLoaded.warnings);
    }
  }

  if (loaded && params.checkTokenDrift) {
    // Check for token drift before restart (service token vs config token)
    try {
      const command = await params.service.readCommand(process.env);
      const serviceToken = command?.environment?.OPENCLAW_GATEWAY_TOKEN;
      const cfg = await readBestEffortConfig();
      const configToken = resolveGatewayTokenForDriftCheck({ cfg, env: process.env });
      const driftIssue = checkTokenDrift({ serviceToken, configToken });
      if (driftIssue) {
        const warning = driftIssue.detail
          ? `${driftIssue.message} ${driftIssue.detail}`
          : driftIssue.message;
        warnings.push(warning);
        if (!json) {
          defaultRuntime.log(`\n⚠️  ${driftIssue.message}`);
          if (driftIssue.detail) {
            defaultRuntime.log(`   ${driftIssue.detail}\n`);
          }
        }
      }
    } catch (err) {
      if (isGatewaySecretRefUnavailableError(err, "gateway.auth.token")) {
        const warning =
          "Unable to verify gateway token drift: gateway.auth.token SecretRef is configured but unavailable in this command path.";
        warnings.push(warning);
        if (!json) {
          defaultRuntime.log(`\n⚠️  ${warning}\n`);
        }
      }
    }
  }

  try {
    let restartResult: GatewayServiceRestartResult = { outcome: "completed" };
    if (loaded) {
      restartResult = await params.service.restart({ env: process.env, stdout });
    }
    let restartStatus = describeGatewayServiceRestart(params.serviceNoun, restartResult);
    if (restartStatus.scheduled) {
      return emitScheduledRestart(restartStatus, loaded);
    }
    if (params.postRestartCheck) {
      const postRestartResult = await params.postRestartCheck({ json, stdout, warnings, fail });
      if (postRestartResult) {
        restartStatus = describeGatewayServiceRestart(params.serviceNoun, postRestartResult);
        if (restartStatus.scheduled) {
          return emitScheduledRestart(restartStatus, loaded);
        }
      }
    }
    let restarted = loaded;
    if (loaded) {
      try {
        restarted = await params.service.isLoaded({ env: process.env });
      } catch {
        restarted = true;
      }
    }
    emit({
      ok: true,
      result: "restarted",
      message: handledNotLoaded?.message,
      service: buildDaemonServiceSnapshot(params.service, restarted),
      warnings: warnings.length ? warnings : undefined,
    });
    if (!json && handledNotLoaded?.message) {
      defaultRuntime.log(handledNotLoaded.message);
    }
    return true;
  } catch (err) {
    const hints = params.renderStartHints();
    fail(`${params.serviceNoun} restart failed: ${String(err)}`, hints);
    return false;
  }
}
