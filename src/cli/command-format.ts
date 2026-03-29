/**
 * @fileoverview CLI 命令格式化与标准化
 * 
 * 本文件实现了 OpenClaw CLI 命令的格式化和标准化逻辑。
 * 
 * **核心功能**:
 * - CLI 名称替换和规范化
 * - 容器标志自动注入（--container）
 * - Profile 标志自动注入（--profile）
 * - 命令前缀检测和匹配
 * - 更新命令特殊处理
 * 
 * **环境变量支持**:
 * - `OPENCLAW_CONTAINER_HINT`: 容器提示（如 docker, podman）
 * - `OPENCLAW_PROFILE`: 配置 profile 名称
 * 
 * **正则表达式模式**:
 * - CLI_PREFIX_RE: 匹配 openclaw 命令前缀（支持 pnpm/npm/bunx/npx）
 * - CONTAINER_FLAG_RE: 检测 --container 标志
 * - PROFILE_FLAG_RE: 检测 --profile 标志
 * - DEV_FLAG_RE: 检测 --dev 标志
 * - UPDATE_COMMAND_RE: 检测 update 命令
 * 
 * **使用示例**:
 * ```typescript
 * // 场景 1: 基本命令格式化
 * formatCliCommand('openclaw agent --message "Hello"');
 * // → 'openclaw agent --message "Hello"'
 * 
 * // 场景 2: 带容器环境
 * process.env.OPENCLAW_CONTAINER_HINT = 'docker';
 * formatCliCommand('openclaw gateway');
 * // → 'openclaw gateway --container docker'
 * 
 * // 场景 3: 带 Profile
 * process.env.OPENCLAW_PROFILE = 'production';
 * formatCliCommand('openclaw deploy');
 * // → 'openclaw deploy --profile production'
 * 
 * // 场景 4: 已有标志不重复添加
 * formatCliCommand('openclaw gateway --container docker');
 * // → 'openclaw gateway --container docker' (不重复)
 * 
 * // 场景 5: 更新命令特殊处理
 * formatCliCommand('openclaw update');
 * // → 'openclaw update' (不添加 container 标志)
 * ```
 * 
 * @module cli/command-format
 */

import { replaceCliName, resolveCliName } from "./cli-name.js";
import { normalizeProfileName } from "./profile-utils.js";

/** CLI 命令前缀正则表达式 */
const CLI_PREFIX_RE = /^(?:pnpm|npm|bunx|npx)\s+openclaw\b|^openclaw\b/;

/** 容器标志正则表达式（检测是否已包含 --container） */
const CONTAINER_FLAG_RE = /(?:^|\s)--container(?:\s|=|$)/;

/** Profile 标志正则表达式（检测是否已包含 --profile） */
const PROFILE_FLAG_RE = /(?:^|\s)--profile(?:\s|=|$)/;

/** 开发模式标志正则表达式（检测是否已包含 --dev） */
const DEV_FLAG_RE = /(?:^|\s)--dev(?:\s|$)/;

/** 更新命令正则表达式（update 命令需要特殊处理） */
const UPDATE_COMMAND_RE =
  /^(?:pnpm|npm|bunx|npx)\s+openclaw\b.*(?:^|\s)update(?:\s|$)|^openclaw\b.*(?:^|\s)update(?:\s|$)/;

/**
 * 格式化 CLI 命令
 * 
 * **核心逻辑**:
 * 1. 替换 CLI 名称为标准格式
 * 2. 检查是否需要添加容器标志
 * 3. 检查是否需要添加 profile 标志
 * 4. 避免重复添加已存在的标志
 * 5. update 命令特殊处理（不添加 container）
 * 
 * **参数说明**:
 * - `command`: 原始 CLI 命令字符串
 * - `env`: 环境变量对象（默认 process.env）
 * 
 * **返回值**:
 * 格式化后的 CLI 命令字符串
 * 
 * @param command - 要格式化的 CLI 命令
 * @param env - 环境变量对象（可选，默认 process.env）
 * @returns 格式化后的命令字符串
 * 
 * @example
 * ```typescript
 * // 示例 1: 无环境变量，返回原命令
 * const cmd1 = formatCliCommand('openclaw agent --message "Hello"');
 * // → 'openclaw agent --message "Hello"'
 * 
 * // 示例 2: 有容器环境，自动注入 --container
 * const cmd2 = formatCliCommand(
 *   'openclaw gateway --port 18789',
 *   { OPENCLAW_CONTAINER_HINT: 'docker' }
 * );
 * // → 'openclaw gateway --port 18789 --container docker'
 * 
 * // 示例 3: 有 Profile 环境，自动注入 --profile
 * const cmd3 = formatCliCommand(
 *   'openclaw deploy',
 *   { OPENCLAW_PROFILE: 'production' }
 * );
 * // → 'openclaw deploy --profile production'
 * 
 * // 示例 4: 同时有 container 和 profile
 * const cmd4 = formatCliCommand(
 *   'openclaw run task',
 *   { 
 *     OPENCLAW_CONTAINER_HINT: 'podman',
 *     OPENCLAW_PROFILE: 'staging'
 *   }
 * );
 * // → 'openclaw run task --container podman --profile staging'
 * 
 * // 示例 5: 命令已有标志，不重复添加
 * const cmd5 = formatCliCommand(
 *   'openclaw gateway --container docker --profile dev',
 *   { 
 *     OPENCLAW_CONTAINER_HINT: 'docker',
 *     OPENCLAW_PROFILE: 'prod'
 *   }
 * );
 * // → 'openclaw gateway --container docker --profile dev' (保持不变)
 * 
 * // 示例 6: update 命令特殊处理（不添加 container）
 * const cmd6 = formatCliCommand(
 *   'openclaw update',
 *   { OPENCLAW_CONTAINER_HINT: 'docker' }
 * );
 * // → 'openclaw update' (update 命令不需要 container)
 * 
 * // 示例 7: 支持多种 CLI 启动方式
 * const cmd7 = formatCliCommand(
 *   'pnpm openclaw agent',
 *   { OPENCLAW_PROFILE: 'test' }
 * );
 * // → 'pnpm openclaw agent --profile test'
 * 
 * const cmd8 = formatCliCommand(
 *   'npx openclaw@latest gateway',
 *   { OPENCLAW_CONTAINER_HINT: 'docker' }
 * );
 * // → 'npx openclaw@latest gateway --container docker'
 * ```
 */
export function formatCliCommand(
  command: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  // 步骤 1: 解析并替换 CLI 名称为标准格式
  const cliName = resolveCliName();
  const normalizedCommand = replaceCliName(command, cliName);
  
  // 步骤 2: 从环境变量中读取 container hint 和 profile
  const container = env.OPENCLAW_CONTAINER_HINT?.trim();
  const profile = normalizeProfileName(env.OPENCLAW_PROFILE);
  
  // 步骤 3: 如果都没有，直接返回标准化后的命令
  if (!container && !profile) {
    return normalizedCommand;
  }
  
  // 步骤 4: 检查是否是 openclaw 命令（非 openclaw 命令不处理）
  if (!CLI_PREFIX_RE.test(normalizedCommand)) {
    return normalizedCommand;
  }
  
  // 步骤 5: 收集需要添加的标志
  const additions: string[] = [];
  
  // 添加 container 标志（如果未包含且不是 update 命令）
  if (
    container &&
    !CONTAINER_FLAG_RE.test(normalizedCommand) &&
    !UPDATE_COMMAND_RE.test(normalizedCommand)
  ) {
    additions.push(`--container ${container}`);
  }
  
  // 添加 profile 标志（如果未包含且不是 dev 模式）
  if (
    !container &&  // 注意：有 container 时不再添加 profile
    profile &&
    !PROFILE_FLAG_RE.test(normalizedCommand) &&
    !DEV_FLAG_RE.test(normalizedCommand)
  ) {
    additions.push(`--profile ${profile}`);
  }
  
  // 步骤 6: 如果没有需要添加的标志，直接返回
  if (additions.length === 0) {
    return normalizedCommand;
  }
  
  // 步骤 7: 在 CLI 前缀后插入新增的标志
  return normalizedCommand.replace(CLI_PREFIX_RE, (match) => `${match} ${additions.join(" ")}`);
}
