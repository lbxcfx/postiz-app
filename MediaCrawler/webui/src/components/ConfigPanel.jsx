import React, { useState, useEffect } from 'react'
import { Save, RefreshCw, Settings as SettingsIcon } from 'lucide-react'
import './ConfigPanel.css'

const ConfigPanel = () => {
  const [config, setConfig] = useState({
    saveDataOption: 'json',
    enableIPProxy: false,
    ipProxyPoolCount: 2,
    ipProxyProvider: 'kuaidaili',
    headless: false,
    saveLoginState: true,
    enableCdpMode: true,
    cdpDebugPort: 9222,
    cdpHeadless: false,
    autoCloseBrowser: true,
    startPage: 1,
    crawlerMaxNotesCount: 10,
    maxConcurrencyNum: 1,
    enableGetComments: false,
    crawlerMaxCommentsCount: 10,
    enableGetSubComments: false,
    enableGetMedias: false,
    enableGetWordcloud: false,
    crawlerMaxSleepSec: 10,
    xhsMinSaveCountPerKeyword: 10,
  })
  const [loading, setLoading] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)

  useEffect(() => {
    fetchCurrentConfig()
  }, [])

  const fetchCurrentConfig = async () => {
    try {
      const response = await fetch('/api/config/current')
      const data = await response.json()
      if (!data || !data.config) return
      const cfg = data.config
      setConfig({
        saveDataOption: cfg.save_data_option ?? 'json',
        enableIPProxy: cfg.enable_ip_proxy ?? false,
        ipProxyPoolCount: cfg.ip_proxy_pool_count ?? 2,
        ipProxyProvider: cfg.ip_proxy_provider ?? 'kuaidaili',
        headless: cfg.headless ?? false,
        saveLoginState: cfg.save_login_state ?? true,
        enableCdpMode: cfg.enable_cdp_mode ?? true,
        cdpDebugPort: cfg.cdp_debug_port ?? 9222,
        cdpHeadless: cfg.cdp_headless ?? false,
        autoCloseBrowser: cfg.auto_close_browser ?? true,
        startPage: cfg.start_page ?? 1,
        crawlerMaxNotesCount: cfg.crawler_max_notes_count ?? 10,
        maxConcurrencyNum: cfg.max_concurrency_num ?? 1,
        enableGetComments: cfg.enable_get_comments ?? false,
        crawlerMaxCommentsCount: cfg.crawler_max_comments_count_singlenotes ?? 10,
        enableGetSubComments: cfg.enable_get_sub_comments ?? false,
        enableGetMedias: cfg.enable_get_medias ?? false,
        enableGetWordcloud: cfg.enable_get_wordcloud ?? false,
        crawlerMaxSleepSec: cfg.crawler_max_sleep_sec ?? 10,
        xhsMinSaveCountPerKeyword: cfg.xhs_min_save_count_per_keyword ?? 10,
      })
    } catch (error) {
      console.error('Failed to load config:', error)
    }
  }

  const handleSave = async () => {
    setLoading(true)
    try {
      const payload = {
        save_data_option: config.saveDataOption,
        enable_ip_proxy: config.enableIPProxy,
        ip_proxy_pool_count: parseInt(config.ipProxyPoolCount) || 0,
        ip_proxy_provider: config.ipProxyProvider,
        headless: config.headless,
        save_login_state: config.saveLoginState,
        enable_cdp_mode: config.enableCdpMode,
        cdp_debug_port: parseInt(config.cdpDebugPort) || 0,
        cdp_headless: config.cdpHeadless,
        auto_close_browser: config.autoCloseBrowser,
        start_page: parseInt(config.startPage) || 1,
        crawler_max_notes_count: parseInt(config.crawlerMaxNotesCount) || 10,
        max_concurrency_num: parseInt(config.maxConcurrencyNum) || 1,
        enable_get_comments: config.enableGetComments,
        crawler_max_comments_count_singlenotes: parseInt(config.crawlerMaxCommentsCount) || 0,
        enable_get_sub_comments: config.enableGetSubComments,
        enable_get_medias: config.enableGetMedias,
        enable_get_wordcloud: config.enableGetWordcloud,
        crawler_max_sleep_sec: parseInt(config.crawlerMaxSleepSec) || 0,
        xhs_min_save_count_per_keyword: parseInt(config.xhsMinSaveCountPerKeyword) || 0,
      }

      const response = await fetch('/api/config/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configs: payload })
      })

      if (!response.ok) {
        const err = await response.json()
        throw new Error(err.detail || '保存失败')
      }
      
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 3000)
      await fetchCurrentConfig()
    } catch (error) {
      alert('保存失败: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="config-panel">
      <div className="config-header">
        <h2>配置管理</h2>
        <button 
          className="btn btn-primary" 
          onClick={handleSave}
          disabled={loading}
        >
          {loading ? <RefreshCw size={18} className="spin" /> : <Save size={18} />}
          {loading ? '保存中...' : '保存配置'}
        </button>
      </div>

      {saveSuccess && (
        <div className="success-banner">
          ✓ 配置保存成功！重启爬虫后生效
        </div>
      )}

      <div className="config-content">
        {/* Data Storage */}
        <div className="config-section">
          <h3><SettingsIcon size={20} /> 数据存储</h3>
          <div className="form-grid">
            <div className="form-group">
              <label>保存格式</label>
              <select
                value={config.saveDataOption}
                onChange={(e) => setConfig({ ...config, saveDataOption: e.target.value })}
              >
                <option value="json">JSON</option>
                <option value="csv">CSV</option>
                <option value="excel">Excel</option>
                <option value="sqlite">SQLite</option>
                <option value="db">MySQL</option>
                <option value="mongodb">MongoDB</option>
                <option value="txt">TXT</option>
              </select>
            </div>
          </div>
        </div>

        {/* Proxy Settings */}
        <div className="config-section">
          <h3><SettingsIcon size={20} /> 代理设置</h3>
          <div className="checkbox-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={config.enableIPProxy}
                onChange={(e) => setConfig({ ...config, enableIPProxy: e.target.checked })}
              />
              <span>启用IP代理</span>
            </label>
          </div>
          {config.enableIPProxy && (
            <div className="form-grid">
              <div className="form-group">
                <label>代理池数量</label>
                <input
                  type="number"
                  value={config.ipProxyPoolCount}
                  onChange={(e) => setConfig({ ...config, ipProxyPoolCount: e.target.value })}
                  min="1"
                />
              </div>
              <div className="form-group">
                <label>代理提供商</label>
                <select
                  value={config.ipProxyProvider}
                  onChange={(e) => setConfig({ ...config, ipProxyProvider: e.target.value })}
                >
                  <option value="kuaidaili">快代理</option>
                  <option value="wandouhttp">豌豆HTTP</option>
                </select>
              </div>
            </div>
          )}
        </div>

        {/* Browser Settings */}
        <div className="config-section">
          <h3><SettingsIcon size={20} /> 浏览器设置</h3>
          <div className="checkbox-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={config.headless}
                onChange={(e) => setConfig({ ...config, headless: e.target.checked })}
              />
              <span>无头模式</span>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={config.saveLoginState}
                onChange={(e) => setConfig({ ...config, saveLoginState: e.target.checked })}
              />
              <span>保存登录状态</span>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={config.autoCloseBrowser}
                onChange={(e) => setConfig({ ...config, autoCloseBrowser: e.target.checked })}
              />
              <span>自动关闭浏览器</span>
            </label>
          </div>
        </div>

        {/* CDP Settings */}
        <div className="config-section">
          <h3><SettingsIcon size={20} /> CDP模式设置</h3>
          <div className="checkbox-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={config.enableCdpMode}
                onChange={(e) => setConfig({ ...config, enableCdpMode: e.target.checked })}
              />
              <span>启用CDP模式</span>
            </label>
            {config.enableCdpMode && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={config.cdpHeadless}
                  onChange={(e) => setConfig({ ...config, cdpHeadless: e.target.checked })}
                />
                <span>CDP无头模式</span>
              </label>
            )}
          </div>
          {config.enableCdpMode && (
            <div className="form-grid">
              <div className="form-group">
                <label>CDP调试端口</label>
                <input
                  type="number"
                  value={config.cdpDebugPort}
                  onChange={(e) => setConfig({ ...config, cdpDebugPort: e.target.value })}
                  min="1024"
                  max="65535"
                />
              </div>
            </div>
          )}
        </div>

        {/* Crawler Settings */}
        <div className="config-section">
          <h3><SettingsIcon size={20} /> 爬虫设置</h3>
          <div className="form-grid">
            <div className="form-group">
              <label>起始页码</label>
              <input
                type="number"
                value={config.startPage}
                onChange={(e) => setConfig({ ...config, startPage: e.target.value })}
                min="1"
              />
            </div>
            <div className="form-group">
              <label>最大爬取数量</label>
              <input
                type="number"
                value={config.crawlerMaxNotesCount}
                onChange={(e) => setConfig({ ...config, crawlerMaxNotesCount: e.target.value })}
                min="1"
              />
            </div>
            <div className="form-group">
              <label>并发数量</label>
              <input
                type="number"
                value={config.maxConcurrencyNum}
                onChange={(e) => setConfig({ ...config, maxConcurrencyNum: e.target.value })}
                min="1"
              />
            </div>
            <div className="form-group">
              <label>爬取间隔(秒)</label>
              <input
                type="number"
                value={config.crawlerMaxSleepSec}
                onChange={(e) => setConfig({ ...config, crawlerMaxSleepSec: e.target.value })}
                min="0"
              />
            </div>
            <div className="form-group">
              <label>每个关键词最少保存数量</label>
              <input
                type="number"
                value={config.xhsMinSaveCountPerKeyword}
                onChange={(e) => setConfig({ ...config, xhsMinSaveCountPerKeyword: e.target.value })}
                min="0"
              />
              <small style={{ color: '#666', marginTop: '5px', display: 'block' }}>
                search 模式：若一页达不到该数量且有下一页，会继续翻页直到满足或无更多数据
              </small>
            </div>
          </div>
        </div>

        {/* Comment Settings */}
        <div className="config-section">
          <h3><SettingsIcon size={20} /> 评论设置</h3>
          <div className="checkbox-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={config.enableGetComments}
                onChange={(e) => setConfig({ ...config, enableGetComments: e.target.checked })}
              />
              <span>爬取评论</span>
            </label>
            {config.enableGetComments && (
              <>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={config.enableGetSubComments}
                    onChange={(e) => setConfig({ ...config, enableGetSubComments: e.target.checked })}
                  />
                  <span>爬取二级评论</span>
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={config.enableGetWordcloud}
                    onChange={(e) => setConfig({ ...config, enableGetWordcloud: e.target.checked })}
                  />
                  <span>生成词云图</span>
                </label>
              </>
            )}
          </div>
          {config.enableGetComments && (
            <div className="form-grid">
              <div className="form-group">
                <label>最大评论数</label>
                <input
                  type="number"
                  value={config.crawlerMaxCommentsCount}
                  onChange={(e) => setConfig({ ...config, crawlerMaxCommentsCount: e.target.value })}
                  min="1"
                />
              </div>
            </div>
          )}
        </div>

        {/* Media Settings */}
        <div className="config-section">
          <h3><SettingsIcon size={20} /> 媒体设置</h3>
          <div className="checkbox-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={config.enableGetMedias}
                onChange={(e) => setConfig({ ...config, enableGetMedias: e.target.checked })}
              />
              <span>下载图片和视频</span>
            </label>
          </div>
        </div>

        <div className="config-notice">
          <strong>注意：</strong>配置修改后需要重启爬虫才能生效。某些配置项可能会影响爬虫性能和稳定性，请谨慎修改。
        </div>
      </div>
    </div>
  )
}

export default ConfigPanel
