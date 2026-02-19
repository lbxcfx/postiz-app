# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Repository: https://github.com/NanmiCoder/MediaCrawler/blob/main/config/xhs_config.py
# GitHub: https://github.com/NanmiCoder
# Licensed under NON-COMMERCIAL LEARNING LICENSE 1.1
#

# 声明：本代码仅供学习和研究目的使用。使用者应遵守以下原则：
# 1. 不得用于任何商业用途。
# 2. 使用时应遵守目标平台的使用条款和robots.txt规则。
# 3. 不得进行大规模爬取或对平台造成运营干扰。
# 4. 应合理控制请求频率，避免给目标平台带来不必要的负担。
# 5. 不得用于任何非法或不当的用途。
#
# 详细许可条款请参阅项目根目录下的LICENSE文件。
# 使用本代码即表示您同意遵守上述原则和LICENSE中的所有条款。


# 小红书平台配置

# ==================== 增量爬取與 TXT 存儲相關配置 ====================
# 最低點贊數門檻，低於該值的筆記不會寫入（可自行調整）
# 設置為 0 表示不過濾點贊數
XHS_MIN_LIKED_COUNT = 1000

# 每個關鍵詞最少希望保存的合格筆記數（僅 search 模式）
# 若當前頁未達到該數量且還有更多頁，會繼續翻頁直到達標或沒有更多內容
XHS_MIN_SAVE_COUNT_PER_KEYWORD = 10

# 筆記內容 txt 存儲路徑（每行一條 JSON）
XHS_TXT_STORE_PATH = "./data/xhs/notes.txt"

# 已抓取 note_id 記錄檔案路徑，用於簡單增量去重
XHS_SEEN_IDS_PATH = "./data/xhs/seen_note_ids.txt"

# 排序方式，具体的枚举值在media_platform/xhs/field.py中
# 可選值：
#   - "general": 默認排序
#   - "popularity_descending": 按點贊數排序（最受歡迎）
#   - "time_descending": 按發布時間倒序（最新作品）⭐ 增量爬取推薦使用此選項
SORT_TYPE = "popularity_descending"

# 指定笔记URL列表, 必须要携带xsec_token参数
XHS_SPECIFIED_NOTE_URL_LIST = [
    "https://www.xiaohongshu.com/explore/64b95d01000000000c034587?xsec_token=AB0EFqJvINCkj6xOCKCQgfNNh8GdnBC_6XecG4QOddo3Q=&xsec_source=pc_cfeed"
    # ........................
]

# 指定创作者URL列表，需要携带xsec_token and xsec_source参数

XHS_CREATOR_ID_LIST = [
    "https://www.xiaohongshu.com/user/profile/5f58bd990000000001003753?xsec_token=ABYVg1evluJZZzpMX-VWzchxQ1qSNVW3r-jOEnKqMcgZw=&xsec_source=pc_search"
    # ........................
]

