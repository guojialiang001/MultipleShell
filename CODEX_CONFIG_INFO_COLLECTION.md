# 让用户提交 `config.toml` + `auth.json` 信息的方案

## 目标

Codex 的系统配置需要从两个信息源提取：`config.toml`（配置）和 `auth.json`（认证）。本方案的目标是让用户在“可用 + 安全”的前提下，把这两份信息一次性提交给你用于排障/复现。

---

## 推荐方案：让用户生成“脱敏支持包”（最省沟通、风险最低）

你提供一段固定指引/脚本，让用户在本机把两个文件脱敏后导出，再把导出结果发给你。

1) 用户定位两个文件路径
- `config.toml`：Codex 的配置文件路径
- `auth.json`：Codex 的认证文件路径

2) 用户执行脱敏导出（PowerShell 示例）

```powershell
$ConfigPath = "C:\path\to\config.toml"
$AuthPath   = "C:\path\to\auth.json"
$OutDir     = Join-Path $env:TEMP ("codex-support-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Path $OutDir | Out-Null

# 1) config.toml：基于关键词做行级脱敏（TOML 无内置解析器时的稳妥做法）
$toml = Get-Content -Raw -LiteralPath $ConfigPath
$toml = $toml -replace '(?im)^(\s*.*(api[_-]?key|token|secret|password)\s*=\s*).*$','$1"***REDACTED***"'
$toml | Set-Content -LiteralPath (Join-Path $OutDir "config.redacted.toml") -Encoding UTF8

# 2) auth.json：结构化脱敏（优先）
$j = Get-Content -Raw -LiteralPath $AuthPath | ConvertFrom-Json
foreach ($k in @("token","access_token","refresh_token","api_key","secret","password")) {
  if ($j.PSObject.Properties.Name -contains $k) { $j.$k = "***REDACTED***" }
}
$j | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath (Join-Path $OutDir "auth.redacted.json") -Encoding UTF8

# 3) 附加环境信息（可选但强烈建议）
$diag = [ordered]@{
  os = (Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture)
  pwsh = $PSVersionTable
}
$diag | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $OutDir "env.json") -Encoding UTF8

Compress-Archive -Path (Join-Path $OutDir "*") -DestinationPath ($OutDir + ".zip")
Write-Host "Support bundle:" ($OutDir + ".zip")
```

3) 用户只提交生成的 `codex-support-*.zip`
- 里面包含：`config.redacted.toml`、`auth.redacted.json`、`env.json`
- 明确告知用户：不要直接发原始 `auth.json`（可能包含可用的 token）

为什么推荐这个方案
- 一次性拿到两份信息，减少来回追问
- 默认脱敏，降低泄漏风险
- 你拿到的是“可复现最小信息集”，便于自动化比对/解析

---

## 备选方案 A：让用户“直接上传两个文件”（仅适合私密渠道/企业内网）

适用场景：你们有安全的工单系统/私有 IM/加密邮箱，且用户明确同意传原始文件。

落地规则（建议在指引里写清楚）
- 只接受私密渠道；公共 issue/群聊一律拒绝
- 用户确认：`auth.json` 里可能是可用凭证，一旦泄漏需要立刻撤销/重置

---

## 备选方案 B：让用户“粘贴内容”但按模板提交（最通用）

适用场景：用户不会跑脚本、也不方便传文件。

你提供一个模板，让用户复制粘贴“必要字段”，并要求对敏感字段打码：

```text
1) config.toml（粘贴相关段落即可；包含：endpoint/model/proxy/feature flags；删除或打码 api_key/token/secret/password）
<paste here>

2) auth.json（只保留结构字段；token 一律替换为 "***REDACTED***"）
{
  "type": "...",
  "expires_at": "...",
  "token": "***REDACTED***"
}
```

为了避免信息不全，你可以在模板里把“必须项/可选项”写成清单：
- 必须：endpoint/base_url、model/provider、proxy（如果有）、认证类型（bearer/oauth/…）
- 可选：timeout、retries、TLS/证书相关开关、日志级别

---

## 脱敏规则（建议固定写死，减少争议）

永远不允许用户提交原文的字段/内容（出现就让用户重发脱敏版）：
- `token` / `access_token` / `refresh_token`
- `api_key`
- `secret` / `password`
- `Authorization: Bearer ...` 之类 header

允许提交（对排障有帮助且风险相对可控）：
- endpoint/base_url（如果是公司内网地址，视你们安全策略决定是否也脱敏）
- model/provider、超时/重试、代理开关、证书校验开关
- token 的“长度/前 4 后 4”（可选，用于判断是不是读错文件/截断）

---

## 产品化落地（如果你在应用里做“导出诊断信息”）

如果这是你自己的客户端/工具在引导用户提交信息，建议做成一个按钮/向导：
- UI：`导出诊断信息` -> 选择 `config.toml` 和 `auth.json` -> 自动脱敏 -> 生成 zip -> 一键复制/打开所在目录
- 校验：缺字段/格式错误立刻提示（比如 `auth.json` 不是 JSON、缺少认证类型字段等）
- 安全：默认只导出脱敏版；原始文件永不出包；提示用户不要在公开渠道分享


