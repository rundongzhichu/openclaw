/**
 * @fileoverview OpenClaw 配置系统
 * 
 * 本文件是配置系统的导出入口，提供了完整的配置管理能力：
 * 
 * **核心功能**:
 * - 配置文件加载和解析 (JSON5 格式)
 * - 配置验证 (使用 Zod Schema)
 * - 环境变量覆盖
 * - SecretRef 引用解析
 * - 遗留配置迁移
 * - 运行时配置快照
 * - 配置热重载
 * 
 * **配置层次**:
 * 1. **文件配置**: ~/.openclaw/config.json
 * 2. **环境变量**: OPENCLAW_* 前缀的变量
 * 3. **运行时覆盖**: CLI 参数或程序化修改
 * 4. **Secret 解析**: 从密钥管理工具解析敏感值
 * 
 * **主要导出**:
 * - {@link loadConfig} - 加载并验证完整配置
 * - {@link readConfigFileSnapshot} - 读取配置文件快照
 * - {@link validateConfigObjectWithPlugins} - 验证配置对象
 * - {@link migrateLegacyConfig} - 迁移遗留配置
 * - {@link writeConfigFile} - 写入配置文件
 * 
 * **配置结构**:
 * ```typescript
 * interface OpenClawConfig {
 *   gateway: GatewayConfig;        // 网关配置
 *   agents: AgentsConfig;          // Agent 配置
 *   channels: ChannelsConfig;      // 通道配置
 *   models: ModelsConfig;          // 模型配置
 *   tools: ToolsConfig;            // 工具配置
 *   session: SessionConfig;        // 会话配置
 *   secrets: SecretsConfig;        // 密钥配置
 * }
 * ```
 * 
 * @module config/config
 */

export {
  clearConfigCache,
  ConfigRuntimeRefreshError,
  clearRuntimeConfigSnapshot,
  createConfigIO,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  projectConfigOntoRuntimeSourceSnapshot,
  loadConfig,
  readBestEffortConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  resolveConfigSnapshotHash,
  setRuntimeConfigSnapshotRefreshHandler,
  setRuntimeConfigSnapshot,
  writeConfigFile,
} from "./io.js";
export { migrateLegacyConfig } from "./legacy-migrate.js";
export * from "./paths.js";
export * from "./runtime-overrides.js";
export * from "./types.js";
export {
  validateConfigObject,
  validateConfigObjectRaw,
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";
