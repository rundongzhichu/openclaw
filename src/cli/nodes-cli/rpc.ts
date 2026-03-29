/**
 * @fileoverview 节点 RPC 调用封装与节点解析工具
 * 
 * 本文件实现了 OpenClaw 节点管理 CLI 命令的 RPC 调用封装，提供了与 Gateway 通信、节点 ID 解析、权限错误处理等功能：
 * 
 * **核心功能**:
 * - RPC 选项定义（URL/Token/超时/JSON 输出）
 * - Gateway 调用封装（带进度指示器）
 * - 节点调用参数构建（幂等性键生成）
 * - 未授权错误识别与提示（peekaboo bridge 安全机制）
 * - 节点 ID 解析（从节点列表或配对列表中查找）
 * - 节点对象解析（统一节点和配对设备的数据结构）
 * 
 * **辅助函数**（6 个核心导出）:
 * 
 * 1. **nodesCallOpts** - 定义节点 RPC 命令选项
 *    - `--url`: Gateway WebSocket URL（可选，默认从配置读取）
 *    - `--token`: Gateway 认证 Token（可选）
 *    - `--timeout`: 超时时间（毫秒），默认 10000ms
 *    - `--json`: JSON 输出模式，默认 false
 * 
 * 2. **callGatewayCli** - 调用 Gateway RPC 方法
 *    - 封装 callGateway 函数
 *    - 带进度指示器（withProgress）
 *    - 支持自定义超时时间
 *    - 自动设置客户端名称和模式
 * 
 * 3. **buildNodeInvokeParams** - 构建节点调用参数
 *    - nodeId: 目标节点 ID
 *    - command: 要执行的命令
 *    - params: 命令参数
 *    - idempotencyKey: 幂等性键（随机生成）
 *    - timeoutMs: 超时时间（可选）
 * 
 * 4. **unauthorizedHintForMessage** - 识别未授权错误
 *    - 检测 "unauthorizedclient"
 *    - 检测 "bridge client is not authorized"
 *    - 检测 "unsigned bridge clients are not allowed"
 *    - 返回 peekaboo bridge 修复提示
 * 
 * 5. **resolveNodeId** - 解析节点 ID
 *    - 支持节点名称/ID 模糊匹配
 *    - 优先从 node.list 获取
 *    - 回退到 node.pair.list
 * 
 * 6. **resolveNode** - 解析节点对象
 *    - 尝试从已连接节点列表获取
 *    - 失败时从配对设备列表获取
 *    - 统一返回 NodeListNode 格式
 * 
 * **使用示例**:
 * ```typescript
 * // 场景 1: 定义 RPC 选项
 * const cmd = new Command();
 * nodesCallOpts(cmd, { timeoutMs: 5000 });
 * // → 添加了 --url, --token, --timeout, --json 选项
 * 
 * // 场景 2: 调用 Gateway RPC
 * const opts: NodesRpcOpts = {
 *   url: 'ws://127.0.0.1:18789',
 *   token: 'my-token',
 *   timeout: '10000',
 *   json: false
 * };
 * const result = await callGatewayCli('node.list', opts, {});
 * /*
 * [Progress] Nodes node.list
 * ✓ Completed
 * Returns: { nodes: [...], paired: [...] }
 * *\/
 * 
 * // 场景 3: 构建节点调用参数
 * const params = buildNodeInvokeParams({
 *   nodeId: 'macos-node-id',
 *   command: 'system.run',
 *   params: { cmd: 'uname -a' },
 *   timeoutMs: 30000
 * });
 * /*
 * {
 *   nodeId: 'macos-node-id',
 *   command: 'system.run',
 *   params: { cmd: 'uname -a' },
 *   idempotencyKey: 'random-key-123',
 *   timeoutMs: 30000
 * }
 * *\/
 * 
 * // 场景 4: 识别未授权错误
 * const message = "UnauthorizedClient: bridge client is not authorized";
 * const hint = unauthorizedHintForMessage(message);
 * /*
 * "peekaboo bridge rejected the client. sign the peekaboo CLI (TeamID Y5PE65HELJ) or launch the host with PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1 for local dev."
 * *\/
 * 
 * // 场景 5: 解析节点 ID
 * const nodeId = await resolveNodeId(opts, 'macos-pro');
 * // → 从节点列表中查找并返回匹配的 nodeId
 * 
 * // 场景 6: 解析节点对象
 * const node = await resolveNode(opts, 'iphone-15');
 * /*
 * {
 *   nodeId: 'iphone-node-id',
 *   displayName: 'iPhone 15',
 *   platform: 'iOS',
 *   version: '2.0.0',
 *   remoteIp: '192.168.1.100'
 * }
 * *\/
 * 
 * // 场景 7: 完整调用流程
 * const opts: NodesRpcOpts = { url: 'ws://...', token: '...', timeout: '10000', json: false };
 * const nodeId = await resolveNodeId(opts, 'macos-pro');
 * const params = buildNodeInvokeParams({
 *   nodeId,
 *   command: 'system.run',
 *   params: { cmd: 'whoami' }
 * });
 * const result = await callGatewayCli('node.invoke', opts, params);
 * console.log(result.output); // 'root'
 * ```
 * 
 * @module cli/nodes-cli/rpc
 */

import type { Command } from "commander";
import { callGateway, randomIdempotencyKey } from "../../gateway/call.js";
import { resolveNodeFromNodeList } from "../../shared/node-resolve.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { withProgress } from "../progress.js";
import { parseNodeList, parsePairingList } from "./format.js";
import type { NodeListNode, NodesRpcOpts } from "./types.js";

export const nodesCallOpts = (cmd: Command, defaults?: { timeoutMs?: number }) =>
  cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--timeout <ms>", "Timeout in ms", String(defaults?.timeoutMs ?? 10_000))
    .option("--json", "Output JSON", false);

export const callGatewayCli = async (
  method: string,
  opts: NodesRpcOpts,
  params?: unknown,
  callOpts?: { transportTimeoutMs?: number },
) =>
  withProgress(
    {
      label: `Nodes ${method}`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway({
        url: opts.url,
        token: opts.token,
        method,
        params,
        timeoutMs: callOpts?.transportTimeoutMs ?? Number(opts.timeout ?? 10_000),
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      }),
  );

export function buildNodeInvokeParams(params: {
  nodeId: string;
  command: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  idempotencyKey?: string;
}): Record<string, unknown> {
  const invokeParams: Record<string, unknown> = {
    nodeId: params.nodeId,
    command: params.command,
    params: params.params,
    idempotencyKey: params.idempotencyKey ?? randomIdempotencyKey(),
  };
  if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) {
    invokeParams.timeoutMs = params.timeoutMs;
  }
  return invokeParams;
}

export function unauthorizedHintForMessage(message: string): string | null {
  const haystack = message.toLowerCase();
  if (
    haystack.includes("unauthorizedclient") ||
    haystack.includes("bridge client is not authorized") ||
    haystack.includes("unsigned bridge clients are not allowed")
  ) {
    return [
      "peekaboo bridge rejected the client.",
      "sign the peekaboo CLI (TeamID Y5PE65HELJ) or launch the host with",
      "PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1 for local dev.",
    ].join(" ");
  }
  return null;
}

export async function resolveNodeId(opts: NodesRpcOpts, query: string) {
  return (await resolveNode(opts, query)).nodeId;
}

export async function resolveNode(opts: NodesRpcOpts, query: string): Promise<NodeListNode> {
  let nodes: NodeListNode[] = [];
  try {
    const res = await callGatewayCli("node.list", opts, {});
    nodes = parseNodeList(res);
  } catch {
    const res = await callGatewayCli("node.pair.list", opts, {});
    const { paired } = parsePairingList(res);
    nodes = paired.map((n) => ({
      nodeId: n.nodeId,
      displayName: n.displayName,
      platform: n.platform,
      version: n.version,
      remoteIp: n.remoteIp,
    }));
  }
  return resolveNodeFromNodeList(nodes, query);
}
