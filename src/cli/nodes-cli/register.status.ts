import type { Command } from "commander";
import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
import { defaultRuntime } from "../../runtime.js";
import { getTerminalTableWidth, renderTable } from "../../terminal/table.js";
import { shortenHomeInString } from "../../utils.js";
import { parseDurationMs } from "../parse-duration.js";
import { getNodesTheme, runNodesCommand } from "./cli-utils.js";
import { formatPermissions, parseNodeList, parsePairingList } from "./format.js";
import { renderPendingPairingRequestsTable } from "./pairing-render.js";
import { callGatewayCli, nodesCallOpts, resolveNodeId } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

/**
 * @fileoverview 节点状态管理命令实现
 * 
 * 本文件实现了 OpenClaw 节点状态管理 CLI 命令的核心逻辑，提供了节点列表查看、状态过滤、版本显示等功能：
 * 
 * **核心功能**:
 * - 节点版本格式化（核心版本/UI 版本分离、 legacy 兼容）
 * - 路径环境变量显示优化（截断过长路径）
 * - 时间戳解析与相对时间显示（如 "2 hours ago"）
 * - 节点列表解析与过滤（在线/离线状态、平台类型）
 * - 配对请求列表渲染（待处理请求表格展示）
 * - RPC 调用封装（与 Gateway 通信获取实时状态）
 * - 终端表格渲染（自适应宽度、彩色输出）
 * 
 * **辅助函数**（7 个内部工具函数）:
 * 
 * 1. **formatVersionLabel** - 格式化版本号标签
 *    - 自动添加 'v' 前缀（纯数字版本）
 *    - 保持已有 'v' 前缀
 *    - 处理空字符串和空白字符
 * 
 * 2. **resolveNodeVersions** - 解析节点版本信息
 *    - 优先使用 coreVersion/uiVersion 分离字段
 *    - 回退到 legacy version 字段
 *    - 根据平台判断 headless/非 headless
 *    - 支持 Darwin/Linux/Win32/Windows 平台
 * 
 * 3. **formatNodeVersions** - 格式化节点版本显示
 *    - 生成 "core vX.X.X · ui vX.X.X" 格式
 *    - 仅显示存在的版本字段
 *    - 返回 null 如果无版本信息
 * 
 * 4. **formatPathEnv** - 格式化路径环境变量
 *    - 按冒号分割 PATH 条目
 *    - 超过 3 个条目时截断显示（显示前 2 个 + ... + 最后 1 个）
 *    - 使用 shortenHomeInString 缩短家目录路径
 * 
 * 5. **parseSinceMs** - 解析时间范围参数
 *    - 支持多种时间格式（ms, s, m, h, d）
 *    - 错误处理和退出码设置
 *    - 支持字符串和数字输入
 * 
 * 6. **formatPermissions** - 格式化权限列表
 *    - 从 nodes.format 导入
 *    - 显示已授予的权限列表
 * 
 * 7. **parseNodeList / parsePairingList** - 解析列表数据
 *    - 从 nodes.format 导入
 *    - 处理 Gateway 返回的 JSON 数据
 * 
 * **使用示例**:
 * ```typescript
 * // 场景 1: 格式化版本号
 * formatVersionLabel('1.0.0');        // 'v1.0.0'
 * formatVersionLabel('v2.0.0');       // 'v2.0.0'
 * formatVersionLabel('beta');         // 'beta'
 * formatVersionLabel('  ');           // '  ' (保持原样)
 * 
 * // 场景 2: 解析节点版本
 * const node = {
 *   platform: 'darwin',
 *   coreVersion: '1.0.0',
 *   uiVersion: '2.0.0'
 * };
 * resolveNodeVersions(node);
 * // → { core: '1.0.0', ui: '2.0.0' }
 * 
 * const legacy = {
 *   platform: 'android',
 *   version: '1.5.0'
 * };
 * resolveNodeVersions(legacy);
 * // → { core: undefined, ui: '1.5.0' }
 * 
 * // 场景 3: 格式化版本显示
 * formatNodeVersions({
 *   platform: 'darwin',
 *   coreVersion: '1.0.0',
 *   uiVersion: '2.0.0'
 * });
 * // → 'core v1.0.0 · ui v2.0.0'
 * 
 * formatNodeVersions({
 *   platform: 'linux',
 *   version: '1.0.0'
 * });
 * // → 'core v1.0.0'
 * 
 * // 场景 4: 格式化路径环境变量
 * formatPathEnv('/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin');
 * // → '/usr/bin:/bin:...:/opt/homebrew/bin'
 * 
 * formatPathEnv('/usr/local/bin');
 * // → '/usr/local/bin' (不截断)
 * 
 * // 场景 5: 解析时间范围
 * parseSinceMs('1h', 'since');    // 3600000 (1 小时毫秒数)
 * parseSinceMs('30m', 'since');   // 1800000 (30 分钟毫秒数)
 * parseSinceMs('invalid', 'since'); // 输出错误并退出
 * 
 * // 场景 6: 注册节点状态命令
 * const nodes = new Command();
 * registerNodesStatusCommands(nodes);
 * await nodes.parseAsync(['node', 'openclaw', 'nodes', 'status']);
 * /*
 * Node Status:
 * ┌─────────────┬──────────┬──────────────┬─────────────────┐
 * │ ID          │ Platform │ Last Seen    │ Version         │
 * ├─────────────┼──────────┼──────────────┼─────────────────┤
 * │ macos-pro   │ macOS    │ just now     │ core v1.0.0     │
 * │ iphone-15   │ iOS      │ 2 hours ago  │ ui v2.0.0       │
 * └─────────────┴──────────┴──────────────┴─────────────────┘
 * *\/
 * 
 * // 场景 7: 查看待处理配对请求
 * await nodes.parseAsync(['node', 'openclaw', 'nodes', 'pairing', 'pending']);
 * /*
 * Pending Pairing Requests:
 * ┌────┬──────────────┬─────────────────┬──────────────┐
 * │ ID │ Device Name  │ Requested       │ Permissions  │
 * ├────┼──────────────┼─────────────────┼──────────────┤
 * │ 1  │ Windows-PC   │ 10 minutes ago  │ screen, run  │
 * └────┴──────────────┴─────────────────┴──────────────┘
 * *\/
 * ```
 * 
 * @module cli/nodes-cli/register.status
 */

function formatVersionLabel(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return raw;
  }
  if (trimmed.toLowerCase().startsWith("v")) {
    return trimmed;
  }
  return /^\d/.test(trimmed) ? `v${trimmed}` : trimmed;
}

function resolveNodeVersions(node: {
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
}) {
  const core = node.coreVersion?.trim() || undefined;
  const ui = node.uiVersion?.trim() || undefined;
  if (core || ui) {
    return { core, ui };
  }
  const legacy = node.version?.trim();
  if (!legacy) {
    return { core: undefined, ui: undefined };
  }
  const platform = node.platform?.trim().toLowerCase() ?? "";
  const headless =
    platform === "darwin" || platform === "linux" || platform === "win32" || platform === "windows";
  return headless ? { core: legacy, ui: undefined } : { core: undefined, ui: legacy };
}

function formatNodeVersions(node: {
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
}) {
  const { core, ui } = resolveNodeVersions(node);
  const parts: string[] = [];
  if (core) {
    parts.push(`core ${formatVersionLabel(core)}`);
  }
  if (ui) {
    parts.push(`ui ${formatVersionLabel(ui)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatPathEnv(raw?: string): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(":").filter(Boolean);
  const display =
    parts.length <= 3 ? trimmed : `${parts.slice(0, 2).join(":")}:…:${parts.slice(-1)[0]}`;
  return shortenHomeInString(display);
}

function parseSinceMs(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const value =
    typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw).trim() : null;
  if (value === null) {
    defaultRuntime.error(`${label}: invalid duration value`);
    defaultRuntime.exit(1);
    return undefined;
  }
  if (!value) {
    return undefined;
  }
  try {
    return parseDurationMs(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    defaultRuntime.error(`${label}: ${message}`);
    defaultRuntime.exit(1);
    return undefined;
  }
}

export function registerNodesStatusCommands(nodes: Command) {
  nodesCallOpts(
    nodes
      .command("status")
      .description("List known nodes with connection status and capabilities")
      .option("--connected", "Only show connected nodes")
      .option("--last-connected <duration>", "Only show nodes connected within duration (e.g. 24h)")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("status", async () => {
          const connectedOnly = Boolean(opts.connected);
          const sinceMs = parseSinceMs(opts.lastConnected, "Invalid --last-connected");
          const result = await callGatewayCli("node.list", opts, {});
          const obj: Record<string, unknown> =
            typeof result === "object" && result !== null ? result : {};
          const { ok, warn, muted } = getNodesTheme();
          const tableWidth = getTerminalTableWidth();
          const now = Date.now();
          const nodes = parseNodeList(result);
          const lastConnectedById =
            sinceMs !== undefined
              ? new Map(
                  parsePairingList(await callGatewayCli("node.pair.list", opts, {})).paired.map(
                    (entry) => [entry.nodeId, entry],
                  ),
                )
              : null;
          const filtered = nodes.filter((n) => {
            if (connectedOnly && !n.connected) {
              return false;
            }
            if (sinceMs !== undefined) {
              const paired = lastConnectedById?.get(n.nodeId);
              const lastConnectedAtMs =
                typeof paired?.lastConnectedAtMs === "number"
                  ? paired.lastConnectedAtMs
                  : typeof n.connectedAtMs === "number"
                    ? n.connectedAtMs
                    : undefined;
              if (typeof lastConnectedAtMs !== "number") {
                return false;
              }
              if (now - lastConnectedAtMs > sinceMs) {
                return false;
              }
            }
            return true;
          });

          if (opts.json) {
            const ts = typeof obj.ts === "number" ? obj.ts : Date.now();
            defaultRuntime.writeJson({ ...obj, ts, nodes: filtered });
            return;
          }

          const pairedCount = filtered.filter((n) => Boolean(n.paired)).length;
          const connectedCount = filtered.filter((n) => Boolean(n.connected)).length;
          const filteredLabel = filtered.length !== nodes.length ? ` (of ${nodes.length})` : "";
          defaultRuntime.log(
            `Known: ${filtered.length}${filteredLabel} · Paired: ${pairedCount} · Connected: ${connectedCount}`,
          );
          if (filtered.length === 0) {
            return;
          }

          const rows = filtered.map((n) => {
            const name = n.displayName?.trim() ? n.displayName.trim() : n.nodeId;
            const perms = formatPermissions(n.permissions);
            const versions = formatNodeVersions(n);
            const pathEnv = formatPathEnv(n.pathEnv);
            const detailParts = [
              n.deviceFamily ? `device: ${n.deviceFamily}` : null,
              n.modelIdentifier ? `hw: ${n.modelIdentifier}` : null,
              perms ? `perms: ${perms}` : null,
              versions,
              pathEnv ? `path: ${pathEnv}` : null,
            ].filter(Boolean) as string[];
            const caps = Array.isArray(n.caps)
              ? n.caps.map(String).filter(Boolean).toSorted().join(", ")
              : "?";
            const paired = n.paired ? ok("paired") : warn("unpaired");
            const connected = n.connected ? ok("connected") : muted("disconnected");
            const since =
              typeof n.connectedAtMs === "number"
                ? ` (${formatTimeAgo(Math.max(0, now - n.connectedAtMs))})`
                : "";

            return {
              Node: name,
              ID: n.nodeId,
              IP: n.remoteIp ?? "",
              Detail: detailParts.join(" · "),
              Status: `${paired} · ${connected}${since}`,
              Caps: caps,
            };
          });

          defaultRuntime.log(
            renderTable({
              width: tableWidth,
              columns: [
                { key: "Node", header: "Node", minWidth: 14, flex: true },
                { key: "ID", header: "ID", minWidth: 10 },
                { key: "IP", header: "IP", minWidth: 10 },
                { key: "Detail", header: "Detail", minWidth: 18, flex: true },
                { key: "Status", header: "Status", minWidth: 18 },
                { key: "Caps", header: "Caps", minWidth: 12, flex: true },
              ],
              rows,
            }).trimEnd(),
          );
        });
      }),
  );

  nodesCallOpts(
    nodes
      .command("describe")
      .description("Describe a node (capabilities + supported invoke commands)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("describe", async () => {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const result = await callGatewayCli("node.describe", opts, {
            nodeId,
          });
          if (opts.json) {
            defaultRuntime.writeJson(result);
            return;
          }

          const obj: Record<string, unknown> =
            typeof result === "object" && result !== null ? result : {};
          const displayName = typeof obj.displayName === "string" ? obj.displayName : nodeId;
          const connected = Boolean(obj.connected);
          const paired = Boolean(obj.paired);
          const caps = Array.isArray(obj.caps)
            ? obj.caps.map(String).filter(Boolean).toSorted()
            : null;
          const commands = Array.isArray(obj.commands)
            ? obj.commands.map(String).filter(Boolean).toSorted()
            : [];
          const perms = formatPermissions(obj.permissions);
          const family = typeof obj.deviceFamily === "string" ? obj.deviceFamily : null;
          const model = typeof obj.modelIdentifier === "string" ? obj.modelIdentifier : null;
          const ip = typeof obj.remoteIp === "string" ? obj.remoteIp : null;
          const pathEnv = typeof obj.pathEnv === "string" ? obj.pathEnv : null;
          const versions = formatNodeVersions(
            obj as {
              platform?: string;
              version?: string;
              coreVersion?: string;
              uiVersion?: string;
            },
          );

          const { heading, ok, warn, muted } = getNodesTheme();
          const status = `${paired ? ok("paired") : warn("unpaired")} · ${
            connected ? ok("connected") : muted("disconnected")
          }`;
          const tableWidth = getTerminalTableWidth();
          const rows = [
            { Field: "ID", Value: nodeId },
            displayName ? { Field: "Name", Value: displayName } : null,
            ip ? { Field: "IP", Value: ip } : null,
            family ? { Field: "Device", Value: family } : null,
            model ? { Field: "Model", Value: model } : null,
            perms ? { Field: "Perms", Value: perms } : null,
            versions ? { Field: "Version", Value: versions } : null,
            pathEnv ? { Field: "PATH", Value: pathEnv } : null,
            { Field: "Status", Value: status },
            { Field: "Caps", Value: caps ? caps.join(", ") : "?" },
          ].filter(Boolean) as Array<{ Field: string; Value: string }>;

          defaultRuntime.log(heading("Node"));
          defaultRuntime.log(
            renderTable({
              width: tableWidth,
              columns: [
                { key: "Field", header: "Field", minWidth: 8 },
                { key: "Value", header: "Value", minWidth: 24, flex: true },
              ],
              rows,
            }).trimEnd(),
          );
          defaultRuntime.log("");
          defaultRuntime.log(heading("Commands"));
          if (commands.length === 0) {
            defaultRuntime.log(muted("- (none reported)"));
            return;
          }
          for (const c of commands) {
            defaultRuntime.log(`- ${c}`);
          }
        });
      }),
  );

  nodesCallOpts(
    nodes
      .command("list")
      .description("List pending and paired nodes")
      .option("--connected", "Only show connected nodes")
      .option("--last-connected <duration>", "Only show nodes connected within duration (e.g. 24h)")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("list", async () => {
          const connectedOnly = Boolean(opts.connected);
          const sinceMs = parseSinceMs(opts.lastConnected, "Invalid --last-connected");
          const result = await callGatewayCli("node.pair.list", opts, {});
          const { pending, paired } = parsePairingList(result);
          const { heading, muted, warn } = getNodesTheme();
          const tableWidth = getTerminalTableWidth();
          const now = Date.now();
          const hasFilters = connectedOnly || sinceMs !== undefined;
          const pendingRows = hasFilters ? [] : pending;
          const connectedById = hasFilters
            ? new Map(
                parseNodeList(await callGatewayCli("node.list", opts, {})).map((node) => [
                  node.nodeId,
                  node,
                ]),
              )
            : null;
          const filteredPaired = paired.filter((node) => {
            if (connectedOnly) {
              const live = connectedById?.get(node.nodeId);
              if (!live?.connected) {
                return false;
              }
            }
            if (sinceMs !== undefined) {
              const live = connectedById?.get(node.nodeId);
              const lastConnectedAtMs =
                typeof node.lastConnectedAtMs === "number"
                  ? node.lastConnectedAtMs
                  : typeof live?.connectedAtMs === "number"
                    ? live.connectedAtMs
                    : undefined;
              if (typeof lastConnectedAtMs !== "number") {
                return false;
              }
              if (now - lastConnectedAtMs > sinceMs) {
                return false;
              }
            }
            return true;
          });
          const filteredLabel =
            hasFilters && filteredPaired.length !== paired.length ? ` (of ${paired.length})` : "";
          defaultRuntime.log(
            `Pending: ${pendingRows.length} · Paired: ${filteredPaired.length}${filteredLabel}`,
          );

          if (opts.json) {
            defaultRuntime.writeJson({ pending: pendingRows, paired: filteredPaired });
            return;
          }

          if (pendingRows.length > 0) {
            const rendered = renderPendingPairingRequestsTable({
              pending: pendingRows,
              now,
              tableWidth,
              theme: { heading, warn, muted },
            });
            defaultRuntime.log("");
            defaultRuntime.log(rendered.heading);
            defaultRuntime.log(rendered.table);
          }

          if (filteredPaired.length > 0) {
            const pairedRows = filteredPaired.map((n) => {
              const live = connectedById?.get(n.nodeId);
              const lastConnectedAtMs =
                typeof n.lastConnectedAtMs === "number"
                  ? n.lastConnectedAtMs
                  : typeof live?.connectedAtMs === "number"
                    ? live.connectedAtMs
                    : undefined;
              return {
                Node: n.displayName?.trim() ? n.displayName.trim() : n.nodeId,
                Id: n.nodeId,
                IP: n.remoteIp ?? "",
                LastConnect:
                  typeof lastConnectedAtMs === "number"
                    ? formatTimeAgo(Math.max(0, now - lastConnectedAtMs))
                    : muted("unknown"),
              };
            });
            defaultRuntime.log("");
            defaultRuntime.log(heading("Paired"));
            defaultRuntime.log(
              renderTable({
                width: tableWidth,
                columns: [
                  { key: "Node", header: "Node", minWidth: 14, flex: true },
                  { key: "Id", header: "ID", minWidth: 10 },
                  { key: "IP", header: "IP", minWidth: 10 },
                  { key: "LastConnect", header: "Last Connect", minWidth: 14 },
                ],
                rows: pairedRows,
              }).trimEnd(),
            );
          }
        });
      }),
  );
}
