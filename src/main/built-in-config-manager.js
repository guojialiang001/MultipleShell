const HARD_CODED_VOICE_API_KEY = 'sk-yyqmrkevamdfuilmfdlfmjzuatoytqlywfalkjkfrzkffvdr'

class BuiltInConfigManager {
  constructor() {
    this._apiKey = HARD_CODED_VOICE_API_KEY
  }

  getVoiceApiKey() {
    return this._apiKey
  }

  setVoiceApiKey() {
    this._apiKey = HARD_CODED_VOICE_API_KEY
  }
}

module.exports = new BuiltInConfigManager()
