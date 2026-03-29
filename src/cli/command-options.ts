/**
 * @fileoverview CLI 命令选项处理与继承逻辑
 * 
 * 本文件实现了 Commander.js 命令选项的来源检测和祖先继承逻辑。
 * 
 * **核心功能**:
 * - 检测选项是否来自 CLI 显式指定（而非默认值）
 * - 从父级/祖父级命令继承选项值
 * - 防御性深度限制（最多 2 层继承）
 * - 选项来源追踪（cli, default, env 等）
 * 
 * **选项来源类型**:
 * - `"cli"`: 用户通过命令行显式指定（如 `--profile dev`）
 * - `"default"`: 使用默认值
 * - `"env"`: 来自环境变量
 * - `"config"`: 来自配置文件
 * 
 * **继承规则**:
 * 1. 子命令优先：如果子命令已显式指定，不继承
 * 2. 向上查找：从父级开始，最多查找 2 层（parent → grandparent）
 * 3. 跳过默认值：只继承非默认值
 * 
 * **使用示例**:
 * ```typescript
 * // 场景 1: 检测是否有显式指定 options
 * const program = new Command()
 *   .option('--profile <name>', 'Profile name', 'default')
 *   .parse(['node', 'test', '--profile', 'prod']);
 * 
 * hasExplicitOptions(program, ['profile']);
 * // → true (因为 --profile prod 是显式指定的)
 * 
 * // 场景 2: 从父命令继承选项
 * const parent = new Command()
 *   .option('--verbose', 'Verbose mode')
 *   .parse(['node', 'test', '--verbose']);
 * 
 * const child = parent.command('sub');
 * inheritOptionFromParent(child, 'verbose');
 * // → true (从父命令继承了 verbose)
 * 
 * // 场景 3: 子命令覆盖父命令
 * const parent2 = new Command()
 *   .option('--timeout <ms>', 'Timeout in ms', '5000')
 *   .parse(['node', 'test', '--timeout', '10000']);
 * 
 * const child2 = parent2.command('sub')
 *   .option('--timeout <ms>', 'Timeout in ms', '5000')
 *   .parse(['node', 'test', 'sub', '--timeout', '3000']);
 * 
 * inheritOptionFromParent(child2, 'timeout');
 * // → undefined (子命令已有显式值，不继承)
 * ```
 * 
 * @module cli/command-options
 */

import type { Command } from "commander";

/**
 * 检查命令是否包含显式指定的选项
 * 
 * **检测逻辑**:
 * 1. 检查 Commander API 支持性（getOptionValueSource）
 * 2. 遍历所有指定选项名
 * 3. 检查选项值来源是否为 "cli"（命令行显式指定）
 * 
 * **用途**:
 * - 区分用户显式指定 vs 默认值
 * - 条件逻辑判断（如显式指定时才执行特定操作）
 * - 避免覆盖用户的显式选择
 * 
 * @param command - Commander 命令对象
 * @param names - 要检查的选项名列表（只读数组）
 * @returns 是否存在至少一个显式指定的选项
 * 
 * @example
 * ```typescript
 * // 示例 1: 有显式指定
 * const cmd1 = new Command()
 *   .option('--profile <name>', 'Profile name')
 *   .parse(['node', 'test', '--profile', 'prod']);
 * 
 * hasExplicitOptions(cmd1, ['profile']);
 * // → true (因为 --profile prod 来自 CLI)
 * 
 * // 示例 2: 无显式指定（使用默认值）
 * const cmd2 = new Command()
 *   .option('--profile <name>', 'Profile name', 'default')
 *   .parse(['node', 'test']);
 * 
 * hasExplicitOptions(cmd2, ['profile']);
 * // → false (因为没有指定，使用默认值)
 * 
 * // 示例 3: 多个选项中至少有一个显式指定
 * const cmd3 = new Command()
 *   .option('--verbose', 'Verbose')
 *   .option('--timeout <ms>', 'Timeout', '5000')
 *   .parse(['node', 'test', '--verbose']);
 * 
 * hasExplicitOptions(cmd3, ['verbose', 'timeout']);
 * // → true (因为 verbose 是显式指定的)
 * 
 * // 示例 4: Commander API 不支持时的防御处理
 * const mockCmd = { getOptionValueSource: undefined };
 * hasExplicitOptions(mockCmd as any, ['profile']);
 * // → false (安全降级，不抛异常)
 * ```
 */
export function hasExplicitOptions(command: Command, names: readonly string[]): boolean {
  // 防御性检查：Commander API 支持性
  if (typeof command.getOptionValueSource !== "function") {
    return false;
  }
  
  // 只要有一个选项是来自 CLI，就返回 true
  return names.some((name) => command.getOptionValueSource(name) === "cli");
}

/**
 * 获取选项的值来源
 * 
 * **返回值说明**:
 * - `"cli"`: 从命令行参数解析
 * - `"default"`: 使用默认值
 * - `"env"`: 从环境变量加载
 * - `"config"`: 从配置文件读取
 * - `undefined`: API 不支持或选项不存在
 * 
 * @param command - Commander 命令对象
 * @param name - 选项名
 * @returns 选项值来源字符串或 undefined
 */
function getOptionSource(command: Command, name: string): string | undefined {
  // 防御性检查：API 支持性
  if (typeof command.getOptionValueSource !== "function") {
    return undefined;
  }
  
  return command.getOptionValueSource(name);
}

/** 最大继承深度限制（防御性设计） */
const MAX_INHERIT_DEPTH = 2;

/**
 * 从祖先命令继承选项值
 * 
 * **继承策略**:
 * 1. **子命令优先**: 如果子命令已显式指定选项，不继承（返回 undefined）
 * 2. **向上查找**: 从父级开始，逐级向上查找（parent → grandparent）
 * 3. **深度限制**: 最多查找 2 层，避免无界遍历
 * 4. **跳过默认值**: 只继承非默认值（source !== "default"）
 * 
 * **为什么需要继承**:
 * - 全局选项（如 --verbose, --timeout）可以在根命令定义
 * - 子命令自动继承这些选项，无需重复定义
 * - 保持 DRY 原则，减少配置冗余
 * 
 * @template T - 选项值的类型
 * @param command - 子命令对象（可选，undefined 则直接返回 undefined）
 * @param name - 要继承的选项名
 * @returns 继承到的选项值，如果没有可继承的值则返回 undefined
 * 
 * @example
 * ```typescript
 * // 场景 1: 基本继承（父 → 子）
 * const parent = new Command()
 *   .option('--verbose', 'Enable verbose mode')
 *   .parse(['node', 'openclaw', '--verbose']);
 * 
 * const child = parent.command('gateway');
 * inheritOptionFromParent(child, 'verbose');
 * // → true (从父命令继承了 verbose)
 * 
 * // 场景 2: 跨层继承（祖父 → 子）
 * const grandparent = new Command()
 *   .option('--timeout <ms>', 'Global timeout', '10000')
 *   .parse(['node', 'openclaw', '--timeout', '15000']);
 * 
 * const parent2 = grandparent.command('agent');
 * const child2 = parent2.command('spawn');
 * 
 * inheritOptionFromParent(child2, 'timeout');
 * // → '15000' (从祖父命令继承，跨越 2 层)
 * 
 * // 场景 3: 子命令覆盖（不继承）
 * const parent3 = new Command()
 *   .option('--profile <name>', 'Profile', 'default')
 *   .parse(['node', 'openclaw', '--profile', 'prod']);
 * 
 * const child3 = parent3.command('sub')
 *   .option('--profile <name>', 'Profile', 'default')
 *   .parse(['node', 'openclaw', 'sub', '--profile', 'dev']);
 * 
 * inheritOptionFromParent(child3, 'profile');
 * // → undefined (子命令已有显式值，不继承)
 * 
 * // 场景 4: 子命令使用默认值（可继承）
 * const parent4 = new Command()
 *   .option('--verbose', '', false)
 *   .parse(['node', 'openclaw', '--verbose']);
 * 
 * const child4 = parent4.command('sub')
 *   .option('--verbose', '', false)
 *   .parse(['node', 'openclaw', 'sub']);
 * 
 * inheritOptionFromParent(child4, 'verbose');
 * // → true (子命令未显式指定，继承父命令的值)
 * 
 * // 场景 5: 超过继承深度（返回 undefined）
 * const root = new Command()
 *   .option('--global-flag', '')
 *   .parse(['node', 'root', '--global-flag']);
 * 
 * const level1 = root.command('l1');
 * const level2 = level1.command('l2');
 * const level3 = level2.command('l3');
 * 
 * inheritOptionFromParent(level3, 'global-flag');
 * // → undefined (超过 MAX_INHERIT_DEPTH=2 的限制)
 * ```
 */
export function inheritOptionFromParent<T = unknown>(
  command: Command | undefined,
  name: string,
): T | undefined {
  // 快速路径：command 为 undefined 时直接返回
  if (!command) {
    return undefined;
  }

  // 步骤 1: 检查子命令自身的选项来源
  const childSource = getOptionSource(command, name);
  
  // 如果子命令已有显式值（非默认值），不继承
  if (childSource && childSource !== "default") {
    return undefined;
  }

  // 步骤 2: 向上遍历祖先链（最多 2 层）
  let depth = 0;
  let ancestor = command.parent;
  
  while (ancestor && depth < MAX_INHERIT_DEPTH) {
    // 检查当前祖先的选项来源
    const source = getOptionSource(ancestor, name);
    
    // 找到非默认值的祖先选项，返回其值
    if (source && source !== "default") {
      return ancestor.opts<Record<string, unknown>>()[name] as T | undefined;
    }
    
    // 继续向上一级
    depth += 1;
    ancestor = ancestor.parent;
  }
  
  // 没有找到可继承的值
  return undefined;
}
