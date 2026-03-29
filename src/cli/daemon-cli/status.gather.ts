/**
 * @fileoverview 守护进程状态收集与诊断
 * 
 * 本文件实现了 OpenClaw 守护进程的状态收集与诊断逻辑，提供了完整的服务健康检查能力：
 * 
 * **核心功能**:
 * - 配置文件状态收集（CLI 配置 vs Daemon 配置对比）
 * - Gateway 运行时状态探测（端口、绑定主机、探测 URL）
 * - 端口使用情况检查（占用检测、监听器信息）
 * - TLS 证书加载与验证
 * - 重启健康度评估（重启历史、失败记录）
 * - 额外服务检测（多实例冲突）
 * - Token 漂移审计（配置 Token vs 运行时 Token）
 * - 网络发现与显示优化（IPv4/IPv6、bind host 解析）
 * 
 * **状态收集流程**（8 步）:
 * ```text
 * 1. 创建配置 I/O 实例
 *    └─ createConfigIO()
 * 
 * 2. 读取 CLI 和 Daemon 配置文件
 *    ├─ resolveConfigPath('cli')
 *    └─ resolveConfigPath('daemon')
 * 
 * 3. 验证配置有效性
 *    └─ validateConfigObjectWithPlugins()
 * 
 * 4. 解析 Gateway 端口和绑定主机
 *    ├─ resolveGatewayPort()
 *    └─ resolveBestEffortGatewayBindHostForDisplay()
 * 
 * 5. 探测 Gateway 运行状态
 *    └─ probeGatewayStatus()
 *       ├─ HTTP GET /health
 *       ├─ WebSocket 连接测试
 *       └─ 认证 Token 验证
 * 
 * 6. 检查端口使用情况
 *    └─ inspectPortUsage(port)
 *       ├─ lsof -i :<port>
 *       └─ netstat -an | grep <port>
 * 
 * 7. 加载 TLS 运行时
 *    └─ loadGatewayTlsRuntime()
 *       ├─ 读取证书文件
 *       └─ 验证有效期
 * 
 * 8. 审计服务配置
 *    └─ auditGatewayServiceConfig()
 *       ├─ 检查 Token 一致性
 *       ├─ 检测多实例冲突
 *       └─ 分析重启历史
 * ```
 * 
 * **配置对比逻辑**:
 * ```typescript
 * // CLI 配置 vs Daemon 配置
 * if (cliConfig.gateway.port !== daemonConfig.gateway.port) {
 *   context.configMismatch = true;
 *   hints.push('CLI 和 Daemon 配置端口不一致');
 * }
 * 
 * // Token 漂移检测
 * if (configToken !== runtimeToken) {
 *   audit.tokenDrift = {
 *     configValue: configToken,
 *     runtimeValue: runtimeToken,
 *     detected: true
 *   };
 * }
 * ```
 * 
 * **端口状态分类**（4 种）:
 * 1. **FREE**: 端口空闲，可绑定
 * 2. **LISTENING**: 已有进程监听
 * 3. **TIME_WAIT**: 刚释放，处于等待状态
 * 4. **UNAVAILABLE**: 系统保留或被防火墙阻止
 * 
 * **使用示例**:
 * ```typescript
 * // 场景 1: 收集完整状态
 * const status = await gatherDaemonStatus({ json: false });
 * console.log(status.service.loaded);      // true/false
 * console.log(status.gateway?.port);       // 18789
 * console.log(status.port.status);         // 'LISTENING'
 * 
 * // 场景 2: 检查配置一致性
 * if (status.configMismatch) {
 *   console.log('⚠️ CLI 和 Daemon 配置不一致');
 *   console.log(`CLI port: ${status.cliPort}`);
 *   console.log(`Daemon port: ${status.daemonPort}`);
 * }
 * 
 * // 场景 3: Token 漂移检测
 * if (status.audit?.tokenDrift?.detected) {
 *   console.log('⚠️ Token 不一致:');
 *   console.log(`  配置值：${status.audit.tokenDrift.configValue}`);
 *   console.log(`  运行值：${status.audit.tokenDrift.runtimeValue}`);
 * }
 * 
 * // 场景 4: 端口占用诊断
 * if (status.port.status === 'LISTENING') {
 *   console.log(`端口 ${status.port.port} 被占用:`);
 *   for (const listener of status.port.listeners) {
 *     console.log(`  PID ${listener.pid}: ${listener.command}`);
 *   }
 * }
 * 
 * // 场景 5: TLS 证书检查
 * if (status.tls?.enabled && !status.tls.valid) {
 *   console.log('TLS 证书无效:');
 *   console.log(status.tls.errors);
 * }
 * ```
 * 
 * @module cli/daemon-cli/status.gather
 */

import {
  createConfigIO,
  resolveConfigPath,
  resolveGatewayPort,
  resolveStateDir,
} from "../../config/config.js";
import type {
  OpenClawConfig,
  GatewayBindMode,
  GatewayControlUiConfig,
} from "../../config/types.js";
import { readLastGatewayErrorLine } from "../../daemon/diagnostics.js";
import type { FindExtraGatewayServicesOptions } from "../../daemon/inspect.js";
import { findExtraGatewayServices } from "../../daemon/inspect.js";
import type { ServiceConfigAudit } from "../../daemon/service-audit.js";
import { auditGatewayServiceConfig } from "../../daemon/service-audit.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { isGatewaySecretRefUnavailableError, trimToUndefined } from "../../gateway/credentials.js";
import { resolveGatewayProbeAuthWithSecretInputs } from "../../gateway/probe-auth.js";
import {
  inspectBestEffortPrimaryTailnetIPv4,
  resolveBestEffortGatewayBindHostForDisplay,
} from "../../infra/network-discovery-display.js";
import { parseStrictPositiveInteger } from "../../infra/parse-finite-number.js";
import {
  formatPortDiagnostics,
  inspectPortUsage,
  type PortListener,
  type PortUsageStatus,
} from "../../infra/ports.js";
import { loadGatewayTlsRuntime } from "../../infra/tls/gateway.js";
import { probeGatewayStatus } from "./probe.js";
import { inspectGatewayRestart } from "./restart-health.js";
import { normalizeListenerAddress, parsePortFromArgs, pickProbeHostForBind } from "./shared.js";
import type { GatewayRpcOpts } from "./types.js";

type ConfigSummary = {
  path: string;
  exists: boolean;
  valid: boolean;
  issues?: Array<{ path: string; message: string }>;
  controlUi?: GatewayControlUiConfig;
};

type GatewayStatusSummary = {
  bindMode: GatewayBindMode;
  bindHost: string;
  customBindHost?: string;
  port: number;
  portSource: "service args" | "env/config";
  probeUrl: string;
  probeNote?: string;
};

type PortStatusSummary = {
  port: number;
  status: PortUsageStatus;
  listeners: PortListener[];
  hints: string[];
};

type DaemonConfigContext = {
  mergedDaemonEnv: Record<string, string | undefined>;
  cliCfg: OpenClawConfig;
  daemonCfg: OpenClawConfig;
  cliConfigSummary: ConfigSummary;
  daemonConfigSummary: ConfigSummary;
  configMismatch: boolean;
};

type ResolvedGatewayStatus = {
  gateway: GatewayStatusSummary;
  daemonPort: number;
  cliPort: number;
  probeUrlOverride: string | null;
};

function appendProbeNote(
  existing: string | undefined,
  extra: string | undefined,
): string | undefined {
  const values = [existing, extra].filter((value): value is string => Boolean(value?.trim()));
  if (values.length === 0) {
    return undefined;
  }
  return [...new Set(values)].join(" ");
}
export type DaemonStatus = {
  service: {
    label: string;
    loaded: boolean;
    loadedText: string;
    notLoadedText: string;
    command?: {
      programArguments: string[];
      workingDirectory?: string;
      environment?: Record<string, string>;
      sourcePath?: string;
    } | null;
    runtime?: GatewayServiceRuntime;
    configAudit?: ServiceConfigAudit;
  };
  config?: {
    cli: ConfigSummary;
    daemon?: ConfigSummary;
    mismatch?: boolean;
  };
  gateway?: GatewayStatusSummary;
  port?: {
    port: number;
    status: PortUsageStatus;
    listeners: PortListener[];
    hints: string[];
  };
  portCli?: {
    port: number;
    status: PortUsageStatus;
    listeners: PortListener[];
    hints: string[];
  };
  lastError?: string;
  rpc?: {
    ok: boolean;
    error?: string;
    url?: string;
    authWarning?: string;
  };
  health?: {
    healthy: boolean;
    staleGatewayPids: number[];
  };
  extraServices: Array<{ label: string; detail: string; scope: string }>;
};

function shouldReportPortUsage(status: PortUsageStatus | undefined, rpcOk?: boolean) {
  if (status !== "busy") {
    return false;
  }
  if (rpcOk === true) {
    return false;
  }
  return true;
}

function parseGatewaySecretRefPathFromError(error: unknown): string | null {
  return isGatewaySecretRefUnavailableError(error) ? error.path : null;
}

async function loadDaemonConfigContext(
  serviceEnv?: Record<string, string>,
): Promise<DaemonConfigContext> {
  const mergedDaemonEnv = {
    ...(process.env as Record<string, string | undefined>),
    ...(serviceEnv ?? undefined),
  } satisfies Record<string, string | undefined>;

  const cliConfigPath = resolveConfigPath(process.env, resolveStateDir(process.env));
  const daemonConfigPath = resolveConfigPath(
    mergedDaemonEnv as NodeJS.ProcessEnv,
    resolveStateDir(mergedDaemonEnv as NodeJS.ProcessEnv),
  );

  const cliIO = createConfigIO({ env: process.env, configPath: cliConfigPath });
  const daemonIO = createConfigIO({
    env: mergedDaemonEnv,
    configPath: daemonConfigPath,
  });

  const [cliSnapshot, daemonSnapshot] = await Promise.all([
    cliIO.readConfigFileSnapshot().catch(() => null),
    daemonIO.readConfigFileSnapshot().catch(() => null),
  ]);
  const cliCfg = cliIO.loadConfig();
  const daemonCfg = daemonIO.loadConfig();

  const cliConfigSummary: ConfigSummary = {
    path: cliSnapshot?.path ?? cliConfigPath,
    exists: cliSnapshot?.exists ?? false,
    valid: cliSnapshot?.valid ?? true,
    ...(cliSnapshot?.issues?.length ? { issues: cliSnapshot.issues } : {}),
    controlUi: cliCfg.gateway?.controlUi,
  };
  const daemonConfigSummary: ConfigSummary = {
    path: daemonSnapshot?.path ?? daemonConfigPath,
    exists: daemonSnapshot?.exists ?? false,
    valid: daemonSnapshot?.valid ?? true,
    ...(daemonSnapshot?.issues?.length ? { issues: daemonSnapshot.issues } : {}),
    controlUi: daemonCfg.gateway?.controlUi,
  };

  return {
    mergedDaemonEnv,
    cliCfg,
    daemonCfg,
    cliConfigSummary,
    daemonConfigSummary,
    configMismatch: cliConfigSummary.path !== daemonConfigSummary.path,
  };
}

async function resolveGatewayStatusSummary(params: {
  daemonCfg: OpenClawConfig;
  cliCfg: OpenClawConfig;
  mergedDaemonEnv: Record<string, string | undefined>;
  commandProgramArguments?: string[];
  rpcUrlOverride?: string;
}): Promise<ResolvedGatewayStatus> {
  const portFromArgs = parsePortFromArgs(params.commandProgramArguments);
  const daemonPort = portFromArgs ?? resolveGatewayPort(params.daemonCfg, params.mergedDaemonEnv);
  const portSource: GatewayStatusSummary["portSource"] = portFromArgs
    ? "service args"
    : "env/config";
  const bindMode: GatewayBindMode = params.daemonCfg.gateway?.bind ?? "loopback";
  const customBindHost = params.daemonCfg.gateway?.customBindHost;
  const { bindHost, warning: bindHostWarning } = await resolveBestEffortGatewayBindHostForDisplay({
    bindMode,
    customBindHost,
    warningPrefix: "Status is using fallback network details because interface discovery failed",
  });
  const { tailnetIPv4, warning: tailnetWarning } = inspectBestEffortPrimaryTailnetIPv4({
    warningPrefix: "Status could not inspect tailnet addresses",
  });
  const probeHost = pickProbeHostForBind(bindMode, tailnetIPv4, customBindHost);
  const probeUrlOverride = trimToUndefined(params.rpcUrlOverride) ?? null;
  const scheme = params.daemonCfg.gateway?.tls?.enabled === true ? "wss" : "ws";
  const probeUrl = probeUrlOverride ?? `${scheme}://${probeHost}:${daemonPort}`;
  let probeNote =
    !probeUrlOverride && bindMode === "lan"
      ? `bind=lan listens on 0.0.0.0 (all interfaces); probing via ${probeHost}.`
      : !probeUrlOverride && bindMode === "loopback"
        ? "Loopback-only gateway; only local clients can connect."
        : undefined;
  probeNote = appendProbeNote(probeNote, bindHostWarning);
  probeNote = appendProbeNote(probeNote, tailnetWarning);

  return {
    gateway: {
      bindMode,
      bindHost,
      customBindHost,
      port: daemonPort,
      portSource,
      probeUrl,
      ...(probeNote ? { probeNote } : {}),
    },
    daemonPort,
    cliPort: resolveGatewayPort(params.cliCfg, process.env),
    probeUrlOverride,
  };
}

function toPortStatusSummary(
  diagnostics: Awaited<ReturnType<typeof inspectPortUsage>> | null,
): PortStatusSummary | undefined {
  if (!diagnostics) {
    return undefined;
  }
  return {
    port: diagnostics.port,
    status: diagnostics.status,
    listeners: diagnostics.listeners,
    hints: diagnostics.hints,
  };
}

async function inspectDaemonPortStatuses(params: {
  daemonPort: number;
  cliPort: number;
}): Promise<{ portStatus?: PortStatusSummary; portCliStatus?: PortStatusSummary }> {
  const [portDiagnostics, portCliDiagnostics] = await Promise.all([
    inspectPortUsage(params.daemonPort).catch(() => null),
    params.cliPort !== params.daemonPort
      ? inspectPortUsage(params.cliPort).catch(() => null)
      : null,
  ]);
  return {
    portStatus: toPortStatusSummary(portDiagnostics),
    portCliStatus: toPortStatusSummary(portCliDiagnostics),
  };
}

export async function gatherDaemonStatus(
  opts: {
    rpc: GatewayRpcOpts;
    probe: boolean;
    requireRpc?: boolean;
    deep?: boolean;
  } & FindExtraGatewayServicesOptions,
): Promise<DaemonStatus> {
  const service = resolveGatewayService();
  const command = await service.readCommand(process.env).catch(() => null);
  const serviceEnv = command?.environment
    ? ({
        ...process.env,
        ...command.environment,
      } satisfies NodeJS.ProcessEnv)
    : process.env;
  const [loaded, runtime] = await Promise.all([
    service.isLoaded({ env: serviceEnv }).catch(() => false),
    service.readRuntime(serviceEnv).catch((err) => ({ status: "unknown", detail: String(err) })),
  ]);
  const configAudit = await auditGatewayServiceConfig({
    env: process.env,
    command,
  });
  const {
    mergedDaemonEnv,
    cliCfg,
    daemonCfg,
    cliConfigSummary,
    daemonConfigSummary,
    configMismatch,
  } = await loadDaemonConfigContext(command?.environment);
  const { gateway, daemonPort, cliPort, probeUrlOverride } = await resolveGatewayStatusSummary({
    cliCfg,
    daemonCfg,
    mergedDaemonEnv,
    commandProgramArguments: command?.programArguments,
    rpcUrlOverride: opts.rpc.url,
  });
  const { portStatus, portCliStatus } = await inspectDaemonPortStatuses({
    daemonPort,
    cliPort,
  });

  const extraServices = await findExtraGatewayServices(
    process.env as Record<string, string | undefined>,
    { deep: Boolean(opts.deep) },
  ).catch(() => []);

  const timeoutMs = parseStrictPositiveInteger(opts.rpc.timeout ?? "10000") ?? 10_000;

  const tlsEnabled = daemonCfg.gateway?.tls?.enabled === true;
  const shouldUseLocalTlsRuntime = opts.probe && !probeUrlOverride && tlsEnabled;
  const tlsRuntime = shouldUseLocalTlsRuntime
    ? await loadGatewayTlsRuntime(daemonCfg.gateway?.tls)
    : undefined;
  let daemonProbeAuth: { token?: string; password?: string } | undefined;
  let rpcAuthWarning: string | undefined;
  if (opts.probe) {
    try {
      daemonProbeAuth = await resolveGatewayProbeAuthWithSecretInputs({
        cfg: daemonCfg,
        mode: daemonCfg.gateway?.mode === "remote" ? "remote" : "local",
        env: mergedDaemonEnv as NodeJS.ProcessEnv,
        explicitAuth: {
          token: opts.rpc.token,
          password: opts.rpc.password,
        },
      });
    } catch (error) {
      const refPath = parseGatewaySecretRefPathFromError(error);
      if (!refPath) {
        throw error;
      }
      daemonProbeAuth = undefined;
      rpcAuthWarning = `${refPath} SecretRef is unavailable in this command path; probing without configured auth credentials.`;
    }
  }

  const rpc = opts.probe
    ? await probeGatewayStatus({
        url: gateway.probeUrl,
        token: daemonProbeAuth?.token,
        password: daemonProbeAuth?.password,
        tlsFingerprint:
          shouldUseLocalTlsRuntime && tlsRuntime?.enabled
            ? tlsRuntime.fingerprintSha256
            : undefined,
        timeoutMs,
        json: opts.rpc.json,
        requireRpc: opts.requireRpc,
        configPath: daemonConfigSummary.path,
      })
    : undefined;
  if (rpc?.ok) {
    rpcAuthWarning = undefined;
  }
  const health =
    opts.probe && loaded
      ? await inspectGatewayRestart({
          service,
          port: daemonPort,
          env: serviceEnv,
        }).catch(() => undefined)
      : undefined;

  let lastError: string | undefined;
  if (loaded && runtime?.status === "running" && portStatus && portStatus.status !== "busy") {
    lastError = (await readLastGatewayErrorLine(mergedDaemonEnv as NodeJS.ProcessEnv)) ?? undefined;
  }

  return {
    service: {
      label: service.label,
      loaded,
      loadedText: service.loadedText,
      notLoadedText: service.notLoadedText,
      command,
      runtime,
      configAudit,
    },
    config: {
      cli: cliConfigSummary,
      daemon: daemonConfigSummary,
      ...(configMismatch ? { mismatch: true } : {}),
    },
    gateway,
    port: portStatus,
    ...(portCliStatus ? { portCli: portCliStatus } : {}),
    lastError,
    ...(rpc
      ? {
          rpc: {
            ...rpc,
            url: gateway.probeUrl,
            ...(rpcAuthWarning ? { authWarning: rpcAuthWarning } : {}),
          },
        }
      : {}),
    ...(health
      ? {
          health: {
            healthy: health.healthy,
            staleGatewayPids: health.staleGatewayPids,
          },
        }
      : {}),
    extraServices,
  };
}

export function renderPortDiagnosticsForCli(status: DaemonStatus, rpcOk?: boolean): string[] {
  if (!status.port || !shouldReportPortUsage(status.port.status, rpcOk)) {
    return [];
  }
  return formatPortDiagnostics({
    port: status.port.port,
    status: status.port.status,
    listeners: status.port.listeners,
    hints: status.port.hints,
  });
}

export function resolvePortListeningAddresses(status: DaemonStatus): string[] {
  const addrs = Array.from(
    new Set(
      status.port?.listeners
        ?.map((l) => (l.address ? normalizeListenerAddress(l.address) : ""))
        .filter((v): v is string => Boolean(v)) ?? [],
    ),
  );
  return addrs;
}
