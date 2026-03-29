/**
 * @fileoverview 工具目录与配置文件管理
 * 
 * 本文件实现了 OpenClaw 系统中工具（Tools）的目录管理和配置功能。
 * 
 * **核心职责**:
 * - 工具配置文件定义（Tool Profile）
 * - 核心工具分类和编目
 * - 工具分组管理（按功能区域）
 * - 工具可见性控制（OpenClaw Group）
 * - 工具元数据管理（ID、标签、描述）
 * 
 * **工具配置文件类型**:
 * - `minimal` - 最小化工具集（仅基础操作）
 * - `coding` - 编码工具集（读写编辑 + 执行）
 * - `messaging` - 消息工具集（通信相关）
 * - `full` - 完整工具集（所有可用工具）
 * 
 * **工具分类（Section）**:
 * 1. **Files** (fs) - 文件系统操作
 * 2. **Runtime** (runtime) - 运行时执行
 * 3. **Web** (web) - 网络相关
 * 4. **Memory** (memory) - 记忆存储
 * 5. **Sessions** (sessions) - 会话管理
 * 6. **UI** (ui) - 用户界面
 * 7. **Messaging** (messaging) - 消息通信
 * 8. **Automation** (automation) - 自动化
 * 9. **Nodes** (nodes) - 节点管理
 * 10. **Agents** (agents) - Agent 控制
 * 11. **Media** (media) - 媒体处理
 * 
 * **核心工具列表**:
 * - **文件类**: read, write, edit, apply_patch
 * - **执行类**: exec, process, code_execution
 * - **网络类**: web_search, web_fetch
 * - **会话类**: session_list, session_spawn, session_kill
 * - **Agent 类**: agent_spawn, agent_query
 * 
 * **使用示例**:
 * ```typescript
 * // 获取特定 Profile 的工具策略
 * const policy = getToolProfilePolicy('coding');
 * console.log(policy.allow);  // 允许的工具列表
 * 
 * // 构建工具目录 UI
 * const sections = buildCoreToolSections();
 * for (const section of sections) {
 *   console.log(`${section.label}: ${section.tools.length} tools`);
 * }
 * 
 * // 检查工具是否在 OpenClaw Group 中
 * if (isToolInOpenClawGroup('web_search')) {
 *   // 显示在推荐工具列表中
 * }
 * ```
 * 
 * @module agents/tool-catalog
 */

/**
 * 工具配置文件 ID 类型
 * 
 * 定义了系统中预定义的工具配置模板，每个 Profile 代表一组工具的集合。
 * 
 * **配置说明**:
 * - `minimal` - 最小化工具集：仅包含最基础的操作工具
 * - `coding` - 编码工具集：完整的编程开发工具（读写编辑 + 执行）
 * - `messaging` - 消息工具集：通信和会话管理工具
 * - `full` - 完整工具集：包含所有可用工具
 * 
 * @example
 * ```typescript
 * // 根据场景选择合适的 Profile
 * const profile: ToolProfileId = 'coding';  // 编程助手
 * const messagingProfile: ToolProfileId = 'messaging';  // 客服机器人
 * const fullProfile: ToolProfileId = 'full';  // 全能助手
 * ```
 */
export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

/**
 * 工具配置文件策略
 * 
 * 定义工具的允许/拒绝列表，用于细粒度控制 Agent 可以使用的工具。
 * 
 * **字段说明**:
 * - `allow`: 允许使用的工具 ID 列表（白名单）
 * - `deny`: 禁止使用的工具 ID 列表（黑名单）
 * 
 * **优先级规则**: deny 优先于 allow
 * 
 * @example
 * ```typescript
 * // 只允许特定工具
 * const restrictivePolicy: ToolProfilePolicy = {
 *   allow: ['read', 'write', 'exec']
 * };
 * 
 * // 允许大部分工具，但禁止危险操作
 * const permissivePolicy: ToolProfilePolicy = {
 *   allow: ['*'],  // 允许所有
 *   deny: ['exec', 'process']  // 但禁止执行命令
 * };
 * 
 * // 完全禁止某些工具
 * const blockPolicy: ToolProfilePolicy = {
 *   deny: ['memory_search', 'sessions_list']  // 禁止访问记忆和会话
 * };
 * ```
 */
type ToolProfilePolicy = {
  /** 允许的工具 ID 列表（支持通配符 '*'） */
  allow?: string[];
  /** 禁止的工具 ID 列表（优先级高于 allow） */
  deny?: string[];
};

/**
 * 核心工具分类（Section）结构
 * 
 * 用于 UI 展示和工具组织，将相关工具按功能分组。
 * 
 * @property id - 分类唯一标识（如 'fs', 'runtime', 'web'）
 * @property label - 分类显示名称（如 'Files', 'Runtime', 'Web'）
 * @property tools - 该分类下的工具列表
 * 
 * @example
 * ```typescript
 * const fsSection: CoreToolSection = {
 *   id: 'fs',
 *   label: 'Files',
 *   tools: [
 *     {
 *       id: 'read',
 *       label: 'read',
 *       description: '读取文件内容'
 *     },
 *     {
 *       id: 'write',
 *       label: 'write',
 *       description: '创建或覆盖文件'
 *     }
 *   ]
 * };
 * ```
 */
export type CoreToolSection = {
  /** 分类唯一标识 */
  id: string;
  /** 分类显示名称 */
  label: string;
  /** 该分类下的工具列表 */
  tools: Array<{
    /** 工具唯一标识 */
    id: string;
    /** 工具显示标签 */
    label: string;
    /** 工具功能描述 */
    description: string;
  }>;
};

/**
 * 核心工具定义
 * 
 * 描述单个工具的元数据信息，包括其所属分类、适用场景等。
 * 
 * @property id - 工具唯一标识（如 'read', 'exec', 'web_search'）
 * @property label - 工具显示标签（通常与 id 相同）
 * @property description - 工具功能描述（英文）
 * @property sectionId - 所属分类 ID（如 'fs', 'runtime'）
 * @property profiles - 适用的工具配置文件 ID 列表
 * @property includeInOpenClawGroup - 是否包含在 OpenClaw 推荐组中
 * 
 * @example
 * ```typescript
 * const readTool: CoreToolDefinition = {
 *   id: 'read',
 *   label: 'read',
 *   description: 'Read file contents',
 *   sectionId: 'fs',
 *   profiles: ['coding'],  // 只在 coding profile 中可用
 *   includeInOpenClawGroup: true  // 在推荐列表中显示
 * };
 * 
 * const execTool: CoreToolDefinition = {
 *   id: 'exec',
 *   label: 'exec',
 *   description: 'Run shell commands',
 *   sectionId: 'runtime',
 *   profiles: ['coding'],
 *   includeInOpenClawGroup: false  // 不推荐，因为较危险
 * };
 * ```
 */
type CoreToolDefinition = {
  /** 工具唯一标识 */
  id: string;
  /** 工具显示标签 */
  label: string;
  /** 工具功能描述 */
  description: string;
  /** 所属分类 ID */
  sectionId: string;
  /** 适用的工具配置文件 ID 列表 */
  profiles: ToolProfileId[];
  /** 是否包含在 OpenClaw 推荐组中（可选） */
  includeInOpenClawGroup?: boolean;
};

/**
 * 工具分类排序定义
 * 
 * 定义工具分类在 UI 中的显示顺序。
 * 按照从底层到高层、从具体到抽象的顺序排列：
 * 1. 文件系统（最基础）
 * 2. 运行时执行
 * 3. 网络访问
 * 4. 记忆存储
 * 5. 会话管理
 * 6. 用户界面
 * 7. 消息通信
 * 8. 自动化
 * 9. 节点管理
 * 10. Agent 控制
 * 11. 媒体处理（最高层）
 */
const CORE_TOOL_SECTION_ORDER: Array<{ id: string; label: string }> = [
  { id: "fs", label: "Files" },        // 文件系统操作
  { id: "runtime", label: "Runtime" },  // 运行时执行
  { id: "web", label: "Web" },          // 网络访问
  { id: "memory", label: "Memory" },    // 记忆存储
  { id: "sessions", label: "Sessions" },// 会话管理
  { id: "ui", label: "UI" },            // 用户界面
  { id: "messaging", label: "Messaging" }, // 消息通信
  { id: "automation", label: "Automation" }, // 自动化
  { id: "nodes", label: "Nodes" },      // 节点管理
  { id: "agents", label: "Agents" },    // Agent 控制
  { id: "media", label: "Media" },      // 媒体处理
];

/**
 * 核心工具定义列表
 * 
 * 包含系统中所有预定义工具的完整元数据。
 * 
 * **工具分类统计**:
 * - Files (fs): read, write, edit, apply_patch 等
 * - Runtime (runtime): exec, process, code_execution 等
 * - Web (web): web_search, web_fetch, x_search 等
 * - Memory (memory): memory_search, memory_get 等
 * - Sessions (sessions): sessions_list, sessions_history 等
 * - UI (ui): screenshot, display 等
 * - Messaging (messaging): send_message, broadcast 等
 * - Automation (automation): cron_job, webhook 等
 * - Nodes (nodes): node_list, node_status 等
 * - Agents (agents): agent_spawn, agent_query 等
 * - Media (media): image_gen, audio_transcribe 等
 * 
 * **OpenClaw Group 工具** (includeInOpenClawGroup=true):
 * - code_execution - 沙箱代码执行
 * - web_search - 网络搜索
 * - web_fetch - 网页抓取
 * - x_search - X/Twitter 搜索
 * - memory_search - 语义记忆搜索
 * - memory_get - 记忆读取
 * - sessions_list - 会话列表
 * - sessions_history - 会话历史
 * - ... (更多推荐工具)
 */
const CORE_TOOL_DEFINITIONS: CoreToolDefinition[] = [
  // ========== Files (fs) 文件系统工具 ==========
  {
    id: "read",
    label: "read",
    description: "Read file contents",  // 读取文件内容
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "write",
    label: "write",
    description: "Create or overwrite files",  // 创建或覆盖文件
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "edit",
    label: "edit",
    description: "Make precise edits",  // 精确编辑
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "apply_patch",
    label: "apply_patch",
    description: "Patch files",  // 应用补丁
    sectionId: "fs",
    profiles: ["coding"],
  },
  
  // ========== Runtime (runtime) 运行时工具 ==========
  {
    id: "exec",
    label: "exec",
    description: "Run shell commands",  // 执行 shell 命令
    sectionId: "runtime",
    profiles: ["coding"],
  },
  {
    id: "process",
    label: "process",
    description: "Manage background processes",  // 管理后台进程
    sectionId: "runtime",
    profiles: ["coding"],
  },
  {
    id: "code_execution",
    label: "code_execution",
    description: "Run sandboxed remote analysis",  // 沙箱远程代码执行
    sectionId: "runtime",
    profiles: ["coding"],
    includeInOpenClawGroup: true,  // 推荐工具
  },
  
  // ========== Web (web) 网络工具 ==========
  {
    id: "web_search",
    label: "web_search",
    description: "Search the web",  // 网络搜索
    sectionId: "web",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "web_fetch",
    label: "web_fetch",
    description: "Fetch web content",  // 抓取网页内容
    sectionId: "web",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "x_search",
    label: "x_search",
    description: "Search X posts",  // 搜索 X/Twitter 帖子
    sectionId: "web",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  
  // ========== Memory (memory) 记忆工具 ==========
  {
    id: "memory_search",
    label: "memory_search",
    description: "Semantic search",  // 语义搜索记忆
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "memory_get",
    label: "memory_get",
    description: "Read memory files",  // 读取记忆文件
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  
  // ========== Sessions (sessions) 会话工具 ==========
  {
    id: "sessions_list",
    label: "sessions_list",
    description: "List sessions",  // 列出会话
    sectionId: "sessions",
    profiles: ["coding", "messaging"],  // 同时适用于编码和消息场景
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_history",
    label: "sessions_history",
    description: "Session history",  // 会话历史
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_send",
    label: "sessions_send",
    description: "Send to session",  // 发送消息到会话
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_spawn",
    label: "sessions_spawn",
    description: "Spawn sub-agent",  // 生成子代理
    sectionId: "sessions",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_yield",
    label: "sessions_yield",
    description: "End turn to receive sub-agent results",  // 结束回合以接收子代理结果
    sectionId: "sessions",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "subagents",
    label: "subagents",
    description: "Manage sub-agents",  // 管理子代理
    sectionId: "sessions",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "session_status",
    label: "session_status",
    description: "Session status",  // 会话状态
    sectionId: "sessions",
    profiles: ["minimal", "coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  
  // ========== UI (ui) 用户界面工具 ==========
  {
    id: "browser",
    label: "browser",
    description: "Control web browser",  // 控制浏览器
    sectionId: "ui",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "canvas",
    label: "canvas",
    description: "Control canvases",  // 控制画布
    sectionId: "ui",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  
  // ========== Messaging (messaging) 消息工具 ==========
  {
    id: "message",
    label: "message",
    description: "Send messages",  // 发送消息
    sectionId: "messaging",
    profiles: ["messaging"],
    includeInOpenClawGroup: true,
  },
  
  // ========== Automation (automation) 自动化工具 ==========
  {
    id: "cron",
    label: "cron",
    description: "Schedule tasks",  // 定时任务
    sectionId: "automation",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "gateway",
    label: "gateway",
    description: "Gateway control",  // 网关控制
    sectionId: "automation",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  
  // ========== Nodes (nodes) 节点工具 ==========
  {
    id: "nodes",
    label: "nodes",
    description: "Nodes + devices",  // 节点和设备
    sectionId: "nodes",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  
  // ========== Agents (agents) 代理工具 ==========
  {
    id: "agents_list",
    label: "agents_list",
    description: "List agents",  // 列出代理
    sectionId: "agents",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  
  // ========== Media (media) 媒体工具 ==========
  {
    id: "image",
    label: "image",
    description: "Image understanding",  // 图像理解
    sectionId: "media",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "image_generate",
    label: "image_generate",
    description: "Image generation",  // 图像生成
    sectionId: "media",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "tts",
    label: "tts",
    description: "Text-to-speech conversion",  // 文本转语音
    sectionId: "media",
    profiles: [],
    includeInOpenClawGroup: true,
  },
];

const CORE_TOOL_BY_ID = new Map<string, CoreToolDefinition>(
  CORE_TOOL_DEFINITIONS.map((tool) => [tool.id, tool]),
);

function listCoreToolIdsForProfile(profile: ToolProfileId): string[] {
  return CORE_TOOL_DEFINITIONS.filter((tool) => tool.profiles.includes(profile)).map(
    (tool) => tool.id,
  );
}

const CORE_TOOL_PROFILES: Record<ToolProfileId, ToolProfilePolicy> = {
  minimal: {
    allow: listCoreToolIdsForProfile("minimal"),
  },
  coding: {
    allow: listCoreToolIdsForProfile("coding"),
  },
  messaging: {
    allow: listCoreToolIdsForProfile("messaging"),
  },
  full: {},
};

function buildCoreToolGroupMap() {
  const sectionToolMap = new Map<string, string[]>();
  for (const tool of CORE_TOOL_DEFINITIONS) {
    const groupId = `group:${tool.sectionId}`;
    const list = sectionToolMap.get(groupId) ?? [];
    list.push(tool.id);
    sectionToolMap.set(groupId, list);
  }
  const openclawTools = CORE_TOOL_DEFINITIONS.filter((tool) => tool.includeInOpenClawGroup).map(
    (tool) => tool.id,
  );
  return {
    "group:openclaw": openclawTools,
    ...Object.fromEntries(sectionToolMap.entries()),
  };
}

export const CORE_TOOL_GROUPS = buildCoreToolGroupMap();

export const PROFILE_OPTIONS = [
  { id: "minimal", label: "Minimal" },
  { id: "coding", label: "Coding" },
  { id: "messaging", label: "Messaging" },
  { id: "full", label: "Full" },
] as const;

export function resolveCoreToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
  if (!profile) {
    return undefined;
  }
  const resolved = CORE_TOOL_PROFILES[profile as ToolProfileId];
  if (!resolved) {
    return undefined;
  }
  if (!resolved.allow && !resolved.deny) {
    return undefined;
  }
  return {
    allow: resolved.allow ? [...resolved.allow] : undefined,
    deny: resolved.deny ? [...resolved.deny] : undefined,
  };
}

export function listCoreToolSections(): CoreToolSection[] {
  return CORE_TOOL_SECTION_ORDER.map((section) => ({
    id: section.id,
    label: section.label,
    tools: CORE_TOOL_DEFINITIONS.filter((tool) => tool.sectionId === section.id).map((tool) => ({
      id: tool.id,
      label: tool.label,
      description: tool.description,
    })),
  })).filter((section) => section.tools.length > 0);
}

export function resolveCoreToolProfiles(toolId: string): ToolProfileId[] {
  const tool = CORE_TOOL_BY_ID.get(toolId);
  if (!tool) {
    return [];
  }
  return [...tool.profiles];
}

export function isKnownCoreToolId(toolId: string): boolean {
  return CORE_TOOL_BY_ID.has(toolId);
}
