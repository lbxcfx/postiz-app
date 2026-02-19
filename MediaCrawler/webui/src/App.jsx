import React, { useState, useEffect } from 'react'
import { Activity, Database, FileText, BookOpen } from 'lucide-react'
import XhsCrawlerControl from './components/XhsCrawlerControl'
import DataManagement from './components/DataManagement'
import LogViewer from './components/LogViewer'
import ContentGallery from './components/ContentGallery'
import './App.css'

function App() {
  const [activeTab, setActiveTab] = useState('crawler')
  const [crawlerStatus, setCrawlerStatus] = useState('idle')
  const [qrCodeData, setQrCodeData] = useState(null)
  const [showQrModal, setShowQrModal] = useState(false)

  // Poll crawler status
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const response = await fetch('/api/crawler/status')
        const data = await response.json()
        setCrawlerStatus(data.status)
      } catch (error) {
        console.error('Failed to fetch status:', error)
      }
    }

    checkStatus()
    const interval = setInterval(checkStatus, 3000)
    return () => clearInterval(interval)
  }, [])

  // Global WebSocket listener for QR codes
  useEffect(() => {
    let ws = null
    const connectWs = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${protocol}//${window.location.host}/api/ws/logs`

      try {
        ws = new WebSocket(wsUrl)
        ws.onmessage = (event) => {
          try {
            const log = JSON.parse(event.data)
            // Handle QR Code
            const qrCodeMatch = log.message && log.message.match(/QRCODE_BASE64:(.*)/)
            if (qrCodeMatch) {
              const data = qrCodeMatch[1].trim()
              setQrCodeData(data)
              setShowQrModal(true)
            }

            // Handle Status Updates (New Feature)
            if (log.type === 'status_change') {
              setCrawlerStatus(log.status)
            }
          } catch (error) {
            // Ignore parse errors for non-JSON logs
          }
        }
        ws.onclose = () => {
          console.log('App WS closed, reconnecting in 5s...')
          setTimeout(connectWs, 5000)
        }
      } catch (error) {
        console.error('App WS connection error:', error)
      }
    }

    connectWs()
    return () => {
      if (ws) ws.close()
    }
  }, [])

  const tabs = [
    { id: 'crawler', label: '小红书爬虫', icon: BookOpen },
    { id: 'data', label: '数据管理', icon: Database },
    { id: 'gallery', label: '精选预览', icon: Activity },
    { id: 'logs', label: '运行日志', icon: FileText },
  ]

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-content">
          <div className="logo-section">
            <div className="xhs-logo">🌸</div>
            <div>
              <h1 className="app-title">小红书爆款工厂</h1>
              <p className="app-subtitle">Viral Content Factory</p>
            </div>
          </div>
          <div className="status-badge">
            <div className={`status-indicator ${crawlerStatus}`}></div>
            <span className="status-text">
              {crawlerStatus === 'running' ? '运行中' :
                crawlerStatus === 'idle' ? '系统就绪' : '已停止'}
            </span>
          </div>
        </div>
      </header>

      <div className="app-layout">
        <nav className="sidebar">
          {tabs.map(tab => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                className={`nav-item ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon size={20} className={activeTab === tab.id ? 'animate-pulse' : ''} />
                <span>{tab.label}</span>
              </button>
            )
          })}
        </nav>

        <main className="main-content">
          {activeTab === 'crawler' && <XhsCrawlerControl onStatusChange={setCrawlerStatus} />}
          {activeTab === 'data' && <DataManagement />}
          {activeTab === 'gallery' && <ContentGallery />}
          {activeTab === 'logs' && <LogViewer />}
        </main>
      </div>

      {/* QR Code Modal */}
      {showQrModal && qrCodeData && (
        <div className="modal-overlay">
          <div className="qr-modal">
            <div className="modal-header">
              <h3>📱 扫码登录</h3>
            </div>
            <div className="modal-body">
              <div className="qr-image-wrapper">
                <img src={`data:image/png;base64,${qrCodeData}`} alt="Login QR Code" />
              </div>
              <p className="qr-tip">请打开小红书 APP 扫码</p>
              <p className="qr-sub-tip">登录成功后窗口将自动关闭</p>
            </div>
            <div className="modal-footer">
              <button className="btn-primary" onClick={() => setShowQrModal(false)}>
                暂时跳过
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
