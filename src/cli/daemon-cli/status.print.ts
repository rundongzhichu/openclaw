import { resolveControlUiLinks } from "../../commands/onboard-helpers.js";
import { formatConfigIssueLine } from "../../config/issue-format.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
} from "../../daemon/constants.js";
import { renderGatewayServiceCleanupHints } from "../../daemon/inspect.js";
import { resolveGatewayLogPaths } from "../../daemon/launchd.js";
import {
  isSystemdUnavailableDetail,
  renderSystemdUnavailableHints,
} from "../../daemon/systemd-hints.js";
import { classifySystemdUnavailableDetail } from "../../daemon/systemd-unavailable.js";
import { isWSLEnv } from "../../infra/wsl.js";
import { getResolvedLoggerSettings } from "../../logging.js";
import { defaultRuntime } from "../../runtime.js";
import { colorize } from "../../terminal/theme.js";
import { shortenHomePath } from "../../utils.js";
import { formatCliCommand } from "../command-format.js";
import {
  createCliStatusTextStyles,
  filterDaemonEnv,
  formatRuntimeStatus,
  resolveDaemonContainerContext,
  resolveRuntimeStatusColor,
  renderRuntimeHints,
  safeDaemonEnv,
} from "./shared.js";
import {
  type DaemonStatus,
  renderPortDiagnosticsForCli,
  resolvePortListeningAddresses,
} from "./status.gather.js";

/**
 * @fileoverview 守护进程状态打印与格式化
 * 
 * 本文件实现了 OpenClaw 守护进程状态的 CLI 打印与格式化逻辑，提供了友好的用户界面输出能力：
 * 
 * **核心功能**:
 * - 服务状态打印（加载状态、命令、工作目录、环境变量）
 * - RPC 连接信息显示（WebSocket URL、认证状态）
 * - Gateway 运行时状态（端口、绑定主机、TLS 状态）
 * - 配置审计报告（Token 漂移、多实例冲突、遗留问题）
 * - 端口诊断信息（占用情况、监听地址）
 * - Control UI 链接生成（HTTP/WebSocket 入口）
 * - systemd/launchd 服务提示（不可用检测、WSL 特殊处理）
 * - JSON 输出模式（机器可读、脱敏处理）
 * 
 * **输出模式**（2 种）:
 * 1. **人类可读模式** (json=false):
 *    - 使用彩色终端样式（rich/label/accent/infoText）
 *    - 结构化分组显示（Service、RPC、Gateway、Port 等）
 *    - 包含 hints 和修复建议
 * 
 * 2. **JSON 模式** (json=true):
 *    - 机器可读的完整数据结构
 *    - 自动脱敏敏感环境变量（过滤 Token、密钥）
 *    - 保持字段顺序和完整性
 * 
 * **打印流程**（8 步）:
 * ```text
 * 1. 检查输出模式
 *    ├─ json=true → 调用 sanitizeDaemonStatusForJson()
 *    └─ json=false → 继续以下步骤
 * 
 * 2. 创建终端样式
 *    └─ createCliStatusTextStyles()
 *       ├─ rich: 富文本样式
 *       ├─ label: 标签样式（粗体）
 *       ├─ accent: 强调色
 *       ├─ infoText: 信息文本
 *       ├─ okText: 成功状态（绿色）
 *       ├─ warnText: 警告状态（黄色）
 *       └─ errorText: 错误状态（红色）
 * 
 * 3. 打印服务基本信息
 *    ├─ Service: <label> (loaded/not-loaded)
 *    ├─ File logs: <日志路径>
 *    ├─ Command: <启动命令>
 *    ├─ Service file: <服务配置文件路径>
 *    ├─ Working dir: <工作目录>
 *    └─ Service env: <环境变量列表>
 * 
 * 4. 打印配置审计报告
 *    ├─ 检查 configAudit.issues
 *    ├─ 打印验证失败消息
 *    └─ 提供修复命令建议
 * 
 * 5. 打印 RPC 连接信息
 *    ├─ WebSocket URL
 *    ├─ 认证模式（token/pairing）
 *    └─ 连接状态（connected/disconnected）
 * 
 * 6. 打印 Gateway 运行时状态
 *    ├─ 端口和绑定主机
 *    ├─ TLS 启用状态
 *    ├─ 探测 URL
 *    └─ 网络类型（IPv4/IPv6）
 * 
 * 7. 打印端口诊断
 *    ├─ 端口占用状态（FREE/LISTENING/TIME_WAIT）
 *    ├─ 监听器列表（PID、命令）
 *    └─ 冲突检测和提示
 * 
 * 8. 生成 Control UI 链接
 *    ├─ HTTP 入口（http://localhost:18789）
 *    ├─ WebSocket 入口（ws://localhost:18789）
 *    └─ 根据 TLS 状态选择协议
 * ```
 * 
 * **环境变量脱敏规则**:
 * ```typescript
 * // 保留的安全变量
 * const SAFE_ENV_KEYS = ['NODE_ENV', 'PATH', 'HOME', 'USER'];
 * 
 * // 过滤的敏感变量
 * const SENSITIVE_ENV_KEYS = [
 *   'OPENCLAW_GATEWAY_TOKEN',
 *   'OPENCLAW_AUTH_TOKEN',
 *   'SECRET',
 *   'PASSWORD',
 *   'API_KEY'
 * ];
 * 
 * // 脱敏逻辑
 * function filterDaemonEnv(env) {
 *   return Object.fromEntries(
 *     Object.entries(env).filter(([key]) => 
 *       !SENSITIVE_ENV_KEYS.some(sensitive => 
 *         key.toUpperCase().includes(sensitive)
 *       )
 *     )
 *   );
 * }
 * ```
 * 
 * **systemd 不可用处理**:
 * ```typescript
 * // 检测 systemd 不可用的详细原因
 * const detail = await classifySystemdUnavailableDetail();
 * 
 * // 根据原因生成不同的提示
 * if (detail === 'wsl_without_systemd_shim') {
 *   hints.push('WSL 环境需要安装 systemd-shim');
 *   hints.push('参考：https://github.com/DamionGiles/ubuntu-wsl2-systemd-script');
 * }
 * 
 * if (detail === 'docker_container') {
 *   hints.push('容器环境中 systemd 不可用是正常的');
 *   hints.push('建议使用 docker-compose 或 Kubernetes 管理');
 * }
 * ```
 * 
 * **使用示例**:
 * ```typescript
 * // 场景 1: 人类可读模式
 * printDaemonStatus(status, { json: false });
 * // → 输出彩色格式的状态信息
 * // Service: openclaw-user.service (✓ loaded)
 * // File logs: ~/.openclaw/state/logs/gateway.log
 * // Command: node /opt/openclaw/gateway.js --port 18789
 * // Gateway: http://localhost:18789 (TLS disabled)
 * // Port 18789: LISTENING (PID 12345)
 * 
 * // 场景 2: JSON 模式（脱敏）
 * printDaemonStatus(status, { json: true });
 * // → 输出 JSON 数据（敏感环境变量已过滤）
 * // {
 * //   "service": {
 * //     "loaded": true,
 * //     "command": {
 * //       "programArguments": ["node", "gateway.js"],
 * //       "environment": { "NODE_ENV": "production" }  // 敏感变量已移除
 * //     }
 * //   }
 * // }
 * 
 * // 场景 3: 检测到配置问题
 * if (status.service.configAudit?.issues.length > 0) {
 *   defaultRuntime.error('⚠️ Service config looks out of date');
 *   for (const issue of status.service.configAudit.issues) {
 *     defaultRuntime.error(`  - ${issue.message}`);
 *   }
 *   // → 输出修复建议
 *   // Fix with: openclaw config set gateway.port 18789
 * }
 * 
 * // 场景 4: systemd 不可用
 * if (!status.service.loaded && isSystemdUnavailableDetail(detail)) {
 *   renderSystemdUnavailableHints({ wsl: true, kind: detail });
 *   // → 输出 WSL 特殊处理提示
 * }
 * ```
 * 
 * @module cli/daemon-cli/status.print
 */

function sanitizeDaemonStatusForJson(status: DaemonStatus): DaemonStatus {
  const command = status.service.command;
  if (!command?.environment) {
    return status;
  }
  const safeEnv = filterDaemonEnv(command.environment);
  const nextCommand = {
    ...command,
    environment: Object.keys(safeEnv).length > 0 ? safeEnv : undefined,
  };
  return {
    ...status,
    service: {
      ...status.service,
      command: nextCommand,
    },
  };
}

export function printDaemonStatus(status: DaemonStatus, opts: { json: boolean }) {
  if (opts.json) {
    const sanitized = sanitizeDaemonStatusForJson(status);
    defaultRuntime.writeJson(sanitized);
    return;
  }

  const { rich, label, accent, infoText, okText, warnText, errorText } =
    createCliStatusTextStyles();
  const spacer = () => defaultRuntime.log("");

  const { service, rpc, extraServices } = status;
  const serviceStatus = service.loaded
    ? okText(service.loadedText)
    : warnText(service.notLoadedText);
  defaultRuntime.log(`${label("Service:")} ${accent(service.label)} (${serviceStatus})`);
  try {
    const logFile = getResolvedLoggerSettings().file;
    defaultRuntime.log(`${label("File logs:")} ${infoText(shortenHomePath(logFile))}`);
  } catch {
    // ignore missing config/log resolution
  }
  if (service.command?.programArguments?.length) {
    defaultRuntime.log(
      `${label("Command:")} ${infoText(service.command.programArguments.join(" "))}`,
    );
  }
  if (service.command?.sourcePath) {
    defaultRuntime.log(
      `${label("Service file:")} ${infoText(shortenHomePath(service.command.sourcePath))}`,
    );
  }
  if (service.command?.workingDirectory) {
    defaultRuntime.log(
      `${label("Working dir:")} ${infoText(shortenHomePath(service.command.workingDirectory))}`,
    );
  }
  const daemonEnvLines = safeDaemonEnv(service.command?.environment);
  if (daemonEnvLines.length > 0) {
    defaultRuntime.log(`${label("Service env:")} ${daemonEnvLines.join(" ")}`);
  }
  spacer();

  if (service.configAudit?.issues.length) {
    defaultRuntime.error(warnText("Service config looks out of date or non-standard."));
    for (const issue of service.configAudit.issues) {
      const detail = issue.detail ? ` (${issue.detail})` : "";
      defaultRuntime.error(`${warnText("Service config issue:")} ${issue.message}${detail}`);
    }
    defaultRuntime.error(
      warnText(
        `Recommendation: run "${formatCliCommand("openclaw doctor")}" (or "${formatCliCommand("openclaw doctor --repair")}").`,
      ),
    );
  }

  if (status.config) {
    const cliCfg = `${shortenHomePath(status.config.cli.path)}${status.config.cli.exists ? "" : " (missing)"}${status.config.cli.valid ? "" : " (invalid)"}`;
    defaultRuntime.log(`${label("Config (cli):")} ${infoText(cliCfg)}`);
    if (!status.config.cli.valid && status.config.cli.issues?.length) {
      for (const issue of status.config.cli.issues.slice(0, 5)) {
        defaultRuntime.error(
          `${errorText("Config issue:")} ${formatConfigIssueLine(issue, "", { normalizeRoot: true })}`,
        );
      }
    }
    if (status.config.daemon) {
      const daemonCfg = `${shortenHomePath(status.config.daemon.path)}${status.config.daemon.exists ? "" : " (missing)"}${status.config.daemon.valid ? "" : " (invalid)"}`;
      defaultRuntime.log(`${label("Config (service):")} ${infoText(daemonCfg)}`);
      if (!status.config.daemon.valid && status.config.daemon.issues?.length) {
        for (const issue of status.config.daemon.issues.slice(0, 5)) {
          defaultRuntime.error(
            `${errorText("Service config issue:")} ${formatConfigIssueLine(issue, "", { normalizeRoot: true })}`,
          );
        }
      }
    }
    if (status.config.mismatch) {
      defaultRuntime.error(
        errorText(
          "Root cause: CLI and service are using different config paths (likely a profile/state-dir mismatch).",
        ),
      );
      defaultRuntime.error(
        errorText(
          `Fix: rerun \`${formatCliCommand("openclaw gateway install --force")}\` from the same --profile / OPENCLAW_STATE_DIR you expect.`,
        ),
      );
    }
    spacer();
  }

  if (status.gateway) {
    const bindHost = status.gateway.bindHost ?? "n/a";
    defaultRuntime.log(
      `${label("Gateway:")} bind=${infoText(status.gateway.bindMode)} (${infoText(bindHost)}), port=${infoText(String(status.gateway.port))} (${infoText(status.gateway.portSource)})`,
    );
    defaultRuntime.log(`${label("Probe target:")} ${infoText(status.gateway.probeUrl)}`);
    const controlUiEnabled = status.config?.daemon?.controlUi?.enabled ?? true;
    if (!controlUiEnabled) {
      defaultRuntime.log(`${label("Dashboard:")} ${warnText("disabled")}`);
    } else {
      const links = resolveControlUiLinks({
        port: status.gateway.port,
        bind: status.gateway.bindMode,
        customBindHost: status.gateway.customBindHost,
        basePath: status.config?.daemon?.controlUi?.basePath,
      });
      defaultRuntime.log(`${label("Dashboard:")} ${infoText(links.httpUrl)}`);
    }
    if (status.gateway.probeNote) {
      defaultRuntime.log(`${label("Probe note:")} ${infoText(status.gateway.probeNote)}`);
    }
    spacer();
  }

  const runtimeLine = formatRuntimeStatus(service.runtime);
  if (runtimeLine) {
    const runtimeColor = resolveRuntimeStatusColor(service.runtime?.status);
    defaultRuntime.log(`${label("Runtime:")} ${colorize(rich, runtimeColor, runtimeLine)}`);
  }

  if (rpc && !rpc.ok && service.loaded && service.runtime?.status === "running") {
    defaultRuntime.log(
      warnText("Warm-up: launch agents can take a few seconds. Try again shortly."),
    );
  }
  if (rpc) {
    if (rpc.ok) {
      defaultRuntime.log(`${label("RPC probe:")} ${okText("ok")}`);
    } else {
      defaultRuntime.error(`${label("RPC probe:")} ${errorText("failed")}`);
      if (rpc.authWarning) {
        defaultRuntime.error(`${label("RPC auth:")} ${warnText(rpc.authWarning)}`);
      }
      if (rpc.url) {
        defaultRuntime.error(`${label("RPC target:")} ${rpc.url}`);
      }
      const lines = String(rpc.error ?? "unknown")
        .split(/\r?\n/)
        .filter(Boolean);
      for (const line of lines.slice(0, 12)) {
        defaultRuntime.error(`  ${errorText(line)}`);
      }
    }
    spacer();
  }

  if (
    status.health &&
    status.health.staleGatewayPids.length > 0 &&
    service.runtime?.status === "running" &&
    typeof service.runtime.pid === "number"
  ) {
    defaultRuntime.error(
      errorText(
        `Gateway runtime PID does not own the listening port. Other gateway process(es) are listening: ${status.health.staleGatewayPids.join(", ")}`,
      ),
    );
    defaultRuntime.error(
      errorText(
        `Fix: run ${formatCliCommand("openclaw gateway restart")} and re-check with ${formatCliCommand("openclaw gateway status --deep")}.`,
      ),
    );
    spacer();
  }

  const systemdUnavailable =
    process.platform === "linux" && isSystemdUnavailableDetail(service.runtime?.detail);
  if (systemdUnavailable) {
    const container = Boolean(
      resolveDaemonContainerContext(service.command?.environment ?? process.env),
    );
    defaultRuntime.error(errorText("systemd user services unavailable."));
    for (const hint of renderSystemdUnavailableHints({
      wsl: isWSLEnv(),
      kind: classifySystemdUnavailableDetail(service.runtime?.detail),
      container,
    })) {
      defaultRuntime.error(errorText(hint));
    }
    spacer();
  }

  if (service.runtime?.missingUnit) {
    defaultRuntime.error(errorText("Service unit not found."));
    for (const hint of renderRuntimeHints(service.runtime)) {
      defaultRuntime.error(errorText(hint));
    }
  } else if (service.loaded && service.runtime?.status === "stopped") {
    defaultRuntime.error(
      errorText("Service is loaded but not running (likely exited immediately)."),
    );
    for (const hint of renderRuntimeHints(
      service.runtime,
      service.command?.environment ?? process.env,
    )) {
      defaultRuntime.error(errorText(hint));
    }
    spacer();
  }

  if (service.runtime?.cachedLabel) {
    const env = service.command?.environment ?? process.env;
    const labelValue = resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE);
    defaultRuntime.error(
      errorText(
        `LaunchAgent label cached but plist missing. Clear with: launchctl bootout gui/$UID/${labelValue}`,
      ),
    );
    defaultRuntime.error(
      errorText(`Then reinstall: ${formatCliCommand("openclaw gateway install")}`),
    );
    spacer();
  }

  for (const line of renderPortDiagnosticsForCli(status, rpc?.ok)) {
    defaultRuntime.error(errorText(line));
  }

  if (status.port) {
    const addrs = resolvePortListeningAddresses(status);
    if (addrs.length > 0) {
      defaultRuntime.log(`${label("Listening:")} ${infoText(addrs.join(", "))}`);
    }
  }

  if (status.portCli && status.portCli.port !== status.port?.port) {
    defaultRuntime.log(
      `${label("Note:")} CLI config resolves gateway port=${status.portCli.port} (${status.portCli.status}).`,
    );
  }

  if (
    service.loaded &&
    service.runtime?.status === "running" &&
    status.port &&
    status.port.status !== "busy"
  ) {
    defaultRuntime.error(
      errorText(`Gateway port ${status.port.port} is not listening (service appears running).`),
    );
    if (status.lastError) {
      defaultRuntime.error(`${errorText("Last gateway error:")} ${status.lastError}`);
    }
    if (process.platform === "linux") {
      const env = service.command?.environment ?? process.env;
      const unit = resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
      defaultRuntime.error(
        errorText(`Logs: journalctl --user -u ${unit}.service -n 200 --no-pager`),
      );
    } else if (process.platform === "darwin") {
      const logs = resolveGatewayLogPaths(service.command?.environment ?? process.env);
      defaultRuntime.error(`${errorText("Logs:")} ${shortenHomePath(logs.stdoutPath)}`);
      defaultRuntime.error(`${errorText("Errors:")} ${shortenHomePath(logs.stderrPath)}`);
    }
    spacer();
  }

  if (extraServices.length > 0) {
    defaultRuntime.error(errorText("Other gateway-like services detected (best effort):"));
    for (const svc of extraServices) {
      defaultRuntime.error(`- ${errorText(svc.label)} (${svc.scope}, ${svc.detail})`);
    }
    for (const hint of renderGatewayServiceCleanupHints()) {
      defaultRuntime.error(`${errorText("Cleanup hint:")} ${hint}`);
    }
    spacer();
  }

  if (extraServices.length > 0) {
    defaultRuntime.error(
      errorText(
        "Recommendation: run a single gateway per machine for most setups. One gateway supports multiple agents (see docs: /gateway#multiple-gateways-same-host).",
      ),
    );
    defaultRuntime.error(
      errorText(
        "If you need multiple gateways (e.g., a rescue bot on the same host), isolate ports + config/state (see docs: /gateway#multiple-gateways-same-host).",
      ),
    );
    spacer();
  }

  defaultRuntime.log(`${label("Troubles:")} run ${formatCliCommand("openclaw status")}`);
  defaultRuntime.log(`${label("Troubleshooting:")} https://docs.openclaw.ai/troubleshooting`);
}
