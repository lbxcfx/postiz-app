import React, { useState, useEffect } from 'react'
import { PlayCircle, StopCircle, RefreshCw, Search, FileText, UserCircle, Upload, TrendingUp, Database, FileJson } from 'lucide-react'
import './XhsCrawlerControl.css'

const XhsCrawlerControl = ({ onStatusChange }) => {
  const [config, setConfig] = useState({
    // 基础配置
    crawlerType: 'search',
    loginType: 'cookie',
    cookies: '',
    headless: false,
    saveOption: 'json',
    startPage: 1,
    
    // 评论配置（全局）
    enableComments: false,
    enableSubComments: false,
    
    // 点赞追踪配置（全局）
    likeTrackingEnable: false,
    
    // 搜索模式专属配置
    search: {
      keywords: '超声炮',
      sortType: 'popularity_descending',
      minLikedCount: 1000,
      minSaveCount: 10,
    },
    
    // 笔记详情模式专属配置
    detail: {
      sourceType: 'manual',  // 'manual' | 'csv'
      postIds: '',
      csvOnlyNeedT1: true,
    },
    
    // 创作者模式专属配置
    creator: {
      sourceType: 'manual',  // 'manual' | 'search_json'
      creatorIds: '',
      searchJsonPath: '',
      maxNotesCount: 20,  // 每个创作者爬取的最大作品数
    },
  })
  
  const [isRunning, setIsRunning] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('basic')

  useEffect(() => {
    checkCrawlerStatus()
  }, [])

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
    
    // 验证必填字段
    if (config.crawlerType === 'search' && !config.search.keywords) {
      alert('❌ 请输入搜索关键词')
      return
    }
    if (config.crawlerType === 'detail' && config.detail.sourceType === 'manual' && !config.detail.postIds) {
      alert('❌ 请输入笔记ID，或选择"从CSV读取"')
      return
    }
    if (config.crawlerType === 'creator' && config.creator.sourceType === 'manual' && !config.creator.creatorIds) {
      alert('❌ 请输入创作者ID，或选择"从搜索结果加载"')
      return
    }
    
    setIsLoading(true)
    console.log('🚀 开始启动爬虫...')
    
    try {
      // 提前写入全局配置，确保后端子进程能读取到
      try {
        const cfgResp = await fetch('/api/config/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            configs: {
              xhs_min_save_count_per_keyword: parseInt(config.search.minSaveCount) || 0
            }
          })
        })
        if (!cfgResp.ok) {
          console.warn('config/update failed', await cfgResp.text())
        }
      } catch (e) {
        console.warn('config/update error', e)
      }

      const requestData = {
        platform: 'xhs',
        login_type: config.loginType,
        crawler_type: config.crawlerType,
        keywords: config.crawlerType === 'search' ? config.search.keywords : '',
        specified_ids: config.crawlerType === 'detail' ? config.detail.postIds : '',
        creator_ids: config.crawlerType === 'creator' ? config.creator.creatorIds : '',
        start_page: parseInt(config.startPage) || 1,
        enable_comments: config.enableComments,
        enable_sub_comments: config.enableSubComments,
        save_option: config.saveOption,
        headless: config.headless,
        cookies: config.cookies,
        // 作品数量控制（创作者模式特别重要）
        crawler_max_notes_count: config.crawlerType === 'creator' 
          ? parseInt(config.creator.maxNotesCount) || 20 
          : 10,
        // 扩展配置
        xhs_config: {
          // 根据不同模式传递不同的配置
          ...(config.crawlerType === 'search' && {
            sort_type: config.search.sortType,
            min_liked_count: parseInt(config.search.minLikedCount) || 0,
            min_save_count_per_keyword: parseInt(config.search.minSaveCount) || 0,
          }),
          ...(config.crawlerType === 'detail' && {
            note_source_type: config.detail.sourceType,
            specified_note_url_from_csv: config.detail.sourceType === 'csv',
            specified_note_url_csv_only_need_t1: config.detail.csvOnlyNeedT1,
          }),
          ...(config.crawlerType === 'creator' && {
            creator_source_type: config.creator.sourceType,
            creator_seed_from_search_json: config.creator.sourceType === 'search_json',
            creator_seed_search_json_path: config.creator.searchJsonPath,
          }),
          like_tracking_enable: config.likeTrackingEnable,
        }
      }

      console.log('📤 发送请求数据:', JSON.stringify(requestData, null, 2))

      const response = await fetch('/api/crawler/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestData)
      })

      console.log('📥 响应状态:', response.status, response.statusText)
      const responseText = await response.text()
      console.log('📥 响应内容:', responseText)
      
      if (response.ok) {
        try {
          const result = JSON.parse(responseText)
          console.log('✅ 解析成功:', result)
          setIsRunning(true)
          if (onStatusChange) onStatusChange('running')
          alert('✅ 小红书爬虫启动成功！\n\n请切换到"运行日志"标签查看实时输出。')
        } catch (e) {
          console.error('❌ JSON解析失败:', e)
          alert('⚠️ 启动请求已发送，但响应格式异常。\n请检查后端日志。')
        }
      } else {
        console.error('❌ 请求失败:', response.status, responseText)
        try {
          const error = JSON.parse(responseText)
          alert('❌ 启动失败:\n\n' + (error.detail || JSON.stringify(error)))
        } catch {
          alert('❌ 启动失败:\n\n' + responseText)
        }
      }
    } catch (error) {
      console.error('💥 请求异常:', error)
      alert('❌ 请求失败:\n\n' + error.message + '\n\n请确保后端服务正在运行！')
    } finally {
      setIsLoading(false)
    }
  }

  const handleStop = async () => {
    try {
      const response = await fetch('/api/crawler/stop', { method: 'POST' })
      if (response.ok) {
        setIsRunning(false)
        if (onStatusChange) onStatusChange('idle')
        alert('✅ 爬虫已停止')
      } else {
        const error = await response.json()
        alert('❌ 停止失败: ' + (error.detail || '未知错误'))
      }
    } catch (error) {
      alert('❌ 停止失败: ' + error.message)
    }
  }

  return (
    <div className="xhs-crawler-control">
      <div className="control-header">
        <h2>🌸 小红书爬虫控制台</h2>
        <div className="control-buttons">
          <button
            className={`btn btn-start ${isRunning ? 'disabled' : ''}`}
            onClick={handleStart}
            disabled={isRunning || isLoading}
          >
            <PlayCircle size={18} />
            {isLoading ? '启动中...' : '启动爬虫'}
          </button>
          <button
            className={`btn btn-stop ${!isRunning ? 'disabled' : ''}`}
            onClick={handleStop}
            disabled={!isRunning}
          >
            <StopCircle size={18} />
            停止爬虫
          </button>
          <button className="btn btn-refresh" onClick={checkCrawlerStatus}>
            <RefreshCw size={18} />
            刷新状态
          </button>
        </div>
      </div>

      <div className="tabs">
        <button
          className={`tab ${activeTab === 'basic' ? 'active' : ''}`}
          onClick={() => setActiveTab('basic')}
        >
          <FileText size={16} />
          基础配置
        </button>
        <button
          className={`tab ${activeTab === 'tracking' ? 'active' : ''}`}
          onClick={() => setActiveTab('tracking')}
        >
          <TrendingUp size={16} />
          点赞追踪
        </button>
        <button
          className={`tab ${activeTab === 'advanced' ? 'active' : ''}`}
          onClick={() => setActiveTab('advanced')}
        >
          <Upload size={16} />
          高级选项
        </button>
      </div>

      <div className="config-container">
        {activeTab === 'basic' && (
          <div className="config-content">
            {/* 爬取模式 */}
            <div className="config-section">
              <h3>🎯 爬取模式</h3>
              <div className="mode-selector">
                <label className={`mode-card ${config.crawlerType === 'search' ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="crawlerType"
                    value="search"
                    checked={config.crawlerType === 'search'}
                    onChange={(e) => setConfig({ ...config, crawlerType: e.target.value })}
                    disabled={isRunning}
                  />
                  <Search size={24} />
                  <div>
                    <strong>关键词搜索</strong>
                    <p>搜索关键词相关的笔记</p>
                  </div>
                </label>
                <label className={`mode-card ${config.crawlerType === 'detail' ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="crawlerType"
                    value="detail"
                    checked={config.crawlerType === 'detail'}
                    onChange={(e) => setConfig({ ...config, crawlerType: e.target.value })}
                    disabled={isRunning}
                  />
                  <FileText size={24} />
                  <div>
                    <strong>笔记详情</strong>
                    <p>抓取指定笔记的详细信息</p>
                  </div>
                </label>
                <label className={`mode-card ${config.crawlerType === 'creator' ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="crawlerType"
                    value="creator"
                    checked={config.crawlerType === 'creator'}
                    onChange={(e) => setConfig({ ...config, crawlerType: e.target.value })}
                    disabled={isRunning}
                  />
                  <UserCircle size={24} />
                  <div>
                    <strong>创作者主页</strong>
                    <p>抓取创作者的所有笔记</p>
                  </div>
                </label>
              </div>
            </div>

            {/* 搜索配置 */}
            {config.crawlerType === 'search' && (
              <div className="config-section">
                <h3>🔍 搜索配置</h3>
                <div className="form-group">
                  <label>搜索关键词 *</label>
                  <input
                    type="text"
                    value={config.search.keywords}
                    onChange={(e) => setConfig({ 
                      ...config, 
                      search: { ...config.search, keywords: e.target.value }
                    })}
                    placeholder="输入搜索关键词，如：美食、旅游"
                    disabled={isRunning}
                  />
                </div>
                <div className="form-grid">
                  <div className="form-group">
                    <label>排序方式</label>
                    <select
                      value={config.search.sortType}
                      onChange={(e) => setConfig({ 
                        ...config, 
                        search: { ...config.search, sortType: e.target.value }
                      })}
                      disabled={isRunning}
                    >
                      <option value="general">默认排序</option>
                      <option value="popularity_descending">点赞数排序（热门优先）</option>
                      <option value="time_descending">发布时间排序（最新优先）⭐ 增量爬取推荐</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>最低点赞数</label>
                    <input
                      type="number"
                      value={config.search.minLikedCount}
                      onChange={(e) => setConfig({ 
                        ...config, 
                        search: { ...config.search, minLikedCount: e.target.value }
                      })}
                      min="0"
                      placeholder="0 表示不过滤"
                      disabled={isRunning}
                    />
                  </div>
                  <div className="form-group">
                    <label>每个关键词最少保存数量</label>
                    <input
                      type="number"
                      value={config.search.minSaveCount}
                      onChange={(e) => setConfig({ 
                        ...config, 
                        search: { ...config.search, minSaveCount: e.target.value }
                      })}
                      min="0"
                      placeholder="默认10，0表示不强制"
                      disabled={isRunning}
                    />
                  </div>
                </div>
                <div className="info-box">
                  <span>💡</span>
                  <div>
                    <strong>增量爬取提示：</strong>
                    <p>选择"发布时间排序"并设置最低点赞数，系统会自动去重已爬取的笔记，适合定期执行。</p>
                  </div>
                </div>
              </div>
            )}

            {/* 笔记详情配置 */}
            {config.crawlerType === 'detail' && (
              <div className="config-section">
                <h3>📝 笔记详情配置</h3>
                
                {/* 数据源选择 */}
                <div className="source-selector">
                  <label className="source-option">
                    <input
                      type="radio"
                      name="noteSourceType"
                      value="manual"
                      checked={config.detail.sourceType === 'manual'}
                      onChange={(e) => setConfig({ 
                        ...config, 
                        detail: { ...config.detail, sourceType: e.target.value }
                      })}
                      disabled={isRunning}
                    />
                    <FileText size={20} />
                    <div>
                      <strong>手动输入</strong>
                      <p>直接输入笔记URL或ID</p>
                    </div>
                  </label>
                  <label className="source-option">
                    <input
                      type="radio"
                      name="noteSourceType"
                      value="csv"
                      checked={config.detail.sourceType === 'csv'}
                      onChange={(e) => setConfig({ 
                        ...config, 
                        detail: { ...config.detail, sourceType: e.target.value }
                      })}
                      disabled={isRunning}
                    />
                    <Database size={20} />
                    <div>
                      <strong>从CSV读取</strong>
                      <p>从点赞追踪CSV文件读取</p>
                    </div>
                  </label>
                </div>

                {config.detail.sourceType === 'manual' && (
                  <div className="form-group">
                    <label>笔记URL/ID列表 *</label>
                    <textarea
                      value={config.detail.postIds}
                      onChange={(e) => setConfig({ 
                        ...config, 
                        detail: { ...config.detail, postIds: e.target.value }
                      })}
                      placeholder="每行一个笔记URL或ID，URL必须包含xsec_token参数&#10;例如：&#10;https://www.xiaohongshu.com/explore/xxx?xsec_token=xxx&xsec_source=xxx&#10;或直接输入ID：xxx,yyy,zzz"
                      rows="5"
                      disabled={isRunning}
                    />
                  </div>
                )}

                {config.detail.sourceType === 'csv' && (
                  <>
                    <div className="info-box success">
                      <span>✅</span>
                      <div>
                        <strong>从CSV自动读取</strong>
                        <p>将从 <code>./data/xhs/like_tracking.csv</code> 读取笔记URL</p>
                        <p>默认读取 <code>note_url</code> 列</p>
                      </div>
                    </div>
                    <label className="checkbox-label" style={{ marginTop: '10px' }}>
                      <input
                        type="checkbox"
                        checked={config.detail.csvOnlyNeedT1}
                        onChange={(e) => setConfig({ 
                          ...config, 
                          detail: { ...config.detail, csvOnlyNeedT1: e.target.checked }
                        })}
                        disabled={isRunning}
                      />
                      <span>只读取需要T1的记录（未回填T1的笔记）</span>
                    </label>
                  </>
                )}
              </div>
            )}

            {/* 创作者配置 */}
            {config.crawlerType === 'creator' && (
              <div className="config-section">
                <h3>👤 创作者主页配置</h3>
                
                {/* 数据源选择 */}
                <div className="source-selector">
                  <label className="source-option">
                    <input
                      type="radio"
                      name="creatorSourceType"
                      value="manual"
                      checked={config.creator.sourceType === 'manual'}
                      onChange={(e) => setConfig({ 
                        ...config, 
                        creator: { ...config.creator, sourceType: e.target.value }
                      })}
                      disabled={isRunning}
                    />
                    <UserCircle size={20} />
                    <div>
                      <strong>手动输入</strong>
                      <p>直接输入创作者URL或ID</p>
                    </div>
                  </label>
                  <label className="source-option">
                    <input
                      type="radio"
                      name="creatorSourceType"
                      value="search_json"
                      checked={config.creator.sourceType === 'search_json'}
                      onChange={(e) => setConfig({ 
                        ...config, 
                        creator: { ...config.creator, sourceType: e.target.value }
                      })}
                      disabled={isRunning}
                    />
                    <FileJson size={20} />
                    <div>
                      <strong>从搜索结果加载</strong>
                      <p>从之前的搜索JSON自动提取创作者</p>
                    </div>
                  </label>
                </div>

                {config.creator.sourceType === 'manual' && (
                  <div className="form-group">
                    <label>创作者URL/ID列表 *</label>
                    <textarea
                      value={config.creator.creatorIds}
                      onChange={(e) => setConfig({ 
                        ...config, 
                        creator: { ...config.creator, creatorIds: e.target.value }
                      })}
                      placeholder="每行一个创作者URL或ID，URL必须包含xsec_token参数&#10;例如：&#10;https://www.xiaohongshu.com/user/profile/xxx?xsec_token=xxx&xsec_source=xxx&#10;或直接输入ID：xxx,yyy,zzz"
                      rows="5"
                      disabled={isRunning}
                    />
                  </div>
                )}

                {config.creator.sourceType === 'search_json' && (
                  <>
                    <div className="form-group">
                      <label>搜索JSON路径（可选）</label>
                      <input
                        type="text"
                        value={config.creator.searchJsonPath}
                        onChange={(e) => setConfig({ 
                          ...config, 
                          creator: { ...config.creator, searchJsonPath: e.target.value }
                        })}
                        placeholder="留空则自动选择最新的 search_contents_*.json"
                        disabled={isRunning}
                      />
                    </div>
                    <div className="info-box success">
                      <span>✅</span>
                      <div>
                        <strong>自动创作者种子</strong>
                        <p>系统会从搜索结果JSON中提取所有创作者信息</p>
                        <p>使用流程：1) 先运行关键词搜索 → 2) 再运行创作者模式</p>
                        <p>会保留每个创作者的种子笔记信息，方便后续分析</p>
                      </div>
                    </div>
                  </>
                )}

                {/* 作品数量控制 */}
                <div className="form-group">
                  <label>每个创作者最大作品数 ⭐</label>
                  <input
                    type="number"
                    value={config.creator.maxNotesCount}
                    onChange={(e) => setConfig({ 
                      ...config, 
                      creator: { ...config.creator, maxNotesCount: e.target.value }
                    })}
                    min="1"
                    max="999"
                    placeholder="默认20条"
                    disabled={isRunning}
                  />
                  <small style={{ color: '#666', marginTop: '5px', display: 'block' }}>
                    💡 设置每个创作者要爬取的作品数量（建议20-100）
                  </small>
                </div>
              </div>
            )}

            {/* 登录配置 */}
            <div className="config-section">
              <h3>🔐 登录配置</h3>
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
                  <div className="form-group">
                    <label>Cookie值</label>
                    <input
                      type="text"
                      value={config.cookies}
                      onChange={(e) => setConfig({ ...config, cookies: e.target.value })}
                      placeholder="粘贴完整的Cookie字符串"
                      disabled={isRunning}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* 保存配置 */}
            <div className="config-section">
              <h3>💾 保存配置</h3>
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
                    <option value="txt">TXT（支持增量去重）</option>
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
        )}

        {activeTab === 'tracking' && (
          <div className="config-content">
            <div className="config-section">
              <h3>📊 点赞追踪系统 (T0/T1)</h3>
              <div className="info-box">
                <span>💡</span>
                <div>
                  <strong>功能说明：</strong>
                  <p>T0: 首次抓取时记录点赞数和时间戳</p>
                  <p>T1: 二次抓取时记录新的点赞数，计算点赞增量和速率</p>
                  <p>使用流程：1) 启用追踪运行一次 → 2) 等待一段时间 → 3) 笔记详情模式(CSV源)二次抓取</p>
                </div>
              </div>

              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={config.likeTrackingEnable}
                  onChange={(e) => setConfig({ ...config, likeTrackingEnable: e.target.checked })}
                  disabled={isRunning}
                />
                <span>启用点赞追踪（保存T0数据到CSV）</span>
              </label>

              <div className="info-box" style={{ marginTop: '20px' }}>
                <span>ℹ️</span>
                <div>
                  <strong>T1回填配置</strong>
                  <p>T1回填选项已移至"笔记详情"模式配置中</p>
                  <p>使用步骤：</p>
                  <p>1. 选择"笔记详情"模式</p>
                  <p>2. 数据源选择"从CSV读取"</p>
                  <p>3. 勾选"只读取需要T1的记录"</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'advanced' && (
          <div className="config-content">
            <div className="config-section">
              <h3>⚙️ 高级选项</h3>
              <div className="info-box">
                <span>💡</span>
                <p>这些选项通常使用默认值即可，无需修改</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default XhsCrawlerControl
