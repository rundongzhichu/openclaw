# OpenClaw 记忆系统详细架构文档

## 📋 目录

- [1. 系统概览](#1-系统概览)
- [2. 核心组件](#2-核心组件)
  - [2.1 memory-core - 核心记忆引擎](#21-memory-core---核心记忆引擎)
  - [2.2 memory-lancedb - 向量数据库后端](#22-memory-lancedb---向量数据库后端)
  - [2.3 memory-wiki - Wiki 知识库](#23-memory-wiki---wiki-知识库)
  - [2.4 active-memory - 主动记忆系统](#24-active-memory---主动记忆系统)
- [3. 基础设施层](#3-基础设施层)
  - [3.1 memory-host-sdk](#31-memory-host-sdk)
- [4. 数据流和架构](#4-数据流和架构)
- [5. 关键算法和技术](#5-关键算法和技术)
- [6. 配置和使用](#6-配置和使用)
- [7. 扩展开发指南](#7-扩展开发指南)

---

## 1. 系统概览

OpenClaw 的记忆系统是一个**多层次、多后端**的智能记忆管理架构，旨在为 AI Agent 提供持久化、可搜索的长期记忆能力。系统采用插件化设计，支持多种存储后端和检索策略。

### 1.1 设计目标

- **持久化记忆**：将对话中的重要信息提取并保存到文件系统
- **智能检索**：结合向量搜索和全文检索，提供精准的记忆召回
- **自动管理**：自动捕获、索引、同步会话内容
- **可扩展性**：支持多种嵌入提供商和存储后端
- **性能优化**：缓存、批处理、异步操作等优化策略

### 1.2 架构层次

```
┌─────────────────────────────────────────┐
│         Application Layer               │
│  (Agents, Tools, CLI, Gateway API)      │
├─────────────────────────────────────────┤
│       Memory Plugin Layer               │
│  ┌──────────┬──────────┬──────────┐    │
│  │mem-core  │mem-lance │mem-wiki  │    │
│  └──────────┴──────────┴──────────┘    │
├─────────────────────────────────────────┤
│     Host SDK & Runtime Layer            │
│  (Embeddings, QMD, Batch Processing)    │
├─────────────────────────────────────────┤
│       Storage Backend Layer             │
│  (SQLite, LanceDB, File System)         │
└─────────────────────────────────────────┘
```

---

## 2. 核心组件

### 2.1 memory-core - 核心记忆引擎

**位置**: `extensions/memory-core/`

#### 2.1.1 主要功能

memory-core 是整个记忆系统的**核心引擎**，提供：

1. **基于文件的记忆存储**
   - 使用 SQLite 数据库存储记忆元数据和索引
   - 原始会话内容以 Markdown 文件形式保存
   - 支持增量更新和原子化操作

2. **混合检索系统**
   - **向量搜索**：基于嵌入向量的语义搜索
   - **全文检索 (FTS)**：基于 BM25 算法的关键词搜索
   - **混合排序**：结合两种搜索结果，应用时间衰减

3. **嵌入提供商适配器**
   - 支持多种嵌入模型提供商（OpenAI、Anthropic、Google 等）
   - 统一的 EmbeddingProvider 接口
   - 自动故障转移和降级

4. **会话同步机制**
   - 监听会话文件变化
   - 增量索引新内容
   - 批量处理和去重

5. **CLI 工具集**
   ```bash
   openclaw memory search <query>     # 搜索记忆
   openclaw memory inspect            # 检查记忆状态
   openclaw memory reindex            # 重新索引
   openclaw memory status             # 查看同步状态
   ```

#### 2.1.2 核心模块

##### **MemoryIndexManager** (`src/memory/manager.ts`)

记忆索引管理器是核心类，负责：

- **初始化**：加载数据库、配置嵌入提供商、设置缓存
- **索引管理**：维护向量表和 FTS 表
- **搜索执行**：协调向量搜索和全文检索
- **同步控制**：管理会话文件的增量同步
- **资源清理**：关闭数据库连接、停止文件监听

```typescript
class MemoryIndexManager extends MemoryManagerEmbeddingOps {
  // 核心属性
  protected db: DatabaseSync;              // SQLite 数据库
  protected provider: EmbeddingProvider;   // 嵌入提供商
  protected sources: Set<MemorySource>;    // 记忆源集合
  protected cache: CacheManager;           // 嵌入缓存
  
  // 关键方法
  async search(query: string): Promise<MemorySearchResult[]>
  async syncSession(sessionFile: string): Promise<void>
  async reindex(force: boolean): Promise<void>
}
```

##### **嵌入提供商系统** (`src/memory/embeddings.ts`)

提供统一的嵌入生成接口：

```typescript
interface EmbeddingProvider {
  id: EmbeddingProviderId;
  embed(texts: string[]): Promise<number[][]>;
  getDimensions(): number;
  isAvailable(): boolean;
}
```

支持的提供商：
- OpenAI (text-embedding-3-small/large)
- Anthropic (通过外部适配器)
- Google (text-embedding-004)
- Ollama (本地模型)
- Mistral、Voyage 等

##### **混合检索** (`src/memory/hybrid.ts`)

实现向量搜索和 FTS 的结果融合：

```typescript
function mergeHybridResults(
  vectorResults: VectorResult[],
  ftsResults: FTSResult[],
  weights: { vector: number; fts: number }
): HybridResult[]
```

**BM25 评分转换**：
```typescript
function bm25RankToScore(rank: number, totalResults: number): number
```

##### **MMR 去重** (`src/memory/mmr.ts`)

Maximal Marginal Relevance 算法，平衡相关性和多样性：

```typescript
function mmrSelect(
  candidates: SearchResult[],
  queryVector: number[],
  lambda: number,  // 相关性权重 (0-1)
  k: number        // 选择数量
): SearchResult[]
```

##### **时间衰减** (`src/memory/temporal-decay.ts`)

根据记忆的时间戳调整相关性分数：

```typescript
function applyTemporalDecay(
  results: SearchResult[],
  now: number,
  halfLifeMs: number  // 半衰期
): SearchResult[]
```

公式：`adjusted_score = original_score * exp(-λ * age)`

##### **QMD 查询解析** (`src/memory/qmd-manager.ts`)

Query Memory Database 语法解析器，支持复杂查询：

```
# 基本搜索
search:keyword

# 向量搜索
vsearch:semantic query

# 过滤条件
search:project filter:category=technical after:2024-01-01

# 组合查询
(search:API design) AND (filter:type=specification)
```

#### 2.1.3 高级特性

##### **原子化重新索引** (`manager-atomic-reindex.ts`)

确保重新索引操作的原子性：
1. 创建临时数据库
2. 在临时数据库中执行索引
3. 验证完整性
4. 原子替换原数据库

##### **只读恢复机制** (`manager.readonly-recovery.test.ts`)

当数据库变为只读时：
1. 检测只读错误
2. 尝试修复文件权限
3. 重建数据库连接
4. 记录恢复统计

##### **异步搜索同步** (`manager-async-state.ts`)

后台同步机制：
- 队列管理待处理的会话文件
- 批量处理减少 I/O 开销
- 失败重试和指数退避

##### **嵌入缓存** (`manager-embedding-cache.ts`)

避免重复计算嵌入：
```typescript
interface EmbeddingCache {
  get(hash: string): number[] | undefined;
  set(hash: string, vector: number[]): void;
  prune(maxEntries: number): void;
}
```

缓存键：`SHA256(text + provider_id + model)`

#### 2.1.4 工具注册

memory-core 注册的工具：

1. **memory_search**
   ```typescript
   {
     name: "memory_search",
     description: "Search long-term memory with hybrid retrieval",
     parameters: {
       query: string,      // 搜索查询
       limit?: number,     // 结果数量限制
       category?: string,  // 分类过滤
       after?: string,     // 时间过滤
     }
   }
   ```

2. **memory_get**
   ```typescript
   {
     name: "memory_get",
     description: "Retrieve specific memory by ID",
     parameters: {
       id: string,  // 记忆 ID
     }
   }
   ```

#### 2.1.5 提示词构建

`buildPromptSection()` 函数为 Agent 生成记忆上下文：

```markdown
## 🧠 Relevant Memories

Based on your conversation, here are relevant memories:

1. **[Technical]** API Design Discussion (2024-01-15)
   - Discussed RESTful API patterns
   - Decided on versioning strategy
   - Score: 0.89

2. **[Project]** Architecture Decision Record (2024-01-10)
   - Chose microservices architecture
   - Rationale: scalability and team autonomy
   - Score: 0.76
```

---

### 2.2 memory-lancedb - 向量数据库后端

**位置**: `extensions/memory-lancedb/`

#### 2.2.1 主要功能

memory-lancedb 提供基于 **LanceDB** 的向量存储后端，特点：

1. **高性能向量搜索**
   - 使用 LanceDB 原生向量索引
   - 支持近似最近邻 (ANN) 搜索
   - 内存映射文件，低延迟访问

2. **自动回忆和捕获**
   - 生命周期钩子自动触发
   - 基于重要性评分的选择性存储
   - 分类系统组织记忆

3. **云存储支持**
   - S3、GCS、Azure Blob Storage
   - 远程数据库连接
   - 分布式部署能力

#### 2.2.2 核心架构

##### **MemoryDB 类** (`index.ts`)

```typescript
class MemoryDB {
  private db: LanceDB.Connection;
  private table: LanceDB.Table;
  
  constructor(
    dbPath: string,
    vectorDim: number,
    storageOptions?: Record<string, string>
  )
  
  // 核心方法
  async add(entry: MemoryEntry): Promise<string>
  async search(query: string, limit: number): Promise<MemorySearchResult[]>
  async delete(id: string): Promise<void>
  async count(): Promise<number>
}
```

##### **记忆条目结构**

```typescript
type MemoryEntry = {
  id: string;              // UUID
  text: string;            // 记忆文本
  vector: number[];        // 嵌入向量
  importance: number;      // 重要性评分 (0-1)
  category: MemoryCategory; // 分类
  createdAt: number;       // 时间戳
};

type MemoryCategory = 
  | "technical"
  | "personal"
  | "project"
  | "preference"
  | "fact"
  | "other";
```

##### **生命周期钩子**

自动捕获对话中的关键信息：

```typescript
api.registerLifecycleHook("onMessageComplete", async (ctx) => {
  // 分析消息重要性
  const importance = await assessImportance(ctx.message);
  
  if (importance > threshold) {
    // 生成嵌入
    const vector = await embed(ctx.message.content);
    
    // 分类
    const category = await classify(ctx.message.content);
    
    // 存储
    await db.add({
      id: randomUUID(),
      text: ctx.message.content,
      vector,
      importance,
      category,
      createdAt: Date.now(),
    });
  }
});
```

#### 2.2.3 配置示例

```yaml
memory:
  lancedb:
    enabled: true
    path: "~/.openclaw/memory/lancedb"
    vectorDim: 1536  # 对应 text-embedding-3-small
    
    # 云存储配置
    storage:
      type: "s3"
      bucket: "my-openclaw-memory"
      region: "us-east-1"
    
    # 自动捕获配置
    capture:
      enabled: true
      minImportance: 0.7
      maxChars: 2000
      categories: ["technical", "project", "fact"]
    
    # 搜索配置
    search:
      defaultLimit: 5
      minScore: 0.6
      enableMMR: true
      mmrLambda: 0.7
```

#### 2.2.4 性能优化

1. **批量插入**
   ```typescript
   async addBatch(entries: MemoryEntry[]): Promise<string[]>
   ```

2. **向量维度自适应**
   ```typescript
   function vectorDimsForModel(model: string): number {
     switch (model) {
       case "text-embedding-3-small": return 1536;
       case "text-embedding-3-large": return 3072;
       case "text-embedding-ada-002": return 1536;
       default: return 1536;
     }
   }
   ```

3. **索引预热**
   - 启动时加载常用向量到内存
   - 定期重建索引优化查询性能

---

### 2.3 memory-wiki - Wiki 知识库

**位置**: `extensions/memory-wiki/`

#### 2.3.1 主要功能

memory-wiki 提供**结构化知识库**管理能力：

1. **Obsidian 兼容**
   - 标准 Markdown 格式
   - 双向链接支持 `[[Page Name]]`
   - Frontmatter 元数据
   - 标签系统 `#tag`

2. **知识编译**
   - Markdown 编译为内部表示
   - 链接解析和验证
   - 冲突检测和解决

3. **智能检索**
   - 全文搜索
   - 标签过滤
   - 链接图遍历
   - 相关性排序

4. **质量保障**
   - Lint 检查（断链、格式问题）
   - 自动化修复建议
   - 健康度报告

#### 2.3.2 核心模块

##### **WikiCompiler** (`src/compile.ts`)

编译 Markdown 文件为内部表示：

```typescript
interface WikiPage {
  slug: string;              // URL 友好的标识符
  title: string;             // 页面标题
  content: string;           // 正文内容
  frontmatter: Record<string, any>; // 元数据
  links: WikiLink[];         // 出向链接
  backlinks: string[];       // 入向链接（反向引用）
  tags: string[];            // 标签列表
  wordCount: number;         // 字数统计
  lastModified: number;      // 最后修改时间
}

interface WikiLink {
  target: string;    // 目标页面 slug
  anchor?: string;   // 锚点
  text: string;      // 链接文本
  exists: boolean;   // 目标是否存在
}
```

编译流程：
1. 解析 Frontmatter
2. 提取标题
3. 解析 Markdown AST
4. 提取链接和标签
5. 计算统计数据
6. 验证完整性

##### **WikiQueryEngine** (`src/query.ts`)

强大的查询引擎：

```typescript
interface WikiQuery {
  text?: string;           // 全文搜索
  tags?: string[];         // 标签过滤
  linksTo?: string;        // 链接到某页
  linkedFrom?: string;     // 被某页链接
  modifiedAfter?: number;  // 时间过滤
  minWordCount?: number;   // 最小字数
  limit?: number;          // 结果限制
  sortBy?: "relevance" | "modified" | "title";
}

class WikiQueryEngine {
  async search(query: WikiQuery): Promise<WikiSearchResult[]>
  async getPage(slug: string): Promise<WikiPage | null>
  async getBacklinks(slug: string): Promise<WikiPage[]>
  async getTags(): Promise<Map<string, number>>
}
```

**搜索算法**：
- TF-IDF 评分
- BM25 排名
- 标签匹配加分
- 链接强度加权

##### **WikiBridge** (`src/bridge.ts`)

与 Agent 系统的桥接层：

```typescript
// 为 Agent 提供记忆上下文
function buildWikiPromptSection(
  context: AgentContext,
  config: WikiConfig
): PromptSection {
  // 基于当前对话提取关键词
  const keywords = extractKeywords(context.recentMessages);
  
  // 搜索相关页面
  const pages = await queryEngine.search({
    text: keywords.join(" "),
    limit: 5,
  });
  
  // 构建提示词片段
  return formatWikiContext(pages);
}
```

##### **WikiLint** (`src/lint.ts`)

知识库质量检查：

```typescript
interface LintIssue {
  severity: "error" | "warning" | "info";
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
}

class WikiLinter {
  async lint(): Promise<LintIssue[]> {
    // 检查项：
    // - 断裂的双向链接
    // - 缺失的 Frontmatter
    // - 过长的页面
    // - 孤立的页面（无链接）
    // - 重复的标签
    // - 格式不一致
  }
}
```

#### 2.3.3 CLI 工具

```bash
# 初始化 Wiki 知识库
openclaw wiki init

# 查看状态
openclaw wiki status

# 质量检查
openclaw wiki lint

# 应用修复建议
openclaw wiki apply --fix broken-links

# 搜索
openclaw wiki search "API design"

# 获取特定页面
openclaw wiki get api-guidelines

# 导入 Obsidian vault
openclaw wiki import-obsidian ~/Obsidian/Vault
```

#### 2.3.4 工具注册

1. **wiki_search**
   ```typescript
   {
     name: "wiki_search",
     description: "Search the knowledge wiki",
     parameters: {
       query: string,
       tags?: string[],
       limit?: number,
     }
   }
   ```

2. **wiki_get**
   ```typescript
   {
     name: "wiki_get",
     description: "Get a specific wiki page",
     parameters: {
       slug: string,
     }
   }
   ```

3. **wiki_status**
   ```typescript
   {
     name: "wiki_status",
     description: "Get wiki health and statistics",
     parameters: {}
   }
   ```

4. **wiki_lint**
   ```typescript
   {
     name: "wiki_lint",
     description: "Run quality checks on wiki",
     parameters: {
       fix?: boolean,
     }
   }
   ```

5. **wiki_apply**
   ```typescript
   {
     name: "wiki_apply",
     description: "Apply suggested fixes from lint",
     parameters: {
       issues: string[],
     }
   }
   ```

#### 2.3.5 配置示例

```yaml
memory:
  wiki:
    enabled: true
    vaultPath: "~/.openclaw/wiki"
    
    # 编译配置
    compile:
      autoCompile: true
      watchChanges: true
      validateLinks: true
    
    # 搜索配置
    search:
      defaultLimit: 5
      minRelevanceScore: 0.6
      enableTagBoost: true
      tagBoostFactor: 1.3
    
    # 提示词集成
    prompt:
      enabled: true
      maxPages: 3
      includeBacklinks: true
      showWordCount: false
    
    # Obsidian 兼容性
    obsidian:
      compatible: true
      syncInterval: 300  # 秒
      respectGitignore: true
```

---

### 2.4 active-memory - 主动记忆系统

**位置**: `extensions/active-memory/`

#### 2.4.1 主要功能

active-memory 提供**实时会话增强**：

1. **智能上下文注入**
   - 基于当前对话动态检索相关记忆
   - 自动决定何时需要回忆
   - 避免不必要的 API 调用

2. **查询扩展**
   - 从最近消息中提取关键词
   - 生成优化的搜索查询
   - 支持多轮对话理解

3. **性能优化**
   - 多级缓存策略
   - 超时控制
   - 并发请求管理

4. **QMD 集成**
   - 支持复杂的查询语法
   - 继承全局 QMD 配置
   - 灵活的搜索模式

#### 2.4.2 核心架构

##### **ActiveRecallEngine** (`index.ts`)

```typescript
class ActiveRecallEngine {
  private cache: LRUCache<string, RecallResult>;
  private readonly config: ResolvedActiveRecallPluginConfig;
  
  async recallOnMessage(ctx: MessageContext): Promise<RecallResult> {
    // 1. 检查是否应该触发回忆
    if (!this.shouldRecall(ctx)) {
      return NO_RECALL;
    }
    
    // 2. 构建查询
    const query = this.buildQuery(ctx);
    
    // 3. 检查缓存
    const cached = this.cache.get(query.hash);
    if (cached && !cached.expired) {
      return cached;
    }
    
    // 4. 执行搜索（带超时）
    const result = await this.executeSearchWithTimeout(query);
    
    // 5. 缓存结果
    this.cache.set(query.hash, result);
    
    return result;
  }
}
```

##### **查询构建策略**

支持三种查询模式：

1. **Message Mode** - 仅使用当前消息
   ```typescript
   query = ctx.currentMessage.content
   ```

2. **Recent Mode** - 使用最近的对话历史
   ```typescript
   query = combine([
     ...ctx.recentUserMessages.slice(-2),
     ...ctx.recentAssistantMessages.slice(-1)
   ])
   ```

3. **Full Mode** - 使用完整会话上下文
   ```typescript
   query = ctx.fullConversationSummary
   ```

##### **提示词风格**

不同的提示词策略影响回忆行为：

```typescript
type PromptStyle = 
  | "balanced"        // 平衡相关性和精确性
  | "strict"          // 高阈值，只返回高度相关
  | "contextual"      // 重视上下文连贯性
  | "recall-heavy"    // 倾向于返回更多记忆
  | "precision-heavy" // 宁可少返也不误返
  | "preference-only";// 只返回用户偏好类记忆
```

**Balanced 风格示例**：
```markdown
Based on our conversation, I found some potentially relevant information:

📝 **From previous discussions:**
- You mentioned preferring TypeScript for backend development
- We discussed API design patterns last week

Would you like me to consider these in my response?
```

##### **缓存系统**

```typescript
interface RecallCache {
  key: string;           // 查询哈希
  result: RecallResult;  // 搜索结果
  timestamp: number;     // 缓存时间
  ttl: number;          // 存活时间 (默认 15s)
}

// 缓存清理
setInterval(() => {
  cache.sweep();  // 移除过期条目
}, CACHE_SWEEP_INTERVAL_MS);
```

##### **超时和降级**

```typescript
async executeSearchWithTimeout(query: Query): Promise<RecallResult> {
  const timeout = this.config.timeoutMs || DEFAULT_TIMEOUT_MS;
  
  try {
    return await Promise.race([
      this.performSearch(query),
      new Promise((_, reject) => 
        setTimeout(() => reject(new TimeoutError()), timeout)
      )
    ]);
  } catch (error) {
    if (error instanceof TimeoutError) {
      log.warn(`Memory search timed out after ${timeout}ms`);
      return NO_RECALL;
    }
    
    // 尝试备用模型
    if (this.config.modelFallback) {
      return this.executeWithFallback(query);
    }
    
    throw error;
  }
}
```

#### 2.4.3 转录持久化

可选的转录保存功能：

```typescript
if (config.persistTranscripts) {
  const transcriptDir = path.join(
    tmpDir,
    config.transcriptDir || "active-memory"
  );
  
  await fs.writeFile(
    path.join(transcriptDir, `${sessionId}-${timestamp}.json`),
    JSON.stringify({
      query,
      results,
      context: recentMessages,
      timestamp,
    })
  );
}
```

用于调试和分析回忆质量。

#### 2.4.4 配置示例

```yaml
plugins:
  active-memory:
    enabled: true
    
    # 启用的 Agent
    agents: ["main", "coder", "analyst"]
    
    # 模型配置
    model: "anthropic/claude-3-sonnet"
    modelFallback: "openai/gpt-4-turbo"
    modelFallbackPolicy: "default-remote"
    
    # 查询配置
    queryMode: "recent"  # message | recent | full
    recentUserTurns: 2
    recentAssistantTurns: 1
    recentUserChars: 220
    recentAssistantChars: 180
    
    # 提示词配置
    promptStyle: "balanced"
    maxSummaryChars: 220
    
    # 性能配置
    timeoutMs: 15000
    cacheTtlMs: 15000
    logging: false
    
    # QMD 配置
    qmd:
      searchMode: "inherit"  # inherit | search | vsearch | query
    
    # 转录配置
    persistTranscripts: false
    transcriptDir: "active-memory"
```

#### 2.4.5 会话级控制

通过 session store 实现细粒度控制：

```typescript
// 切换某个会话的主动回忆
await updateSessionStore(sessionKey, {
  activeMemoryEnabled: false,  // 禁用
});

// 查询状态
const state = await resolveSessionStoreEntry(sessionKey);
console.log(state.activeMemoryEnabled);
```

---

## 3. 基础设施层

### 3.1 memory-host-sdk

**位置**: `packages/memory-host-sdk/`

#### 3.1.1 主要功能

memory-host-sdk 提供**主机级别的记忆引擎接口**，供其他扩展和运行时使用：

1. **嵌入提供商接口**
2. **批量处理引擎**
3. **QMD 查询解析器**
4. **会话文件管理**
5. **多模态支持**

#### 3.1.2 核心模块

##### **嵌入引擎** (`src/host/embeddings.ts`)

统一的嵌入生成接口：

```typescript
interface EmbeddingEngine {
  embed(
    texts: string[],
    options?: EmbeddingOptions
  ): Promise<EmbeddingResult>;
  
  getProviderInfo(): ProviderInfo;
  validateModel(model: string): boolean;
}

interface EmbeddingOptions {
  model?: string;
  dimensions?: number;
  batchSize?: number;
  timeoutMs?: number;
}

interface EmbeddingResult {
  vectors: number[][];
  usage: {
    totalTokens: number;
    model: string;
  };
  warnings?: string[];
}
```

##### **批量处理** (`src/host/batch-*.ts`)

高效的批量嵌入生成：

```typescript
class BatchEmbeddingRunner {
  async runBatch(
    texts: string[],
    options: BatchOptions
  ): Promise<BatchResult> {
    // 1. 分块处理（避免超出 API 限制）
    const chunks = this.chunkTexts(texts, options.maxBatchSize);
    
    // 2. 并发执行
    const results = await Promise.allSettled(
      chunks.map(chunk => this.embedChunk(chunk))
    );
    
    // 3. 错误处理和重试
    const failed = this.handleFailures(results);
    if (failed.length > 0) {
      await this.retryFailed(failed, options.maxRetries);
    }
    
    // 4. 合并结果
    return this.mergeResults(results);
  }
}
```

**批量 HTTP 优化**：
```typescript
// 使用 HTTP keep-alive 和连接池
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  maxFreeSockets: 5,
});
```

##### **QMD 查询解析器** (`src/host/qmd-*.ts`)

Query Memory Database 语法解析：

```typescript
interface QMDQuery {
  mode: "search" | "vsearch" | "query";
  text: string;
  filters?: {
    categories?: string[];
    dateRange?: { after?: number; before?: number };
    tags?: string[];
    minScore?: number;
  };
  operators?: {
    AND?: string[];
    OR?: string[];
    NOT?: string[];
  };
}

class QMDQueryParser {
  parse(queryString: string): QMDQuery {
    // 解析语法：
    // search:text filter:category=tech after:2024-01-01
    // vsearch:semantic query AND filter:tags=[important,review]
  }
  
  expandQuery(query: QMDQuery): ExpandedQuery {
    // 查询扩展：
    // - 同义词扩展
    // - 拼写纠正
    // - 短语检测
  }
}
```

**查询扩展示例**：
```typescript
// 输入
"API design best practices"

// 扩展后
{
  original: "API design best practices",
  expanded: [
    "API design best practices",
    "RESTful API design patterns",
    "API architecture guidelines",
    "web service design principles"
  ]
}
```

##### **会话文件管理** (`src/host/session-files.ts`)

管理会话文件的读取和监控：

```typescript
interface SessionFileManager {
  listSessions(agentId: string): Promise<SessionInfo[]>;
  readSession(sessionPath: string): Promise<SessionContent>;
  watchSessions(
    agentId: string,
    callback: (event: FileEvent) => void
  ): Watcher;
}

interface SessionContent {
  messages: Message[];
  metadata: SessionMetadata;
  attachments?: Attachment[];
}
```

##### **多模态支持** (`src/host/multimodal.ts`)

处理包含图像的会话：

```typescript
interface MultimodalProcessor {
  extractTextFromImage(image: Buffer): Promise<string>;
  generateImageDescription(image: Buffer): Promise<string>;
  createMultimodalEmbedding(
    text: string,
    images: Buffer[]
  ): Promise<number[]>;
}
```

#### 3.1.3 类型定义

##### **记忆 Schema** (`src/host/memory-schema.ts`)

```typescript
interface MemoryRecord {
  id: string;
  content: string;
  embedding?: number[];
  metadata: {
    source: "session" | "manual" | "import";
    sessionId?: string;
    agentId?: string;
    timestamp: number;
    category?: string;
    tags?: string[];
    importance?: number;
  };
  vectorStore?: {
    provider: "sqlite-vec" | "lancedb";
    indexId?: string;
  };
}

interface MemorySearchRequest {
  query: string;
  filters?: MemoryFilters;
  options?: SearchOptions;
}

interface MemorySearchResponse {
  results: MemorySearchResult[];
  metrics: {
    totalCandidates: number;
    searchDurationMs: number;
    vectorSearchMs?: number;
    ftsSearchMs?: number;
  };
}
```

#### 3.1.4 秘密管理

安全的 API 密钥处理：

```typescript
import { SecretInput } from "./secret-input";

// 安全地处理敏感信息
const apiKey = await SecretInput.prompt("Enter OpenAI API key");
const embeddings = await engine.embed(texts, { apiKey });

// API 密钥不会出现在日志或错误消息中
```

---

## 4. 数据流和架构

### 4.1 记忆捕获流程

```
┌─────────────┐
│ User Message │
└──────┬──────┘
       │
       ▼
┌──────────────────┐
│  Agent Processes  │
└──────┬───────────┘
       │
       ▼
┌──────────────────────┐
│ Lifecycle Hook Fires  │
│ (onMessageComplete)   │
└──────┬───────────────┘
       │
       ├─────────────────────────┐
       │                         │
       ▼                         ▼
┌──────────────┐      ┌─────────────────┐
│ Assess       │      │ Check Config     │
│ Importance   │      │ (enabled/cats)   │
└──────┬───────┘      └────────┬────────┘
       │                       │
       │  Score > Threshold    │
       ▼                       ▼
┌──────────────────────────────────┐
│   Generate Embedding             │
│   (via EmbeddingProvider)        │
└──────┬───────────────────────────┘
       │
       ▼
┌──────────────────────┐
│ Classify Category     │
│ (ML rule-based)       │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────────┐
│ Store in Memory Backend  │
│ (Core/LanceDB/Wiki)      │
└──────┬───────────────────┘
       │
       ▼
┌──────────────────────┐
│ Update Index          │
│ (Vector + FTS)        │
└──────────────────────┘
```

### 4.2 记忆检索流程

```
┌──────────────────┐
│ Agent Needs Info  │
└──────┬───────────┘
       │
       ▼
┌──────────────────────┐
│ Build Search Query    │
│ (from context/QMD)    │
└──────┬───────────────┘
       │
       ├──────────────┬──────────────┐
       │              │              │
       ▼              ▼              ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│ Vector   │  │ FTS      │  │ Wiki     │
│ Search   │  │ Search   │  │ Query    │
└────┬─────┘  └────┬─────┘  └────┬─────┘
     │             │              │
     │             │              │
     ▼             ▼              ▼
┌──────────────────────────────────────┐
│    Merge & Rank Results              │
│    - Apply temporal decay            │
│    - MMR deduplication               │
│    - Category boosting               │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────┐
│ Format for Prompt     │
│ (buildPromptSection)  │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ Inject into Context   │
│ (Agent receives)      │
└──────────────────────┘
```

### 4.3 同步流程

```
┌────────────────────┐
│ File System Watcher │
│ (chokidar)          │
└──────┬─────────────┘
       │
       │ File Changed
       ▼
┌──────────────────────┐
│ Debounce Timer        │
│ (avoid rapid updates) │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ Parse New Content     │
│ (extract messages)    │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ Check Cache           │
│ (embedding already    │
│  computed?)           │
└──────┬───────────────┘
       │
       ├──── Hit ──────► Use Cached
       │
       │ Miss
       ▼
┌──────────────────────┐
│ Generate Embedding    │
│ (batch if possible)   │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ Update SQLite DB      │
│ - Insert chunks       │
│ - Update FTS index    │
│ - Update vector index │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ Invalidate Cache      │
│ (search results)      │
└──────────────────────┘
```

---

## 5. 关键算法和技术

### 5.1 混合检索算法

#### BM25 评分

```typescript
function bm25Score(
  termFrequency: number,
  docLength: number,
  avgDocLength: number,
  numDocs: number,
  numDocsWithTerm: number,
  k1: number = 1.2,
  b: number = 0.75
): number {
  const idf = Math.log((numDocs - numDocsWithTerm + 0.5) / (numDocsWithTerm + 0.5));
  const tf = (termFrequency * (k1 + 1)) / (termFrequency + k1 * (1 - b + b * (docLength / avgDocLength)));
  return idf * tf;
}
```

#### 向量相似度

```typescript
function cosineSimilarity(a: number[], b: number[]): number {
  const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (normA * normB);
}
```

#### 结果融合

```typescript
function mergeHybridResults(
  vectorResults: Array<{ id: string; score: number }>,
  ftsResults: Array<{ id: string; score: number }>,
  weights: { vector: number; fts: number }
): Array<{ id: string; combinedScore: number }> {
  const allIds = new Set([...vectorResults.map(r => r.id), ...ftsResults.map(r => r.id)]);
  
  return Array.from(allIds).map(id => {
    const vecScore = vectorResults.find(r => r.id === id)?.score || 0;
    const ftsScore = ftsResults.find(r => r.id === id)?.score || 0;
    
    return {
      id,
      combinedScore: weights.vector * vecScore + weights.fts * ftsScore
    };
  }).sort((a, b) => b.combinedScore - a.combinedScore);
}
```

### 5.2 MMR (Maximal Marginal Relevance)

```typescript
function mmrSelect(
  candidates: SearchResult[],
  queryVector: number[],
  lambda: number,
  k: number
): SearchResult[] {
  const selected: SearchResult[] = [];
  const remaining = [...candidates];
  
  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    
    for (let i = 0; i < remaining.length; i++) {
      // 相关性得分
      const relevance = cosineSimilarity(queryVector, remaining[i].vector);
      
      // 多样性得分（与已选项目的最大相似度）
      let maxSimilarity = 0;
      for (const sel of selected) {
        const sim = cosineSimilarity(remaining[i].vector, sel.vector);
        maxSimilarity = Math.max(maxSimilarity, sim);
      }
      
      // MMR 分数
      const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity;
      
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }
    
    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }
  
  return selected;
}
```

### 5.3 时间衰减

```typescript
function applyTemporalDecay(
  score: number,
  timestamp: number,
  now: number,
  halfLifeMs: number = 7 * 24 * 60 * 60 * 1000  // 7 days
): number {
  const ageMs = now - timestamp;
  const decayFactor = Math.exp(-Math.LN2 * ageMs / halfLifeMs);
  return score * decayFactor;
}

// 示例：
// - 刚创建的记忆：decay = 1.0
// - 7天前的记忆：decay = 0.5
// - 14天前的记忆：decay = 0.25
```

### 5.4 嵌入缓存策略

```typescript
class EmbeddingCache {
  private cache: Map<string, CachedEntry>;
  
  getOrCreate(text: string, provider: string): number[] {
    const key = this.computeKey(text, provider);
    
    if (this.cache.has(key)) {
      const entry = this.cache.get(key)!;
      if (!this.isExpired(entry)) {
        return entry.vector;
      }
    }
    
    const vector = this.computeEmbedding(text, provider);
    this.cache.set(key, {
      vector,
      timestamp: Date.now(),
      accessCount: 0
    });
    
    return vector;
  }
  
  private computeKey(text: string, provider: string): string {
    return crypto.createHash('sha256')
      .update(`${provider}:${text}`)
      .digest('hex');
  }
  
  prune(maxEntries: number): void {
    if (this.cache.size <= maxEntries) return;
    
    // LRU 策略：移除最少访问的条目
    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].accessCount - b[1].accessCount);
    
    const toRemove = entries.slice(0, this.cache.size - maxEntries);
    toRemove.forEach(([key]) => this.cache.delete(key));
  }
}
```

---

## 6. 配置和使用

### 6.1 完整配置示例

```yaml
# ~/.openclaw/openclaw.yaml

agents:
  defaults:
    # 全局记忆配置
    memory:
      # Core 记忆
      core:
        enabled: true
        provider: "openai"
        model: "text-embedding-3-small"
        
        # 同步配置
        sync:
          enabled: true
          interval: 60  # 秒
          batchSize: 10
        
        # 搜索配置
        search:
          defaultLimit: 5
          minScore: 0.6
          enableHybrid: true
          hybridWeights:
            vector: 0.7
            fts: 0.3
          
          # 时间衰减
          temporalDecay:
            enabled: true
            halfLifeDays: 7
          
          # MMR 去重
          mmr:
            enabled: true
            lambda: 0.7
      
      # LanceDB 后端
      lancedb:
        enabled: false  # 默认禁用
        path: "~/.openclaw/memory/lancedb"
        
        # 自动捕获
        capture:
          enabled: true
          minImportance: 0.7
          maxChars: 2000
      
      # Wiki 知识库
      wiki:
        enabled: true
        vaultPath: "~/.openclaw/wiki"
        
        compile:
          autoCompile: true
          watchChanges: true
        
        search:
          defaultLimit: 3
          minRelevanceScore: 0.6

# 插件配置
plugins:
  # 主动记忆
  active-memory:
    enabled: true
    agents: ["main"]
    model: "anthropic/claude-3-sonnet"
    queryMode: "recent"
    promptStyle: "balanced"
    timeoutMs: 15000
    cacheTtlMs: 15000
```

### 6.2 使用示例

#### 手动搜索记忆

```bash
# 基本搜索
openclaw memory search "API design patterns"

# 带过滤
openclaw memory search "database optimization" \
  --category technical \
  --after 2024-01-01 \
  --limit 10

# 向量搜索
openclaw memory vsearch "how to improve system performance"

# QMD 查询
openclaw memory query "search:TypeScript filter:category=programming after:2024-01-01"
```

#### Wiki 管理

```bash
# 初始化
openclaw wiki init

# 查看状态
openclaw wiki status

# 质量检查
openclaw wiki lint

# 搜索
openclaw wiki search "authentication best practices"

# 获取页面
openclaw wiki get security-guidelines
```

#### 程序化使用

```typescript
import { getMemorySearchTool } from "openclaw/plugin-sdk";

// 在 Agent 中使用
const memorySearch = getMemorySearchTool({
  config,
  agentSessionKey: sessionKey,
});

const results = await memorySearch.execute({
  query: "previous API design decisions",
  limit: 5,
});

console.log(results);
// [
//   {
//     id: "mem_123",
//     content: "We decided to use REST over GraphQL...",
//     score: 0.89,
//     category: "technical",
//     timestamp: 1705334400000
//   }
// ]
```

---

## 7. 扩展开发指南

### 7.1 创建自定义嵌入提供商

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk";
import { registerEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";

export default definePluginEntry({
  id: "my-embedding-provider",
  name: "My Custom Embeddings",
  kind: "memory",
  
  register(api) {
    registerEmbeddingProvider(api, {
      id: "my-provider",
      name: "My Provider",
      
      async embed(texts: string[], options: EmbeddingOptions): Promise<number[][]> {
        // 调用你的嵌入 API
        const response = await fetch("https://api.my-provider.com/embed", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: options.model || "default-model",
            texts,
          }),
        });
        
        const data = await response.json();
        return data.embeddings;
      },
      
      getDimensions(model: string): number {
        return 768;  // 你的模型维度
      },
      
      isAvailable(): boolean {
        // 检查 API 密钥等
        return !!process.env.MY_PROVIDER_API_KEY;
      },
    });
  },
});
```

### 7.2 创建自定义记忆后端

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk";

export default definePluginEntry({
  id: "my-memory-backend",
  name: "My Memory Backend",
  kind: "memory",
  
  register(api) {
    // 注册记忆存储接口
    api.registerMemoryBackend({
      id: "my-backend",
      name: "My Backend",
      
      async initialize(config: BackendConfig): Promise<void> {
        // 初始化连接
      },
      
      async store(entry: MemoryEntry): Promise<string> {
        // 存储记忆
        return entry.id;
      },
      
      async search(query: SearchQuery): Promise<SearchResult[]> {
        // 执行搜索
        return [];
      },
      
      async delete(id: string): Promise<void> {
        // 删除记忆
      },
      
      async close(): Promise<void> {
        // 清理资源
      },
    });
  },
});
```

### 7.3 注册记忆工具

```typescript
api.registerTool(
  (ctx) => ({
    name: "my_memory_tool",
    description: "Custom memory operation",
    parameters: {
      query: { type: "string" },
    },
    
    async execute(params: { query: string }) {
      // 你的逻辑
      const results = await customSearch(params.query);
      
      return {
        content: formatResults(results),
      };
    },
  }),
  { name: "my_memory_tool" }
);
```

### 7.4 最佳实践

1. **错误处理**
   ```typescript
   try {
     await operation();
   } catch (error) {
     if (isTransientError(error)) {
       await retryWithBackoff();
     } else {
       log.error(`Memory operation failed: ${error.message}`);
       throw error;
     }
   }
   ```

2. **资源管理**
   ```typescript
   // 始终在插件卸载时清理
   api.onDispose(async () => {
     await manager.close();
     await watcher.close();
   });
   ```

3. **性能优化**
   - 使用批量操作减少 API 调用
   - 实现缓存避免重复计算
   - 异步处理非关键路径
   
4. **安全性**
   - 使用 SecretInput 处理 API 密钥
   - 验证用户输入防止注入
   - 限制文件大小和数量

---

## 附录

### A. 相关文件清单

#### memory-core
```
extensions/memory-core/
├── index.ts                    # 插件入口
├── src/
│   ├── cli.ts                  # CLI 命令注册
│   ├── cli.runtime.ts          # CLI 运行时
│   ├── tools.ts                # 工具定义
│   ├── prompt-section.ts       # 提示词构建
│   ├── flushing.ts             # 内存刷新
│   ├── dreaming.ts             # 梦境记忆（实验性）
│   └── memory/
│       ├── manager.ts          # 核心管理器
│       ├── embeddings.ts       # 嵌入提供商
│       ├── hybrid.ts           # 混合检索
│       ├── mmr.ts              # MMR 去重
│       ├── temporal-decay.ts   # 时间衰减
│       ├── qmd-manager.ts      # QMD 查询
│       └── ...                 # 其他辅助模块
```

#### memory-lancedb
```
extensions/memory-lancedb/
├── index.ts                    # 插件入口
├── config.ts                   # 配置定义
├── lancedb-runtime.ts          # LanceDB 运行时
└── ...
```

#### memory-wiki
```
extensions/memory-wiki/
├── index.ts                    # 插件入口
├── src/
│   ├── cli.ts                  # CLI 命令
│   ├── compile.ts              # Wiki 编译器
│   ├── query.ts                # 查询引擎
│   ├── bridge.ts               # Agent 桥接
│   ├── lint.ts                 # 质量检查
│   └── tool.ts                 # 工具定义
```

#### active-memory
```
extensions/active-memory/
└── index.ts                    # 主实现（单文件）
```

#### memory-host-sdk
```
packages/memory-host-sdk/
└── src/
    ├── host/
    │   ├── embeddings.ts       # 嵌入引擎
    │   ├── batch-*.ts          # 批量处理
    │   ├── qmd-*.ts            # QMD 解析
    │   ├── session-files.ts    # 会话文件
    │   └── memory-schema.ts    # 类型定义
    └── ...
```

### B. 常见问题

**Q: 如何选择合适的嵌入模型？**

A: 考虑因素：
- **精度**：text-embedding-3-large > 3-small > ada-002
- **成本**：3-small 性价比最高
- **速度**：本地模型（Ollama）最快
- **隐私**：本地模型数据不出境

**Q: 记忆系统会影响性能吗？**

A: 优化措施：
- 嵌入缓存减少重复计算
- 异步同步不阻塞主流程
- 批量处理降低 API 调用次数
- 可配置的超时和降级

**Q: 如何调试记忆问题？**

A: 启用日志：
```yaml
plugins:
  active-memory:
    logging: true
```

查看转录：
```bash
openclaw memory inspect
ls ~/.openclaw/tmp/active-memory/
```

**Q: 可以迁移现有记忆吗？**

A: 支持导入：
```bash
# 从 Obsidian
openclaw wiki import-obsidian ~/Vault

# 从 ChatGPT
openclaw wiki import-chatgpt export.json

# 手动添加
openclaw memory add --file notes.md
```

### C. 性能基准

| 操作 | 平均耗时 | 备注 |
|------|---------|------|
| 单次嵌入 (OpenAI) | 200-500ms | 取决于文本长度 |
| 批量嵌入 (10条) | 1-2s | 并行处理 |
| 向量搜索 | 10-50ms | 10K 条记忆 |
| FTS 搜索 | 5-20ms | 10K 条记忆 |
| 混合搜索 | 20-80ms | 含融合排序 |
| 会话同步 | 100-500ms | 增量更新 |
| 完全重新索引 | 分钟级 | 取决于记忆数量 |

### D. 未来规划

1. **图神经网络** - 基于知识图谱的关系推理
2. **增量学习** - 在线更新嵌入模型
3. **联邦记忆** - 跨设备同步
4. **多模态记忆** - 图像、音频嵌入
5. **主动遗忘** - 基于重要性的自动清理
6. **记忆压缩** - 摘要和去冗余

---

## 总结

OpenClaw 的记忆系统是一个**功能强大、灵活可扩展**的长期记忆解决方案，通过多层架构和多种后端支持，为 AI Agent 提供了类似人类的记忆能力。系统设计的核心优势包括：

✅ **混合检索** - 结合语义和关键词搜索的优势  
✅ **智能管理** - 自动捕获、索引、同步  
✅ **高性能** - 缓存、批处理、异步优化  
✅ **可扩展** - 插件化架构，易于定制  
✅ **生产就绪** - 完善的错误处理和监控  

通过合理使用记忆系统，Agent 能够：
- 记住用户偏好和历史决策
- 跨会话保持上下文连贯
- 快速检索相关知识
- 提供个性化的交互体验

---

*文档版本: 1.0*  
*最后更新: 2026-05-07*  
*维护者: OpenClaw Team*
