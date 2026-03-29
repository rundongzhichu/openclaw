/**
 * @fileoverview 网关配置类型定义
 * 
 * 本文件定义了 OpenClaw Gateway 的所有配置类型，包括：
 * - 网络绑定配置 (bind, TLS)
 * - 服务发现配置 (mDNS, Wide Area)
 * - Control UI 配置
 * - Canvas/Talk 等扩展功能配置
 * - Tailscale 暴露配置
 * - 认证配置
 * - HTTP 端点配置 (Chat Completions, Responses API)
 * - 推送通知配置 (APNs)
 * - 节点和工具访问控制
 * 
 * **设计原则**:
 * - 所有字段都是可选的 (`?`)，通过默认值填充保证运行时完整性
 * - 使用 `SecretInput` 包装敏感字段，支持多种密钥来源（明文、环境变量、密钥管理器）
 * - 支持渐进式配置，最小配置即可启动
 * 
 * **使用示例**:
 * ```json
 * {
 *   "gateway": {
 *     "port": 18789,
 *     "bind": "loopback",
 *     "tls": { "enabled": true, "autoGenerate": true },
 *     "auth": { "mode": "token", "token": { "source": "env", "id": "GATEWAY_TOKEN" } }
 *   }
 * }
 * ```
 * 
 * @module config/types.gateway
 */

import type { SecretInput } from "./types.secrets.js";

/**
 * 网关绑定模式类型
 * 
 * 控制 Gateway WebSocket/HTTP 服务器的网络绑定策略，决定哪些网络接口可以访问网关服务。
 * 
 * **各模式详解**:
 * - `"auto"`: 自动选择（优先 loopback 127.0.0.1，失败则回退到 0.0.0.0）
 * - `"lan"`: 绑定到 `0.0.0.0`（所有网络接口，局域网可访问）
 * - `"loopback"`: 仅绑定到 `127.0.0.1`（最安全，仅本地访问）
 * - `"custom"`: 使用 `customBindHost` 指定的自定义 IP 地址
 * - `"tailnet"`: 仅绑定到 Tailscale IPv4 地址 (100.64.0.0/10 网段)
 * 
 * **安全建议**:
 * - 开发环境：使用 `"loopback"` 或 `"auto"`
 * - 生产环境：配合反向代理使用 `"loopback"`，或直接使用 `"tailnet"` 进行安全远程访问
 * - 避免在生产环境直接使用 `"lan"`，除非有额外的网络安全措施
 * 
 * @example
 * // 在 config.json 中使用：
 * {
 *   "gateway": {
 *     "bind": "loopback"  // 仅本地访问，最安全
 *   }
 * }
 * 
 * @example
 * // 使用 Tailscale 进行安全远程访问：
 * {
 *   "gateway": {
 *     "bind": "tailnet",
 *     "tailscale": { "mode": "serve" }
 *   }
 * }
 */
export type GatewayBindMode = "auto" | "lan" | "loopback" | "custom" | "tailnet";

/**
 * TLS 配置接口
 * 
 * 为 Gateway 启用 HTTPS/WSS 加密连接，保护传输数据安全。
 * 支持自签名证书自动生成或指定现有证书文件。
 * 
 * **工作原理**:
 * 1. 当 `enabled: true` 时，Gateway 会尝试加载证书
 * 2. 如果 `autoGenerate: true` 且证书不存在，自动生成自签名证书
 * 3. 如果指定了 `certPath` 和 `keyPath`，使用提供的证书
 * 4. `caPath` 用于 mTLS（双向认证）或自定义根证书验证
 * 
 * **证书管理建议**:
 * - 开发环境：使用 `autoGenerate: true` 快速启动
 * - 生产环境：使用正式的 CA 证书（Let's Encrypt 等）
 * - 内部部署：可考虑自建 CA 签发证书
 * 
 * @example
 * // 开发环境：自动生成证书
 * const tlsConfig: GatewayTlsConfig = {
 *   enabled: true,
 *   autoGenerate: true,
 * };
 * 
 * @example
 * // 生产环境：使用正式证书
 * const tlsConfig: GatewayTlsConfig = {
 *   enabled: true,
 *   autoGenerate: false,
 *   certPath: "/etc/ssl/openclaw.crt",
 *   keyPath: "/etc/ssl/openclaw.key",
 * };
 * 
 * @example
 * // mTLS 配置（双向认证）
 * const tlsConfig: GatewayTlsConfig = {
 *   enabled: true,
 *   certPath: "/etc/ssl/server.crt",
 *   keyPath: "/etc/ssl/server.key",
 *   caPath: "/etc/ssl/ca-bundle.crt",  // 验证客户端证书
 * };
 */
export type GatewayTlsConfig = {
  /** 是否启用 TLS 加密（默认：false） */
  enabled?: boolean;
  
  /** 
   * 当缺少证书时是否自动生成自签名证书（默认：true）
   * 
   * 注意：自签名证书会导致浏览器/客户端显示安全警告，
   * 仅适用于开发环境或内部测试。
   */
  autoGenerate?: boolean;
  
  /** 
   * PEM 格式证书路径
   * 
   * 与 `autoGenerate` 互斥，如果同时指定，优先使用此证书。
   * 证书必须是 PEM 格式，可以包含完整的证书链。
   */
  certPath?: string;
  
  /** 
   * PEM 格式私钥路径
   * 
   * 必须与 `certPath` 配对使用。
   * 私钥不应有密码保护，或需在启动时提供密码。
   */
  keyPath?: string;
  
  /** 
   * 可选的 PEM CA 证书包
   * 
   * 用途：
   * - mTLS（双向认证）：验证客户端证书
   * - 自定义根证书：信任内部 CA 签发的证书
   * 
   * 可以包含多个 CA 证书，按顺序验证。
   */
  caPath?: string;
};

/**
 * 广域发现配置
 * 
 * 配置基于 DNS-SD（DNS Service Discovery，RFC 6763）的服务发现机制，
 * 允许在局域网或广域网内自动发现 Gateway 实例。
 * 
 * **工作原理**:
 * 1. Gateway 启动时在指定域名注册 SRV 记录
 * 2. 客户端通过 DNS 查询 `_openclaw._tcp.<domain>` 发现服务
 * 3. 返回服务器地址和端口，客户端自动连接
 * 
 * **适用场景**:
 * - 企业内网多网关部署
 * - 动态 IP 环境（如 DHCP）
 * - 容器化部署（Kubernetes、Docker Swarm）
 * 
 * **DNS 记录示例**:
 * ```
 * _openclaw._tcp.openclaw.internal.  SRV  0 5 18789  gateway-host.openclaw.internal.
 * gateway-host.openclaw.internal.    A    192.168.1.100
 * ```
 * 
 * @example
 * // 配置示例：
 * {
 *   "gateway": {
 *     "discovery": {
 *       "wideArea": {
 *         "enabled": true,
 *         "domain": "openclaw.internal"
 *       }
 *     }
 *   }
 * }
 */
export type WideAreaDiscoveryConfig = {
  /** 是否启用广域发现（默认：false） */
  enabled?: boolean;
  
  /** 
   * 可选的单播 DNS-SD 域名
   * 
   * 示例值：
   * - `"openclaw.internal"` - 内部域名
   * - `"openclaw.example.com"` - 公共域名
   * 
   * 如果不指定，可能使用本地域名或系统默认域名。
   */
  domain?: string;
};

/**
 * mDNS 发现模式类型
 * 
 * 控制 Bonjour/mDNS（Multicast DNS，RFC 6762）广播行为，
 * 用于零配置网络服务发现。
 * 
 * **模式对比**:
 * 
 * | 模式 | TXT 记录内容 | 带宽占用 | 隐私性 | 适用场景 |
 * |------|-------------|---------|--------|----------|
 * | `off` | 无广播 | 无 | 最高 | 安全敏感环境 |
 * | `minimal` | 基本信息（名称、端口） | 低 | 较高 | 默认推荐 |
 * | `full` | 完整信息（含 CLI 路径、SSH 端口） | 中 | 较低 | 开发调试 |
 * 
 * **技术细节**:
 * - mDNS 使用组播地址 `224.0.0.251` (IPv4) 或 `ff02::fb` (IPv6)
 * - 服务类型：`_openclaw._tcp.local`
 * - 广播间隔：通常 1 秒，稳定后降低频率
 * 
 * **安全考虑**:
 * - `full` 模式会暴露更多系统信息，不建议在公共网络使用
 * - 可以通过防火墙规则限制 mDNS 流量
 */
export type MdnsDiscoveryMode = "off" | "minimal" | "full";

/**
 * mDNS 发现配置
 * 
 * 配置本地网络的 Bonjour/mDNS 服务发现行为。
 * 
 * **工作特点**:
 * - 无需配置服务器，自动发现同一局域网内的服务
 * - 适用于家庭网络、小型办公室等环境
 * - macOS、iOS、Linux（Avahi）原生支持
 * - Windows 需要安装 Bonjour 打印服务或其他兼容软件
 * 
 * @example
 * // 配置示例：
 * {
 *   "gateway": {
 *     "discovery": {
 *       "mdns": {
 *         "mode": "full"  // 广播所有服务信息，方便调试
 *       }
 *     }
 *   }
 * }
 * 
 * @example
 * // 安全环境配置：
 * {
 *   "gateway": {
 *     "discovery": {
 *       "mdns": {
 *         "mode": "minimal"  // 仅广播必要信息
 *       }
 *     }
 *   }
 * }
 */
export type MdnsDiscoveryConfig = {
  /** 
   * mDNS/Bonjour 广播模式（默认：minimal）
   * 
   * 选择合适的模式平衡便利性和安全性。
   */
  mode?: MdnsDiscoveryMode;
};

/**
 * 服务发现配置
 * 
 * 组合广域发现（DNS-SD）和本地发现（mDNS）配置，
 * 允许同时启用多种发现机制以适应不同网络环境。
 * 
 * **发现策略建议**:
 * 
 * | 场景 | 推荐配置 |
 * |------|---------|
 * | 单机开发 | 禁用所有发现 |
 * | 家庭网络 | 仅启用 mDNS (`minimal` 模式) |
 * | 企业内网 | 同时启用 mDNS + WideArea |
 * | 云端部署 | 仅启用 WideArea，配合服务网格 |
 * | 混合云 | 根据网络分区灵活配置 |
 * 
 * **故障排查**:
 * - 使用 `dns-sd -B _openclaw._tcp` (macOS) 或 `avahi-browse -a` (Linux) 测试发现
 * - 检查防火墙是否放行 UDP 5353 (mDNS) 端口
 * - 确认路由器是否支持组播转发
 * 
 * @example
 * // 完整配置示例：
 * {
 *   "gateway": {
 *     "discovery": {
 *       "wideArea": {
 *         "enabled": true,
 *         "domain": "openclaw.internal"
 *       },
 *       "mdns": {
 *         "mode": "minimal"
 *       }
 *     }
 *   }
 * }
 */
export type DiscoveryConfig = {
  /** 广域 DNS-SD 配置，适用于跨子网、跨路由器的服务发现 */
  wideArea?: WideAreaDiscoveryConfig;
  
  /** mDNS 配置，适用于同一局域网内的零配置发现 */
  mdns?: MdnsDiscoveryConfig;
};

/**
 * Canvas 主机配置
 * 
 * Canvas 是 OpenClaw 的实时协作画布功能（A2UI - Agent-to-User Interface），
 * 需要独立的 HTTP 服务器来托管前端静态资源和 WebSocket 服务。
 * 
 * **功能特性**:
 * - 托管 Canvas 前端应用（HTML/CSS/JS）
 * - 提供 WebSocket 实时更新通道
 * - 支持多人协作编辑
 * - 集成 AI 助手可视化界面
 * 
 * **架构说明**:
 * ```
 * ┌─────────────┐     HTTP/WebSocket     ┌──────────────┐
 * │   Browser   │ ◄──────────────────►   │ Canvas Host  │
 * └─────────────┘                        │  (port 18793)│
 *                                        └──────────────┘
 *                                               │
 *                                               │ 内部通信
 *                                               ▼
 *                                        ┌──────────────┐
 *                                        │   Gateway    │
 *                                        └──────────────┘
 * ```
 * 
 * **性能优化**:
 * - 启用 `liveReload` 可在开发时自动刷新浏览器
 * - 生产环境建议关闭 `liveReload` 减少资源占用
 * - 可以使用 CDN 或反向代理缓存静态资源
 * 
 * @example
 * // 开发环境配置：
 * {
 *   "canvasHost": {
 *     "enabled": true,
 *     "port": 18793,
 *     "root": "~/.openclaw/workspace/canvas",
 *     "liveReload": true  // 开发模式很有用
 *   }
 * }
 * 
 * @example
 * // 生产环境配置：
 * {
 *   "canvasHost": {
 *     "enabled": true,
 *     "port": 18793,
 *     "root": "/var/www/openclaw/canvas",
 *     "liveReload": false  // 关闭以节省资源
 *   }
 * }
 */
export type CanvasHostConfig = {
  /** 是否启用 Canvas 主机服务（默认：false） */
  enabled?: boolean;
  
  /** 
   * 要服务的静态资源目录
   * 
   * 默认值：`~/.openclaw/workspace/canvas`
   * 
   * 目录结构示例：
   * ```
   * canvas/
   * ├── index.html
   * ├── assets/
   * │   ├── main.js
   * │   └── style.css
   * └── manifest.json
   * ```
   */
  root?: string;
  
  /** 
   * HTTP 监听端口
   * 
   * 默认值：18793
   * 
   * 注意：确保端口未被占用，并在防火墙中开放（如需远程访问）。
   */
  port?: number;
  
  /** 
   * 是否启用实时重载
   * 
   * 功能：
   * - 监听文件系统变化
   * - 通过 WebSocket 通知浏览器刷新
   * - 开发调试非常有用
   * 
   * 默认值：true
   * 
   * 生产环境建议：false（减少资源占用和安全风险）
   */
  liveReload?: boolean;
};

export type TalkProviderConfig = {
  /** Default voice ID for the provider's Talk mode implementation. */
  voiceId?: string;
  /** Optional voice name -> provider voice ID map. */
  voiceAliases?: Record<string, string>;
  /** Default provider model ID for Talk mode. */
  modelId?: string;
  /** Default provider output format (for example pcm_44100). */
  outputFormat?: string;
  /** Provider API key (optional; provider-specific env fallback may apply). */
  apiKey?: SecretInput;
  /** Provider-specific extensions. */
  [key: string]: unknown;
};

export type ResolvedTalkConfig = {
  /** Active Talk TTS provider resolved from the current config payload. */
  provider: string;
  /** Provider config for the active Talk provider. */
  config: TalkProviderConfig;
};

export type TalkConfig = {
  /** Active Talk TTS provider (for example "elevenlabs"). */
  provider?: string;
  /** Provider-specific Talk config keyed by provider id. */
  providers?: Record<string, TalkProviderConfig>;
  /** Stop speaking when user starts talking (default: true). */
  interruptOnSpeech?: boolean;
  /** Milliseconds of user silence before Talk mode sends the transcript after a pause. */
  silenceTimeoutMs?: number;

  /**
   * Legacy ElevenLabs compatibility fields.
   * Kept during rollout while older clients migrate to provider/providers.
   */
  voiceId?: string;
  voiceAliases?: Record<string, string>;
  modelId?: string;
  outputFormat?: string;
  apiKey?: SecretInput;
};

export type TalkConfigResponse = TalkConfig & {
  /** Canonical active Talk payload for clients. */
  resolved?: ResolvedTalkConfig;
};

export type GatewayControlUiConfig = {
  /** If false, the Gateway will not serve the Control UI (default /). */
  enabled?: boolean;
  /** Optional base path prefix for the Control UI (e.g. "/openclaw"). */
  basePath?: string;
  /** Optional filesystem root for Control UI assets (defaults to dist/control-ui). */
  root?: string;
  /** Allowed browser origins for Control UI/WebChat websocket connections. */
  allowedOrigins?: string[];
  /**
   * DANGEROUS: Keep Host-header origin fallback behavior.
   * Supported long-term for deployments that intentionally rely on this policy.
   */
  dangerouslyAllowHostHeaderOriginFallback?: boolean;
  /**
   * Insecure-auth toggle.
   * Control UI still requires secure context + device identity unless
   * dangerouslyDisableDeviceAuth is enabled.
   */
  allowInsecureAuth?: boolean;
  /** DANGEROUS: Disable device identity checks for the Control UI (default: false). */
  dangerouslyDisableDeviceAuth?: boolean;
};

export type GatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";

/**
 * Configuration for trusted reverse proxy authentication.
 * Used when Clawdbot runs behind an identity-aware proxy (Pomerium, Caddy + OAuth, etc.)
 * that handles authentication and passes user identity via headers.
 */
export type GatewayTrustedProxyConfig = {
  /**
   * Header name containing the authenticated user identity (required).
   * Common values: "x-forwarded-user", "x-remote-user", "x-pomerium-claim-email"
   */
  userHeader: string;
  /**
   * Additional headers that MUST be present for the request to be trusted.
   * Use this to verify the request actually came through the proxy.
   * Example: ["x-forwarded-proto", "x-forwarded-host"]
   */
  requiredHeaders?: string[];
  /**
   * Optional allowlist of user identities that can access the gateway.
   * If empty or omitted, all authenticated users from the proxy are allowed.
   * Example: ["nick@example.com", "admin@company.org"]
   */
  allowUsers?: string[];
};

export type GatewayAuthConfig = {
  /** Authentication mode for Gateway connections. Defaults to token when unset. */
  mode?: GatewayAuthMode;
  /** Shared token for token mode (plaintext or SecretRef). */
  token?: SecretInput;
  /** Shared password for password mode (consider env instead). */
  password?: SecretInput;
  /** Allow Tailscale identity headers when serve mode is enabled. */
  allowTailscale?: boolean;
  /** Rate-limit configuration for failed authentication attempts. */
  rateLimit?: GatewayAuthRateLimitConfig;
  /**
   * Configuration for trusted-proxy auth mode.
   * Required when mode is "trusted-proxy".
   */
  trustedProxy?: GatewayTrustedProxyConfig;
};

export type GatewayAuthRateLimitConfig = {
  /** Maximum failed attempts per IP before blocking.  @default 10 */
  maxAttempts?: number;
  /** Sliding window duration in milliseconds.  @default 60000 (1 min) */
  windowMs?: number;
  /** Lockout duration in milliseconds after the limit is exceeded.  @default 300000 (5 min) */
  lockoutMs?: number;
  /** Exempt localhost/loopback addresses from auth rate limiting.  @default true */
  exemptLoopback?: boolean;
};

export type GatewayTailscaleMode = "off" | "serve" | "funnel";

export type GatewayTailscaleConfig = {
  /** Tailscale exposure mode for the Gateway control UI. */
  mode?: GatewayTailscaleMode;
  /** Reset serve/funnel configuration on shutdown. */
  resetOnExit?: boolean;
};

export type GatewayRemoteConfig = {
  /** Whether remote gateway surfaces are enabled. Default: true when absent. */
  enabled?: boolean;
  /** Remote Gateway WebSocket URL (ws:// or wss://). */
  url?: string;
  /** Transport for macOS remote connections (ssh tunnel or direct WS). */
  transport?: "ssh" | "direct";
  /** Token for remote auth (when the gateway requires token auth). */
  token?: SecretInput;
  /** Password for remote auth (when the gateway requires password auth). */
  password?: SecretInput;
  /** Expected TLS certificate fingerprint (sha256) for remote gateways. */
  tlsFingerprint?: string;
  /** SSH target for tunneling remote Gateway (user@host). */
  sshTarget?: string;
  /** SSH identity file path for tunneling remote Gateway. */
  sshIdentity?: string;
};

export type GatewayReloadMode = "off" | "restart" | "hot" | "hybrid";

export type GatewayReloadConfig = {
  /** Reload strategy for config changes (default: hybrid). */
  mode?: GatewayReloadMode;
  /** Debounce window for config reloads (ms). Default: 300. */
  debounceMs?: number;
  /**
   * Maximum time (ms) to wait for in-flight operations to complete before
   * forcing a SIGUSR1 restart. Default: 300000 (5 minutes).
   * Lower values risk aborting active subagent LLM calls.
   * @see https://github.com/openclaw/openclaw/issues/47711
   */
  deferralTimeoutMs?: number;
};

export type GatewayHttpChatCompletionsConfig = {
  /**
   * If false, the Gateway will not serve `POST /v1/chat/completions`.
   * Default: false when absent.
   */
  enabled?: boolean;
  /**
   * Max request body size in bytes for `/v1/chat/completions`.
   * Default: 20MB.
   */
  maxBodyBytes?: number;
  /**
   * Max number of `image_url` parts processed from the latest user message.
   * Default: 8.
   */
  maxImageParts?: number;
  /**
   * Max cumulative decoded image bytes for all `image_url` parts in one request.
   * Default: 20MB.
   */
  maxTotalImageBytes?: number;
  /** Image input controls for `image_url` parts. */
  images?: GatewayHttpChatCompletionsImagesConfig;
};

export type GatewayHttpChatCompletionsImagesConfig = {
  /** Allow URL fetches for `image_url` parts. Default: false. */
  allowUrl?: boolean;
  /**
   * Optional hostname allowlist for URL fetches.
   * Supports exact hosts and `*.example.com` wildcards.
   */
  urlAllowlist?: string[];
  /** Allowed MIME types (case-insensitive). */
  allowedMimes?: string[];
  /** Max bytes per image. Default: 10MB. */
  maxBytes?: number;
  /** Max redirects when fetching a URL. Default: 3. */
  maxRedirects?: number;
  /** Fetch timeout in ms. Default: 10s. */
  timeoutMs?: number;
};

export type GatewayHttpResponsesConfig = {
  /**
   * If false, the Gateway will not serve `POST /v1/responses` (OpenResponses API).
   * Default: false when absent.
   */
  enabled?: boolean;
  /**
   * Max request body size in bytes for `/v1/responses`.
   * Default: 20MB.
   */
  maxBodyBytes?: number;
  /**
   * Max number of URL-based `input_file` + `input_image` parts per request.
   * Default: 8.
   */
  maxUrlParts?: number;
  /** File inputs (input_file). */
  files?: GatewayHttpResponsesFilesConfig;
  /** Image inputs (input_image). */
  images?: GatewayHttpResponsesImagesConfig;
};

export type GatewayHttpResponsesFilesConfig = {
  /** Allow URL fetches for input_file. Default: true. */
  allowUrl?: boolean;
  /**
   * Optional hostname allowlist for URL fetches.
   * Supports exact hosts and `*.example.com` wildcards.
   */
  urlAllowlist?: string[];
  /** Allowed MIME types (case-insensitive). */
  allowedMimes?: string[];
  /** Max bytes per file. Default: 5MB. */
  maxBytes?: number;
  /** Max decoded characters per file. Default: 200k. */
  maxChars?: number;
  /** Max redirects when fetching a URL. Default: 3. */
  maxRedirects?: number;
  /** Fetch timeout in ms. Default: 10s. */
  timeoutMs?: number;
  /** PDF handling (application/pdf). */
  pdf?: GatewayHttpResponsesPdfConfig;
};

export type GatewayHttpResponsesPdfConfig = {
  /** Max pages to parse/render. Default: 4. */
  maxPages?: number;
  /** Max pixels per rendered page. Default: 4M. */
  maxPixels?: number;
  /** Minimum extracted text length to skip rasterization. Default: 200 chars. */
  minTextChars?: number;
};

export type GatewayHttpResponsesImagesConfig = {
  /** Allow URL fetches for input_image. Default: true. */
  allowUrl?: boolean;
  /**
   * Optional hostname allowlist for URL fetches.
   * Supports exact hosts and `*.example.com` wildcards.
   */
  urlAllowlist?: string[];
  /** Allowed MIME types (case-insensitive). */
  allowedMimes?: string[];
  /** Max bytes per image. Default: 10MB. */
  maxBytes?: number;
  /** Max redirects when fetching a URL. Default: 3. */
  maxRedirects?: number;
  /** Fetch timeout in ms. Default: 10s. */
  timeoutMs?: number;
};

export type GatewayHttpEndpointsConfig = {
  chatCompletions?: GatewayHttpChatCompletionsConfig;
  responses?: GatewayHttpResponsesConfig;
};

export type GatewayHttpSecurityHeadersConfig = {
  /**
   * Value for the Strict-Transport-Security response header.
   * Set to false to disable explicitly.
   *
   * Example: "max-age=31536000; includeSubDomains"
   */
  strictTransportSecurity?: string | false;
};

export type GatewayHttpConfig = {
  endpoints?: GatewayHttpEndpointsConfig;
  securityHeaders?: GatewayHttpSecurityHeadersConfig;
};

export type GatewayPushApnsRelayConfig = {
  /** Base HTTPS URL for the external iOS APNs relay service. */
  baseUrl?: string;
  /** Timeout in milliseconds for relay send requests (default: 10000). */
  timeoutMs?: number;
};

export type GatewayPushApnsConfig = {
  relay?: GatewayPushApnsRelayConfig;
};

export type GatewayPushConfig = {
  apns?: GatewayPushApnsConfig;
};

export type GatewayNodesConfig = {
  /** Browser routing policy for node-hosted browser proxies. */
  browser?: {
    /** Routing mode (default: auto). */
    mode?: "auto" | "manual" | "off";
    /** Pin to a specific node id/name (optional). */
    node?: string;
  };
  /** Additional node.invoke commands to allow on the gateway. */
  allowCommands?: string[];
  /** Commands to deny even if they appear in the defaults or node claims. */
  denyCommands?: string[];
};

export type GatewayToolsConfig = {
  /** Tools to deny via gateway HTTP /tools/invoke (extends defaults). */
  deny?: string[];
  /** Tools to explicitly allow (removes from default deny list). */
  allow?: string[];
};

export type GatewayConfig = {
  /** Single multiplexed port for Gateway WS + HTTP (default: 18789). */
  port?: number;
  /**
   * Explicit gateway mode. When set to "remote", local gateway start is disabled.
   * When set to "local", the CLI may start the gateway locally.
   */
  mode?: "local" | "remote";
  /**
   * Bind address policy for the Gateway WebSocket + Control UI HTTP server.
   * - auto: Loopback (127.0.0.1) if available, else 0.0.0.0 (fallback to all interfaces)
   * - lan: 0.0.0.0 (all interfaces, no fallback)
   * - loopback: 127.0.0.1 (local-only)
   * - tailnet: Tailnet IPv4 if available (100.64.0.0/10), else loopback
   * - custom: User-specified IP, fallback to 0.0.0.0 if unavailable (requires customBindHost)
   * Default: loopback (127.0.0.1).
   */
  bind?: GatewayBindMode;
  /** Custom IP address for bind="custom" mode. Fallback: 0.0.0.0. */
  customBindHost?: string;
  controlUi?: GatewayControlUiConfig;
  auth?: GatewayAuthConfig;
  tailscale?: GatewayTailscaleConfig;
  remote?: GatewayRemoteConfig;
  reload?: GatewayReloadConfig;
  tls?: GatewayTlsConfig;
  http?: GatewayHttpConfig;
  push?: GatewayPushConfig;
  nodes?: GatewayNodesConfig;
  /**
   * IPs of trusted reverse proxies (e.g. Traefik, nginx). When a connection
   * arrives from one of these IPs, the Gateway trusts `x-forwarded-for`
   * to determine the client IP for local pairing and HTTP checks.
   */
  trustedProxies?: string[];
  /**
   * Allow `x-real-ip` as a fallback only when `x-forwarded-for` is missing.
   * Default: false (safer fail-closed behavior).
   */
  allowRealIpFallback?: boolean;
  /** Tool access restrictions for HTTP /tools/invoke endpoint. */
  tools?: GatewayToolsConfig;
  /**
   * Channel health monitor interval in minutes.
   * Periodically checks channel health and restarts unhealthy channels.
   * Set to 0 to disable. Default: 5.
   */
  channelHealthCheckMinutes?: number;
  /**
   * Stale event threshold in minutes for the channel health monitor.
   * A connected channel that receives no events for this duration is treated
   * as a stale socket and restarted. Default: 30.
   */
  channelStaleEventThresholdMinutes?: number;
  /**
   * Maximum number of health-monitor-initiated channel restarts per hour.
   * Once this limit is reached, the monitor skips further restarts until
   * the rolling window expires. Default: 10.
   */
  channelMaxRestartsPerHour?: number;
};
