export default {
  common: {
    close: 'Close',
    cancel: 'Cancel'
  },
  menu: {
    settings: 'Settings',
    manageTemplates: 'Manage templates',
    language: 'Language',
    modeShell: 'Shell',
    modeMonitor: 'View',
    modeRemote: 'Remote'
  },
  remote: {
    title: 'Remote Access',
    remoteAppEnabled: 'Enable RemoteApp shortcut',
    clientIdBase64: 'Base64-encode connection name',
    baseUrl: 'Portal URL (Guacamole)',
    baseUrlPlaceholder: 'e.g. https://remote.example.com/guacamole/',
    systemRdpPort: 'System RDP port',
    systemRdpPortPlaceholder: 'e.g. 3389',
    systemRdpPortInvalidHint: 'Port must be an integer between 1 and 65535',
    rdpConfigStatus: 'RDP config status',
    rdpConfigured: 'Enabled',
    rdpNotConfigured: 'Not enabled',
    remoteAppClientId: 'RemoteApp connection name',
    remoteAppNamePlaceholder: 'e.g. MultipleShell (RemoteApp / 3389 / NLA)',
    remoteAppAliasLabel: 'RemoteApp alias',
    vncClientId: 'VNC connection name',
    vncNamePlaceholder: 'e.g. VNC :1',
    clientIdPlaceholder: 'e.g. MultipleShell (RemoteApp / 3389 / NLA)',
    hint: 'Direct link: <PortalURL>/#/client/c/<connectionId> (copy <connectionId> from the browser address bar; enable Base64 if your connection name must be encoded)',
    openPortal: 'Open portal',
    openRemoteApp: 'Open RemoteApp',
    openVnc: 'Open VNC',
    loadRdpConfig: 'Load RDP config',
    rdpMultiAppRunningHint: 'Detected {count} running MultipleShell instance(s). Multi-instance launching may prevent RemoteApp from starting correctly. Close extra instances and try again.',
    loading: 'Loading...',
    loaded: 'Loaded',
    loadFailed: 'Load failed',
    notConfigured: 'Set the portal URL in Settings first',
    remoteAppDisabledHint: 'RemoteApp is disabled in Settings',
    missingClientIdHint: 'Set the connection name first',
    copyLink: 'Copy link',
    copied: 'Copied',
    copyFailed: 'Copy failed',
    clearSettings: 'Clear remote settings',
    clearSettingsConfirm: 'Clear remote settings?',
    urlInvalidHint: 'Invalid portal URL (must start with http:// or https://)',
    urlHasSpacesHint: 'Portal URL contains spaces',
    urlUnsupportedProtocolHint: 'Portal URL must use http:// or https://',
    urlHttpWarningHint: 'Prefer https:// (current: http://)'
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
    category: 'Category',
    ccswitchSectionTitle: 'CC Switch',
    manage: 'Manage',
    back: 'Back',
    importFromCCSwitch: 'Import from CC Switch',
    useCCSwitch: 'Use CC Switch',
    useCCSwitchProxy: 'Use CC Switch Proxy',
    onlyCCSwitchConfigs: 'Only CC Switch configs',
    ccswitchAutoDetect: 'Auto-detect (CC Switch)',
    ccswitchRefresh: 'Refresh',
    ccswitchStatus: 'CC Switch',
    ccswitchProxy: 'Proxy',
    ccswitchFailover: 'Failover',
    ccswitchDetecting: 'Detecting...',
    ccswitchEnabled: 'Enabled',
    ccswitchDisabled: 'Disabled',
    ccswitchUnknown: 'Unknown',
    close: 'Close',
    availableTemplates: 'Available Templates',
    emptyList: 'No templates in this category.',
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
    ccSwitchTitle: 'CC Switch',
    ccSwitchProviderId: 'CC Switch provider ID (optional)',
    ccSwitchProviderIdPlaceholder: 'Leave empty to follow CC Switch current provider',
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
  },
  monitor: {
    title: 'View',
    open: 'Open terminal',
    collapse: 'Collapse',
    expand: 'Expand',
    emptyTitle: 'No sessions',
    emptyHint: 'Create a terminal session to see live status here.',
    snapshotPending: 'Generating snapshot...',
    settings: {
      title: 'View Display',
      modeCard: 'Cards (summary)',
      modeTerminal: 'Terminal snapshot',
      hint: 'Terminal snapshots use more resources; keep the default cards mode unless you need it.'
    },
    stats: {
      running: 'Running',
      completed: 'Completed',
      stuck: 'Stuck',
      error: 'Error'
    },
    types: {
      claudeCode: 'Claude Code',
      codex: 'Codex',
      opencode: 'OpenCode'
    },
    status: {
      starting: 'Starting',
      running: 'Running',
      idle: 'Idle',
      completed: 'Completed',
      stuck: 'Stuck',
      error: 'Error',
      stopped: 'Stopped'
    },
    card: {
      duration: 'Uptime',
      sinceActive: 'Idle',
      lines: 'Lines'
    }
  }
}
