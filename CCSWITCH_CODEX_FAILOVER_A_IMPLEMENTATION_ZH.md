# 落地 A：在 CC Switch Proxy 实现 Codex 熔断降级（实施清单）

> 适用场景：你能修改/发布 CC Switch（而不是在 MultipleShell 侧兜底）。
>
> MultipleShell 这边只需要让 Codex 走 `CC Switch proxy`（本仓库已支持 `useCCSwitchProxy` + 自动导入默认勾选）。

---

## 0. 结论先行（你要做什么）

在 **CC Switch 的 Codex proxy** 请求处理链路里，加一层“路由器”：

1. **按 failover 队列选 provider**（`in_failover_queue` + `sort_index` + `id`）。
2. **每个 provider 维护 circuit breaker 状态**（Closed / Open / Half-Open）。
3. 对符合条件的错误（超时 / 429 / 5xx / 网络错误）：
   - 累计失败 → 熔断该 provider（Open 一段时间）
   - 并在“安全失败”（还没开始返回任何响应）时，**切换到下一个 provider 重试 1 次**
4. 暴露一个 `/__status`（或类似）接口，用于查看当前 provider 与熔断状态。

---

## 1. 依赖的现有数据（尽量复用 CC Switch 现状）

从 MultipleShell 读取 CC Switch DB 的逻辑可推断 CC Switch 至少具备如下结构（建议你在 CC Switch 侧直接复用/保持一致）：

- `providers` 表：含 `app_type`、`id`、`sort_index`、`in_failover_queue`、`is_current`、`settings_config` 等字段
- `proxy_config` 表：含 `app_type`、`listen_address`、`listen_port`、`proxy_enabled`、`enabled`、`auto_failover_enabled`

落地 A 不强制新增表；参数可先用默认值或挂在现有配置里（例如 `proxy_config.meta` / 配置文件 / 环境变量）。

---

## 2. 行为定义（必须先定清楚，否则实现会走样）

### 2.1 什么时候触发“失败计数 / 熔断”

建议把错误分成两类：

**A. 可切换型错误（计入失败，可能触发 failover）**

- 网络错误：连接失败、连接被拒绝、TLS 握手失败、DNS 失败等
- 超时：connect/read timeout
- HTTP：`408`, `429`, `500`, `502`, `503`, `504`
- SSE/流式：连接在“尚未发送任何响应字节”前就中断

**B. 不建议切换的错误（通常不计入失败）**

- `400`（请求不合法/模型不支持）
- `401/403`（鉴权问题更可能是配置错误；除非你明确知道这是“临时态”）

> 你也可以先粗暴一些：除 `400/401/403` 外都算失败；后续再收敛。

### 2.2 什么时候允许“自动重试到下一个 provider”

强烈建议只做 **“安全重试”**：

- 仅在“还没把任何上游响应写给客户端”时才允许切换重试
- 一旦开始向客户端写响应（尤其是 stream/SSE），就**不**重试（避免内容断裂/重复计费/协议混乱）

建议默认：每个请求最多 failover 重试 **1 次**（最多尝试 2 个 provider），避免雪崩与级联放大。

---

## 3. Circuit Breaker（熔断器）最小实现

### 3.1 状态机

- `closed`：正常放量
- `open`：拒绝请求（直到冷却结束）
- `half_open`：只放少量“探测请求”，成功则恢复，失败则继续 open

### 3.2 推荐默认参数（可后续配置化）

- `failureThreshold = 3`（连续失败 3 次熔断）
- `openDurationMs = 60_000`（熔断 60 秒）
- `halfOpenMaxInFlight = 1`（半开期最多 1 个并发探测）
- `successToClose = 1`（探测成功 1 次就恢复）
- `upstreamTimeoutMs = 30_000`

### 3.3 伪代码（语言无关）

```text
state per provider:
  mode: closed|open|half_open
  consecutiveFailures: int
  openedAt: timestamp|null
  halfOpenInFlight: int

canAttempt(now):
  if mode == closed: return true
  if mode == open:
    if now - openedAt >= openDurationMs:
      mode = half_open
    else:
      return false
  if mode == half_open:
    if halfOpenInFlight >= halfOpenMaxInFlight: return false
    halfOpenInFlight += 1
    return true

onSuccess():
  if mode == half_open:
    mode = closed
  consecutiveFailures = 0
  openedAt = null
  halfOpenInFlight = 0 (or decrement if你用计数)

onFailure(now, reason):
  if mode == half_open:
    mode = open
    openedAt = now
    consecutiveFailures = 0
    halfOpenInFlight = 0
    return
  consecutiveFailures += 1
  if consecutiveFailures >= failureThreshold:
    mode = open
    openedAt = now
    consecutiveFailures = 0
```

> 实际实现时要注意 half_open 的 `inFlight` 计数释放（finally）。

---

## 4. Provider 选择与 Failover 队列

### 4.1 队列定义（建议与 DB 一致）

1. 过滤：`in_failover_queue = true`
2. 排序：`ORDER BY COALESCE(sort_index, 999999), id ASC`

当队列为空时的策略（选一种并写死/可配置）：

- 策略 1：只用 `current provider`（最保守）
- 策略 2：让“所有 providers”都参与 failover（更自动，但风险更大）

### 4.2 选择算法（伪代码）

```text
pickProvider(appType):
  providers = loadProviders(appType)  // 已排好序
  for p in providers:
    if breaker[p.id].canAttempt(now):
      return p
  return null
```

当 `pickProvider == null` 时：

- 返回 503 + `Retry-After: <seconds>`（取最近一个 open 结束时间的最小值）
- body 里给出清晰信息：all providers are in OPEN state / no available provider

---

## 5. Proxy 转发：对 Codex 的关键点

### 5.1 协议透传优先

Codex（尤其 `wire_api="responses"`）可能用 **流式** 返回；最佳实践是：

- 不做协议转换：只做 HTTP 透传（headers/body/stream）
- 请求/响应都要支持 chunked/SSE

### 5.2 “安全失败”判定（决定是否切换重试）

实现时建议维护一个布尔值 `hasWrittenToClient`：

- 在写入任何 response headers/body 之前：`hasWrittenToClient=false`
- 一旦写了 headers 或任何 chunk：置 `true`

若上游失败且 `hasWrittenToClient=false`，才允许 failover 重试到下一个 provider。

### 5.3 透传时的观测增强（建议）

- 响应 header 加：`X-CCSwitch-Provider: <providerId>`
- 若发生 failover：`X-CCSwitch-Failover: 1`、`X-CCSwitch-Failover-From: <id>`

（注意：不要把敏感信息写进 header）

---

## 6. `/__status`（可观测）建议字段

建议返回 JSON：

- `appType: "codex"`
- `proxyEnabled/enabled/autoFailoverEnabled`
- `providers[]`：
  - `id/name/sortIndex/inFailoverQueue/isCurrent`
  - `breaker.mode`
  - `breaker.openedAt`
  - `breaker.openRemainingMs`
  - `breaker.consecutiveFailures`
  - `lastFailureReason/lastFailureAt`
- `now`

并在 UI / 日志里做到可读。

---

## 7. 测试策略（建议最低覆盖）

### 7.1 单元测试（必做）

- breaker 状态机：closed→open、open→half_open→closed、half_open 失败回 open
- provider 选择：按队列顺序跳过 open 状态 provider
- 失败分类：429/5xx/timeout 计入失败；401/400 不计入（按你选择）

### 7.2 集成测试（强烈建议）

用 2~3 个“假上游”HTTP server：

- server A：返回 429/超时
- server B：正常 200（含 stream）

断言：

- A 连续失败 3 次后被 open
- 下一次请求直接走 B
- openDuration 到期后 half-open 探测成功 → A 恢复

---

## 8. 发布与回滚

- 默认只在 `proxy_config.auto_failover_enabled=1` 且 `enabled=1` 时启用（避免影响现有用户）
- 提供一个快速“全局关闭 failover”的开关（环境变量或配置项）
- 保留详细日志（至少在 debug level）便于线上排查

---

## 9. 与 MultipleShell 的配合点（无需改代码，但建议确认）

MultipleShell 在创建 Codex 会话时会：

- 当勾选“走 CC Switch 代理”时，把 `base_url` 指向 `http://<listenAddress>:<listenPort>/v1`
- 并写入占位 `api_key = "ccswitch"`（由 proxy 接管鉴权）

因此落地 A 完成后，MultipleShell 用户侧会直接受益，无需额外升级逻辑（除了把 CC Switch 更新到包含此功能的版本）。

