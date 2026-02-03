# CC Switch / Codex 熔断降级（Failover）方案（设计草案）

## 1. 背景与问题

当前 MultipleShell 已支持 **Codex 配置跟随 CC Switch provider**，以及将 Codex 请求 **指向 CC Switch proxy**（`useCCSwitchProxy`）。  
但在“Codex 走 CC Switch proxy”的链路上，如果上游服务出现限流/超时/5xx 等问题，而 **CC Switch 对 Codex 没有完善的熔断/降级/自动切换**，则会出现：

- 某个 provider 出现系统性故障时，Codex 会持续失败，体验很差；
- 需要手动切换 provider，且切换成本高（可能要重启会话/重跑命令）；
- 多实例/RemoteApp 场景下，人为排查更麻烦。

本文给出一个可落地的实现方案，分为 **优先推荐的“在 CC Switch 侧实现”** 与 **备选的“在 MultipleShell 侧兜底实现”** 两条路径。

## 2. 目标

1. **自动熔断**：对连续失败的 Codex provider 在一段时间内“断开”（Open circuit），避免持续打爆故障上游。
2. **自动降级/切换**：按 failover 队列（`in_failover_queue` + `sort_index`）选择下一个可用 provider。
3. **可观测**：能看到当前选中的 provider、失败原因、熔断状态、切换次数等。
4. **低侵入**：尽量不要求用户改 Codex 配置；在已有 CC Switch 数据模型基础上实现。

## 3. 方案 A（推荐）：在 CC Switch Proxy 内实现 Codex 熔断降级

### 3.1 核心思路

让 Codex 永远只请求一个地址：`CC Switch Codex Proxy`（例如 `http://127.0.0.1:<port>/v1`）。  
Proxy 作为“网关”，对请求进行 **路由 + 熔断 + 降级**：

- 每个 provider 维护一个 circuit breaker 状态（Closed / Open / Half-Open）。
- 每次请求选择“当前可用且优先级最高”的 provider 转发。
- 当请求触发故障条件时，累计失败并在达到阈值后熔断该 provider；随后选择下一个 provider。
- 当所有 provider 都不可用时，返回可理解的 503/错误信息（并给出 Retry-After）。

### 3.2 需要的状态与配置

**(1) Provider 运行时状态（内存即可）**

- `state`: `closed | open | half_open`
- `consecutiveFailures`: 连续失败次数
- `openedAt`: 进入 open 的时间
- `lastFailureAt / lastFailureReason`
- `halfOpenInFlight`: half-open 试探中的并发数（防止放量）

**(2) 推荐默认参数**

- `failureThreshold`: 3（连续失败 3 次熔断）
- `openDurationMs`: 60_000（熔断 60 秒）
- `halfOpenMaxInFlight`: 1（半开只放 1 个试探请求）
- `successToClose`: 1（试探成功 1 次恢复）
- `requestTimeoutMs`: 30_000（上游请求超时）

> 参数可先写死，后续再接入 CC Switch 的 `proxy_config` 或独立配置表。

### 3.3 失败判定（触发熔断的条件）

建议按“可重试/可切换”的故障类型判定：

**应计入失败（建议触发切换）**

- 网络错误：连接拒绝、DNS、TLS 失败
- 超时：connect/read timeout
- HTTP `429/408/5xx`
- 流式响应中断（SSE/Chunked 被动断开）

**通常不建议切换（更可能是配置问题）**

- `401/403`：鉴权错误（除非明确知道某些 provider 会临时鉴权失败）
- `400`：请求参数问题（模型不支持等）

> 实际落地可用白名单：`{408, 409, 425, 429, 500, 502, 503, 504}` + 网络/超时。

### 3.4 路由选择（Failover 队列）

优先使用 CC Switch 已有排序规则（MultipleShell 的 `computeFailoverPriorityByProviderId` 已按该规则实现）：

1. 仅选择 `in_failover_queue = true` 的 provider
2. 排序：`ORDER BY COALESCE(sort_index, 999999), id ASC`
3. 选择第一个 `state != open` 的 provider

当队列为空时：

- 退化为“只用 current provider”；或
- 允许“所有 providers 都参与 failover”（看产品选择）。

### 3.5 请求重试策略（关键取舍）

Failover 的重试存在“重复计费/副作用”的风险，建议分两层：

- **安全重试（强烈建议）**：仅在 *未拿到任何上游响应* 时（连接失败/超时/5xx 且无 body）重试到下一个 provider；
- **非安全重试（不建议默认开启）**：已经开始流式输出后再切换，基本不可行（会破坏客户端协议/内容连续性）。

因此建议实现为：

1. 选择 provider A，转发请求
2. 如果出现“安全失败”→ 立刻切到 provider B 重试一次（最多 1 次，避免雪崩）
3. 若仍失败→ 将错误返回给 Codex（下一次请求再走新的 provider）

### 3.6 可观测与对外接口

建议至少实现：

- 日志：`[FAILOVER]`、`[CIRCUIT] provider=<id> state=<...> reason=<...>`
- 状态查询接口：`GET /__status`（返回 providers 状态、当前选中 provider、熔断剩余时间）
- （可选）将“当前有效 provider”写回 `settings.json` 或 DB，方便 UI 端展示

### 3.7 交付步骤（最小可用版本）

1. 在 CC Switch 的 Codex proxy 路由层加入 circuit breaker 状态机
2. 按 failover 队列选择 provider 并转发请求
3. 加入“安全失败”下的一次重试与切换
4. 增加日志与 `/__status`
5. 压测与故障注入：429/5xx/timeout，验证切换与熔断恢复

## 4. 方案 B（兜底）：在 MultipleShell 内实现 Codex Failover Proxy（不改 CC Switch）

当无法修改 CC Switch 或其发版周期较长时，可在 MultipleShell 主进程启动一个本地代理：

- Codex 的 `base_url` 指向 `MultipleShell Proxy`（例如 `http://127.0.0.1:<mpsPort>/v1`）
- MultipleShell Proxy 根据 CC Switch 的 provider 列表（读取 `cc-switch.db`）做 failover
- 上游请求直接转发到各 provider 的实际 `base_url`（从 provider 的 `settings_config.config` 提取）

### 4.1 需要新增/改动点（MultipleShell）

- 新增：`src/main/codex-failover-proxy.js`（HTTP 代理 + 熔断状态机）
- 改造：`PTYManager.resolveCCSwitchRuntimeConfig()`  
  - 当用户选择“Codex 走 failover”（新增开关），将 `codexConfigToml` 的 `base_url` 改为 MultipleShell Proxy 地址
  - `auth.json` 填充为占位（或不需要）——由 Proxy 负责给上游加鉴权
- 新增 IPC：查询 proxy 状态（用于前端展示）

### 4.2 风险与边界

- 需要解析 provider 的 Codex TOML（至少拿到 `base_url` 与鉴权来源），建议引入 TOML 解析库或保守正则实现；
- 需要处理流式 SSE 透传（建议仅做“不断流透传”，失败后下一次请求再切换）；
- provider 的协议差异（`responses`/`chat.completions`）需要确保上游都支持，否则需要做协议转换（复杂度会上升）。

## 5. 推荐选择

- **能改 CC Switch：选方案 A**（最干净；所有 Codex 客户端都受益；不依赖 MultipleShell）。
- **短期必须落地：选方案 B**（MultipleShell 自带兜底；但代理/解析成本更高）。

## 6. 验收标准（无论选 A/B）

- 人为制造 429/timeout/5xx 时：在 3 次失败内触发熔断并切换到下一个 provider
- 熔断时间到后：半开试探成功即可恢复
- 在 UI 或日志中可以明确看到：当前 provider、熔断状态、最近失败原因
- 不影响正常成功路径的延迟（无故障时基本等价于普通 proxy 透传）

