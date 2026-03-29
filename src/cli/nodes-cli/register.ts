import type { Command } from "commander";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { formatHelpExamples } from "../help-format.js";
import { registerNodesCameraCommands } from "./register.camera.js";
import { registerNodesCanvasCommands } from "./register.canvas.js";
import { registerNodesInvokeCommands } from "./register.invoke.js";
import { registerNodesLocationCommands } from "./register.location.js";
import { registerNodesNotifyCommand } from "./register.notify.js";
import { registerNodesPairingCommands } from "./register.pairing.js";
import { registerNodesPushCommand } from "./register.push.js";
import { registerNodesScreenCommands } from "./register.screen.js";
import { registerNodesStatusCommands } from "./register.status.js";

/**
 * @fileoverview 节点 CLI 命令注册与实现
 * 
 * 本文件实现了 OpenClaw 节点管理 CLI 命令的注册逻辑，提供了完整的节点配对、状态检查、命令调用、媒体控制等功能：
 * 
 * **核心功能**:
 * - 节点命令注册入口（统一注册所有子命令）
 * - 节点状态管理（在线/离线状态、心跳检测）
 * - 节点配对管理（待处理请求、已授权列表）
 * - 远程命令执行（shell 命令、脚本运行）
 * - 通知推送（系统通知、消息推送）
 * - Push 配置管理（APNs/FCM 配置）
 * - 画布协作控制（实时共享、协作编辑）
 * - 摄像头控制（拍照、录像、流媒体）
 * - 屏幕共享（屏幕录制、窗口捕获）
 * - 位置获取（GPS 定位、地址解析）
 * 
 * **节点命令列表**（9 个主要子命令模块）:
 * 1. **nodes status** - 节点状态管理
 *    - 列出已知节点
 *    - 显示在线状态
 *    - 心跳时间戳
 * 
 * 2. **nodes pairing** - 节点配对管理
 *    - 查看待处理请求
 *    - 授权/拒绝配对
 *    - 撤销已授权设备
 * 
 * 3. **nodes run/invoke** - 远程命令执行
 *    - 执行 shell 命令
 *    - 运行脚本
 *    - 获取输出结果
 * 
 * 4. **nodes notify** - 通知推送
 *    - 发送系统通知
 *    - 推送消息到设备
 *    - 自定义通知内容
 * 
 * 5. **nodes push** - Push 配置管理
 *    - APNs 配置（iOS/macOS）
 *    - FCM 配置（Android）
 *    - 测试推送
 * 
 * 6. **nodes canvas** - 画布协作
 *    - 开启实时共享
 *    - 协作编辑控制
 *    - 画布状态管理
 * 
 * 7. **nodes camera** - 摄像头控制
 *    - 拍照快照
 *    - 开始/停止录像
 *    - 获取摄像头列表
 * 
 * 8. **nodes screen** - 屏幕共享
 *    - 开始屏幕录制
 *    - 窗口捕获
 *    - 屏幕截图
 * 
 * 9. **nodes location** - 位置获取
 *    - 获取 GPS 坐标
 *    - 地址反向解析
 *    - 位置历史记录
 * 
 * **使用示例**:
 * ```typescript
 * // 场景 1: 注册节点 CLI
 * const program = new Command();
 * registerNodesCli(program);
 * await program.parseAsync(process.argv);
 * 
 * // 场景 2: 查看节点状态
 * await program.parseAsync(['node', 'openclaw', 'nodes', 'status']);
 * /*
 * Node Status:
 *   macOS-Pro (online) - Last seen: just now
 *   iPhone-15 (offline) - Last seen: 2 hours ago
 * *\/
 * 
 * // 场景 3: 管理配对请求
 * await program.parseAsync(['node', 'openclaw', 'nodes', 'pairing', 'pending']);
 * /*
 * Pending Pairing Requests:
 *   [1] Windows-PC (Unknown Device)
 *       Requested: 2024-01-15 10:30:00
 *       Use: openclaw nodes pairing approve --id 1
 * *\/
 * 
 * // 场景 4: 远程执行命令
 * await program.parseAsync([
 *   'node', 'openclaw', 'nodes', 'run',
 *   '--node', 'macos-node-id',
 *   '--raw', 'uname -a'
 * ]);
 * /*
 * Output:
 *   Darwin macOS-Pro 23.2.0 arm64
 * *\/
 * 
 * // 场景 5: 拍照快照
 * await program.parseAsync([
 *   'node', 'openclaw', 'nodes', 'camera', 'snap',
 *   '--node', 'iphone-node-id',
 *   '--output', './photo.jpg'
 * ]);
 * /*
 * ✓ Captured photo from iPhone (12MP)
 * Saved to: ./photo.jpg
 * *\/
 * 
 * // 场景 6: 推送系统通知
 * await program.parseAsync([
 *   'node', 'openclaw', 'nodes', 'notify',
 *   '--node', 'macos-node-id',
 *   '--title', 'Meeting Reminder',
 *   '--body', 'Team meeting in 5 minutes'
 * ]);
 * /*
 * ✓ Notification sent to macOS-Pro
 * *\/
 * ```
 * 
 * @module cli/nodes-cli/register
 */

export function registerNodesCli(program: Command) {
  const nodes = program
    .command("nodes")
    .description("Manage gateway-owned nodes (pairing, status, invoke, and media)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw nodes status", "List known nodes with live status."],
          ["openclaw nodes pairing pending", "Show pending node pairing requests."],
          ['openclaw nodes run --node <id> --raw "uname -a"', "Run a shell command on a node."],
          ["openclaw nodes camera snap --node <id>", "Capture a photo from a node camera."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/nodes", "docs.openclaw.ai/cli/nodes")}\n`,
    );

  registerNodesStatusCommands(nodes);
  registerNodesPairingCommands(nodes);
  registerNodesInvokeCommands(nodes);
  registerNodesNotifyCommand(nodes);
  registerNodesPushCommand(nodes);
  registerNodesCanvasCommands(nodes);
  registerNodesCameraCommands(nodes);
  registerNodesScreenCommands(nodes);
  registerNodesLocationCommands(nodes);
}
