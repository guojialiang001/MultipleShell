# 自研应用（MultipleShell 示例）：内置 Proxy + 熔断（Circuit Breaker）落地指南（合并应用配置与 CC Switch）  
> 目标：**合并“应用配置（MultipleShell 模板）”与“CC Switch 配置（providers + proxy_config）”**，得到一份**可执行的运行时策略**，用于：  
> 1) 决定是否走代理（CC Switch Proxy / 应用内置 Proxy）  
> 2) 决定是否启用熔断与自动降级（Failover）  
> 3) 生成最终交给终端客户端（Claude Code / Codex / OpenCode）的配置
>
> 适用范围：  
> - **在 MultipleShell 仓库落地**：第 2 节给出本仓库的代码位置；第 3~7 节可直接按文档实现。  
> - **迁移到你自己的应用**：跳过第 2 节（仓库细节），直接复用第 3~6 节的模型/合并规则，并参考第 8 节“迁移模板”。

---

## 1. 背景（为什么要“合并配置”）

你的应用（MultipleShell 示例）里存在两类“来源不同但要一起生效”的配置：

1) **应用侧（你的应用 / MultipleShell 示例）配置**：用户在 UI 里选择的模板/开关（例如 `useCCSwitch`、`useCCSwitchProxy`、`ccSwitchProviderId`）。  
2) **CC Switch 配置**：从 CC Switch DB/快照读取的 provider 列表与 proxy 配置（`proxy_config`：`proxy_enabled / enabled / auto_failover_enabled / listen_*`）。

如果只看应用侧开关（例如 `useCCSwitchProxy=true`）而不校验 CC Switch proxy 是否真的启用/支持 failover，就会出现：

- 代理地址被写进客户端配置，但 CC Switch 侧实际上 **没开 proxy / 没开 auto-failover** → 请求失败或“以为有熔断但其实没有”。  
- 导入模板时默认勾选规则不一致，UI 展示与运行时行为不一致。  

因此需要一个明确的“合并规则”：把两侧配置拼成一个 **Effective Policy（最终策略）**。

---

## 2. 现有代码里“配置与合并”的关键点（本仓库）

### 2.1 CC Switch 快照读取（providers + proxy_config）

- `src/main/ccswitch.js`：  
  - `listProviders()` 从 CC Switch DB 读：
    - `providers`（含 `in_failover_queue / sort_index / is_current` 等）
    - `proxy_config`（含 `listen_address / listen_port / proxy_enabled / enabled / auto_failover_enabled`）
  - 返回 `snapshot.proxy[appType]` 与 `snapshot.apps[appKey]`。

### 2.2 导入模板时的默认“走代理”策略（一次性合并）

- `src/main/ccswitch.js`：`importProviders()`  
  - 逻辑：若 `proxyEnabled && enabled && autoFailoverEnabled`，则导入模板默认 `useCCSwitchProxy=true`。  
  - 目的：只有“proxy + auto-failover 都开启”时，才默认让客户端直连 CC Switch proxy（否则 failover 语义无法成立）。

> 如果你把 `useCCSwitchProxy` 的语义升级为“使用 **应用内置 Proxy**（MultipleShell 示例实现；并提供熔断/自动切换）”，那么这里的默认勾选逻辑也应相应调整：  
> - 建议不要让 `useCCSwitchProxy` 同时承载两种语义（“直连 CC Switch Proxy” vs “走应用内置 Proxy”），否则导入默认值与运行时行为很难保持一致。  
> - 推荐新增选项（见 **4.1.1**）：  
>   - `proxyImplementation='app'|'ccswitch'|'off'`：明确走哪种代理实现  
>   - `appFailoverEnabled/appBreakerEnabled` + `breakerConfig/retryConfig`：控制熔断与重试策略  
>   - 可选 `respectCCSwitchProxyConfig=true`：把 `proxy_config.enabled/auto_failover_enabled` 当作“运营开关”，用于控制**是否启用代理/是否启用 failover**（无论实现是 app 还是 ccswitch）  
> - 导入模板默认值建议：  
>   - 若 `snapshot.apps[appKey].providers` 非空：可默认 `proxyImplementation='app'`，并用 `in_failover_queue + sort_index` 生成队列（见 **5.5.2**）  
>   - 若你希望保持旧行为：当 `ccFailoverOk=true` 时可默认 `proxyImplementation='ccswitch'`（让客户端直连 CC Switch Proxy）

### 2.3 启动会话时的运行时重写（再次合并）

- `src/main/pty-manager.js`：`resolveCCSwitchRuntimeConfig(config)`  
  - 仅对“从 CC Switch 导入的模板”进行运行时重写（安全兜底，避免配置串台）。  
  - 根据 `ccSwitchProviderId`（或 CC Switch current provider）拿到 provider.settingsConfig，并写回到：
    - Claude Code：`claudeSettingsJson`（并在走 proxy 时注入 `ANTHROPIC_BASE_URL` 等）
    - Codex：`codexConfigToml + codexAuthJson`（并在走 proxy 时重写 `base_url`）
    - OpenCode：`opencodeConfigJson`（并在走 proxy 时写 provider.baseURL/apiKey）

### 2.4 UI 展示侧的 proxy 状态“合并”

- `src/renderer/utils/ccswitch-status.mjs`：`resolveCCSwitchProxyStatus(proxyCfg)`  
  - 注释明确：`proxy_config` 同时有 server-level `proxy_enabled` 与 app-level `enabled`。  
  - UI 展示更偏向“应用级 enabled”，并给旧 schema 做回退。

---

## 3. 统一的“最终策略”模型（建议）

建议把合并产物收敛到一个对象（示例）：

```ts
type EffectiveProxyPolicy = {
  appKey: 'claude' | 'codex' | 'opencode'
  source: 'ccswitch' | 'local'

  // 模板侧意图（建议第一版只新增 2~3 个用户可见选项，避免配置膨胀；其余用默认值内部处理）
  wantUseCCSwitch: boolean
  wantUseProxy: boolean
  proxyImplementation: 'off' | 'app' | 'ccswitch' // 应用内置 / CC Switch Proxy / 不走代理
  requestedProviderId: string | null             // ccSwitchProviderId（可为空）

  // CC Switch 侧能力/开关（来自 snapshot.proxy）
  ccProxy: {
    listenOrigin: string | null        // http://127.0.0.1:15721
    openAIBase: string | null          // http://127.0.0.1:15721/v1
    serverEnabled: boolean | null      // proxy_enabled
    appEnabled: boolean | null         // enabled（优先）/ proxy_enabled（回退）
    autoFailoverEnabled: boolean | null
  }

  // CC Switch providers 融入的上游队列（来自 snapshot.apps[appKey].providers）
  queue: {
    source: 'ccswitch' | 'local'
    mode: 'failover-queue' | 'all-providers' | 'custom'
    primaryProviderId: string | null
    orderedProviderIds: string[]       // 本地 Proxy 会按这个顺序 pick + failover
  }

  // 应用内置 proxy（应用级；MultipleShell 示例）
  appProxy: {
    enabled: boolean
    origin: string | null             // http://127.0.0.1:<mpsPort>
    openAIBase: string | null         // http://127.0.0.1:<mpsPort>/v1
  }

  // 应用内置 failover + breaker（可由 template 覆盖；也可接入 CC Switch proxy_config 作为运营开关）
  appFailover: {
    enabled: boolean
    maxAttempts: number               // 建议 2（原始 + failover 1 次）
    commitDelayMs: number             // 0 表示不启用 buffer-before-commit
    commitBytes: number
    retryStatusCodes: number[]        // 建议 [408,429,500,502,503,504]
    upstreamTimeoutMs: number
  }
  appBreaker: {
    enabled: boolean
    failureThreshold: number
    openDurationMs: number
    halfOpenMaxInFlight: number
    successToClose: number
  }

  // 合并结论
  routeMode: 'direct' | 'ccswitch-proxy' | 'app-proxy'
  circuitBreakerMode: 'off' | 'ccswitch' | 'app'
}
```

> 提示：上面是“全量概念模型”，方便讨论合并规则；落地时建议按模块拆分（merge/queue/proxy/breaker），并且不要把所有字段都暴露成模板/UI 选项（见 4.1.1）。

这样做的好处：
- UI 展示、导入默认值、运行时重写、Proxy Server 启停，都可以基于同一套规则，避免“前后不一致”。

---

## 4. 合并规则（推荐的确定性算法）

下面给出一个**可直接照抄实现**的合并顺序（伪代码）：

### 4.1 输入

- `template`：应用模板（MultipleShell 示例为用户选择/编辑的 config）
- `snapshot`：`ccSwitch.listProviders()` 的结果
- `appKey`：`claude | codex | opencode`（注意 OpenCode 复用 Codex proxy 配置）

#### 4.1.1 需要新增的选项（建议）

要实现“应用本地代理 + 熔断/Failover”，并把 CC Switch 的配置融入**代理队列与熔断开关**，建议分两层看待配置：

- **用户可见（MVP）**：先只暴露 2~3 个选项，避免配置膨胀；其余用合理默认值在内部处理。  
- **高级/内部（可选）**：当你真的需要“可运营/可调参”时再开放；否则保持隐藏，减少误用与排查成本。

**用户可见（建议先做）**

| 字段（示例命名） | 类型 | 建议默认值 | 说明 |
| --- | --- | --- | --- |
| `proxyEnabled` | boolean | `false` | 是否启用代理（统一语义：无论最终走 app-proxy 还是 ccswitch-proxy） |
| `proxyImplementation` | `'app' \| 'ccswitch' \| 'off'` | `'app'` | 选择代理实现：应用内置 Proxy / CC Switch Proxy / 关闭 |

> 说明：`ccSwitchProviderId`（用户指定 provider）属于既有字段，通常仍需要保留。

**高级/内部选项（默认不建议作为模板字段）**

| 字段（示例命名） | 类型 | 建议默认值 | 说明 |
| --- | --- | --- | --- |
| `respectCCSwitchProxyConfig` | boolean | `false` | （谨慎）是否复用 `proxy_config.enabled/auto_failover_enabled` 当作“运营开关”（本仓库当前实现默认为 `true`；更推荐在 CC Switch 增加独立字段，如 `app_proxy_enabled`；见 5.6.1/第 9 节第 2 点） |
| `proxyQueueMode` | `'failover-queue' \| 'all-providers' \| 'custom'` | `'failover-queue'` | 队列模式（见 **5.5.2**） |
| `proxyAllowProviderIds` | `string[]` | `null` | 白名单（`custom` 时使用） |
| `proxyDenyProviderIds` | `string[]` | `null` | 黑名单（可与白名单组合） |
| `appFailoverEnabled` | boolean |（见合并规则）| app-proxy 是否启用自动切换（可默认跟随运营开关） |
| `appBreakerEnabled` | boolean | `true` | app-proxy 是否启用熔断 |
| `breakerConfig` | object |（见 5.6）| `failureThreshold/openDurationMs/...` |
| `retryConfig` | object |（见 5.7）| `maxAttempts/commitDelayMs/commitBytes/...` |

兼容旧字段（建议在合并层统一映射）：

- `proxyEnabled = template.proxyEnabled ?? Boolean(template.useCCSwitchProxy)`（旧模板常用 `useCCSwitchProxy`）
- `proxyImplementation = template.proxyImplementation ?? (template.useCCSwitchProxy ? 'ccswitch' : 'app')`（避免旧模板语义变化）
- `requestedProviderId = trim(template.ccSwitchProviderId)`（保持不变）

### 4.2 计算 CC Switch proxy 能力

```text
proxyCfg = snapshot.proxy[proxyAppKey]  // opencode -> codex

serverEnabled = proxyCfg ? proxyCfg.proxyEnabled : null
appEnabled =
  proxyCfg has key 'enabled' ? Boolean(proxyCfg.enabled)
  : proxyCfg has key 'proxyEnabled' ? Boolean(proxyCfg.proxyEnabled)
  : null

autoFailoverEnabled = proxyCfg ? Boolean(proxyCfg.autoFailoverEnabled) : null
listenOrigin = proxyCfg ? buildProxyOrigin(proxyCfg.listenAddress, proxyCfg.listenPort) : null
openAIBase = listenOrigin ? listenOrigin + '/v1' : null
```

> 注意：  
> - **熔断/降级要成立**，通常需要 `serverEnabled && appEnabled && autoFailoverEnabled`。  
> - “是否可用”与“是否想用”要分开（want vs can）。
> - 这组开关不仅用于判断“CC Switch Proxy 是否可用”，也可以（可选）作为 **app-proxy 的运营开关**（见 4.3/5.6.1）。

### 4.3 合并：决定走哪条链路

```text
// 1) 读模板选项（含兼容映射）
proxyEnabled = template.proxyEnabled ?? Boolean(template.useCCSwitchProxy)
proxyImplementation =
  template.proxyImplementation ?? (template.useCCSwitchProxy ? 'ccswitch' : 'app')
respectCC = (template.respectCCSwitchProxyConfig !== false) // current default true（建议生产默认 false；见 5.6.1）
queueMode = template.proxyQueueMode ?? 'failover-queue'

// 2) 构建上游队列（把 CC Switch providers 融入本地 proxy 队列）
providers = snapshot.apps[appKey].providers
orderedProviderIds = buildQueueFromCCSwitchProviders(
  providers,
  requestedProviderId = trim(template.ccSwitchProviderId),
  currentProviderId = trim(snapshot.apps[appKey].currentId),
  queueMode,
  allow = template.proxyAllowProviderIds,
  deny = template.proxyDenyProviderIds
)
appProxyOk = Array.isArray(orderedProviderIds) && orderedProviderIds.length > 0

// CC Switch proxy 能力（用于可选的“委托给 CC Switch”模式）
ccProxyOk = (serverEnabled === true) && (appEnabled === true) && (listenOrigin != null)
ccFailoverOk = ccProxyOk && (autoFailoverEnabled === true)

// 3) 将 CC Switch proxy_config 融入“是否启用代理/是否启用 failover”（可选，但很实用）
// - enabled: 作为“是否启用代理”的运营开关（app-proxy/ccswitch-proxy 都受控）
// - auto_failover_enabled: 作为“是否启用 failover/熔断”的运营开关（主要影响 app-proxy）
proxyAllowedByCC = (appEnabled == null) ? true : (appEnabled === true)
failoverAllowedByCC = (autoFailoverEnabled == null) ? true : (autoFailoverEnabled === true)
effectiveProxyEnabled = proxyEnabled && (respectCC ? proxyAllowedByCC : true)

appFailoverEnabled =
  template.appFailoverEnabled != null
    ? Boolean(template.appFailoverEnabled)
    : (respectCC ? failoverAllowedByCC : true)

appBreakerEnabled =
  template.appBreakerEnabled != null
    ? Boolean(template.appBreakerEnabled)
    : true

// 4) 选择 routeMode（优先遵循 proxyImplementation；不满足条件则降级）
if !effectiveProxyEnabled || proxyImplementation == 'off':
  routeMode = 'direct'
  circuitBreakerMode = 'off'
else if proxyImplementation == 'ccswitch' && ccProxyOk:
  routeMode = 'ccswitch-proxy'
  circuitBreakerMode = ccFailoverOk ? 'ccswitch' : 'off'
else if proxyImplementation == 'app' && appProxyOk:
  routeMode = 'app-proxy'
  circuitBreakerMode = (appFailoverEnabled || appBreakerEnabled) ? 'app' : 'off'
else:
  routeMode = 'direct'
  circuitBreakerMode = 'off'
```

> 说明：  
> - 这里把“是否走代理”（`proxyEnabled`）与“走哪种代理”（`proxyImplementation`）拆开，避免旧字段语义混淆。  
> - “把 CC Switch 配置融入本地代理队列和熔断”主要体现在两点：  
>   1) **队列**：从 `snapshot.apps[appKey].providers` 生成 `orderedProviderIds`（见 5.5.2）  
>   2) **开关**：（谨慎）可选 `respectCCSwitchProxyConfig=true`，用 `proxy_config.enabled/auto_failover_enabled` 控制本地代理的启用与 failover（见 5.6.1/第 9 节第 2 点；更推荐独立字段如 `app_proxy_enabled`）

---

## 5. 推荐落地：应用内置 Proxy（应用级熔断/Failover；MultipleShell 主进程示例）

适用：你希望把“代理 + 熔断/降级/切换”能力收敛在**你的应用主进程**里（MultipleShell 示例在 `src/main`），不依赖 CC Switch proxy 的发版与开关。

### 5.1 运行形态（整体链路）

**终端客户端（Claude Code / Codex / OpenCode） → 应用内置 Proxy → 真实上游 provider**

- Proxy 只监听 `127.0.0.1`（或 `localhost`），避免局域网暴露。
- Proxy 负责两件事：
  1) **路由**：按 failover 队列挑选 provider 并转发请求
  2) **熔断/降级**：对连续失败的 provider 临时断开，自动切换到下一个

### 5.2 合并配置后，如何改写客户端配置（关键）

目标：**把“真实上游的 base_url + 秘钥”从客户端配置里拿掉**，客户端只连本地 Proxy，避免秘钥泄露到终端环境；Proxy 再在内存里注入真实鉴权并转发。

推荐占位值：统一使用 `apiKey/token = "mps-proxy"`（或 `"ccswitch"`），仅用于让客户端通过自身校验，真实鉴权由 Proxy 注入。

#### 5.2.1 Codex（OpenAI-compatible）

- 将 `codexConfigToml` 的 `base_url` 重写为：`http://127.0.0.1:<mpsPort>/v1`
- 将 `codexAuthJson` 的 key 重写为占位：`OPENAI_API_KEY="mps-proxy"`（以及常见变体 `api_key/openai_api_key`）
- 可选：在 `extraEnv` 写入 `OPENAI_BASE_URL/OPENAI_API_BASE` 为同一地址（兼容不同实现）

#### 5.2.2 OpenCode（OpenAI-compatible）

- 将 provider fragment 的 `options.baseURL` 指向：`http://127.0.0.1:<mpsPort>/v1`
- 将 `options.apiKey` 设为占位：`"mps-proxy"`

#### 5.2.3 Claude Code（Anthropic-compatible）

- 将 settings.json 的环境变量改写：
  - `ANTHROPIC_BASE_URL = http://127.0.0.1:<mpsPort>`
  - `ANTHROPIC_AUTH_TOKEN = mps-proxy`（占位）
- Proxy 侧用真实 provider token 覆盖 `x-api-key`（或 Authorization，视上游而定）

> 接入点建议：仍然在 `src/main/pty-manager.js` 的 `resolveCCSwitchRuntimeConfig()` 内做上述改写（保持“仅对 CC Switch 导入模板重写”的安全边界）。

### 5.3 Provider 抽象：Proxy 需要哪些上游信息

Proxy 对每个 provider 至少需要：
- `id/name`（用于日志与状态）
- `priority`（failover 队列优先级）
- `upstreamBaseUrl`（真实上游地址）
- `upstreamHeaders`（真实鉴权头：Authorization/x-api-key/自定义 headers）

建议数据源：复用 `ccSwitch.listProviders()` 的 snapshot：
- `snapshot.apps[appKey].providers[]`（含 `inFailoverQueue/sortIndex/settingsConfig`）

### 5.4 从 CC Switch provider.settingsConfig 提取上游信息（建议实现策略）

> 原则：优先做“足够好”的解析（覆盖 80%），剩下做可扩展点，而不是一次性做全量 TOML/协议转换。

#### 5.4.1 OpenAI-compatible（Codex / OpenCode）

**base_url 提取**
- 优先：从 `settingsConfig.config`（TOML）里读取 `base_url="..."`（本仓库已有同风格正则用于重写 `base_url`）。
- 兼容：若拿不到 `base_url`，允许从 provider endpoints 或已知默认值回退（视产品约束）。

**鉴权提取（headers）**
- 优先：解析 TOML 中的以下字段并从 `settingsConfig.auth` 或 `process.env` 取值：
  - `bearer_token_env_var = "XXX"` → `Authorization: Bearer <value>`
  - `env_key = "XXX"` → 通常等价于 API Key（按你的上游实现映射）
  - `env_http_headers = { "Header-Name" = "ENV_NAME" }` → 逐个注入 header
- 简化兜底：若上面解析不到，尝试从 `settingsConfig.auth.OPENAI_API_KEY` / `api_key` 等常见字段取值并转成 `Authorization: Bearer`。

#### 5.4.2 Anthropic-compatible（Claude Code）

建议直接复用 CC Switch provider settings 里的 env 形态：
- `ANTHROPIC_BASE_URL`：真实上游 origin（如 `https://api.anthropic.com`）
- `ANTHROPIC_AUTH_TOKEN`：真实 token（用于 `x-api-key`）

Proxy 转发时：
- 将客户端传来的 `x-api-key`/`Authorization` 覆盖为真实值（避免占位值被透传到上游）。
- 其它 headers（`anthropic-version` 等）透传。

### 5.5 Failover 队列（与 CC Switch 对齐）

队列定义：
1. 过滤：`in_failover_queue = true`
2. 排序：`ORDER BY COALESCE(sort_index, 999999), id ASC`

> 本仓库已有同规则实现（前端）：`src/renderer/utils/ccswitch-status.mjs` → `computeFailoverPriorityByProviderId()`

#### 5.5.1 “无感切换”的前提：队列内要协议/模型兼容

Failover 想“无感”，队列里的 provider 至少要做到：
- **同协议**：你转发的是 OpenAI-compatible `/v1/*` 还是 Anthropic-compatible `/v1/*`，要一致  
- **同接口能力**：例如 Codex 走 `responses`，但某些上游只支持 `chat.completions`，会直接 404/405/400  
- **同模型命名**：请求里 `model=...` 必须在所有候选 provider 上都可用，否则会出现“切换后仍失败”

工程化建议（建议组合）：
（推荐）在队列构建阶段强制校验协议一致性/接口能力/模型命名；不兼容 provider 直接剔除并记录 warning。
1) **运营约束**：只把“确定兼容”的 provider 放进 `in_failover_queue`（最简单、最稳）。  
2) **能力探测/缓存（可选）**：启动时或定期探测 provider 是否支持某些路径（如 `/v1/models`、`/v1/responses`），把结果缓存在内存里，路由时按能力过滤候选集。  
3) **把一部分 4xx 也当作可切换错误（谨慎）**：例如明确识别“endpoint not found / method not allowed / model not found”后，允许切下一个 provider；但这通常要依赖错误字符串或 provider 特性，容易误判。

#### 5.5.2 把 CC Switch providers 融入本地 Proxy 队列（推荐算法）

本地 Proxy 的“上游候选集 + 顺序”建议完全复用 CC Switch 的 providers 配置，这样运营侧只需要在 CC Switch 里维护一次。

输入（概念）：
- `providers = snapshot.apps[appKey].providers[]`
- `requestedProviderId = template.ccSwitchProviderId`（可选）
- `currentProviderId = snapshot.apps[appKey].currentId`（可选）

推荐生成顺序（概念）：

1) **先生成 failoverOrdered（Failover 候选的有序列表）**
   - 过滤：`in_failover_queue = true`
   - 排序：`COALESCE(sort_index, 999999)` 升序，然后 `id` 升序

2) **选 primary（首选上游）**
   - 若 `requestedProviderId` 存在且在列表里：primary = requestedProviderId
   - 否则若 `currentProviderId` 存在且在列表里：primary = currentProviderId
   - 否则：primary = `failoverOrdered[0].id ?? providers[0].id`

3) **生成 failoverCandidates（自动切换候选）**
   - `failoverCandidates = failoverOrdered` 去掉 primary（避免重复）

4) **合成 orderedProviderIds（按 `proxyQueueMode`）**
   - `failover-queue`（默认）：`[primary] + failoverCandidates`
   - `all-providers`：`[primary] + (providers 中除 primary 外的其它 provider，按 failoverPriority 或 id 排序)`
   - `custom`：在上述结果基础上应用 `allow/deny`（白名单优先），若 primary 被过滤则改用第一项作为 primary

> 注意：  
> - primary 不必在 failover 队列里；它可以是 current provider 或用户指定 provider；failoverCandidates 才严格遵循 `in_failover_queue`。  
> - 队列里的 provider 必须协议/模型兼容（见 5.5.1）。

### 5.6 熔断器（Circuit Breaker）最小实现（Proxy 内部）

每个 provider 维护：
- `mode: closed | open | half_open`
- `consecutiveFailures`
- `openedAt`
- `halfOpenInFlight`
- `lastFailureAt/lastFailureReason`（可观测）

默认参数建议：
- `failureThreshold=3`
- `openDurationMs=60_000`
- `halfOpenMaxInFlight=1`
- `successToClose=1`
- `upstreamTimeoutMs=30_000`

失败计入熔断（建议）：
- 网络错误 / 超时
- HTTP：`408/429/5xx`
- 流式：在“尚未向客户端写出任何响应字节（含 headers/body chunk）”之前断开

#### 5.6.1 将 CC Switch proxy_config 融入本地熔断/Failover（谨慎：语义混淆风险）

`proxy_config` 原本是 “CC Switch Proxy” 的配置表。把它复用为 app-proxy 的“运营开关”虽然方便，但语义很容易混淆，常见风险包括：

- CC Switch 侧把 `enabled` 当成“控制自己的 proxy”，却意外影响应用内的 proxy/failover
- 两套系统的操作人员可能不是同一个人，权限与变更流程不同

更推荐的做法（建议）：

- 在 CC Switch 新增独立字段（例如 `app_proxy_enabled`、`app_auto_failover_enabled`），或单独建表 `app_proxy_policy`，明确它控制的是“应用内 proxy/breaker”
- UI/文档用明确命名展示（避免“开关 CC Switch proxy”与“开关应用代理”混在一起）

如果短期仍需要复用 `proxy_config`（过渡方案），建议至少明确以下映射关系：

- `enabled`：作为“是否允许开启代理”的开关（影响 routeMode 是否允许进入 `app-proxy/ccswitch-proxy`）
- `auto_failover_enabled`：作为“是否允许启用 failover/熔断”的开关（影响 `appFailoverEnabled/appBreakerEnabled` 默认值）
- `proxy_enabled`：可作为全局 kill switch（可选）

建议：

- 不要把该行为默认打开；建议用显式开关 `respectCCSwitchProxyConfig=true` 才启用（生产环境更推荐默认 `false`）
- 用户在模板里显式写了 `appFailoverEnabled/appBreakerEnabled` 时优先模板；否则才跟随运营开关
- 熔断参数（阈值/冷却时间/半开并发等）仍由本地配置决定；如需运营可调，建议独立字段/表，而不是继续借用 `proxy_config`

### 5.7 转发实现要点（避免踩坑）

#### 5.7.1 先定义清楚：什么叫“无感切换”

“无感”通常有 3 个层级，**能做到的边界不一样**：

1) **无感（对用户操作）**：用户不需要手动切 provider（自动熔断/自动 failover）。  
2) **无感（对一次请求的结果）**：请求不报错，最终能返回成功结果（对客户端透明）。  
3) **无感（对流式输出连续性）**：已经开始 stream/SSE 输出后，上游挂了仍能继续输出且内容无断裂/不重复。

其中：
- (1) 很容易：熔断 + 选队列即可。  
- (2) 可做到，但前提是 **失败发生在你还没向客户端写出任何响应（headers/body）之前**。  
- (3) **几乎做不到严格无感**（协议/语义/计费/内容一致性都无法保证）。你只能做“近似无感”，要接受取舍（延迟/成本/一致性）。

#### 5.7.2 只做“安全重试”

强烈建议每个请求最多尝试 2 个 provider（原始 + failover 1 次）：
- 仅当 **还没向客户端写出任何响应** 时，才允许切换到下一个 provider 重试
- 一旦开始 stream/SSE 输出：**不重试**（避免内容断裂/重复计费/协议混乱）

实现时建议维护：
- `hasWrittenToClient`（写了 headers 或任何 chunk 即置 true）

#### 5.7.3 要“更无感”：加一个“提交窗口”（buffer-before-commit）

如果你希望在流式场景下“尽量无感”，推荐的工程化方案是：

- **不要立刻把上游的第一个字节写给客户端**，而是先在 Proxy 里做一个很短的缓冲窗口；
- 只要上游在这个窗口内失败，你就可以 failover 重试并保持对客户端“无感”；
- 一旦窗口结束并把数据写给客户端（commit），后续再失败就无法完全无感（最多做到“下次请求自动走新 provider”）。

推荐参数（可配置）：
- `commitDelayMs`: 200~500ms（窗口时间）
- `commitBytes`: 4~16KB（窗口大小，上游先到哪条就触发 commit）
- `maxAttempts`: 2（最多尝试两个 provider，避免雪崩/重复计费）

伪流程（概念）：

```text
attempt(provider):
  buffer = []
  committed = false
  start upstream request
  while receiving upstream chunks:
    if !committed:
      buffer.push(chunk)
      if elapsed >= commitDelayMs OR bufferedBytes >= commitBytes:
        write response headers to client
        flush(buffer) to client
        committed = true
    else:
      write chunk to client

  if upstream ends OK:
    ensure committed (flush remaining buffer)
    return success

  if upstream fails:
    if !committed:
      return retry with next provider (无感)
    else:
      return error (无法严格无感)
```

取舍：commit 窗口会让“首字节延迟”变大，但换来“早期故障可无感切换”。

#### 5.7.4 不推荐：Hedged Requests（对冲请求）

对冲请求在 LLM API 场景下成本极高（可能双倍 token 计费），并且 streaming/SSE 很难在“已开始写出后”真正取消另一个请求以避免计费。

因此：除非你有非常明确的成本/限流/计费控制策略，否则不建议把 Hedged Requests 纳入本方案。若一定要做，请确保：

- 默认关闭，仅对少量高价值请求开启
- 有严格的并发/速率限制与预算控制，并把成本与命中率做成可观测指标

#### 5.7.5 透传优先：不要做协议转换

- OpenAI-compatible：透传 `/v1/*`（包含 streaming）
- Anthropic-compatible：透传 `/v1/*`（包含 streaming）
- 不解析/不重写 JSON body，只做 headers 注入与 base URL 路由

#### 5.7.6 Hop-by-hop headers 处理

转发时建议移除或重置：`connection/keep-alive/transfer-encoding/upgrade/host` 等 hop-by-hop headers，避免 Node 代理行为异常。

#### 5.7.7 幂等与重复计费（必须写进设计）

只要你做“同一请求的重试/切换”，就存在：
- 可能在上游侧已经受理但你没收到响应（导致重复计费/重复执行）
- 不同 provider 的输出不一致（尤其是生成式输出）

工程建议：
- **严格限制重试次数**（推荐最多 1 次 failover）  
- 尽可能只在“连接失败/超时/未写出任何响应字节”时重试  
- 若上游支持幂等 key（Idempotency-Key / request-id），Proxy 统一注入同一个请求 id（并在日志中记录）  
- 若请求包含“工具调用/写操作”，尽量不要自动重试（或按 endpoint 白名单控制）

### 5.8 可观测与调试接口（建议）

1) `GET /__status`：返回
- 监听地址与端口
- 每个 appKey 的 providers 队列
- 每个 provider 的 breaker 状态（open remaining、失败次数、最近失败原因）

2) 响应 headers 增强（便于排查）：
- `X-MPS-Provider: <providerId>`
- `X-MPS-Failover: 0|1`
- `X-MPS-Failover-From: <providerId>`（当发生切换）

### 5.9 多会话/多标签页的“按会话隔离”（可选增强）

默认实现可以是“按 appKey 全局一套队列”。若你需要不同标签页用不同 provider 集合/起始 provider：

- 方案：在 baseURL 里编码 `sessionId`：
  - Codex/OpenCode：`http://127.0.0.1:<mpsPort>/s/<sessionId>/v1`
  - Claude：`http://127.0.0.1:<mpsPort>/s/<sessionId>`
- Proxy 内维护 `sessionId -> { appKey, preferredProviderId, allowFailoverProviders }` 的映射

这样每个终端 tab 可以拥有独立的路由策略。

### 5.10 安全建议（必须）

- 只监听 `127.0.0.1`；不要监听 `0.0.0.0`
- 不在磁盘/终端环境写入真实上游 token（占位即可）
- 日志对 token 做脱敏（不要输出 header 值）
- 如担心本机其他进程滥用，可增加一个随机生成的 `proxySecret` 并要求请求携带（例如 query/header），并在 baseURL 中编码或由环境变量注入

### 5.11 热更新与生命周期管理（必须讨论）

真正落地时需要明确“快照变更如何生效”，否则线上会出现“配置变了但进程不认”“请求打到已下线 provider”等问题：

- **快照感知**：CC Switch 快照变化后（provider 增删、开关切换），Proxy 如何感知？轮询（pull）还是订阅（push）？变更延迟要求是什么？
- **生效边界**：不做“流式中途切换”；建议让**正在进行的请求按旧 policy 跑完**，新的请求再应用新 policy（并记录切换点用于排查）。
- **队列与 breaker 状态**：provider 新增/删除/排序变化时如何处理已有 breaker 状态（建议按 `providerId` key 做清理与初始化，并记录 warning）。
- **端口与启动失败**：端口冲突、启动失败时给出明确错误与用户提示；必要时自动选择空闲端口并更新客户端 baseURL。
- **生命周期**：何时启动/关闭本地 Proxy（随会话启动/全局常驻/空闲超时退出），避免“无会话却占用端口”的问题。

---

## 6. 推荐的最小交付清单（按优先级）

1) **增加模板/UI 选项**：`proxyEnabled/proxyImplementation/...`（见 4.1.1），并实现旧字段兼容映射。  
2) **把合并逻辑收敛成一个函数/模块**：输出 `EffectiveProxyPolicy`（包含队列 `orderedProviderIds` 与 `appFailover/appBreaker`）。  
3) **实现/启动内置 Proxy**：只监听 `127.0.0.1`，提供 `origin` 与 `openAIBase(/v1)`。  
4) **在 `resolveCCSwitchRuntimeConfig()` 里接入**：当 `routeMode='app-proxy'` 改写三类客户端 baseURL，并写占位 token。  
5) **实现“CC Switch 队列 + 本地熔断/Failover”**：队列按 `in_failover_queue/sort_index/currentId` 生成（见 5.5.2），熔断按 provider 维度维护（见 5.6）。  
6) **实现安全重试 + 可观测**：安全重试（未写出前才切换一次）+ `GET /__status` + `X-MPS-*` headers + 脱敏日志。

---

## 7. 验收用例（建议）

- 基础：开启“走代理”的 CC Switch 导入模板后（例如 `proxyEnabled=true && proxyImplementation='app'`；或旧模板 `useCCSwitchProxy=true` 但你映射到 app-proxy），客户端实际 baseURL 指向内置 Proxy（而不是上游真实地址）。  
- 故障注入：对某个 provider 人为制造 `429/timeout/5xx`：
  - 在 `failureThreshold` 次内触发熔断并切到下一个 provider
  - 熔断期间不再选择该 provider
  - 冷却到期后 half-open 试探成功则恢复 closed
- 可靠性：流式输出中途断开时，不进行“流中切换”，而是让本次请求失败并在下一次请求时自动走新的 provider。  
- 可观测：`/__status` 能看到每个 provider 的 breaker 状态、剩余熔断时间、最近失败原因；响应头能看到实际使用的 providerId。

---

## 8. 迁移到你自己的应用（通用落地模板）

如果你的目标是“在自己的应用里做本地代理 + 熔断/自动切换”，并且**不希望依赖 CC Switch Proxy（数据面）**，你仍然可以继续使用 CC Switch 作为**控制面**（providers + proxy_config）。建议把落地拆成 4 个可复用模块（你可以用任意语言/框架实现）：

1) **Policy Merge（合并策略）**  
   - 输入：用户配置（`proxyEnabled/proxyImplementation/...`）、CC Switch 快照：`providers + proxy_config`（含 failover 队列与运营开关）。  
   - 输出：`EffectiveProxyPolicy`（`routeMode/circuitBreakerMode` + 本地 proxy 的 `origin/openAIBase` + `orderedProviderIds` + breaker/retry 参数）。

2) **Client Config Rewriter（客户端配置改写）**  
   - 目标：客户端只连本地 proxy；token 使用占位；真实 token 只在 proxy 进程/内存里注入。  
   - OpenAI-compatible：`base_url -> http://127.0.0.1:<port>/v1`，`apiKey -> "mps-proxy"`  
   - Anthropic-compatible：`ANTHROPIC_BASE_URL -> http://127.0.0.1:<port>`，`ANTHROPIC_AUTH_TOKEN -> "mps-proxy"`

3) **Local Proxy Server（本地代理）**  
   - 只监听 `127.0.0.1`。  
   - 透传请求/响应（包含 streaming/SSE），不做 JSON body 协议转换（只做路由 + headers 注入）。  
   - 增强可观测：响应头写 `X-Provider/X-Failover`，并提供 `GET /__status` 返回路由与 breaker 状态。

4) **Router + Circuit Breaker（路由 + 熔断 + failover）**  
   - 按 appKey 获取候选队列（排序规则见 5.5.2）。  
   - 跳过 `breaker=open` 的 provider，选择下一个。  
   - 失败计入熔断（超时/网络错误/`408/429/5xx` 等，见 5.6），冷却后 half-open 试探。  
   - “安全重试”：只在**尚未向客户端写出任何响应字节**前允许切换到下一个 provider（建议 `maxAttempts=2`）。

### 8.1 最小接口（建议）

你在工程里可以把接口收敛成下面几类对象（便于单测与替换实现）：

```ts
type Provider = {
  id: string
  upstreamBaseUrl: string
  upstreamHeaders: Record<string, string>
  priority: number
}

type BreakerState = {
  mode: 'closed' | 'open' | 'half_open'
  consecutiveFailures: number
  openedAt: number | null
}

type Breaker = {
  allow: (providerId: string) => boolean
  onSuccess: (providerId: string) => void
  onFailure: (providerId: string, reason: unknown) => void
  getState: (providerId: string) => BreakerState
}

type Router = {
  queue: (appKey: string) => Provider[]
  pick: (appKey: string, triedProviderIds: Set<string>, breaker: Breaker) => Provider | null
}
```

### 8.2 请求处理伪流程（安全重试 + 熔断）

```text
appKey = resolveAppKey(req)
candidates = router.queue(appKey)
tried = {}
attempts = 0

while attempts < maxAttempts:
  p = router.pick(appKey, tried, breaker)
  if p == null: break

  tried.add(p.id)
  if !breaker.allow(p.id): continue

  hasWrittenToClient = false
  try:
    forward(req, res, p, onWriteToClient=()=>hasWrittenToClient=true, timeoutMs)
    breaker.onSuccess(p.id)
    return
  catch err:
    breaker.onFailure(p.id, err)
    if hasWrittenToClient: throw err
    attempts += 1

respond 503 (no upstream available)
```

> 如果你想在 streaming 场景尽量“更无感”：参考 5.7.3 的 `buffer-before-commit`（提交窗口）策略；否则建议保持“只做安全重试”。

### 8.3 配置字段命名建议（避免语义混淆）

本仓库当前使用 `useCCSwitchProxy`，历史语义偏向“让客户端直连 CC Switch Proxy”。当你要做“应用内置 proxy”时，建议不要直接复用该字段：

 - 推荐：`proxyEnabled=true/false` + `proxyImplementation='app'|'ccswitch'|'off'`（谨慎使用 `respectCCSwitchProxyConfig`；更推荐在 CC Switch 增加独立字段；见 5.6.1/第 9 节第 2 点）
- 或新增：`useAppProxy`，保留 `useCCSwitchProxy` 的原语义（便于兼容旧模板与 UI 文案）

---

## 9. 问题与风险

1. **过度抽象，配置膨胀严重**  
   `EffectiveProxyPolicy` 类型有 30+ 个字段，模板新增选项有 10 个（4.1.1 节表格）。对一个“代理 + 熔断”功能来说，这个配置面太大了。实际使用时大部分用户只需要：  
   - 是否走代理  
   - 队列是什么  
   - 熔断参数用默认值  
   建议：先只暴露 2~3 个用户可见选项（例如 `proxyEnabled` + `proxyImplementation`），其余全部用合理默认值内部处理，不作为模板字段。

2. **respectCCSwitchProxyConfig 语义容易混淆**  
   把 CC Switch Proxy 的配置表（`proxy_config`）复用为 app-proxy 的“运营开关”，文档在 5.6.1 也提到了这个风险。这种“借用别人的字段控制自己的行为”会导致：  
   - CC Switch 侧改了 `enabled` 本意是控制自己的 proxy，却意外关掉了应用的 proxy  
   - 两个系统的操作人员可能不是同一个人  
   建议：如果需要远程开关，应该在 CC Switch 中新增独立字段（如 `app_proxy_enabled`），而非复用现有字段。

3. **队列构建逻辑（5.5.2）中 primary 选择过于复杂**  
   4 级 fallback（`requestedProviderId → currentProviderId → is_current=true → providers[0]`）增加了排查难度。  
   建议简化为 2 级：用户指定 > CC Switch current，其余情况直接用队列首位。

4. **缺少热更新和生命周期管理的讨论**  
   - CC Switch 快照变化后（provider 增删、enabled 开关切换），正在运行的 proxy 如何感知？需要轮询还是推送？  
   - 队列变更时正在进行的请求如何处理？  
   - Proxy 端口冲突、启动失败时的错误处理和用户提示  
   这些是落地时必须解决的问题，但文档之前没有涉及。

5. **多协议兼容性被低估**  
   5.5.1 提到队列内 provider 需要“同协议、同接口能力、同模型命名”，但只给了“运营约束”这个建议。实际上这是 failover 能否真正“无感”的核心前提条件。如果队列里混入了不兼容的 provider，熔断切换后仍然会失败，用户体验反而更差（连续失败 → 所有 provider 都被熔断 → 完全不可用）。  
   建议：在队列构建阶段强制校验协议一致性，不兼容的 provider 直接剔除并记录警告。

6. **Hedged Requests（5.7.4）不建议纳入**  
   对冲请求在 LLM API 场景下成本极高（token 计费是双倍），且流式响应难以取消已产生的计费。放在文档里会给实现者造成“应该做”的暗示。建议删除或明确标注为“不推荐”。

---

## 附录：如果你仍想把熔断放到 CC Switch Proxy

当 `proxy_enabled && enabled && auto_failover_enabled` 都为 true 时，仍可选择 `routeMode='ccswitch-proxy'`，把熔断/降级交给 CC Switch。实现细节参考：
- `CCSWITCH_CODEX_CIRCUIT_BREAKER_PLAN_ZH.md`
- `CCSWITCH_CODEX_FAILOVER_A_IMPLEMENTATION_ZH.md`
