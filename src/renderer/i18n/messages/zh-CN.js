export default {
  common: {
    close: '关闭',
    cancel: '取消'
  },
  menu: {
    settings: '设置',
    manageTemplates: '管理配置',
    language: '语言',
    modeShell: '终端',
    modeMonitor: '视图',
    modeRemote: '远程'
  },
  remote: {
    title: '远程访问',
    remoteAppEnabled: '启用 RemoteApp 快捷入口',
    clientIdBase64: '连接名 Base64 编码',
    baseUrl: '入口 URL（Guacamole）',
    baseUrlPlaceholder: '例如：https://remote.example.com/guacamole/',
    systemRdpPort: '系统 RDP 端口',
    systemRdpPortPlaceholder: '例如：3389',
    systemRdpPortInvalidHint: '端口需要为 1-65535 的整数',
    rdpConfigStatus: 'RDP 配置状态',
    rdpConfigured: '已启用',
    rdpNotConfigured: '未启用',
    remoteAppClientId: 'RemoteApp 连接名',
    remoteAppNamePlaceholder: '例如：MultipleShell (RemoteApp / 3389 / NLA)',
    remoteAppAliasLabel: 'RemoteApp 应用别名',
    vncClientId: 'VNC 连接名',
    vncNamePlaceholder: '例如：VNC :1',
    clientIdPlaceholder: '例如：MultipleShell (RemoteApp / 3389 / NLA)',
    hint: '直达链接形态：<入口URL>/#/client/c/<连接ID>（连接ID 可从浏览器地址栏获取；若你的连接名需要 Base64，可在设置里勾选“连接名 Base64 编码”）',
    openPortal: '打开入口',
    openRemoteApp: '打开 RemoteApp',
    openVnc: '打开 VNC',
    loadRdpConfig: '加载 RDP 配置',
    rdpMultiAppRunningHint: '检测到已启动 {count} 个 MultipleShell 实例。多应用启动可能导致 RemoteApp 无法正常启动，请先关闭多余实例后重试。',
    loading: '加载中...',
    loaded: '已加载',
    loadFailed: '加载失败',
    notConfigured: '请先在设置中配置入口 URL',
    remoteAppDisabledHint: 'RemoteApp 已在设置中关闭',
    missingClientIdHint: '请先填写连接名',
    copyLink: '复制链接',
    copied: '已复制',
    copyFailed: '复制失败',
    clearSettings: '清空远程配置',
    clearSettingsConfirm: '确定清空远程配置？',
    urlInvalidHint: '入口 URL 无效（需要以 http:// 或 https:// 开头）',
    urlHasSpacesHint: '入口 URL 包含空格',
    urlUnsupportedProtocolHint: '入口 URL 仅支持 http:// 或 https://',
    urlHttpWarningHint: '提示：建议使用 https://（当前为 http://）'
  },
  updates: {
    title: '\u66f4\u65b0',
    check: '\u68c0\u67e5\u66f4\u65b0',
    checking: '\u68c0\u67e5\u4e2d...',
    available: '\u53d1\u73b0\u66f4\u65b0',
    availableWithVersion: '\u53d1\u73b0\u65b0\u7248\u672c {version}',
    downloading: '\u4e0b\u8f7d\u4e2d {progress}%',
    downloaded: '\u91cd\u542f\u66f4\u65b0',
    latest: '\u5df2\u662f\u6700\u65b0',
    error: '\u66f4\u65b0\u5931\u8d25',
    disabled: '\u66f4\u65b0\u672a\u542f\u7528',
    actionCheck: '\u68c0\u67e5\u66f4\u65b0',
    actionRestart: '\u91cd\u542f\u5b89\u88c5\u66f4\u65b0'
  },
  language: {
    en: 'English',
    zhCN: '中文'
  },
  app: {
    noActiveTerminals: '没有活动终端',
    pressCtrlT: '按 {shortcut} 开始新会话',
    newTerminal: '新建终端',
    confirmExitTitle: '确认关闭应用？',
    confirmExitPrompt: '输入 {keyword} 关闭应用。',
    confirmExitPlaceholder: '输入 {keyword} 确认'
  },

  voice: {
    start: '语音输入',
    cancel: '取消',
    stop: '停止',
    preparing: '1秒后开始录音...',
    recording: '正在录音...',
    processing: '识别中...',
    done: '已写入命令行',
    noActiveTerminal: '没有活动终端',
    noResult: '没有识别结果',
    permissionDenied: '麦克风权限被拒绝',
    failed: '语音识别失败'
  },
  tabs: {
    newTabPlaceholder: '新标签...',
    untitled: '未命名',
    close: '关闭',
    newTabShortcut: '新标签 ({shortcut})',
    tab: '标签',
    confirmCloseTitle: '确认关闭标签？',
    confirmClosePrompt: '输入 {keyword} 关闭“{name}”。',
    confirmClosePlaceholder: '输入 {keyword} 确认',
    cwd: '当前目录'
  },
  configSelector: {
    titleSelectTemplate: '选择配置',
    titleManageTemplates: '管理配置',
    titleEditTabConfig: '编辑标签配置',
    manage: '管理配置',
    back: '返回',
    close: '关闭',
    availableTemplates: '可用配置',
    workingDirectory: '工作目录',
    defaultCwd: '默认：{default}',
    userProfile: '用户目录',
    browse: '浏览...',
    createNewTemplate: '新建配置',
    editCurrentTab: '编辑当前标签',
    createTerminal: '创建终端',
    edit: '编辑',
    delete: '删除',
    custom: '自定义',
    confirmDeleteTemplate: '删除配置“{name}”？'
  },
  configEditor: {
    titleEdit: '编辑配置',
    titleNew: '新建配置',
    type: '类型',
    name: '名称',
    configJson: '配置 JSON',
    claudeSettingsJson: 'Claude settings.json',
    codexConfigToml: 'Codex config.toml',
    codexAuthJson: 'Codex auth.json',
    opencodeConfigJson: 'OpenCode config.json',
    selectType: '选择类型...',
    cancel: '取消',
    saveConfiguration: '保存配置',
    placeholders: {
      name: '请输入名称'
    },
    errors: {
      selectType: '请选择一个类型。',
      enterName: '请输入名称。',
      invalidJson: 'JSON 无效：{message}',
      envRequired: '配置 JSON 必须包含一个 “env”（或 “ENV”）对象。',
      envMustBeObject: '“env” 必须是对象。',
      claudeSettingsJsonInvalid: 'settings.json 必须是合法 JSON：{message}',
      claudeSettingsJsonMustBeObject: 'settings.json 必须是 JSON 对象。',
      codexConfigTomlRequired: 'Codex 需要填写 config.toml 内容。',
      codexAuthJsonRequired: 'Codex 需要填写 auth.json 内容。',
      codexAuthJsonInvalid: 'auth.json 必须是合法 JSON：{message}'
    },
    autosave: {
      idle: '本地草稿',
      saving: '自动保存中...',
      saved: '已自动保存',
      error: '自动保存失败'
    },
    panel: {
      expand: '展开编辑',
      collapse: '收起编辑'
    },
    types: {
      claudeCode: 'Claude Code',
      codex: 'Codex',
      opencode: 'OpenCode'
    }
  },
  monitor: {
    title: '视图',
    open: '打开终端',
    collapse: '收起',
    expand: '展开',
    emptyTitle: '暂无会话',
    emptyHint: '创建终端会话后，这里会显示运行状态。',
    snapshotPending: '缩略图生成中...',
    settings: {
      title: '视图显示',
      modeCard: '卡片',
      modeTerminal: '视图',
      hint: '视图模式会增加资源开销；默认建议使用“卡片”。'
    },
    stats: {
      running: '运行中',
      completed: '完成',
      stuck: '卡住',
      error: '错误'
    },
    types: {
      claudeCode: 'Claude Code',
      codex: 'Codex',
      opencode: 'OpenCode'
    },
    status: {
      starting: '启动中',
      running: '运行中',
      idle: '空闲',
      completed: '完成',
      stuck: '卡住',
      error: '错误',
      stopped: '已停止'
    },
    card: {
      duration: '运行',
      sinceActive: '距活动',
      lines: '输出'
    }
  }
}
