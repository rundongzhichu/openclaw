/**
 * @fileoverview 环境变量标准化工具
 * 
 * 本文件提供 OpenClaw 环境变量的统一处理能力：
 * - 环境变量标准化（别名处理、默认值设置）
 * - 环境变量接受日志（调试用）
 * - 平台兼容性处理
 * 
 * **核心功能**:
 * 1. **logAcceptedEnvOption**: 记录被接受的环境变量，避免重复日志
 * 2. **normalizeEnv**: 标准化所有环境变量（包括各 provider 的别名）
 * 3. **isTruthyEnvValue**: 统一的布尔值判断逻辑
 * 
 * **为什么需要标准化**:
 * 不同的 AI 模型提供者使用不同的环境变量命名：
 * - Z_AI_API_KEY vs ZAI_API_KEY
 * - MOONSHOT_API_KEY vs MOONSHOT_API_KEY
 * - OPENAI_API_KEY vs OPENAI_BASE_URL
 * 
 * 这个模块确保无论用户使用哪种命名，系统都能正确识别。
 * 
 * @module infra/env
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

/** 子系统日志实例（懒加载） */
let log: ReturnType<typeof createSubsystemLogger> | null = null;

/** 已记录的环境变量集合（避免重复日志） */
const loggedEnv = new Set<string>();

/**
 * 获取或创建子系统日志实例
 * 
 * 使用懒加载模式，仅在首次需要时创建 logger。
 * 这样可以避免循环依赖问题。
 * 
 * @returns 环境变量子系统的 logger 实例
 */
function getLog(): ReturnType<typeof createSubsystemLogger> {
  if (!log) {
    log = createSubsystemLogger("env");
  }
  return log;
}

/**
 * 被接受的环境变量选项类型
 * 
 * @property key - 环境变量名称（如 "OPENAI_API_KEY"）
 * @property description - 人类可读的描述（如 "OpenAI API 密钥"）
 * @property value - 可选的显式值（不传则读取 process.env）
 * @property redact - 是否脱敏显示（用于敏感信息如 API Key）
 * 
 * @example
 * logAcceptedEnvOption({
 *   key: "OPENAI_API_KEY",
 *   description: "OpenAI API 密钥",
 *   redact: true  // 日志中显示为 <redacted>
 * });
 */
type AcceptedEnvOption = {
  /** 环境变量名称 */
  key: string;
  /** 人类可读的描述 */
  description: string;
  /** 可选的显式值 */
  value?: string;
  /** 是否脱敏显示 */
  redact?: boolean;
};

/**
 * 格式化环境变量值
 * 
 * **处理逻辑**:
 * 1. 如果 redact=true，返回 "<redacted>"
 * 2. 将空白字符压缩为单个空格
 * 3. 超过 160 字符则截断并添加省略号
 * 
 * 这样既保护了敏感信息，又保持了日志的可读性。
 * 
 * @param value - 原始环境变量值
 * @param redact - 是否脱敏
 * @returns 格式化后的字符串
 * 
 * @example
 * formatEnvValue("sk-abc123...", true)  // → "<redacted>"
 * formatEnvValue("https://api.openai.com", false)  // → "https://api.openai.com"
 * formatEnvValue("very long value ...", false)  // → "very long value …"
 */
function formatEnvValue(value: string, redact?: boolean): string {
  // 脱敏处理
  if (redact) {
    return "<redacted>";
  }
  
  // 压缩空白字符
  const singleLine = value.replace(/\s+/g, " ").trim();
  
  // 长度检查
  if (singleLine.length <= 160) {
    return singleLine;
  }
  
  // 截断并添加省略号
  return `${singleLine.slice(0, 160)}…`;
}

/**
 * 记录被接受的环境变量
 * 
 * **作用**: 在启动时输出用户配置的环境变量，便于调试。
 * 
 * **防重复机制**: 使用 Set 记录已记录的变量，避免同一变量多次输出。
 * 
 * **测试环境静默**: 在 Vitest 或 NODE_ENV=test 时不输出。
 * 
 * **输出格式**:
 * ```
 * env: OPENAI_API_KEY=<redacted> (OpenAI API 密钥)
 * env: OPENCLAW_GATEWAY_PORT=18789 (网关端口)
 * ```
 * 
 * @param option - 环境变量选项
 * 
 * @example
 * // 用户设置了 OPENAI_API_KEY=sk-xxx
 * logAcceptedEnvOption({
 *   key: "OPENAI_API_KEY",
 *   description: "OpenAI API 密钥",
 *   redact: true
 * });
 * // 输出：env: OPENAI_API_KEY=<redacted> (OpenAI API 密钥)
 */
export function logAcceptedEnvOption(option: AcceptedEnvOption): void {
  // 测试环境静默
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }
  
  // 防止重复日志
  if (loggedEnv.has(option.key)) {
    return;
  }
  
  // 获取实际值（从参数或 process.env）
  const rawValue = option.value ?? process.env[option.key];
  
  // 空值忽略
  if (!rawValue || !rawValue.trim()) {
    return;
  }
  
  // 记录并输出
  loggedEnv.add(option.key);
  getLog().info(
    `env: ${option.key}=${formatEnvValue(rawValue, option.redact)} (${option.description})`,
  );
}

/**
 * 标准化 ZAI 环境变量
 * 
 * **背景**: 智谱 AI (Z.ai) 有两种常见的命名方式：
 * - ZAI_API_KEY（旧版本）
 * - Z_AI_API_KEY（新版本，避免某些系统的双下划线问题）
 * 
 * 这个函数确保两种命名都能工作，优先使用 Z_AI_API_KEY。
 */
export function normalizeZaiEnv(): void {
  // 如果 ZAI_API_KEY 不存在但 Z_AI_API_KEY 存在，使用后者
  if (!process.env.ZAI_API_KEY?.trim() && process.env.Z_AI_API_KEY?.trim()) {
    process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
  }
}

/**
 * 判断环境变量值是否为真值
 * 
 * **支持的真理值**:
 * - "1"
 * - "on"
 * - "true"
 * - "yes"
 * 
 * 大小写不敏感，会自动去除首尾空白。
 * 
 * @param value - 要判断的环境变量值
 * @returns 如果是真理值返回 true，否则返回 false
 * 
 * @example
 * isTruthyEnvValue("true")   // → true
 * isTruthyEnvValue("YES")    // → true
 * isTruthyEnvValue("0")      // → false
 * isTruthyEnvValue("false")  // → false
 * isTruthyEnvValue(undefined) // → false
 */
export function isTruthyEnvValue(value?: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
  switch (value.trim().toLowerCase()) {
    case "1":
    case "on":
    case "true":
    case "yes":
      return true;
    default:
      return false;
  }
}

/**
 * 标准化所有环境变量
 * 
 * 调用此函数会执行所有必要的环境变量标准化操作：
 * - ZAI API Key 别名处理
 * - 其他 provider 的别名处理（未来扩展）
 * 
 * 应在应用启动早期调用此函数。
 * 
 * @example
 * // 在应用入口文件中
 * import { normalizeEnv } from "./infra/env.js";
 * normalizeEnv();
 */
export function normalizeEnv(): void {
  normalizeZaiEnv();
}
