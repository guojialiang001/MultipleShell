export default {
  common: {
    close: '关闭',
    cancel: '取消'
  },
  menu: {
    settings: '设置',
    manageTemplates: '管理模板',
    language: '语言'
  },
  language: {
    en: 'English',
    zhCN: '中文'
  },
  app: {
    noActiveTerminals: '没有活动终端',
    pressCtrlT: '按 {shortcut} 开始新会话',
    newTerminal: '新建终端'
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
    titleSelectTemplate: '选择模板',
    titleManageTemplates: '管理模板',
    titleEditTabConfig: '编辑标签配置',
    manage: '管理',
    back: '返回',
    close: '关闭',
    availableTemplates: '可用模板',
    workingDirectory: '工作目录',
    defaultCwd: '默认：{default}',
    userProfile: '用户目录',
    browse: '浏览...',
    createNewTemplate: '新建模板',
    editCurrentTab: '编辑当前标签',
    createTerminal: '创建终端',
    edit: '编辑',
    delete: '删除',
    custom: '自定义',
    confirmDeleteTemplate: '删除模板“{name}”？'
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
  }
}
