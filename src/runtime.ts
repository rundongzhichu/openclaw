#!/usr/bin/env node
/**
 * @fileoverview OpenClaw 运行时环境定义
 * 
 * 本文件定义了 OpenClaw 系统的运行时环境接口和实现，用于抽象底层 I/O 操作。
 * 
 * **核心作用**:
 * - 提供统一的日志输出接口（log/error）
 * - 提供标准化的退出机制（exit）
 * - 支持 stdout 流式写入（writeStdout/writeJson）
 * - 测试环境兼容性（Vitest 模拟支持）
 * - 终端状态恢复
 * 
 * **设计模式**: 依赖注入
 * 通过将 I/O 操作封装为 RuntimeEnv 对象，可以在不同场景下替换实现：
 * - 生产环境：使用 defaultRuntime（实际输出到控制台）
 * - 测试环境：使用 createNonExitingRuntime()（抛出异常而非真正退出）
 * - CLI 后端：自定义输出目标（如文件、网络等）
 * 
 * **关键特性**:
 * 1. **管道安全**: 自动处理 EPIPE/EIO 错误（当输出管道被关闭时）
 * 2. **进度线保护**: 在输出前清除活动进度线，避免显示错乱
 * 3. **终端恢复**: 退出时恢复终端原始状态（特别是 stdin 的 TTY 模式）
 * 4. **测试友好**: 通过环境变量控制是否真实输出
 * 
 * **使用示例**:
 * ```typescript
 * // 在生产环境中使用
 * import { defaultRuntime } from "./runtime.js";
 * defaultRuntime.log("启动 Gateway...");
 * defaultRuntime.exit(0);
 * 
 * // 在测试中模拟
 * const testRuntime = createNonExitingRuntime();
 * try {
 *   testRuntime.exit(1);  // 抛出 Error: exit 1
 * } catch (e) {
 *   console.log("捕获退出信号");
 * }
 * ```
 * 
 * @module runtime
 */

import { clearActiveProgressLine } from "./terminal/progress-line.js";
import { restoreTerminalState } from "./terminal/restore.js";

/**
 * 运行时环境接口
 * 
 * 定义了 OpenClaw 运行所需的最小 I/O 操作集合。
 * 所有需要与用户交互的代码都应该通过这个接口，而非直接使用 console.*。
 * 
 * @property log - 日志输出函数（对应 console.log）
 * @property error - 错误输出函数（对应 console.error）
 * @property exit - 进程退出函数（对应 process.exit）
 * 
 * @example
 * function runAgent(runtime: RuntimeEnv) {
 *   runtime.log("Agent 启动中...");
 *   if (error) {
 *     runtime.error("发生错误：" + error.message);
 *     runtime.exit(1);
 *   }
 * }
 */
export type RuntimeEnv = {
  /** 标准日志输出 */
  log: (...args: unknown[]) => void;
  /** 错误日志输出 */
  error: (...args: unknown[]) => void;
  /** 进程退出（带退出码） */
  exit: (code: number) => void;
};

/**
 * 增强版运行时环境接口
 * 
 * 在基础 RuntimeEnv 上增加了结构化输出能力：
 * - writeStdout: 直接写入 stdout（适用于 JSON、表格等格式化输出）
 * - writeJson: 便捷方法，自动序列化并换行
 * 
 * 主要用于 CLI 命令的输出，便于其他工具解析。
 * 
 * @example
 * // 输出 JSON 结果
 * runtime.writeJson({ status: "success", data: result });
 * 
 * // 输出纯文本
 * runtime.writeStdout("任务完成\n");
 */
export type OutputRuntimeEnv = RuntimeEnv & {
  /** 直接写入 stdout（不换行） */
  writeStdout: (value: string) => void;
  /** 序列化为 JSON 并写入（自动换行） */
  writeJson: (value: unknown, space?: number) => void;
};

/**
 * 检查是否应该输出来自运行时日志
 * 
 * **判断逻辑**:
 * 1. 非 Vitest 环境：始终输出 ✅
 * 2. Vitest 环境但设置了 OPENCLAW_TEST_RUNTIME_LOG=1：输出 ✅
 * 3. Vitest 环境且 console.log 被 mock：不输出 ❌
 * 
 * 这个设计确保：
 * - 正常测试运行时保持安静（除非显式要求日志）
 * - 调试测试时可以启用日志
 * - 生产环境始终有日志
 * 
 * @param env - 环境变量对象（默认使用 process.env）
 * @returns true 表示应该输出日志，false 表示静默
 */
function shouldEmitRuntimeLog(env: NodeJS.ProcessEnv = process.env): boolean {
  // 非测试环境：始终输出
  if (env.VITEST !== "true") {
    return true;
  }
  
  // 测试环境但显式要求日志：输出
  if (env.OPENCLAW_TEST_RUNTIME_LOG === "1") {
    return true;
  }
  
  // 检查 console.log 是否被 mock
  const maybeMockedLog = console.log as unknown as { mock?: unknown };
  return typeof maybeMockedLog.mock === "object";
}

/**
 * 检查是否应该输出来自运行时 stdout
 * 
 * 判断逻辑与 shouldEmitRuntimeLog 类似，但针对 process.stdout.write。
 * 用于控制 CLI 输出是否在测试中显示。
 * 
 * @param env - 环境变量对象（默认使用 process.env）
 * @returns true 表示应该输出到 stdout，false 表示静默
 */
function shouldEmitRuntimeStdout(env: NodeJS.ProcessEnv = process.env): boolean {
  // 非测试环境：始终输出
  if (env.VITEST !== "true") {
    return true;
  }
  
  // 测试环境但显式要求日志：输出
  if (env.OPENCLAW_TEST_RUNTIME_LOG === "1") {
    return true;
  }
  
  // 检查 stdout.write 是否被 mock
  const stdout = process.stdout as NodeJS.WriteStream & {
    write: {
      mock?: unknown;
    };
  };
  return typeof stdout.write.mock === "object";
}

/**
 * 检查是否为管道关闭错误
 * 
 * **常见场景**:
 * - `openclaw gateway | head -n 1`: head 读取一行后关闭管道
 * - `openclaw list | grep foo`: grep 匹配完成后关闭管道
 * - 输出重定向到文件时磁盘已满
 * 
 * 这些情况下会抛出 EPIPE 或 EIO 错误，属于正常行为，不应视为故障。
 * 
 * @param err - 未知错误对象
 * @returns true 表示是管道关闭错误，可以安全忽略
 */
function isPipeClosedError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "EPIPE" || code === "EIO";
}

/**
 * 类型守卫：检查运行时是否支持输出写入器
 * 
 * TypeScript 的类型收窄技巧，用于区分 RuntimeEnv 和 OutputRuntimeEnv。
 * 通过检查 writeStdout 方法是否存在来判断运行时能力。
 * 
 * @param runtime - 运行时环境对象
 * @returns true 表示是 OutputRuntimeEnv，可以调用 writeStdout/writeJson
 */
function hasRuntimeOutputWriter(
  runtime: RuntimeEnv | OutputRuntimeEnv,
): runtime is OutputRuntimeEnv {
  return typeof (runtime as Partial<OutputRuntimeEnv>).writeStdout === "function";
}

/**
 * 向 stdout 写入内容（带管道错误处理）
 * 
 * **内部处理**:
 * 1. 检查是否应该输出（测试环境可能静默）
 * 2. 清除活动进度线（避免显示混乱）
 * 3. 确保内容以换行符结尾
 * 4. 尝试写入 stdout
 * 5. 如果是管道关闭错误，静默忽略
 * 
 * @param value - 要写入的字符串内容
 * @throws 非管道关闭错误会重新抛出
 */
function writeStdout(value: string): void {
  // 检查输出开关
  if (!shouldEmitRuntimeStdout()) {
    return;
  }
  
  // 清除进度线（如果存在）
  clearActiveProgressLine();
  
  // 确保以换行符结尾
  const line = value.endsWith("\n") ? value : `${value}\n`;
  
  try {
    process.stdout.write(line);
  } catch (err) {
    // 管道关闭是正常现象（如被 grep/head 截断）
    if (isPipeClosedError(err)) {
      return;
    }
    // 其他错误继续抛出
    throw err;
  }
}

/**
 * 创建运行时 I/O 实现
 * 
 * 返回一个包含 log/error/writeStdout/writeJson 的对象，
 * 所有方法都集成了：
 * - 测试环境检测
 * - 进度线清除
 * - 管道错误处理
 * 
 * @returns 运行时 I/O 实现对象
 */
function createRuntimeIo(): Pick<OutputRuntimeEnv, "log" | "error" | "writeStdout" | "writeJson"> {
  return {
    /** 标准日志输出（带测试兼容） */
    log: (...args: Parameters<typeof console.log>) => {
      if (!shouldEmitRuntimeLog()) {
        return;
      }
      clearActiveProgressLine();
      console.log(...args);
    },
    /** 错误日志输出（始终清除进度线） */
    error: (...args: Parameters<typeof console.error>) => {
      clearActiveProgressLine();
      console.error(...args);
    },
    /** stdout 写入（带管道保护） */
    writeStdout,
    /** JSON 序列化并写入 */
    writeJson: (value: unknown, space = 2) => {
      writeStdout(JSON.stringify(value, null, space > 0 ? space : undefined));
    },
  };
}

/**
 * 默认运行时环境实例
 * 
 * **生产环境使用**:
 * - log/error: 输出到控制台
 * - writeStdout/writeJson: 输出到 stdout（带管道保护）
 * - exit: 真正退出进程，并在退出前恢复终端状态
 * 
 * **终端恢复的重要性**:
 * 当 OpenClaw 在 TTY 中运行时，可能会修改终端属性（如禁用回显、启用 raw 模式）。
 * 如果不恢复，用户终端可能陷入异常状态（输入无响应、字符不回显等）。
 * 
 * @example
 * import { defaultRuntime } from "./runtime.js";
 * 
 * async function main() {
 *   try {
 *     await runGateway();
 *     defaultRuntime.exit(0);
 *   } catch (error) {
 *     defaultRuntime.error(error);
 *     defaultRuntime.exit(1);
 *   }
 * }
 */
export const defaultRuntime: OutputRuntimeEnv = {
  ...createRuntimeIo(),
  exit: (code) => {
    // 退出前恢复终端状态（特别是 stdin 的 TTY 模式）
    restoreTerminalState("runtime exit", { resumeStdinIfPaused: false });
    process.exit(code);
    // 这行代码理论上不会执行（process.exit 会终止进程）
    // 但在测试中被 mock 时会执行，用于满足类型检查
    throw new Error("unreachable"); 
  },
};

/**
 * 创建非退出运行时环境（用于测试）
 * 
 * **测试场景专用**:
 * 在单元测试中，我们不希望真正退出进程（会导致测试中断）。
 * 这个函数返回的 runtime 在调用 exit() 时会抛出异常，而非真正退出。
 * 
 * **使用方式**:
 * ```typescript
 * const runtime = createNonExitingRuntime();
 * 
 * // 测试代码可以捕获退出信号
 * try {
 *   agent.run(runtime);
 * } catch (e) {
 *   expect(e.message).toBe("exit 1");  // 验证退出码
 * }
 * ```
 * 
 * @returns 不会真正退出的运行时环境
 */
export function createNonExitingRuntime(): OutputRuntimeEnv {
  return {
    ...createRuntimeIo(),
    // 抛出异常而非真正退出，允许测试捕获和验证
    exit: (code: number) => {
      throw new Error(`exit ${code}`);
    },
  };
}

/**
 * 向运行时写入 stdout 内容
 * 
 * **智能降级策略**:
 * - 如果 runtime 支持 writeStdout：直接写入
 * - 否则：降级到 log() 方法
 * 
 * 这个设计允许代码在不关心运行时具体能力的情况下使用。
 * 
 * @param runtime - 运行时环境对象
 * @param value - 要写入的字符串内容
 */
export function writeRuntimeStdout(runtime: RuntimeEnv | OutputRuntimeEnv, value: string): void {
  if (hasRuntimeOutputWriter(runtime)) {
    runtime.writeStdout(value);
    return;
  }
  // 降级到普通日志输出
  runtime.log(value);
}

/**
 * 向运行时写入 JSON 数据
 * 
 * 与 writeRuntimeStdout 类似的智能降级策略。
 * 
 * @param runtime - 运行时环境对象
 * @param value - 要序列化的数据
 * @param space - JSON 缩进空格数（默认 2）
 */
export function writeRuntimeJson(
  runtime: RuntimeEnv | OutputRuntimeEnv,
  value: unknown,
  space = 2,
): void {
  if (hasRuntimeOutputWriter(runtime)) {
    runtime.writeJson(value, space);
    return;
  }
  // 降级为普通日志输出（手动序列化）
  runtime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
}
