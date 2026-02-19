import React, { useState, useEffect } from 'react'
import { PlayCircle, StopCircle, RefreshCw, Search, FileText, UserCircle } from 'lucide-react'
import './CrawlerControl.css'

const CrawlerControl = ({ onStatusChange }) => {
  const [platforms, setPlatforms] = useState([])
  const [config, setConfig] = useState({
    platform: 'xhs',
    loginType: 'qrcode',
    crawlerType: 'search',
    keywords: '超声炮',
    postIds: '',
    creatorIds: '',
    startPage: 1,
    enableComments: true,
    enableSubComments: false,
    saveOption: 'json',
    headless: false,
    cookies: ''
  })
  const [isRunning, setIsRunning] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    fetchPlatforms()
    checkCrawlerStatus()
  }, [])

  const fetchPlatforms = async () => {
    try {
      const response = await fetch('/api/config/platforms')
      const data = await response.json()
      setPlatforms(data.platforms || [])
    } catch (error) {
      console.error('Failed to fetch platforms:', error)
    }
  }

  const checkCrawlerStatus = async () => {
    try {
      const response = await fetch('/api/crawler/status')
      const data = await response.json()
      setIsRunning(data.status === 'running')
      if (onStatusChange) onStatusChange(data.status)
    } catch (error) {
      console.error('Failed to check status:', error)
    }
  }

  const handleStart = async () => {
    if (isLoading) return
    
    setIsLoading(true)
    try {
      const requestData = {
        platform: config.platform,
        login_type: config.loginType,
        crawler_type: config.crawlerType,
        keywords: config.keywords,
        specified_ids: config.postIds,
        creator_ids: config.creatorIds,
        start_page: parseInt(config.startPage) || 1,
        enable_comments: config.enableComments,
        enable_sub_comments: config.enableSubComments,
        save_option: config.saveOption,
        headless: config.headless,
        cookies: config.cookies
      }

      const response = await fetch('/api/crawler/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestData)
      })

      if (response.ok) {
        setIsRunning(true)
        if (onStatusChange) onStatusChange('running')
        alert('爬虫启动成功！')
      } else {
        const error = await response.json()
        alert('启动失败: ' + (error.detail || '未知错误'))
      }
    } catch (error) {
      alert('启动失败: ' + error.message)
    } finally {
      setIsLoading(false)
    }
  }

  const handleStop = async () => {
    if (isLoading) return
    
    setIsLoading(true)
    try {
      const response = await fetch('/api/crawler/stop', { method: 'POST' })
      if (response.ok) {
        setIsRunning(false)
        if (onStatusChange) onStatusChange('idle')
        alert('爬虫已停止')
      } else {
        const error = await response.json()
        alert('停止失败: ' + (error.detail || '未知错误'))
      }
    } catch (error) {
      alert('停止失败: ' + error.message)
    } finally {
      setIsLoading(false)
    }
  }

  const platformLabels = {
    'xhs': '小红书',
    'dy': '抖音',
    'ks': '快手',
    'bili': 'B站',
    'wb': '微博',
    'tieba': '贴吧',
    'zhihu': '知乎'
  }

  return (
    <div className="crawler-control">
      <div className="control-header">
        <h2>爬虫控制台</h2>
        <div className="control-actions">
          <button 
            className={`btn ${isRunning ? 'btn-danger' : 'btn-primary'}`}
            onClick={isRunning ? handleStop : handleStart}
            disabled={isLoading}
          >
            {isLoading ? (
              <RefreshCw className="spin" size={18} />
            ) : isRunning ? (
              <StopCircle size={18} />
            ) : (
              <PlayCircle size={18} />
            )}
            {isLoading ? '处理中...' : isRunning ? '停止爬虫' : '启动爬虫'}
          </button>
        </div>
      </div>

      <div className="config-grid">
        {/* Platform Selection */}
        <div className="config-section">
          <h3>平台选择</h3>
          <div className="platform-grid">
            {Object.entries(platformLabels).map(([value, label]) => (
              <button
                key={value}
                className={`platform-btn ${config.platform === value ? 'active' : ''}`}
                onClick={() => setConfig({ ...config, platform: value })}
                disabled={isRunning}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Crawler Type */}
        <div className="config-section">
          <h3>爬取模式</h3>
          <div className="mode-grid">
            <button
              className={`mode-btn ${config.crawlerType === 'search' ? 'active' : ''}`}
              onClick={() => setConfig({ ...config, crawlerType: 'search' })}
              disabled={isRunning}
            >
              <Search size={20} />
              <div>
                <div className="mode-title">关键词搜索</div>
                <div className="mode-desc">搜索关键词相关内容</div>
              </div>
            </button>
            <button
              className={`mode-btn ${config.crawlerType === 'detail' ? 'active' : ''}`}
              onClick={() => setConfig({ ...config, crawlerType: 'detail' })}
              disabled={isRunning}
            >
              <FileText size={20} />
              <div>
                <div className="mode-title">帖子详情</div>
                <div className="mode-desc">获取指定帖子详情</div>
              </div>
            </button>
            <button
              className={`mode-btn ${config.crawlerType === 'creator' ? 'active' : ''}`}
              onClick={() => setConfig({ ...config, crawlerType: 'creator' })}
              disabled={isRunning}
            >
              <UserCircle size={20} />
              <div>
                <div className="mode-title">创作者主页</div>
                <div className="mode-desc">爬取创作者主页数据</div>
              </div>
            </button>
          </div>
        </div>

        {/* Crawler Parameters */}
        <div className="config-section">
          <h3>爬取参数</h3>
          <div className="form-grid">
            {config.crawlerType === 'search' && (
              <div className="form-group">
                <label>搜索关键词</label>
                <input
                  type="text"
                  value={config.keywords}
                  onChange={(e) => setConfig({ ...config, keywords: e.target.value })}
                  placeholder="请输入搜索关键词,多个用逗号分隔"
                  disabled={isRunning}
                />
              </div>
            )}
            {config.crawlerType === 'detail' && (
              <div className="form-group">
                <label>帖子ID列表</label>
                <input
                  type="text"
                  value={config.postIds}
                  onChange={(e) => setConfig({ ...config, postIds: e.target.value })}
                  placeholder="请输入帖子ID,多个用逗号分隔"
                  disabled={isRunning}
                />
              </div>
            )}
            {config.crawlerType === 'creator' && (
              <div className="form-group">
                <label>创作者ID列表</label>
                <input
                  type="text"
                  value={config.creatorIds}
                  onChange={(e) => setConfig({ ...config, creatorIds: e.target.value })}
                  placeholder="请输入创作者ID,多个用逗号分隔"
                  disabled={isRunning}
                />
              </div>
            )}
            <div className="form-group">
              <label>起始页码</label>
              <input
                type="number"
                value={config.startPage}
                onChange={(e) => setConfig({ ...config, startPage: e.target.value })}
                min="1"
                disabled={isRunning}
              />
            </div>
          </div>
        </div>

        {/* Login Configuration */}
        <div className="config-section">
          <h3>登录配置</h3>
          <div className="form-grid">
            <div className="form-group">
              <label>登录方式</label>
              <select
                value={config.loginType}
                onChange={(e) => setConfig({ ...config, loginType: e.target.value })}
                disabled={isRunning}
              >
                <option value="qrcode">二维码登录</option>
                <option value="cookie">Cookie登录</option>
              </select>
            </div>
            {config.loginType === 'cookie' && (
              <div className="form-group full-width">
                <label>Cookie值</label>
                <textarea
                  value={config.cookies}
                  onChange={(e) => setConfig({ ...config, cookies: e.target.value })}
                  placeholder="请输入Cookie值"
                  rows={3}
                  disabled={isRunning}
                />
              </div>
            )}
          </div>
        </div>

        {/* Advanced Options */}
        <div className="config-section">
          <h3>高级选项</h3>
          <div className="form-grid">
            <div className="form-group">
              <label>数据保存格式</label>
              <select
                value={config.saveOption}
                onChange={(e) => setConfig({ ...config, saveOption: e.target.value })}
                disabled={isRunning}
              >
                <option value="json">JSON</option>
                <option value="csv">CSV</option>
                <option value="excel">Excel</option>
                <option value="sqlite">SQLite</option>
                <option value="db">MySQL</option>
                <option value="mongodb">MongoDB</option>
              </select>
            </div>
            <div className="form-group">
              <label>起始页码</label>
              <input
                type="number"
                value={config.startPage}
                onChange={(e) => setConfig({ ...config, startPage: e.target.value })}
                min="1"
                disabled={isRunning}
              />
            </div>
          </div>
          <div className="checkbox-grid">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={config.enableComments}
                onChange={(e) => setConfig({ ...config, enableComments: e.target.checked })}
                disabled={isRunning}
              />
              <span>爬取评论</span>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={config.enableSubComments}
                onChange={(e) => setConfig({ ...config, enableSubComments: e.target.checked })}
                disabled={isRunning}
              />
              <span>爬取二级评论</span>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={config.headless}
                onChange={(e) => setConfig({ ...config, headless: e.target.checked })}
                disabled={isRunning}
              />
              <span>无头模式(不显示浏览器)</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}

export default CrawlerControl
