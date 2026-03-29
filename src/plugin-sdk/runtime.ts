/**
 * @fileoverview Plugin SDK 运行时工具
 * 
 * 本文件提供插件运行时的核心工具函数，用于创建和解析运行时环境。
 * 
 * **核心功能**:
 * - 创建基于 Logger 的运行时环境
 * - 解析现有的或合成的 RuntimeEnv
 * - 处理不可用的退出操作
 * - 日志和调试支持
 * 
 * **设计模式**:
 * 1. **适配器模式**: 将简单的 Logger 适配为完整的 RuntimeEnv 接口
 * 2. **工厂模式**: 根据条件创建不同的运行时实例
 * 3. **策略模式**: 针对不同的退出行为使用不同的策略
 * 
 * **使用场景**:
 * - 插件开发时需要模拟运行时环境
 * - 测试环境中需要非退出的运行时
 * - CLI 工具中需要自定义日志输出
 * 
 * @module plugin-sdk/runtime
 */

import { format } from "node:util";
import type { OutputRuntimeEnv, RuntimeEnv } from "../runtime.js";
export type { OutputRuntimeEnv, RuntimeEnv } from "../runtime.js";
export { createNonExitingRuntime, defaultRuntime } from "../runtime.js";
export {
  danger,
  info,
  isVerbose,
  isYes,
  logVerbose,
  logVerboseConsole,
  setVerbose,
  setYes,
  shouldLogVerbose,
  success,
  warn,
} from "../globals.js";
export * from "../logging.js";
export { waitForAbortSignal } from "../infra/abort-signal.js";
export { registerUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";

/**
 * 最小化 Logger 契约
 * 
 * 这是运行时适配器助手接受的最简 Logger 接口。
 * 只需要 info 和 error 两个方法即可。
 * 
 * @property info - 信息级别日志
 * @property error - 错误级别日志
 * 
 * @example
 * ```typescript
 * const logger: LoggerLike = {
 *   info: (msg) => console.log(`[INFO] ${msg}`),
 *   error: (msg) => console.error(`[ERROR] ${msg}`)
 * };
 * ```
 */
type LoggerLike = {
  /** 信息日志方法 */
  info: (message: string) => void;
  /** 错误日志方法 */
  error: (message: string) => void;
};

/**
 * 将简单 Logger 适配为 RuntimeEnv 合约
 * 
 * **作用**: 将只有 info/error 方法的简单 Logger 转换为完整的
 * {@link OutputRuntimeEnv} 接口，使其可以被插件 SDK 助手使用。
 * 
 * **适配的功能**:
 * - `log`: 格式化参数后调用 logger.info
 * - `error`: 格式化参数后调用 logger.error
 * - `writeStdout`: 直接调用 logger.info
 * - `writeJson`: JSON 序列化后调用 logger.info
 * - `exit`: 抛出错误或调用自定义退出处理
 * 
 * @param params - 参数对象
 * @param params.logger - 要适配的 Logger 实例
 * @param params.exitError - 可选的自定义退出错误构造函数
 * @returns 完整的 OutputRuntimeEnv 实例
 * 
 * @example
 * ```typescript
 * // 创建一个简单的 logger
 * const logger = {
 *   info: (msg) => fs.appendFileSync('app.log', msg + '\n'),
 *   error: (msg) => fs.appendFileSync('error.log', msg + '\n')
 * };
 * 
 * // 适配为运行时环境
 * const runtime = createLoggerBackedRuntime({
 *   logger,
 *   exitError: (code) => new Error(`Process exit with code ${code}`)
 * });
 * 
 * // 现在可以使用 runtime 的所有功能
 * runtime.log('Application started');
 * runtime.writeJson({ status: 'ok' });
 * ```
 */
export function createLoggerBackedRuntime(params: {
  /** 要适配的 Logger 实例 */
  logger: LoggerLike;
  /** 可选的自定义退出错误构造函数 */
  exitError?: (code: number) => Error;
}): OutputRuntimeEnv {
  return {
    /** 格式化参数并输出信息日志 */
    log: (...args) => {
      params.logger.info(format(...args));
    },
    /** 格式化参数并输出错误日志 */
    error: (...args) => {
      params.logger.error(format(...args));
    },
    /** 直接输出到 stdout（通过 logger.info） */
    writeStdout: (value) => {
      params.logger.info(value);
    },
    /** JSON 序列化后输出（带缩进） */
    writeJson: (value, space = 2) => {
      params.logger.info(JSON.stringify(value, null, space > 0 ? space : undefined));
    },
    /** 退出处理：抛出错误或调用自定义处理 */
    exit: (code: number): never => {
      throw params.exitError?.(code) ?? new Error(`exit ${code}`);
    },
  };
}

/**
 * 解析运行时环境（重载版本 1）
 * 
 * 当提供了现有 runtime 时，直接返回该 runtime。
 * 
 * @param params - 参数对象
 * @param params.runtime - 现有的 RuntimeEnv 实例
 * @param params.logger - 备用的 Logger（如果 runtime 未提供）
 * @param params.exitError - 可选的自定义退出错误构造函数
 * @returns 现有的 RuntimeEnv
 */
export function resolveRuntimeEnv(params: {
  runtime: RuntimeEnv;
  logger: LoggerLike;
  exitError?: (code: number) => Error;
}): RuntimeEnv;

/**
 * 解析运行时环境（重载版本 2）
 * 
 * 当未提供 runtime 时，使用 Logger 创建新的 OutputRuntimeEnv。
 * 
 * @param params - 参数对象
 * @param params.runtime - 未定义（表示需要创建新的）
 * @param params.logger - 用于创建运行时的 Logger
 * @param params.exitError - 可选的自定义退出错误构造函数
 * @returns 新创建的 OutputRuntimeEnv
 */
export function resolveRuntimeEnv(params: {
  runtime?: undefined;
  logger: LoggerLike;
  exitError?: (code: number) => Error;
}): OutputRuntimeEnv;

/**
 * 解析运行时环境（实现）
 * 
 * **逻辑**:
 * 1. 如果提供了 `params.runtime`，直接使用
 * 2. 否则，调用 {@link createLoggerBackedRuntime} 创建新的运行时
 * 
 * 这种设计允许灵活地复用现有运行时或按需创建。
 * 
 * @param params - 参数对象
 * @param params.runtime - 可选的现有运行时
 * @param params.logger - 备用的 Logger
 * @param params.exitError - 可选的自定义退出错误构造函数
 * @returns RuntimeEnv 或 OutputRuntimeEnv
 * 
 * @example
 * ```typescript
 * // 情况 1: 复用现有运行时
 * const runtime1 = resolveRuntimeEnv({
 *   runtime: existingRuntime,
 *   logger: fallbackLogger
 * });
 * 
 * // 情况 2: 创建新运行时
 * const runtime2 = resolveRuntimeEnv({
 *   logger: myLogger
 * });
 * ```
 */
export function resolveRuntimeEnv(params: {
  /** 可选的现有运行时 */
  runtime?: RuntimeEnv;
  /** 备用的 Logger */
  logger: LoggerLike;
  /** 可选的自定义退出错误构造函数 */
  exitError?: (code: number) => Error;
}): RuntimeEnv | OutputRuntimeEnv {
  // 优先使用现有运行时，否则创建新的
  return params.runtime ?? createLoggerBackedRuntime(params);
}

/**
 * 解析运行时环境（退出不可用版本，重载 1）
 * 
 * 当提供了现有 runtime 时，包装其 exit 方法以抛出错误而非真正退出。
 * 
 * **用途**: 适用于不允许真正退出的场景（如 Web 服务器、嵌入式环境）。
 * 
 * @param params - 参数对象
 * @param params.runtime - 现有的 RuntimeEnv 实例
 * @param params.logger - 备用的 Logger
 * @param params.unavailableMessage - 自定义错误消息
 * @returns 包装后的 RuntimeEnv
 */
export function resolveRuntimeEnvWithUnavailableExit(params: {
  runtime: RuntimeEnv;
  logger: LoggerLike;
  unavailableMessage?: string;
}): RuntimeEnv;

/**
 * 解析运行时环境（退出不可用版本，重载 2）
 * 
 * 当未提供 runtime 时，创建新的 OutputRuntimeEnv，exit 会抛出错误。
 * 
 * @param params - 参数对象
 * @param params.runtime - 未定义
 * @param params.logger - 用于创建运行时的 Logger
 * @param params.unavailableMessage - 自定义错误消息
 * @returns 新创建的 OutputRuntimeEnv
 */
export function resolveRuntimeEnvWithUnavailableExit(params: {
  runtime?: undefined;
  logger: LoggerLike;
  unavailableMessage?: string;
}): OutputRuntimeEnv;

/**
 * 解析运行时环境（退出不可用版本，实现）
 * 
 * **特殊处理**:
 * - 将 exit 请求转换为错误抛出，而非真正终止进程
 * - 适用于无法执行进程退出的环境（如浏览器、嵌入式）
 * 
 * **默认错误消息**: `"Runtime exit not available"`
 * 
 * @param params - 参数对象
 * @param params.runtime - 可选的现有运行时
 * @param params.logger - 备用的 Logger
 * @param params.unavailableMessage - 自定义错误消息（默认："Runtime exit not available"）
 * @returns RuntimeEnv 或 OutputRuntimeEnv
 * 
 * @example
 * ```typescript
 * // 在 Web 环境中使用（不允许退出）
 * const runtime = resolveRuntimeEnvWithUnavailableExit({
 *   runtime: baseRuntime,
 *   logger: webLogger,
 *   unavailableMessage: "Exit operations are not supported in web environment"
 * });
 * 
 * // 调用 exit 时会抛出错误而不是退出
 * try {
 *   runtime.exit(1);
 * } catch (err) {
 *   console.error(err.message);  // "Exit operations are not supported..."
 * }
 * ```
 */
export function resolveRuntimeEnvWithUnavailableExit(params: {
  /** 可选的现有运行时 */
  runtime?: RuntimeEnv;
  /** Logger 实例 */
  logger: LoggerLike;
  /** 自定义错误消息 */
  unavailableMessage?: string;
}): RuntimeEnv | OutputRuntimeEnv {
  if (params.runtime) {
    // 有现有运行时：包装其 exit 方法
    return resolveRuntimeEnv({
      runtime: params.runtime,
      logger: params.logger,
      exitError: () => new Error(params.unavailableMessage ?? "Runtime exit not available"),
    });
  }
  
  // 无现有运行时：创建新的
  return resolveRuntimeEnv({
    logger: params.logger,
    exitError: () => new Error(params.unavailableMessage ?? "Runtime exit not available"),
  });
}
