import React, { useState, useEffect, useRef } from 'react'
import { RefreshCw, Download, Trash2, Terminal } from 'lucide-react'
import './LogViewer.css'

const LogViewer = () => {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [filter, setFilter] = useState('all') // all, error, warning, info
  const logsEndRef = useRef(null)
  const wsRef = useRef(null)

  useEffect(() => {
    fetchLogs()
    connectWebSocket()

    return () => {
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [])

  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, autoScroll])

  const fetchLogs = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/crawler/logs?limit=200')
      const data = await response.json()
      setLogs(data.logs || [])
    } catch (error) {
      console.error('Failed to fetch logs:', error)
    } finally {
      setLoading(false)
    }
  }

  const connectWebSocket = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/api/ws/logs`

    try {
      const ws = new WebSocket(wsUrl)

      ws.onmessage = (event) => {
        try {
          const log = JSON.parse(event.data)
          setLogs(prev => [...prev, log])
        } catch (error) {
          console.error('Failed to parse log:', error)
        }
      }

      ws.onerror = (error) => {
        console.error('WebSocket error:', error)
      }

      ws.onclose = () => {
        console.log('WebSocket closed, reconnecting in 5s...')
        setTimeout(connectWebSocket, 5000)
      }

      wsRef.current = ws
    } catch (error) {
      console.error('Failed to connect WebSocket:', error)
    }
  }

  const handleClear = () => {
    if (confirm('确定要清空日志吗？')) {
      setLogs([])
    }
  }

  const handleDownload = () => {
    const content = logs.map(log =>
      `[${log.timestamp || new Date().toISOString()}] [${log.level || 'INFO'}] ${log.message}`
    ).join('\n')

    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mediacrawler-logs-${Date.now()}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  const getLogLevelClass = (level) => {
    if (!level) return 'info'
    const l = level.toLowerCase()
    if (l.includes('error') || l.includes('critical')) return 'error'
    if (l.includes('warn')) return 'warning'
    if (l.includes('debug')) return 'debug'
    return 'info'
  }

  const filteredLogs = logs.filter(log => {
    if (filter === 'all') return true
    return getLogLevelClass(log.level) === filter
  })

  return (
    <div className="log-viewer">
      <div className="log-header">
        <h2><Terminal size={24} /> 运行日志</h2>
        <div className="log-actions">
          <select
            className="log-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">全部日志</option>
            <option value="info">信息</option>
            <option value="warning">警告</option>
            <option value="error">错误</option>
            <option value="debug">调试</option>
          </select>
          <label className="auto-scroll-label">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            <span>自动滚动</span>
          </label>
          <button className="btn btn-secondary" onClick={fetchLogs} disabled={loading}>
            <RefreshCw size={18} className={loading ? 'spin' : ''} />
          </button>
          <button className="btn btn-secondary" onClick={handleDownload}>
            <Download size={18} />
          </button>
          <button className="btn btn-danger" onClick={handleClear}>
            <Trash2 size={18} />
          </button>
        </div>
      </div>

      <div className="log-content">
        {filteredLogs.length === 0 ? (
          <div className="log-empty">
            <Terminal size={48} />
            <p>暂无日志</p>
            <small>启动爬虫后日志将显示在这里</small>
          </div>
        ) : (
          <div className="log-list">
            {filteredLogs.map((log, index) => {
              const qrCodeMatch = log.message && log.message.match(/QRCODE_BASE64:(.*)/);
              const screenshotMatch = log.message && log.message.match(/BROWSER_SCREENSHOT_BASE64:(.*)/);

              const isQrCode = !!qrCodeMatch;
              const isScreenshot = !!screenshotMatch;

              const qrCodeData = qrCodeMatch ? qrCodeMatch[1].trim() : null;
              const screenshotData = screenshotMatch ? screenshotMatch[1].trim() : null;

              return (
                <div key={index} className={`log-entry ${getLogLevelClass(log.level)} ${isQrCode ? 'qrcode-entry' : ''} ${isScreenshot ? 'screenshot-entry' : ''}`}>
                  <span className="log-timestamp">
                    {log.timestamp || new Date().toLocaleTimeString()}
                  </span>
                  <span className="log-level">
                    [{log.level || 'INFO'}]
                  </span>
                  <span className="log-message">
                    {isQrCode ? (
                      <div className="qrcode-container">
                        <p className="qrcode-tip">📸 检测到登录二维码，请使用对应APP扫码登录：</p>
                        <img
                          src={`data:image/png;base64,${qrCodeData}`}
                          alt="Login QR Code"
                          className="log-qrcode-img"
                        />
                      </div>
                    ) : isScreenshot ? (
                      <div className="screenshot-container">
                        <p className="screenshot-tip">🖥️ 浏览器实时状态 (检查是否有验证滑块)：</p>
                        <img
                          src={`data:image/png;base64,${screenshotData}`}
                          alt="Browser Screenshot"
                          className="log-screenshot-img"
                        />
                      </div>
                    ) : log.message}
                  </span>
                </div>
              );
            })}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>

      <div className="log-footer">
        <span>共 {filteredLogs.length} 条日志</span>
        {filter !== 'all' && <span> (已过滤)</span>}
      </div>
    </div>
  )
}

export default LogViewer
