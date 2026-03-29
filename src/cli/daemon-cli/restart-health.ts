/**
 * @fileoverview 守护进程重启健康度评估
 * 
 * 本文件实现了 OpenClaw 守护进程重启时的健康度检查逻辑，提供了完整的重启验证和故障恢复能力：
 * 
 * **核心功能**:
 * - 重启健康度超时管理（默认 60 秒）
 * - 重启延迟重试机制（默认 500ms 间隔）
 * - Gateway 可达性探测（WebSocket 连接测试）
 * - 端口健康检查（占用状态、监听器归属）
 * - 进程树终止（优雅关闭 + 强制杀死）
 * - 认证错误识别（Token/密码/权限问题）
 * - 陈旧进程检测（旧实例残留）
 * - 端口归属间隙判断（port listener attribution gap）
 * 
 * **常量配置**:
 * ```typescript
 * // 默认超时时间：60 秒
 * DEFAULT_RESTART_HEALTH_TIMEOUT_MS = 60_000
 * 
 * // 默认重试间隔：500 毫秒
 * DEFAULT_RESTART_HEALTH_DELAY_MS = 500
 * 
 * // 默认重试次数：120 次 (60000 / 500)
 * DEFAULT_RESTART_HEALTH_ATTEMPTS = 120
 * ```
 * 
 * **健康检查流程**（8 步）:
 * ```text
 * 1. 获取服务运行时信息
 *    └─ service.runtime → { pid, port, status }
 * 
 * 2. 检查端口占用状态
 *    └─ inspectPortUsage(port)
 *       ├─ status: "free" | "busy" | "unknown"
 *       ├─ listeners: [{ pid, ppid, command }]
 *       └─ hints: ["process details unavailable"]
 * 
 * 3. 检测端口归属间隙
 *    └─ hasListenerAttributionGap(portUsage)
 *       ├─ status === "busy" 但 listeners 为空
 *       └─ 或 hints 包含 "unavailable"
 * 
 * 4. 验证监听器归属
 *    └─ listenerOwnedByRuntimePid(listener, runtimePid)
 *       ├─ listener.pid === runtimePid
 *       └─ 或 listener.ppid === runtimePid
 * 
 * 5. 探测 Gateway 可达性
 *    └─ confirmGatewayReachable(port)
 *       ├─ WebSocket 连接 ws://127.0.0.1:<port>
 *       ├─ 认证 Token/密码验证
 *       └─ 3 秒超时
 * 
 * 6. 识别认证错误
 *    └─ looksLikeAuthClose(code, reason)
 *       ├─ code === 1008 (策略违反)
 *       └─ reason 包含 auth/token/password/scope/role
 * 
 * 7. 检测陈旧进程
 *    └─ staleGatewayPids
 *       ├─ 端口被占用但非当前 runtime PID
 *       └─ 判定为旧实例残留
 * 
 * 8. 执行进程树终止
 *    └─ killProcessTree(pid)
 *       ├─ SIGTERM 优雅终止
 *       ├─ 等待子进程退出
 *       └─ SIGKILL 强制杀死（如需要）
 * ```
 * 
 * **端口状态分类**（3 种）:
 * 1. **FREE** - 端口空闲
 *    ```typescript
 *    { status: "free", listeners: [], healthy: false }
 *    ```
 * 
 * 2. **BUSY** - 端口被占用
 *    ```typescript
 *    {
 *      status: "busy",
 *      listeners: [{ pid: 12345, ppid: 1, command: "node" }],
 *      healthy: true  // 如果 WebSocket 可达
 *    }
 *    ```
 * 
 * 3. **UNKNOWN** - 状态未知
 *    ```typescript
 *    {
 *      status: "unknown",
 *      errors: ["Permission denied"],
 *      healthy: false
 *    }
 *    ```
 * 
 * **认证错误识别规则**:
 * ```typescript
 * // WebSocket 关闭码 1008: 策略违反
 * if (code === 1008) {
 *   const reason = "Invalid token scope";
 *   
 *   // 检查是否包含认证相关关键词
 *   if (reason.toLowerCase().includes("auth") ||
 *       reason.toLowerCase().includes("token") ||
 *       reason.toLowerCase().includes("password") ||
 *       reason.toLowerCase().includes("scope") ||
 *       reason.toLowerCase().includes("role")) {
 *     return true;  // 判定为认证错误
 *   }
 * }
 * ```
 * 
 * **重启健康度判断逻辑**:
 * ```typescript
 * // 场景 1: 端口空闲 → 不健康（Gateway 未启动）
 * if (portUsage.status === "free") {
 *   healthy = false;
 * }
 * 
 * // 场景 2: 端口被占用且 WebSocket 可达 → 健康
 * if (portUsage.status === "busy" && await confirmGatewayReachable(port)) {
 *   healthy = true;
 * }
 * 
 * // 场景 3: 端口被占用但认证失败 → 不健康
 * if (portUsage.status === "busy" && !await confirmGatewayReachable(port)) {
 *   healthy = false;
 *   // 可能是 Token 过期或配置错误
 * }
 * 
 * // 场景 4: 端口归属间隙 → 需要进一步诊断
 * if (hasListenerAttributionGap(portUsage)) {
 *   // 端口忙但无法获取进程信息
 *   // 可能是权限不足或系统限制
 * }
 * ```
 * 
 * **使用示例**:
 * ```typescript
 * // 场景 1: 基本重启健康检查
 * const result = await inspectGatewayRestart({
 *   service: gatewayService,
 *   timeoutMs: 60000,
 *   delayMs: 500
 * });
 * 
 * if (result.healthy) {
 *   console.log('✓ 重启成功，Gateway 健康');
 * } else {
 *   console.log('✗ 重启失败，Gateway 不健康');
 *   console.log('陈旧进程:', result.staleGatewayPids);
 * }
 * 
 * // 场景 2: 端口健康检查
 * const portHealth = await inspectGatewayPortHealth(18789);
 * console.log(portHealth.portUsage.status);  // "busy"
 * console.log(portHealth.healthy);           // true/false
 * 
 * // 场景 3: 检测端口归属间隙
 * if (hasListenerAttributionGap(portUsage)) {
 *   console.log('⚠️ 端口被占用但无法获取进程信息');
 *   console.log('可能需要 sudo 权限查看详细信息');
 * }
 * 
 * // 场景 4: 识别认证错误
 * if (looksLikeAuthClose(1008, "Invalid token scope")) {
 *   console.log('⚠️ Token 权限不足，请检查配置');
 * }
 * 
 * // 场景 5: 终止陈旧进程
 * for (const pid of result.staleGatewayPids) {
 *   await killProcessTree(pid);
 *   console.log(`已终止旧实例 PID ${pid}`);
 * }
 * ```
 * 
 * @module cli/daemon-cli/restart-health
 */

import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { GatewayService } from "../../daemon/service.js";
import { probeGateway } from "../../gateway/probe.js";
import {
  classifyPortListener,
  formatPortDiagnostics,
  inspectPortUsage,
  type PortUsage,
} from "../../infra/ports.js";
import { killProcessTree } from "../../process/kill-tree.js";
import { sleep } from "../../utils.js";

export const DEFAULT_RESTART_HEALTH_TIMEOUT_MS = 60_000;
export const DEFAULT_RESTART_HEALTH_DELAY_MS = 500;
export const DEFAULT_RESTART_HEALTH_ATTEMPTS = Math.ceil(
  DEFAULT_RESTART_HEALTH_TIMEOUT_MS / DEFAULT_RESTART_HEALTH_DELAY_MS,
);

export type GatewayRestartSnapshot = {
  runtime: GatewayServiceRuntime;
  portUsage: PortUsage;
  healthy: boolean;
  staleGatewayPids: number[];
};

export type GatewayPortHealthSnapshot = {
  portUsage: PortUsage;
  healthy: boolean;
};

function hasListenerAttributionGap(portUsage: PortUsage): boolean {
  if (portUsage.status !== "busy" || portUsage.listeners.length > 0) {
    return false;
  }
  if (portUsage.errors?.length) {
    return true;
  }
  return portUsage.hints.some((hint) => hint.includes("process details are unavailable"));
}

function listenerOwnedByRuntimePid(params: {
  listener: PortUsage["listeners"][number];
  runtimePid: number;
}): boolean {
  return params.listener.pid === params.runtimePid || params.listener.ppid === params.runtimePid;
}

function looksLikeAuthClose(code: number | undefined, reason: string | undefined): boolean {
  if (code !== 1008) {
    return false;
  }
  const normalized = (reason ?? "").toLowerCase();
  return (
    normalized.includes("auth") ||
    normalized.includes("token") ||
    normalized.includes("password") ||
    normalized.includes("scope") ||
    normalized.includes("role")
  );
}

async function confirmGatewayReachable(port: number): Promise<boolean> {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || undefined;
  const password = process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() || undefined;
  const probe = await probeGateway({
    url: `ws://127.0.0.1:${port}`,
    auth: token || password ? { token, password } : undefined,
    timeoutMs: 3_000,
    includeDetails: false,
  });
  return probe.ok || looksLikeAuthClose(probe.close?.code, probe.close?.reason);
}

async function inspectGatewayPortHealth(port: number): Promise<GatewayPortHealthSnapshot> {
  let portUsage: PortUsage;
  try {
    portUsage = await inspectPortUsage(port);
  } catch (err) {
    portUsage = {
      port,
      status: "unknown",
      listeners: [],
      hints: [],
      errors: [String(err)],
    };
  }

  let healthy = false;
  if (portUsage.status === "busy") {
    try {
      healthy = await confirmGatewayReachable(port);
    } catch {
      // best-effort probe
    }
  }

  return { portUsage, healthy };
}

export async function inspectGatewayRestart(params: {
  service: GatewayService;
  port: number;
  env?: NodeJS.ProcessEnv;
  includeUnknownListenersAsStale?: boolean;
}): Promise<GatewayRestartSnapshot> {
  const env = params.env ?? process.env;
  let runtime: GatewayServiceRuntime = { status: "unknown" };
  try {
    runtime = await params.service.readRuntime(env);
  } catch (err) {
    runtime = { status: "unknown", detail: String(err) };
  }

  let portUsage: PortUsage;
  try {
    portUsage = await inspectPortUsage(params.port);
  } catch (err) {
    portUsage = {
      port: params.port,
      status: "unknown",
      listeners: [],
      hints: [],
      errors: [String(err)],
    };
  }

  if (portUsage.status === "busy" && runtime.status !== "running") {
    try {
      const reachable = await confirmGatewayReachable(params.port);
      if (reachable) {
        return {
          runtime,
          portUsage,
          healthy: true,
          staleGatewayPids: [],
        };
      }
    } catch {
      // Probe is best-effort; keep the ownership-based diagnostics.
    }
  }

  const gatewayListeners =
    portUsage.status === "busy"
      ? portUsage.listeners.filter(
          (listener) => classifyPortListener(listener, params.port) === "gateway",
        )
      : [];
  const fallbackListenerPids =
    params.includeUnknownListenersAsStale &&
    process.platform === "win32" &&
    runtime.status !== "running" &&
    portUsage.status === "busy"
      ? portUsage.listeners
          .filter((listener) => classifyPortListener(listener, params.port) === "unknown")
          .map((listener) => listener.pid)
          .filter((pid): pid is number => Number.isFinite(pid))
      : [];
  const running = runtime.status === "running";
  const runtimePid = runtime.pid;
  const listenerAttributionGap = hasListenerAttributionGap(portUsage);
  const ownsPort =
    runtimePid != null
      ? portUsage.listeners.some((listener) =>
          listenerOwnedByRuntimePid({ listener, runtimePid }),
        ) || listenerAttributionGap
      : gatewayListeners.length > 0 || listenerAttributionGap;
  let healthy = running && ownsPort;
  if (!healthy && running && portUsage.status === "busy") {
    try {
      healthy = await confirmGatewayReachable(params.port);
    } catch {
      // best-effort probe
    }
  }
  const staleGatewayPids = Array.from(
    new Set([
      ...gatewayListeners
        .filter((listener) => Number.isFinite(listener.pid))
        .filter((listener) => {
          if (!running) {
            return true;
          }
          if (runtimePid == null) {
            return false;
          }
          return !listenerOwnedByRuntimePid({ listener, runtimePid });
        })
        .map((listener) => listener.pid as number),
      ...fallbackListenerPids.filter(
        (pid) => runtime.pid == null || pid !== runtime.pid || !running,
      ),
    ]),
  );

  return {
    runtime,
    portUsage,
    healthy,
    staleGatewayPids,
  };
}

export async function waitForGatewayHealthyRestart(params: {
  service: GatewayService;
  port: number;
  attempts?: number;
  delayMs?: number;
  env?: NodeJS.ProcessEnv;
  includeUnknownListenersAsStale?: boolean;
}): Promise<GatewayRestartSnapshot> {
  const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
  const delayMs = params.delayMs ?? DEFAULT_RESTART_HEALTH_DELAY_MS;

  let snapshot = await inspectGatewayRestart({
    service: params.service,
    port: params.port,
    env: params.env,
    includeUnknownListenersAsStale: params.includeUnknownListenersAsStale,
  });

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (snapshot.healthy) {
      return snapshot;
    }
    if (snapshot.staleGatewayPids.length > 0 && snapshot.runtime.status !== "running") {
      return snapshot;
    }
    await sleep(delayMs);
    snapshot = await inspectGatewayRestart({
      service: params.service,
      port: params.port,
      env: params.env,
      includeUnknownListenersAsStale: params.includeUnknownListenersAsStale,
    });
  }

  return snapshot;
}

export async function waitForGatewayHealthyListener(params: {
  port: number;
  attempts?: number;
  delayMs?: number;
}): Promise<GatewayPortHealthSnapshot> {
  const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
  const delayMs = params.delayMs ?? DEFAULT_RESTART_HEALTH_DELAY_MS;

  let snapshot = await inspectGatewayPortHealth(params.port);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (snapshot.healthy) {
      return snapshot;
    }
    await sleep(delayMs);
    snapshot = await inspectGatewayPortHealth(params.port);
  }

  return snapshot;
}

function renderPortUsageDiagnostics(snapshot: GatewayPortHealthSnapshot): string[] {
  const lines: string[] = [];

  if (snapshot.portUsage.status === "busy") {
    lines.push(...formatPortDiagnostics(snapshot.portUsage));
  } else {
    lines.push(`Gateway port ${snapshot.portUsage.port} status: ${snapshot.portUsage.status}.`);
  }

  if (snapshot.portUsage.errors?.length) {
    lines.push(`Port diagnostics errors: ${snapshot.portUsage.errors.join("; ")}`);
  }

  return lines;
}

export function renderRestartDiagnostics(snapshot: GatewayRestartSnapshot): string[] {
  const lines: string[] = [];
  const runtimeSummary = [
    snapshot.runtime.status ? `status=${snapshot.runtime.status}` : null,
    snapshot.runtime.state ? `state=${snapshot.runtime.state}` : null,
    snapshot.runtime.pid != null ? `pid=${snapshot.runtime.pid}` : null,
    snapshot.runtime.lastExitStatus != null ? `lastExit=${snapshot.runtime.lastExitStatus}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  if (runtimeSummary) {
    lines.push(`Service runtime: ${runtimeSummary}`);
  }

  lines.push(...renderPortUsageDiagnostics(snapshot));

  return lines;
}

export function renderGatewayPortHealthDiagnostics(snapshot: GatewayPortHealthSnapshot): string[] {
  return renderPortUsageDiagnostics(snapshot);
}

export async function terminateStaleGatewayPids(pids: number[]): Promise<number[]> {
  const targets = Array.from(
    new Set(pids.filter((pid): pid is number => Number.isFinite(pid) && pid > 0)),
  );
  for (const pid of targets) {
    killProcessTree(pid, { graceMs: 300 });
  }
  if (targets.length > 0) {
    await sleep(500);
  }
  return targets;
}
