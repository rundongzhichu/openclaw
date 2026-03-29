/**
 * @fileoverview 通用工具函数集合
 * 
 * 本文件提供了 OpenClaw 系统中常用的基础工具函数，涵盖：
 * - 文件系统操作（目录创建、路径检查）
 * - 数据类型判断（Record、PlainObject）
 * - 字符串处理（JSON 解析、正则转义）
 * - 数值处理（范围限制）
 * - E.164 电话号码格式化
 * - Self-Chat 模式检测
 * - WhatsApp JID 转换
 * - UTF-16 安全字符串切片
 * - 路径解析与显示
 * 
 * **设计原则**:
 * 1. **函数式**: 纯函数优先，避免副作用
 * 2. **类型安全**: 提供完整的 TypeScript 类型定义
 * 3. **错误处理**: 使用返回 null 而非抛出异常（如 safeParseJson）
 * 4. **实用性**: 短小精悍，单一职责
 * 
 * **使用示例**:
 * ```typescript
 * // 安全解析 JSON
 * const data = safeParseJson<MyType>(jsonString);
 * if (data === null) {
 *   console.error("JSON 解析失败");
 * }
 * 
 * // 数值范围限制
 * const clampedValue = clamp(value, 0, 100);
 * 
 * // 电话号标准化
 * const e164 = normalizeE164("+86 138-0000-0000");  // → "+8613800000000"
 * 
 * // 检查文件是否存在
 * if (await pathExists("./config.json")) {
 *   console.log("配置文件存在");
 * }
 * ```
 * 
 * @module utils
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveOAuthDir } from "./config/paths.js";
import { logVerbose, shouldLogVerbose } from "./globals.js";
import {
  resolveEffectiveHomeDir,
  resolveHomeRelativePath,
  resolveRequiredHomeDir,
} from "./infra/home-dir.js";
import { isPlainObject } from "./infra/plain-object.js";
import { formatTerminalLink } from "./terminal/terminal-link.js";

/**
 * 确保目录存在（递归创建）
 * 
 * 使用 fs.mkdir 的 recursive 选项，如果目录已存在不会报错。
 * 即使父目录不存在也会一并创建。
 * 
 * @param dir - 要创建的目录路径
 * 
 * @example
 * ```typescript
 * await ensureDir("/tmp/openclaw/logs");
 * // 即使 /tmp/openclaw 不存在也会创建完整路径
 * ```
 */
export async function ensureDir(dir: string) {
  await fs.promises.mkdir(dir, { recursive: true });
}

/**
 * 检查文件或目录是否存在
 * 
 * 使用 fs.access 进行非破坏性检查，不会打开文件句柄。
 * 适用于需要预先检查路径存在性的场景。
 * 
 * @param targetPath - 要检查的路径
 * @returns 如果存在返回 true，否则返回 false
 * 
 * @example
 * ```typescript
 * if (await pathExists("./config.json")) {
 *   console.log("配置文件存在");
 * } else {
 *   console.log("需要创建配置文件");
 * }
 * ```
 */
export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 将数值限制在指定范围内
 * 
 * 确保返回值在 [min, max] 区间内：
 * - 小于 min 返回 min
 * - 大于 max 返回 max
 * - 否则返回原值
 * 
 * @param value - 原始数值
 * @param min - 最小值（包含）
 * @param max - 最大值（包含）
 * @returns 限制后的数值
 * 
 * @example
 * ```typescript
 * clampNumber(5, 0, 10);     // → 5
 * clampNumber(-1, 0, 10);    // → 0
 * clampNumber(100, 0, 10);   // → 10
 * ```
 */
export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 将数值向下取整并限制在指定范围内
 * 
 * 先执行 Math.floor()，然后调用 clampNumber。
 * 适用于需要整数结果的场景（如数组索引、计数器等）。
 * 
 * @param value - 原始数值（可以是浮点数）
 * @param min - 最小值（包含）
 * @param max - 最大值（包含）
 * @returns 取整并限制后的整数
 * 
 * @example
 * ```typescript
 * clampInt(3.7, 0, 10);      // → 3
 * clampInt(10.9, 0, 10);     // → 10
 * clampInt(-2.3, 0, 10);     // → 0
 * ```
 */
export function clampInt(value: number, min: number, max: number): number {
  return clampNumber(Math.floor(value), min, max);
}

/** clampNumber 的别名（更简短、更常用的名称） */
export const clamp = clampNumber;

/**
 * 转义正则表达式特殊字符
 * 
 * 将字符串中的正则特殊字符（如 . * + ? ^ $ { } ( ) | [ ] \）进行转义，
 * 使其可以安全地用于 RegExp 构造函数中作为字面量匹配。
 * 
 * **为什么需要**: 
 * 当用户输入需要作为精确字符串匹配时（如搜索功能），必须转义特殊字符，
 * 否则这些字符会被解释为正则元字符。
 * 
 * @param value - 要转义的字符串
 * @returns 转义后的字符串，可安全用于 RegExp 构造
 * 
 * @example
 * ```typescript
 * const userInput = "file.txt";
 * const pattern = new RegExp(escapeRegExp(userInput));
 * pattern.test("file.txt");   // → true
 * pattern.test("fileatxt");   // → false (. 不再匹配任意字符)
 * 
 * // 搜索包含特殊字符的内容
 * const searchStr = "price $100";
 * const regex = new RegExp(escapeRegExp(searchStr), "i");
 * ```
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 安全解析 JSON（不抛出异常）
 * 
 * **优势**: 
 * - 解析失败返回 null，而非抛出 Error
 * - 适合处理不可信的输入（如网络响应、用户输入、配置文件）
 * - 减少 try-catch 嵌套，代码更简洁
 * 
 * @param raw - 原始 JSON 字符串
 * @returns 解析成功返回泛型类型 T 的对象，失败返回 null
 * 
 * @example
 * ```typescript
 * // 处理 API 响应
 * const response = await fetch(url);
 * const text = await response.text();
 * const data = safeParseJson<ApiResponse>(text);
 * if (data === null) {
 *   console.error("无效的 JSON 响应");
 *   return;
 * }
 * 
 * // 读取配置文件
 * const config = safeParseJson<Config>(configText);
 * if (config) {
 *   useConfig(config);
 * }
 * ```
 */
export function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// 导出常用工具
export { formatTerminalLink, isPlainObject };

/**
 * 类型守卫：检查是否为 Record<string, unknown>
 * 
 * 比 isPlainObject 更宽松：
 * - 接受任何非 null 的对象
 * - 排除数组
 * - 不区分普通对象和特殊对象（如 Date、RegExp 等）
 * 
 * **与 isPlainObject 的区别**:
 * - isPlainObject: 严格检查普通对象（排除 Date、RegExp、Array 等内置对象）
 * - isRecord: 只要求是对象且不是数组，适用范围更广
 * 
 * @param value - 要检查的值
 * @returns 如果是 Record 类型返回 true，同时 TypeScript 会收窄类型
 * 
 * @example
 * ```typescript
 * const input: unknown = getValue();
 * if (isRecord(input)) {
 *   // TypeScript 知道 input 是 Record<string, unknown>
 *   console.log(input.foo);
 *   Object.keys(input).forEach(key => {
 *     console.log(key, input[key]);
 *   });
 * }
 * ```
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Web 通道类型（字面量类型，仅允许 "web" 值） */
export type WebChannel = "web";

/**
 * 断言字符串为 Web 通道
 * 
 * TypeScript 类型断言函数，用于运行时验证。
 * 如果输入不是 "web"，抛出错误。
 * 通过断言后，TypeScript 会将类型收窄为 WebChannel。
 * 
 * @param input - 要验证的字符串
 * @throws {Error} 如果 input 不是 "web"
 * 
 * @example
 * ```typescript
 * let channel: string = getChannel();
 * assertWebChannel(channel);  // 通过后类型为 "web"
 * 
 * // 在条件判断中使用
 * if (channel === "web") {
 *   assertWebChannel(channel);  // 此时类型已知为 WebChannel
 *   handleWebChannel(channel);
 * }
 * ```
 */
export function assertWebChannel(input: string): asserts input is WebChannel {
  if (input !== "web") {
    throw new Error("Web channel must be 'web'");
  }
}

/**
 * 标准化 E.164 格式的电话号码
 * 
 * **E.164 格式规范**: 
 * - 以 + 开头
 * - 仅包含数字（除 + 外）
 * - 无空格、连字符、括号等分隔符
 * - 最大长度 15 位数字
 * 
 * **处理步骤**:
 * 1. 移除 "whatsapp:" 前缀（如果存在）
 * 2. 去除首尾空白字符
 * 3. 移除非数字和非 + 字符
 * 4. 确保以单个 + 开头
 * 
 * @param number - 原始电话号码（可能包含各种格式和前缀）
 * @returns 标准化的 E.164 格式字符串
 * 
 * @example
 * ```typescript
 * normalizeE164("+86 138-0000-0000");      // → "+8613800000000"
 * normalizeE164("whatsapp:13800000000");   // → "+13800000000"
 * normalizeE164("(010) 1234-5678");        // → "+01012345678"
 * normalizeE164("8613800000000");          // → "+8613800000000"
 * normalizeE164("+86-138-0000-0000");      // → "+8613800000000"
 * ```
 */
export function normalizeE164(number: string): string {
  const withoutPrefix = number.replace(/^whatsapp:/, "").trim();
  const digits = withoutPrefix.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    return `+${digits.slice(1)}`;
  }
  return `+${digits}`;
}

/**
 * 检测是否为 Self-Chat 模式
 * 
 * **Self-Chat 场景定义**:
 * 网关登录到用户自己的 WhatsApp 账号，并且 `channels.whatsapp.allowFrom` 
 * 配置中包含同一个号码。这种情况下，"机器人"和"人类用户"是同一个 WhatsApp 身份。
 * 
 * **为什么要检测**:
 * Self-Chat 模式下，某些行为没有意义或需要特殊处理：
 * - 自动已读回执（自己给自己发消息不需要标记已读）
 * - @提及触发逻辑（不需要@自己）
 * - 某些安全检查可以放宽
 * - 避免循环消息处理
 * 
 * @param selfE164 - 用户自己的 E.164 号码（可能为 null/undefined）
 * @param allowFrom - 允许发送消息的来源列表（可选，支持 "*" 通配符）
 * @returns true 表示处于 Self-Chat 模式
 * 
 * @example
 * ```typescript
 * // 用户配置了自己的号码且允许列表包含自己
 * const isSelfChat = isSelfChatMode("+8613800000000", ["+8613800000000"]);
 * if (isSelfChat) {
 *   // 启用 Self-Chat 特殊逻辑
 *   disableAutoReadReceipts();
 *   skipMentionTriggers();
 * }
 * 
 * // 允许列表为 "*" 时不算 Self-Chat
 * isSelfChatMode("+8613800000000", ["*"]);  // → false
 * ```
 */
export function isSelfChatMode(
  selfE164: string | null | undefined,
  allowFrom?: Array<string | number> | null,
): boolean {
  // 自己没有号码：不是 Self-Chat
  if (!selfE164) {
    return false;
  }
  
  // allowFrom 不是数组或为空：不是 Self-Chat
  if (!Array.isArray(allowFrom) || allowFrom.length === 0) {
    return false;
  }
  
  // 标准化自己的号码
  const normalizedSelf = normalizeE164(selfE164);
  
  // 检查 allowFrom 中是否有匹配的号码
  return allowFrom.some((n) => {
    // 通配符 "*" 不算 Self-Chat
    if (n === "*") {
      return false;
    }
    
    try {
      // 标准化并比较
      return normalizeE164(String(n)) === normalizedSelf;
    } catch {
      // 标准化失败（无效号码）
      return false;
    }
  });
}

/**
 * 将电话号码转换为 WhatsApp JID (Jabber ID)
 * 
 * **WhatsApp JID 格式**:
 * - 普通号码：{国家码}{手机号}@s.whatsapp.net
 * - 已有 JID：保持不变
 * - LID（Linked ID）：{lid}@lid 或 {lid}@hosted.lid
 * 
 * **处理步骤**:
 * 1. 移除 "whatsapp:" 前缀（如果存在）
 * 2. 如果已包含 "@"，直接返回（已是 JID 格式）
 * 3. 否则标准化为 E.164 格式并添加 @s.whatsapp.net 后缀
 * 
 * @param number - 电话号码或现有 JID
 * @returns WhatsApp JID 字符串
 * 
 * @example
 * ```typescript
 * toWhatsappJid("+8613800000000");           // → "8613800000000@s.whatsapp.net"
 * toWhatsappJid("whatsapp:8613800000000");   // → "8613800000000@s.whatsapp.net"
 * toWhatsappJid("8613800000000@s.whatsapp.net");  // → "8613800000000@s.whatsapp.net"
 * ```
 */
export function toWhatsappJid(number: string): string {
  // 移除 whatsapp: 前缀
  const withoutPrefix = number.replace(/^whatsapp:/, "").trim();
  
  // 如果已包含 @，说明已是 JID 格式
  if (withoutPrefix.includes("@")) {
    return withoutPrefix;
  }
  
  // 标准化为 E.164 并添加域名
  const e164 = normalizeE164(withoutPrefix);
  const digits = e164.replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

/**
 * JID 转 E.164 选项
 * 
 * @property authDir - OAuth 凭据目录（可选）
 * @property lidMappingDirs - LID 映射目录列表（可选）
 * @property logMissing - 是否记录缺失映射的日志（可选）
 */
export type JidToE164Options = {
  /** OAuth 凭据目录路径 */
  authDir?: string;
  /** LID 映射文件所在目录列表 */
  lidMappingDirs?: string[];
  /** 是否在找不到映射时输出日志 */
  logMissing?: boolean;
};

/**
 * LID 查找接口
 * 
 * 用于异步查询 LID 到普通电话号码的映射。
 */
type LidLookup = {
  /** 根据 LID JID 查找对应的普通号码 JID */
  getPNForLID?: (jid: string) => Promise<string | null>;
};

/**
 * 解析 LID 映射目录列表
 * 
 * 按优先级收集所有可能的 LID 映射文件位置：
 * 1. 显式指定的 authDir
 * 2. 显式指定的 lidMappingDirs
 * 3. 默认 OAuth 目录
 * 4. CONFIG_DIR/credentials
 * 
 * @param opts - 选项对象
 * @returns 去重后的目录路径数组
 */
function resolveLidMappingDirs(opts?: JidToE164Options): string[] {
  const dirs = new Set<string>();
  
  // 辅助函数：添加目录（带路径解析）
  const addDir = (dir?: string | null) => {
    if (!dir) {
      return;
    }
    dirs.add(resolveUserPath(dir));
  };
  
  addDir(opts?.authDir);
  for (const dir of opts?.lidMappingDirs ?? []) {
    addDir(dir);
  }
  addDir(resolveOAuthDir());
  addDir(path.join(CONFIG_DIR, "credentials"));
  
  return [...dirs];
}

/**
 * 读取 LID 反向映射
 * 
 * 从文件系统中查找 LID 到电话号码的映射文件。
 * 文件名格式：`lid-mapping-{lid}_reverse.json`
 * 
 * **搜索顺序**:
 * 1. 用户指定的 authDir
 * 2. 用户指定的 lidMappingDirs
 * 3. 默认 OAuth 目录
 * 4. CONFIG_DIR/credentials
 * 
 * @param lid - LID 数字字符串
 * @param opts - 选项对象
 * @returns 找到的 E.164 号码，未找到返回 null
 */
function readLidReverseMapping(lid: string, opts?: JidToE164Options): string | null {
  // 构建映射文件名
  const mappingFilename = `lid-mapping-${lid}_reverse.json`;
  
  // 获取所有可能的目录
  const mappingDirs = resolveLidMappingDirs(opts);
  
  // 依次尝试每个目录
  for (const dir of mappingDirs) {
    const mappingPath = path.join(dir, mappingFilename);
    try {
      const data = fs.readFileSync(mappingPath, "utf8");
      const phone = JSON.parse(data) as string | number | null;
      if (phone === null || phone === undefined) {
        continue;
      }
      return normalizeE164(String(phone));
    } catch {
      // 文件不存在或解析失败，尝试下一个位置
    }
  }
  
  return null;
}

/**
 * 将 WhatsApp JID 转换为 E.164 电话号码
 * 
 * **支持的 JID 格式**:
 * 1. **标准 JID**: `{数字}@s.whatsapp.net` → 提取数字添加 + 号
 * 2. **设备 JID**: `{数字}:{设备 ID}@s.whatsapp.net` → 忽略设备后缀
 * 3. **LID JID**: `{数字}@lid` 或 `{数字}@hosted.lid` → 查反向映射文件
 * 
 * **处理流程**:
 * 1. 尝试标准格式匹配（@s.whatsapp.net）
 * 2. 尝试 LID 格式匹配（@lid / @hosted.lid）
 * 3. LID 模式下查找反向映射文件
 * 4. 找不到映射时记录日志（如果启用）
 * 
 * @param jid - WhatsApp JID 字符串
 * @param opts - 可选的配置（映射目录、日志开关）
 * @returns E.164 格式的电话号码，无法转换返回 null
 * 
 * @example
 * ```typescript
 * jidToE164("8613800000000@s.whatsapp.net");  // → "+8613800000000"
 * jidToE164("8613800000000:1@s.whatsapp.net"); // → "+8613800000000"
 * jidToE164("123456@lid");  // → 查文件 lid-mapping-123456_reverse.json
 * ```
 */
export function jidToE164(jid: string, opts?: JidToE164Options): string | null {
  // 情况 1: 标准 WhatsApp JID（可能带设备后缀）
  // 匹配：1234567890@s.whatsapp.net 或 1234567890:1@s.whatsapp.net
  const match = jid.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/);
  if (match) {
    const digits = match[1];
    return `+${digits}`;
  }

  // 情况 2: LID (Linked ID) 格式 - 需要查找反向映射
  const lidMatch = jid.match(/^(\d+)(?::\d+)?@(lid|hosted\.lid)$/);
  if (lidMatch) {
    const lid = lidMatch[1];
    const phone = readLidReverseMapping(lid, opts);
    if (phone) {
      return phone;
    }
    
    // 找不到映射时的日志
    const shouldLog = opts?.logMissing ?? shouldLogVerbose();
    if (shouldLog) {
      logVerbose(`LID mapping not found for ${lid}; skipping inbound message`);
    }
  }

  // 无法识别的格式
  return null;
}

/**
 * 异步解析 JID 到 E.164（支持 LID 动态查找）
 * 
 * 与 jidToE164 的区别：
 * - 支持通过 lidLookup 参数动态查询 LID 映射
 * - 适用于运行时 LID 尚未持久化到文件的场景
 * 
 * **执行流程**:
 * 1. 首先尝试静态方法（jidToE164）
 * 2. 如果是 LID 且有 lidLookup，调用 getPNForLID 异步查询
 * 3. 对查询结果再次调用 jidToE164
 * 4. 错误处理和日志记录
 * 
 * @param jid - WhatsApp JID 字符串（可能为 null/undefined）
 * @param opts - 选项对象（包含 lidLookup 接口）
 * @returns E.164 电话号码，无法解析返回 null
 * 
 * @example
 * ```typescript
 * const e164 = await resolveJidToE164("123456@lid", {
 *   lidLookup: {
 *     getPNForLID: async (jid) => {
 *       // 从数据库或 API 查询
 *       return "8613800000000@s.whatsapp.net";
 *     }
 *   }
 * });  // → "+8613800000000"
 * ```
 */
export async function resolveJidToE164(
  jid: string | null | undefined,
  opts?: JidToE164Options & { lidLookup?: LidLookup },
): Promise<string | null> {
  // null/undefined 直接返回
  if (!jid) {
    return null;
  }
  
  // 先尝试静态解析
  const direct = jidToE164(jid, opts);
  if (direct) {
    return direct;
  }
  
  // 非 LID 格式无法进一步解析
  if (!/(@lid|@hosted\.lid)$/.test(jid)) {
    return null;
  }
  
  // 没有提供查找接口，无法继续
  if (!opts?.lidLookup?.getPNForLID) {
    return null;
  }
  
  // 异步查找 LID 映射
  try {
    const pnJid = await opts.lidLookup.getPNForLID(jid);
    if (!pnJid) {
      return null;
    }
    // 对查找结果再次解析
    return jidToE164(pnJid, opts);
  } catch (err) {
    // 查找失败的日志
    if (shouldLogVerbose()) {
      logVerbose(`LID mapping lookup failed for ${jid}: ${String(err)}`);
    }
    return null;
  }
}

/**
 * 延迟执行（Promise 版本的 sleep）
 * 
 * 创建一个在指定毫秒后 resolved 的 Promise。
 * 常用于异步操作中的延时等待。
 * 
 * @param ms - 延迟毫秒数
 * @returns Promise<void>
 * 
 * @example
 * ```typescript
 * // 等待 1 秒
 * await sleep(1000);
 * 
 * // 重试逻辑
 * for (let i = 0; i < 3; i++) {
 *   try {
 *     await doSomething();
 *     break;
 *   } catch (e) {
 *     if (i === 2) throw e;
 *     await sleep(1000 * (i + 1));  // 递增延迟
 *   }
 * }
 * ```
 */
export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 检查是否为 UTF-16 高代理项（high surrogate）
 * 
 * UTF-16 编码中，某些字符（如 emoji、罕见汉字）需要使用两个 16 位代码单元表示：
 * - 高代理项（high surrogate）：范围 0xD800-0xDBFF
 * - 低代理项（low surrogate）：范围 0xDC00-0xDFFF
 * 
 * @param codeUnit - UTF-16 代码单元值
 * @returns 如果是高代理项返回 true
 */
function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

/**
 * 检查是否为 UTF-16 低代理项（low surrogate）
 * 
 * @param codeUnit - UTF-16 代码单元值
 * @returns 如果是低代理项返回 true
 */
function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * 安全切割 UTF-16 字符串（不破坏代理对）
 * 
 * **问题背景**:
 * JavaScript 字符串使用 UTF-16 编码，某些字符（如 emoji 😊）占用两个代码单元。
 * 直接在中间切割会导致乱码或不完整的字符。
 * 
 * **解决方案**:
 * 1. 处理负数索引（类似 Python 的切片行为）
 * 2. 交换 from/to 保证 from <= to
 * 3. 检查起始位置：如果是低代理项且前一个是高代理项，跳过这个代理对
 * 4. 检查结束位置：如果前一个是高代理项且当前是低代理项，回退一位
 * 
 * @param input - 要切割的字符串
 * @param start - 起始索引（支持负数）
 * @param end - 结束索引（可选，支持负数）
 * @returns 安全的子字符串
 * 
 * @example
 * ```typescript
 * const emoji = "Hello 😊 World";
 * // 直接 slice 可能会切开 emoji
 * emoji.slice(6, 7);  // 可能输出 ""（半个 emoji）
 * 
 * // 使用本函数保证安全
 * sliceUtf16Safe(emoji, 6, 7);  // → ""（完整保留或完全舍弃）
 * ```
 */
export function sliceUtf16Safe(input: string, start: number, end?: number): string {
  const len = input.length;

  // 处理负数索引（Python 风格）
  let from = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
  let to = end === undefined ? len : end < 0 ? Math.max(len + end, 0) : Math.min(end, len);

  // 保证 from <= to
  if (to < from) {
    const tmp = from;
    from = to;
    to = tmp;
  }

  // 调整起始位置：避开代理对边界
  if (from > 0 && from < len) {
    const codeUnit = input.charCodeAt(from);
    // 如果 from 指向低代理项且前一个是高代理项，跳过
    if (isLowSurrogate(codeUnit) && isHighSurrogate(input.charCodeAt(from - 1))) {
      from += 1;
    }
  }

  // 调整结束位置：避开代理对边界
  if (to > 0 && to < len) {
    const codeUnit = input.charCodeAt(to - 1);
    // 如果 to-1 是高代理项且 to 是低代理项，回退
    if (isHighSurrogate(codeUnit) && isLowSurrogate(input.charCodeAt(to))) {
      to -= 1;
    }
  }

  return input.slice(from, to);
}

/**
 * 安全截断 UTF-16 字符串到指定长度
 * 
 * 确保截断不会破坏代理对（成对的 UTF-16 代码单元）。
 * 内部调用 sliceUtf16Safe 实现。
 * 
 * @param input - 要截断的字符串
 * @param maxLen - 最大长度（字符数）
 * @returns 截断后的字符串（长度 <= maxLen）
 * 
 * @example
 * ```typescript
 * truncateUtf16Safe("Hello 😊", 7);  // → "Hello 😊"（完整保留）
 * truncateUtf16Safe("Hello 😊", 6);  // → "Hello "（舍弃 emoji）
 * ```
 */
export function truncateUtf16Safe(input: string, maxLen: number): string {
  const limit = Math.max(0, Math.floor(maxLen));
  if (input.length <= limit) {
    return input;
  }
  return sliceUtf16Safe(input, 0, limit);
}

/**
 * 解析用户路径（支持 ~ 和 $HOME 变量）
 * 
 * 将用户友好的路径表达式转换为绝对路径：
 * - `~/foo` → `/home/user/foo`
 * - `$HOME/bar` → `/home/user/bar`
 * - 相对路径 → 相对于 HOME 目录
 * 
 * @param input - 输入路径（可能包含 ~ 或环境变量）
 * @param env - 环境变量对象（默认 process.env）
 * @param homedir - 获取 HOME 目录的函数（默认 os.homedir）
 * @returns 解析后的绝对路径
 * 
 * @example
 * ```typescript
 * resolveUserPath("~/config.json");      // → "/home/user/config.json"
 * resolveUserPath("$OPENCLAW_HOME/data"); // → "/path/to/openclaw/data"
 * ```
 */
export function resolveUserPath(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  if (!input) {
    return "";
  }
  return resolveHomeRelativePath(input, { env, homedir });
}

/**
 * 解析配置目录
 * 
 * **优先级**:
 * 1. OPENCLAW_STATE_DIR 环境变量（如果设置）
 * 2. ~/.openclaw（默认位置）
 * 
 * 兼容新旧目录结构：
 * - 新目录：~/.openclaw
 * - 旧目录：$XDG_CONFIG_HOME/openclaw 或其他
 * 
 * @param env - 环境变量对象（默认 process.env）
 * @param homedir - 获取 HOME 目录的函数（默认 os.homedir）
 * @returns 配置目录的绝对路径
 * 
 * @example
 * ```typescript
 * // 未设置环境变量
 * resolveConfigDir();  // → "/home/user/.openclaw"
 * 
 * // 设置了自定义目录
 * process.env.OPENCLAW_STATE_DIR = "/etc/openclaw";
 * resolveConfigDir();  // → "/etc/openclaw"
 * ```
 */
export function resolveConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  // 检查环境变量覆盖
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env, homedir);
  }
  
  // 默认位置：~/.openclaw
  const newDir = path.join(resolveRequiredHomeDir(env, homedir), ".openclaw");
  
  // 检查是否存在（兼容性考虑）
  try {
    const hasNew = fs.existsSync(newDir);
    if (hasNew) {
      return newDir;
    }
  } catch {
    // 尽力而为，失败也不阻塞
  }
  
  return newDir;
}

/**
 * 解析 HOME 目录
 * 
 * 封装 resolveEffectiveHomeDir，处理各种边界情况：
 * - 环境变量 HOME 未设置
 * - 用户使用 sudo 运行
 * - 容器环境
 * 
 * @returns HOME 目录路径，无法解析返回 undefined
 */
export function resolveHomeDir(): string | undefined {
  return resolveEffectiveHomeDir(process.env, os.homedir);
}

/**
 * 解析 HOME 目录显示前缀
 * 
 * 决定如何在日志和 UI 中显示 HOME 目录：
 * - 如果设置了 OPENCLAW_HOME，显示 "$OPENCLAW_HOME"
 * - 否则显示 "~"
 * 
 * @returns 包含 home 路径和前缀的对象，无法解析返回 undefined
 */
function resolveHomeDisplayPrefix(): { home: string; prefix: string } | undefined {
  const home = resolveHomeDir();
  if (!home) {
    return undefined;
  }
  
  // 检查是否有自定义 HOME
  const explicitHome = process.env.OPENCLAW_HOME?.trim();
  if (explicitHome) {
    return { home, prefix: "$OPENCLAW_HOME" };
  }
  
  return { home, prefix: "~" };
}

/**
 * 缩短路径中的 HOME 目录部分
 * 
 * 将绝对路径中的 HOME 目录替换为简短前缀（~ 或 $OPENCLAW_HOME）。
 * 
 * **示例**:
 * - `/home/user/.openclaw/config.json` → `~/.openclaw/config.json`
 * - `/custom/path/data.db` → `/custom/path/data.db`（不变）
 * 
 * @param input - 要缩短的路径
 * @returns 缩短后的路径（如果 HOME 在其中）
 */
export function shortenHomePath(input: string): string {
  if (!input) {
    return input;
  }
  
  const display = resolveHomeDisplayPrefix();
  if (!display) {
    return input;
  }
  
  const { home, prefix } = display;
  
  // 完全匹配 HOME 目录
  if (input === home) {
    return prefix;
  }
  
  // HOME 目录作为前缀
  if (input.startsWith(`${home}/`) || input.startsWith(`${home}\\`)) {
    return `${prefix}${input.slice(home.length)}`;
  }
  
  return input;
}

/**
 * 缩短字符串中的所有 HOME 目录引用
 * 
 * 与 shortenHomePath 的区别：
 * - shortenHomePath: 处理单个路径
 * - shortenHomeInString: 处理字符串中的多个路径（全局替换）
 * 
 * @param input - 要处理的字符串
 * @returns 替换后的字符串
 * 
 * @example
 * ```typescript
 * shortenHomeInString("Config: /home/user/.openclaw/config.json");
 * // → "Config: ~/.openclaw/config.json"
 * ```
 */
export function shortenHomeInString(input: string): string {
  if (!input) {
    return input;
  }
  
  const display = resolveHomeDisplayPrefix();
  if (!display) {
    return input;
  }
  
  // 全局替换所有 HOME 引用
  return input.split(display.home).join(display.prefix);
}

/**
 * 显示友好型路径（缩短 HOME 目录）
 * 
 * shortenHomePath 的别名，语义更清晰。
 * 
 * @param input - 要显示的路径
 * @returns 缩短后的路径
 */
export function displayPath(input: string): string {
  return shortenHomePath(input);
}

/**
 * 显示友好型字符串（缩短其中的 HOME 引用）
 * 
 * shortenHomeInString 的别名，语义更清晰。
 * 
 * @param input - 要显示的字符串
 * @returns 替换后的字符串
 */
export function displayString(input: string): string {
  return shortenHomeInString(input);
}

// 配置根目录（可通过 OPENCLAW_STATE_DIR 覆盖）
export const CONFIG_DIR = resolveConfigDir();
