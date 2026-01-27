export default {
  common: {
    close: 'Close',
    cancel: 'Cancel'
  },
  menu: {
    settings: 'Settings',
    manageTemplates: 'Manage templates',
    language: 'Language'
  },
  updates: {
    title: 'Updates',
    check: 'Check updates',
    checking: 'Checking...',
    available: 'Update available',
    availableWithVersion: 'Update {version}',
    downloading: 'Downloading {progress}%',
    downloaded: 'Restart to update',
    latest: 'Latest',
    error: 'Update failed',
    disabled: 'Updates off',
    actionCheck: 'Check for updates',
    actionRestart: 'Restart to install update'
  },
  language: {
    en: 'English',
    zhCN: 'Chinese (Simplified)'
  },
  app: {
    noActiveTerminals: 'No Active Terminals',
    pressCtrlT: 'Press {shortcut} to start a new session',
    newTerminal: 'New Terminal',
    confirmExitTitle: 'Close MultipleShell?',
    confirmExitPrompt: 'Type {keyword} to close the app.',
    confirmExitPlaceholder: 'Type {keyword} to confirm'
  },
  voice: {
    start: 'Voice Input',
    cancel: 'Cancel',
    stop: 'Stop',
    preparing: 'Starting in 1s...',
    recording: 'Listening...',
    processing: 'Transcribing...',
    done: 'Inserted into terminal',
    noActiveTerminal: 'No active terminal',
    noResult: 'No transcription result',
    permissionDenied: 'Microphone permission denied',
    failed: 'Voice transcription failed'
  },
  tabs: {
    newTabPlaceholder: 'New tab...',
    untitled: 'Untitled',
    close: 'Close',
    newTabShortcut: 'New tab ({shortcut})',
    tab: 'Tab',
    confirmCloseTitle: 'Close tab?',
    confirmClosePrompt: 'Type {keyword} to close "{name}".',
    confirmClosePlaceholder: 'Type {keyword} to confirm',
    cwd: 'CWD'
  },
  configSelector: {
    titleSelectTemplate: 'Select Template',
    titleManageTemplates: 'Manage Templates',
    titleEditTabConfig: 'Edit Tab Config',
    manage: 'Manage',
    back: 'Back',
    close: 'Close',
    availableTemplates: 'Available Templates',
    workingDirectory: 'Working Directory',
    defaultCwd: 'Default: {default}',
    userProfile: 'User Profile',
    browse: 'Browse...',
    createNewTemplate: 'Create New Template',
    editCurrentTab: 'Edit Current Tab',
    createTerminal: 'Create Terminal',
    edit: 'Edit',
    delete: 'Delete',
    custom: 'Custom',
    confirmDeleteTemplate: 'Delete template "{name}"?'
  },
  configEditor: {
    titleEdit: 'Edit Config',
    titleNew: 'New Config',
    type: 'Type',
    name: 'Name',
    configJson: 'Config JSON',
    claudeSettingsJson: 'Claude settings.json',
    codexConfigToml: 'Codex config.toml',
    codexAuthJson: 'Codex auth.json',
    opencodeConfigJson: 'OpenCode config.json',
    selectType: 'Select type...',
    cancel: 'Cancel',
    saveConfiguration: 'Save Configuration',
    placeholders: {
      name: 'e.g. Claude Code - Project A'
    },
    errors: {
      selectType: 'Please select a type.',
      enterName: 'Please enter a name.',
      invalidJson: 'Invalid JSON: {message}',
      envRequired: 'Config JSON must contain an "env" (or "ENV") object.',
      envMustBeObject: '"env" must be an object.',
      claudeSettingsJsonInvalid: 'settings.json must be valid JSON: {message}',
      claudeSettingsJsonMustBeObject: 'settings.json must be a JSON object.',
      codexConfigTomlRequired: 'Codex requires config.toml content.',
      codexAuthJsonRequired: 'Codex requires auth.json content.',
      codexAuthJsonInvalid: 'auth.json must be valid JSON: {message}'
    },
    autosave: {
      idle: 'Local draft',
      saving: 'Autosaving...',
      saved: 'Saved',
      error: 'Autosave failed'
    },
    panel: {
      expand: 'Expand editor',
      collapse: 'Collapse editor'
    },
    types: {
      claudeCode: 'Claude Code',
      codex: 'Codex',
      opencode: 'OpenCode'
    }
  }
}
