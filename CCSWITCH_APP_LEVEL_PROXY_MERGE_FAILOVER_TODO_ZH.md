# TODO：自研应用本地代理 + 熔断/Failover（融合 CC Switch 控制面）

本待办清单基于 `CCSWITCH_APP_LEVEL_PROXY_MERGE_FAILOVER_ZH.md`，目标是在应用内实现**本地 Proxy（数据面）**，并把 CC Switch 的 `providers + proxy_config` 融入：

- **路由队列**：从 CC Switch providers 生成 `orderedProviderIds`（primary + failover candidates）
- **熔断/Failover 开关**：可选把 `proxy_config.enabled/auto_failover_enabled` 当作运营开关

非目标（明确边界）：
- 不做协议/JSON body 转换（只做路由 + headers 注入 + 透传）
- 不做“流式中途无缝切换”（仅做未写出前的安全重试；streaming 一旦写出就不切换）
- 不做 Hedged Requests（对冲请求；成本高且流式难取消计费）

---

## P0（MVP：可用、可控、可观测）

### 1) 配置项 / 选项（模板 + UI）
- [x] 增加模板字段（或等价映射）：`proxyEnabled`、`proxyImplementation('app'|'ccswitch'|'off')`
- [x] 增加“融合 CC Switch 控制面”的开关：`respectCCSwitchProxyConfig`（当前默认 true；建议生产默认 false / 或改用独立字段）
- [x] 增加队列模式：`proxyQueueMode('failover-queue'|'all-providers'|'custom')` + `allow/deny`（可选）
- [x] 增加本地 failover/breaker 开关：`appFailoverEnabled`、`appBreakerEnabled`
- [x] 增加参数对象：`breakerConfig`、`retryConfig`（先支持最小必要字段）
- [ ] 配置收敛：模板/UI 默认只暴露 `proxyEnabled` + `proxyImplementation`（其余作为高级设置/内部默认，避免配置膨胀）
- [ ] 语义澄清：避免复用 `proxy_config.enabled/auto_failover_enabled` 作为 app-proxy 运营开关；更推荐在 CC Switch 增加独立字段（如 `app_proxy_enabled` / `app_auto_failover_enabled`）或独立表
- [x] 兼容旧字段迁移：
  - [x] `proxyEnabled = template.proxyEnabled ?? Boolean(template.useCCSwitchProxy)`
  - [x] `proxyImplementation = template.proxyImplementation ?? (template.useCCSwitchProxy ? 'ccswitch' : 'app')`

### 2) 合并策略（Effective Policy）
- [x] 新增/收敛一个合并函数：输入 `template + snapshot + appKey`，输出 `EffectiveProxyPolicy`
- [x] 合并时构建 `orderedProviderIds`（见 P0-3 队列算法）
- [x] 融入 `proxy_config` 作为开关（当 `respectCCSwitchProxyConfig=true`）：
  - [x] `enabled` 控制是否允许开启代理
  - [x] `auto_failover_enabled` 控制 failover/breaker 默认值（模板显式值优先）
- [x] 决策 `routeMode`：
  - [x] `direct`
  - [x] `app-proxy`（本地代理）
  - [x] `ccswitch-proxy`（直连 CC Switch Proxy，仅当可用）

### 3) 队列算法（把 CC Switch providers 融入本地队列）
- [x] 实现 `buildQueueFromCCSwitchProviders(providers, requestedProviderId, currentProviderId, queueMode, allow, deny)`
- [x] primary 选择规则（当前：requested -> current -> is_current -> fallback；建议简化为：requested -> current -> queue[0]）
- [ ] primary 简化重构：删除 `is_current` fallback 分支（减少排查分支；以队列首位作为兜底）
- [x] failoverCandidates：按 `in_failover_queue=true` + `sort_index` + `id` 排序，去重且移除 primary
- [ ] 队列构建阶段强校验：协议一致性/接口能力/模型命名；不兼容 provider 剔除并记录 warning（否则 failover 切换后仍可能失败）
- [x] `orderedProviderIds` 合成：
  - [x] `failover-queue`：`[primary] + failoverCandidates`
  - [x] `all-providers`：`[primary] + 其它 provider`
  - [x] `custom`：应用 allow/deny（必要时重选 primary）

### 4) 本地 Proxy（数据面）骨架
- [x] 在主进程启动本地 HTTP server（仅监听 `127.0.0.1`）
- [x] 路由透传（至少覆盖）：
  - [x] OpenAI-compatible：`/v1/*`（含 streaming/SSE）
  - [x] Anthropic-compatible：`/v1/*`（含 streaming/SSE）
- [x] 请求转发前注入真实上游鉴权（客户端配置只写占位 token）
- [x] 处理 hop-by-hop headers（移除/重置 `connection/keep-alive/transfer-encoding/upgrade/host` 等）

### 5) 客户端配置改写（让客户端只连本地 Proxy）
- [x] 当 `routeMode='app-proxy'`：
  - [x] Codex：重写 `base_url -> http://127.0.0.1:<port>/v1`，key 写占位
  - [x] OpenCode：重写 provider `baseURL -> http://127.0.0.1:<port>/v1`，key 写占位
  - [x] Claude Code：重写 `ANTHROPIC_BASE_URL -> http://127.0.0.1:<port>`，token 写占位
- [x] 保持“只对 CC Switch 导入模板运行时重写”的安全边界（避免串台）

### 6) 可观测（最小）
- [x] 增加 `GET /__status`：输出监听信息、每个 appKey 的队列、每个 provider 的 breaker 状态（先 stub 也行）
- [x] 响应 headers 增强：
  - [x] `X-MPS-Provider`
  - [x] `X-MPS-Failover`
  - [x] `X-MPS-Failover-From`（发生切换时）
- [ ] 日志脱敏：不打印 token/header 值

---

## P1（可靠性：熔断 + failover 真正生效）

### 7) Provider 信息抽取（从 CC Switch settingsConfig 得到 upstreamBaseUrl + upstreamHeaders）
- [x] OpenAI-compatible（Codex/OpenCode）：
  - [x] 从 TOML/配置中提取 `base_url`
  - [x] 从 auth/env 映射出 `Authorization` 或 `x-api-key` 等 header
- [x] Anthropic-compatible（Claude Code）：
  - [x] 从 env 形态提取 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN`（映射到上游需要的 header）
- [ ] 兜底策略：解析不到时给出明确错误（并在 UI/日志可见）

### 8) 熔断器（按 provider 维度）
- [ ] 状态机：`closed/open/half_open`
- [ ] 参数：`failureThreshold/openDurationMs/halfOpenMaxInFlight/successToClose/upstreamTimeoutMs`
- [ ] 失败计数规则（建议）：网络错误/超时/HTTP `408/429/5xx`
- [ ] half-open 试探：限制并发，成功即 close

### 9) Failover（按队列切换）
- [ ] router：跳过 `breaker=open` 的 provider
- [x] “安全重试”：
  - [x] `maxAttempts=2`（原始 + failover 1 次）
  - [x] 仅当**尚未向客户端写出任何响应字节**时允许切换
- [x] streaming：一旦写出 headers/chunk 就不重试（避免重复计费/内容断裂）

---

## P2（增强：更无感、更安全、更可运营）

### 10) buffer-before-commit（提交窗口，可选）
- [ ] 支持 `commitDelayMs/commitBytes`：窗口内失败允许 failover（仍限制 attempts）
- [ ] 明确开关与默认值（建议默认关闭）

### 11) 幂等与重试风险控制
- [ ] 统一注入 `request-id` / `Idempotency-Key`（若上游支持）
- [ ] 按 endpoint 白名单控制是否允许自动重试（工具调用/写操作默认不重试）

### 12) 多会话隔离（可选）
- [x] `sessionId` 路由：`/s/<sessionId>/v1`（OpenAI）与 `/s/<sessionId>`（Claude）
- [x] `sessionId -> policy/queue` 映射（不同 tab 不互相影响）

### 13) 安全强化
- [ ] 可选 `proxySecret`：本机进程滥用防护（header/query）
- [ ] 更严格的监听与端口冲突处理（自动找空闲端口/提示）

### 14) 热更新与生命周期（落地必做）
- [ ] 快照变更感知：providers/proxy_config 变化后是轮询（pull）还是推送（push）
- [ ] policy 热更新：队列变化时刷新路由；provider 增删时清理/初始化对应 breaker 状态
- [ ] in-flight 边界：不做“流中切换”；让正在进行的请求按旧 policy 跑完，新请求用新 policy
- [ ] 端口冲突/启动失败：明确错误提示；可选自动选择空闲端口并同步更新客户端 baseURL

---

## 测试与验收（建议同步推进）

### 单元测试
- [x] `buildQueueFromCCSwitchProviders()`：覆盖 requested/current/is_current、allow/deny、排序与去重
- [ ] breaker 状态机：失败阈值、open 冷却、half-open 恢复
- [x] merge policy：`respectCCSwitchProxyConfig` 的优先级与降级策略

### 集成/手测用例
- [ ] 本地 proxy 启动后，三类客户端 baseURL 指向本地 proxy
- [ ] 故障注入（`429/timeout/5xx`）触发熔断并自动切换
- [ ] streaming 中断：本次请求失败但下次请求自动走新 provider
- [ ] `GET /__status` 与 `X-MPS-*` headers 能定位实际 provider 与是否 failover
