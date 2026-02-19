import React, { useState, useEffect } from 'react'
import { Download, Eye, RefreshCw, Database, FileJson, FileSpreadsheet } from 'lucide-react'
import './DataManagement.css'

const DataManagement = () => {
  const [files, setFiles] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(false)
  const [selectedFile, setSelectedFile] = useState(null)
  const [previewData, setPreviewData] = useState(null)

  useEffect(() => {
    fetchFiles()
    fetchStats()
  }, [])

  const fetchFiles = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/data/files')
      const data = await response.json()
      setFiles(data.files || [])
    } catch (error) {
      console.error('Failed to fetch files:', error)
    } finally {
      setLoading(false)
    }
  }

  const fetchStats = async () => {
    try {
      const response = await fetch('/api/data/stats')
      const data = await response.json()
      setStats(data)
    } catch (error) {
      console.error('Failed to fetch stats:', error)
    }
  }

  const handlePreview = async (file) => {
    try {
      const response = await fetch(`/api/data/files/${file.path}?preview=true&limit=50`)
      const data = await response.json()
      setSelectedFile(file)
      setPreviewData(data)
    } catch (error) {
      alert('预览失败: ' + error.message)
    }
  }

  const handleDownload = (file) => {
    window.open(`/api/data/download/${file.path}`, '_blank')
  }

  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
  }

  const formatDate = (timestamp) => {
    return new Date(timestamp * 1000).toLocaleString('zh-CN')
  }

  const getFileIcon = (type) => {
    if (type === 'json') return <FileJson size={20} className="file-icon json" />
    if (type === 'csv' || type === 'xlsx' || type === 'xls') return <FileSpreadsheet size={20} className="file-icon excel" />
    return <Database size={20} className="file-icon" />
  }

  return (
    <div className="data-management">
      <div className="data-header">
        <h2>数据管理</h2>
        <button className="btn btn-primary" onClick={() => { fetchFiles(); fetchStats(); }} disabled={loading}>
          <RefreshCw size={18} className={loading ? 'spin' : ''} />
          刷新
        </button>
      </div>

      {stats && (
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-label">文件总数</div>
            <div className="stat-value">{stats.total_files}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">总大小</div>
            <div className="stat-value">{formatSize(stats.total_size)}</div>
          </div>
          {Object.entries(stats.by_platform || {}).map(([platform, count]) => (
            <div key={platform} className="stat-card">
              <div className="stat-label">{platform.toUpperCase()}</div>
              <div className="stat-value">{count} 个文件</div>
            </div>
          ))}
        </div>
      )}

      <div className="files-section">
        <h3>数据文件列表</h3>
        {loading ? (
          <div className="loading-state">
            <RefreshCw className="spin" size={32} />
            <p>加载中...</p>
          </div>
        ) : files.length === 0 ? (
          <div className="empty-state">
            <Database size={48} />
            <p>暂无数据文件</p>
            <small>运行爬虫后数据将保存在这里</small>
          </div>
        ) : (
          <div className="files-table">
            <table>
              <thead>
                <tr>
                  <th>文件名</th>
                  <th>类型</th>
                  <th>大小</th>
                  <th>记录数</th>
                  <th>修改时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {files.map((file, index) => (
                  <tr key={index}>
                    <td>
                      <div className="file-name">
                        {getFileIcon(file.type)}
                        <span>{file.name}</span>
                      </div>
                    </td>
                    <td><span className="file-type-badge">{file.type.toUpperCase()}</span></td>
                    <td>{formatSize(file.size)}</td>
                    <td>{file.record_count || '-'}</td>
                    <td>{formatDate(file.modified_at)}</td>
                    <td>
                      <div className="action-buttons">
                        <button 
                          className="btn-icon" 
                          onClick={() => handlePreview(file)}
                          title="预览"
                        >
                          <Eye size={16} />
                        </button>
                        <button 
                          className="btn-icon" 
                          onClick={() => handleDownload(file)}
                          title="下载"
                        >
                          <Download size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Preview Modal */}
      {previewData && (
        <div className="modal-overlay" onClick={() => setPreviewData(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{selectedFile.name}</h3>
              <button className="modal-close" onClick={() => setPreviewData(null)}>×</button>
            </div>
            <div className="modal-body">
              <p className="preview-info">显示前 {previewData.data.length} 条，共 {previewData.total} 条记录</p>
              <div className="preview-content">
                <pre>{JSON.stringify(previewData.data, null, 2)}</pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default DataManagement
