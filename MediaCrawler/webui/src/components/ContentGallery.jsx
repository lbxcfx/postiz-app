import React, { useState, useEffect } from 'react'
import { Heart, MessageCircle, Play, RefreshCw, ExternalLink } from 'lucide-react'
import './ContentGallery.css'

const ContentGallery = () => {
    const [items, setItems] = useState([])
    const [loading, setLoading] = useState(false)
    const [activePlatform, setActivePlatform] = useState('xhs')
    const [keywords, setKeywords] = useState([])
    const [selectedKeyword, setSelectedKeyword] = useState('')

    useEffect(() => {
        fetchKeywords()
    }, [activePlatform])

    useEffect(() => {
        fetchGallery()
    }, [activePlatform, selectedKeyword])

    const fetchKeywords = async () => {
        try {
            const response = await fetch(`/api/data/keywords?platform=${activePlatform}`)
            const data = await response.json()
            setKeywords(data.keywords || [])
        } catch (error) {
            console.error('Failed to fetch keywords:', error)
        }
    }

    const fetchGallery = async () => {
        setLoading(true)
        try {
            const queryParams = new URLSearchParams({
                limit: 40,
                platform: activePlatform
            })
            if (selectedKeyword) {
                queryParams.append('keyword', selectedKeyword)
            }
            const response = await fetch(`/api/data/gallery?${queryParams.toString()}`)
            const data = await response.json()
            setItems(data.data || [])
        } catch (error) {
            console.error('Failed to fetch gallery:', error)
        } finally {
            setLoading(false)
        }
    }


    const getFirstImage = (imageList) => {
        if (!imageList) return ''
        if (typeof imageList === 'string') {
            return imageList.split(',')[0]
        }
        return imageList[0] || ''
    }

    return (
        <div className="content-gallery">
            <div className="gallery-header">
                <div className="header-left">
                    <h2>精选内容预览</h2>
                    <div className="platform-tabs">
                        <button
                            className={`platform-btn ${activePlatform === 'xhs' ? 'active' : ''}`}
                            onClick={() => setActivePlatform('xhs')}
                        >
                            小红书
                        </button>
                        {/* Future platforms */}
                        <button className="platform-btn disabled">抖音</button>
                        <button className="platform-btn disabled">快手</button>
                    </div>
                </div>
                <div className="header-actions">
                    <button className="btn btn-primary" onClick={fetchGallery} disabled={loading}>
                        <RefreshCw size={18} className={loading ? 'spin' : ''} />
                        刷新数据
                    </button>
                </div>
            </div>

            <div className="keyword-selector">
                <span className="selector-label">切换搜索结果:</span>
                <select
                    className="keyword-select"
                    value={selectedKeyword}
                    onChange={(e) => setSelectedKeyword(e.target.value)}
                >
                    <option value="">最近采集结果 (默认)</option>
                    {keywords.map(kw => (
                        <option key={kw} value={kw}>
                            关键词: {kw}
                        </option>
                    ))}
                </select>
            </div>



            {loading ? (
                <div className="loading-state">
                    <RefreshCw className="spin" size={48} />
                    <p>正在为您寻找优质内容...</p>
                </div>
            ) : items.length === 0 ? (
                <div className="empty-state">
                    <div className="empty-icon">🎨</div>
                    <p>暂无精选内容</p>
                    <small>请先运行爬虫采集数据，系统将自动展示高点赞内容</small>
                </div>
            ) : (
                <div className="masonry-grid">
                    {items.map((item, index) => (
                        <div key={item.note_id || index} className="gallery-card">
                            <div className="card-cover-container">
                                <img
                                    src={getFirstImage(item.image_list)}
                                    alt={item.title}
                                    className="card-cover"
                                    loading="lazy"
                                />
                                {item.type === 'video' && (
                                    <div className="video-badge">
                                        <Play size={16} fill="currentColor" />
                                    </div>
                                )}
                                <div className="card-overlay">
                                    <a href={item.note_url} target="_blank" rel="noopener noreferrer" className="view-original">
                                        <ExternalLink size={20} />
                                    </a>
                                </div>
                            </div>
                            <div className="card-content">
                                <h3 className="card-title">{item.title || item.desc?.slice(0, 30)}</h3>
                                <div className="card-footer">
                                    <div className="author-info">
                                        <img src={item.avatar} alt={item.nickname} className="author-avatar" />
                                        <span className="author-name">{item.nickname}</span>
                                    </div>
                                    <div className="interaction-info">
                                        <div className="stat-item">
                                            <Heart size={14} className="heart-icon" />
                                            <span>{item.liked_count}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

export default ContentGallery
