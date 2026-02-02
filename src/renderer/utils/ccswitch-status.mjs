export const resolveCCSwitchProxyStatus = (proxyCfg) => {
  if (!proxyCfg || typeof proxyCfg !== 'object' || Array.isArray(proxyCfg)) {
    return { proxyEnabled: null, failoverEnabled: null }
  }

  // CC Switch proxy_config has both `proxy_enabled` (server-level) and `enabled` (app-level toggle).
  // Prefer the app-level toggle, but keep a small fallback for older snapshots.
  const enabled =
    Object.prototype.hasOwnProperty.call(proxyCfg, 'enabled')
      ? Boolean(proxyCfg.enabled)
      : Object.prototype.hasOwnProperty.call(proxyCfg, 'proxyEnabled')
        ? Boolean(proxyCfg.proxyEnabled)
        : null

  return {
    proxyEnabled: enabled,
    failoverEnabled: enabled == null ? null : Boolean(enabled && proxyCfg.autoFailoverEnabled)
  }
}

export const pickDefaultCCSwitchTemplate = (templates) => {
  if (!Array.isArray(templates) || templates.length === 0) return null

  const list = templates.filter((cfg) => cfg && typeof cfg === 'object' && !Array.isArray(cfg))
  if (list.length === 0) return null

  // Prefer proxy-based configs when the user is relying on CC Switch proxy.
  const proxyConfig = list.find((cfg) => Boolean(cfg.useCCSwitchProxy))
  if (proxyConfig) return proxyConfig

  const ccSwitchConfig = list.find((cfg) => Boolean(cfg.useCCSwitch))
  if (ccSwitchConfig) return ccSwitchConfig

  return list[0] || null
}

export const computeFailoverPriorityByProviderId = (providers) => {
  const out = {}
  if (!Array.isArray(providers) || providers.length === 0) return out

  // Match CC Switch's get_failover_queue ordering:
  // ORDER BY COALESCE(sort_index, 999999), id ASC
  const queue = providers
    .filter((p) => p && typeof p === 'object' && !Array.isArray(p) && p.inFailoverQueue)
    .map((p) => ({
      id: typeof p.id === 'string' ? p.id.trim() : '',
      sortIndex: p.sortIndex == null ? null : Number(p.sortIndex)
    }))
    .filter((p) => p.id)
    .sort((a, b) => {
      const aKey = Number.isFinite(a.sortIndex) ? a.sortIndex : 999999
      const bKey = Number.isFinite(b.sortIndex) ? b.sortIndex : 999999
      if (aKey !== bKey) return aKey - bKey
      return a.id.localeCompare(b.id)
    })

  let priority = 1
  for (const p of queue) out[p.id] = priority++
  return out
}
