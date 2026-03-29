/**
 * @fileoverview CLI Profile 名称验证与标准化工具
 * 
 * 本文件实现了 OpenClaw 系统中 Profile 名称的验证和规范化逻辑。
 * 
 * **核心功能**:
 * - Profile 名称正则表达式验证
 * - 名称标准化（去除空格、大小写处理）
 * - "default" 特殊值处理
 * - 路径安全和 Shell 友好性保证
 * 
 * **Profile 命名规则**:
 * ```text
 * 1. 长度：1-64 个字符
 * 2. 首字符：必须是字母或数字（a-z, A-Z, 0-9）
 * 3. 后续字符：字母、数字、下划线、连字符
 * 4. 不区分大小写（内部统一转为小写）
 * 5. 保留字："default"（视为 null，使用默认配置）
 * ```
 * 
 * **有效示例**:
 * - ✅ "dev" - 开发环境
 * - ✅ "production" - 生产环境
 * - ✅ "test-env" - 测试环境
 * - ✅ "my_profile" - 自定义配置
 * - ✅ "claude-sonnet-4" - 模型配置
 * 
 * **无效示例**:
 * - ❌ "" - 空字符串
 * - ❌ "123abc" - 首字符是数字（允许，但不推荐）
 * - ❌ "my profile" - 包含空格
 * - ❌ "test.env" - 包含点号
 * - ❌ "café" - 非 ASCII 字符
 * 
 * **使用示例**:
 * ```typescript
 * // 场景 1: 验证 Profile 名称
 * isValidProfileName('dev');  // → true
 * isValidProfileName('production');  // → true
 * isValidProfileName('test.env');  // → false
 * 
 * // 场景 2: 标准化 Profile 名称
 * normalizeProfileName('  DEV  ');  // → 'DEV'
 * normalizeProfileName('default');  // → null (使用默认配置)
 * normalizeProfileName('');  // → null
 * 
 * // 场景 3: CLI 参数处理
 * const profileArg = process.argv.find(arg => arg.startsWith('--profile='));
 * const profileName = profileArg?.split('=')[1];
 * const normalized = normalizeProfileName(profileName);
 * if (normalized) {
 *   console.log(`Using profile: ${normalized}`);
 * } else {
 *   console.log('Using default configuration');
 * }
 * ```
 * 
 * @module cli/profile-utils
 */

/**
 * Profile 名称正则表达式 ⭐
 * 
 * **匹配规则**:
 * - `^` - 从头开始匹配
 * - `[a-z0-9]` - 首字符必须是字母或数字
 * - `[a-z0-9_-]{0,63}` - 后续 0-63 个字符可以是字母、数字、下划线或连字符
 * - `$` - 到结尾结束
 * - `/i` - 不区分大小写
 * 
 * **总长度**: 1-64 个字符
 * 
 * **设计考虑**:
 * - **路径安全**: 避免特殊字符导致文件系统问题
 * - **Shell 友好**: 可在命令行中直接使用，无需引号包裹
 * - **跨平台兼容**: 仅使用 ASCII 字符，避免编码问题
 * - **可读性**: 支持连字符和下划线分隔单词
 * 
 * @example
 * ```typescript
 * // 有效匹配
 * PROFILE_NAME_RE.test('dev');         // → true
 * PROFILE_NAME_RE.test('production');  // → true
 * PROFILE_NAME_RE.test('test-env');    // → true
 * PROFILE_NAME_RE.test('my_profile');  // → true
 * PROFILE_NAME_RE.test('Dev');         // → true (不区分大小写)
 * 
 * // 无效匹配
 * PROFILE_NAME_RE.test('');            // → false (空字符串)
 * PROFILE_NAME_RE.test('my.profile');  // → false (包含点号)
 * PROFILE_NAME_RE.test('test env');    // → false (包含空格)
 * PROFILE_NAME_RE.test('café');        // → false (非 ASCII)
 * PROFILE_NAME_RE.test('-dev');        // → false (首字符不是连字符)
 * PROFILE_NAME_RE.test('dev-');        // → true (尾字符可以是连字符)
 * ```
 */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * 验证 Profile 名称是否有效
 * 
 * **验证逻辑**:
 * 1. 检查是否为空（空字符串、null、undefined）
 * 2. 使用正则表达式 PROFILE_NAME_RE 进行匹配
 * 
 * **用途**:
 * - CLI 参数验证（如 --profile <name>）
 * - 配置文件中的 profile 引用检查
 * - 创建新 Profile 前的预检
 * 
 * @param value - 要验证的 Profile 名称
 * @returns 是否为有效的 Profile 名称
 * 
 * @example
 * ```typescript
 * // 示例 1: 基本验证
 * isValidProfileName('dev');  // → true
 * isValidProfileName('production');  // → true
 * 
 * // 示例 2: 边界情况
 * isValidProfileName('');  // → false (空字符串)
 * isValidProfileName(null);  // → false (null)
 * isValidProfileName(undefined);  // → false (undefined)
 * 
 * // 示例 3: 格式错误
 * isValidProfileName('my.profile');  // → false (包含点号)
 * isValidProfileName('test env');  // → false (包含空格)
 * isValidProfileName('café');  // → false (非 ASCII 字符)
 * 
 * // 示例 4: 长度限制
 * isValidProfileName('a'.repeat(64));  // → true (最大长度)
 * isValidProfileName('a'.repeat(65));  // → false (超长)
 * isValidProfileName('a');  // → true (最小长度)
 * 
 * // 示例 5: 特殊字符
 * isValidProfileName('test_env');  // → true (下划线)
 * isValidProfileName('test-env');  // → true (连字符)
 * isValidProfileName('test_env_v1');  // → true (组合)
 * ```
 */
export function isValidProfileName(value: string): boolean {
  // 快速路径：空值直接返回 false
  if (!value) {
    return false;
  }
  
  // 使用正则表达式验证（路径安全 + Shell 友好）
  return PROFILE_NAME_RE.test(value);
}

/**
 * 标准化 Profile 名称
 * 
 * **处理流程**:
 * ```text
 * 1. 输入检查：null/undefined → 返回 null
 * 
 * 2. 去除首尾空格：trim()
 * 
 * 3. "default" 特殊处理：
 *    - 如果值为 "default"（不区分大小写）→ 返回 null
 *    - 原因："default" 表示使用默认配置，等同于未指定
 * 
 * 4. 格式验证：调用 isValidProfileName()
 *    - 无效 → 返回 null
 *    - 有效 → 返回标准化后的名称
 * ```
 * 
 * **返回值说明**:
 * - 有效的 Profile 名称 → 返回原样字符串
 * - 无效输入（空、格式错误、"default"）→ 返回 null
 * 
 * **用途**:
 * - CLI 参数解析后的标准化
 * - 配置文件中的 profile 引用清理
 * - 避免 "default" 被误认为有效 Profile 名
 * 
 * @param raw - 原始 Profile 名称（可选）
 * @returns 标准化后的 Profile 名称或 null
 * 
 * @example
 * ```typescript
 * // 示例 1: 基本标准化
 * normalizeProfileName('dev');  // → 'dev'
 * normalizeProfileName('  DEV  ');  // → 'DEV' (去除空格)
 * 
 * // 示例 2: "default" 特殊处理
 * normalizeProfileName('default');  // → null
 * normalizeProfileName('Default');  // → null (不区分大小写)
 * normalizeProfileName(' DEFAULT ');  // → null (去除空格后是 default)
 * 
 * // 示例 3: 无效输入
 * normalizeProfileName('');  // → null
 * normalizeProfileName(null);  // → null
 * normalizeProfileName(undefined);  // → null
 * normalizeProfileName('my.profile');  // → null (格式错误)
 * 
 * // 示例 4: CLI 参数处理实战
 * // 命令行：openclaw --profile "  dev  "
 * const profileArg = '  dev  ';
 * const normalized = normalizeProfileName(profileArg);
 * console.log(normalized);  // → 'dev'
 * 
 * // 命令行：openclaw --profile default
 * const defaultArg = 'default';
 * const normalizedDefault = normalizeProfileName(defaultArg);
 * console.log(normalizedDefault);  // → null (使用默认配置)
 * 
 * // 示例 5: 条件判断
 * const profileName = normalizeProfileName(userInput);
 * if (profileName) {
 *   console.log(`Loading profile: ${profileName}`);
 * } else {
 *   console.log('Using default configuration');
 * }
 * ```
 */
export function normalizeProfileName(raw?: string | null): string | null {
  // 步骤 1: 去除首尾空格
  const profile = raw?.trim();
  
  // 步骤 2: 空值检查
  if (!profile) {
    return null;
  }
  
  // 步骤 3: "default" 特殊处理（视为未指定）
  if (profile.toLowerCase() === "default") {
    return null;
  }
  
  // 步骤 4: 格式验证
  if (!isValidProfileName(profile)) {
    return null;
  }
  
  // 步骤 5: 返回标准化后的名称
  return profile;
}
