# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Repository: https://github.com/NanmiCoder/MediaCrawler/blob/main/api/routers/data.py
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

import os
import json
import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

router = APIRouter(prefix="/data", tags=["data"])

# Data directory
DATA_DIR = Path(__file__).parent.parent.parent / "data"
JOB_FILE_PATTERN = re.compile(r"^job_(.+?)__")


def get_file_info(file_path: Path) -> dict:
    """Get file information"""
    stat = file_path.stat()
    record_count = None
    client_job_id = None
    match = JOB_FILE_PATTERN.match(file_path.name)
    if match:
        client_job_id = match.group(1)

    # Try to get record count
    try:
        if file_path.suffix == ".json":
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    record_count = len(data)
        elif file_path.suffix == ".txt":  # JSONL
            with open(file_path, "r", encoding="utf-8") as f:
                record_count = sum(1 for line in f if line.strip())
        elif file_path.suffix == ".csv":
            with open(file_path, "r", encoding="utf-8") as f:
                record_count = sum(1 for _ in f) - 1  # Subtract header row
    except Exception:
        pass

    return {
        "name": file_path.name,
        "path": str(file_path.relative_to(DATA_DIR)),
        "size": stat.st_size,
        "modified_at": stat.st_mtime,
        "record_count": record_count,
        "type": file_path.suffix[1:] if file_path.suffix else "unknown",
        "client_job_id": client_job_id,
    }


@router.get("/files")
async def list_data_files(platform: Optional[str] = None, file_type: Optional[str] = None):
    """Get data file list"""
    if not DATA_DIR.exists():
        return {"files": []}

    files = []
    supported_extensions = {".json", ".csv", ".xlsx", ".xls", ".txt"}

    for root, dirs, filenames in os.walk(DATA_DIR):
        root_path = Path(root)
        for filename in filenames:
            file_path = root_path / filename
            if file_path.suffix.lower() not in supported_extensions:
                continue

            # Platform filter
            if platform:
                rel_path = str(file_path.relative_to(DATA_DIR))
                if platform.lower() not in rel_path.lower():
                    continue

            # Type filter
            if file_type and file_path.suffix[1:].lower() != file_type.lower():
                continue

            try:
                files.append(get_file_info(file_path))
            except Exception:
                continue

    # Sort by modification time (newest first)
    files.sort(key=lambda x: x["modified_at"], reverse=True)

    return {"files": files}


@router.get("/files/{file_path:path}")
async def get_file_content(file_path: str, preview: bool = True, limit: int = 100):
    """Get file content or preview"""
    full_path = DATA_DIR / file_path

    if not full_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    if not full_path.is_file():
        raise HTTPException(status_code=400, detail="Not a file")

    # Security check: ensure within DATA_DIR
    try:
        full_path.resolve().relative_to(DATA_DIR.resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")

    if preview:
        # Return preview data
        try:
            if full_path.suffix == ".json":
                with open(full_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, list):
                        return {"data": data[:limit], "total": len(data)}
                    return {"data": data, "total": 1}
            elif full_path.suffix == ".csv":
                import csv
                with open(full_path, "r", encoding="utf-8") as f:
                    reader = csv.DictReader(f)
                    rows = []
                    for i, row in enumerate(reader):
                        if i >= limit:
                            break
                        rows.append(row)
                    # Re-read to get total count
                    f.seek(0)
                    total = sum(1 for _ in f) - 1
                    return {"data": rows, "total": total}
            elif full_path.suffix.lower() in (".xlsx", ".xls"):
                import pandas as pd
                # Read first limit rows
                df = pd.read_excel(full_path, nrows=limit)
                # Get total row count (only read first column to save memory)
                df_count = pd.read_excel(full_path, usecols=[0])
                total = len(df_count)
                # Convert to list of dictionaries, handle NaN values
                rows = df.where(pd.notnull(df), None).to_dict(orient='records')
                return {
                    "data": rows,
                    "total": total,
                    "columns": list(df.columns)
                }
            elif full_path.suffix == ".txt":  # JSONL
                rows = []
                with open(full_path, "r", encoding="utf-8") as f:
                    for i, line in enumerate(f):
                        if not line.strip():
                            continue
                        if len(rows) >= limit:
                            continue
                        try:
                            rows.append(json.loads(line))
                        except:
                            continue
                    f.seek(0)
                    total = sum(1 for line in f if line.strip())
                return {"data": rows, "total": total}
            else:
                raise HTTPException(status_code=400, detail="Unsupported file type for preview")
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid JSON file")
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
    else:
        # Return file download
        return FileResponse(
            path=full_path,
            filename=full_path.name,
            media_type="application/octet-stream"
        )


@router.get("/download/{file_path:path}")
async def download_file(file_path: str):
    """Download file"""
    full_path = DATA_DIR / file_path

    if not full_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    if not full_path.is_file():
        raise HTTPException(status_code=400, detail="Not a file")

    # Security check
    try:
        full_path.resolve().relative_to(DATA_DIR.resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")

    return FileResponse(
        path=full_path,
        filename=full_path.name,
        media_type="application/octet-stream"
    )


@router.get("/stats")
async def get_data_stats():
    """Get data statistics"""
    if not DATA_DIR.exists():
        return {"total_files": 0, "total_size": 0, "by_platform": {}, "by_type": {}}

    stats = {
        "total_files": 0,
        "total_size": 0,
        "by_platform": {},
        "by_type": {}
    }

    supported_extensions = {".json", ".csv", ".xlsx", ".xls", ".txt"}

    for root, dirs, filenames in os.walk(DATA_DIR):
        root_path = Path(root)
        for filename in filenames:
            file_path = root_path / filename
            if file_path.suffix.lower() not in supported_extensions:
                continue

            try:
                stat = file_path.stat()
                stats["total_files"] += 1
                stats["total_size"] += stat.st_size

                # Statistics by type
                file_type = file_path.suffix[1:].lower()
                stats["by_type"][file_type] = stats["by_type"].get(file_type, 0) + 1

                # Statistics by platform (inferred from path)
                rel_path = str(file_path.relative_to(DATA_DIR))
                for platform in ["xhs", "dy", "ks", "bili", "wb", "tieba", "zhihu"]:
                    if platform in rel_path.lower():
                        stats["by_platform"][platform] = stats["by_platform"].get(platform, 0) + 1
                        break
            except Exception:
                continue

    return stats


@router.get("/keywords")
async def list_keywords(platform: str = "xhs"):
    """Get list of historical search keywords"""
    if not DATA_DIR.exists():
        return {"keywords": []}

    platform_dir = DATA_DIR / platform / "json"
    if not platform_dir.exists():
        return {"keywords": []}

    keywords = set()
    # Check all subdirectories (json, txt, csv) for search results
    for sub_dir in ["json", "txt", "csv"]:
        dir_path = DATA_DIR / platform / sub_dir
        if not dir_path.exists():
            continue
        for file_path in dir_path.glob("search_contents_*.*"):
            name = file_path.stem
            parts = name.split("_")
            if len(parts) >= 4 and parts[0] == "search":
                # Handle search_contents_date_time_keyword
                # or search_contents_date_keyword
                start_idx = 3
                if len(parts) >= 5 and parts[3].isdigit() and len(parts[3]) == 4:
                    start_idx = 4
                
                keyword = "_".join(parts[start_idx:])
                if keyword:
                    keywords.add(keyword)
    
    # Sort alphabetically
    sorted_keywords = sorted(list(keywords))
    return {"keywords": sorted_keywords}


@router.get("/gallery")
async def get_gallery_content(limit: int = 50, platform: str = "xhs", keyword: Optional[str] = None):
    """Get high-quality recent records for gallery view"""
    all_records = []
    # Collect all search files from json and txt subfolders
    data_files = []
    for sub_dir in ["json", "txt"]:
        dir_path = DATA_DIR / platform / sub_dir
        if not dir_path.exists():
            continue
        # Only include files that match the search_contents_* pattern
        files = list(dir_path.glob("search_contents_*.*"))
        
        if keyword:
            # Filter by specific keyword in filename
            for f in files:
                name = f.stem
                parts = name.split("_")
                if len(parts) >= 4 and parts[0] == "search":
                    start_idx = 3
                    if len(parts) >= 5 and parts[3].isdigit() and len(parts[3]) == 4:
                        start_idx = 4
                    if "_".join(parts[start_idx:]) == keyword:
                        data_files.append(f)
        else:
            data_files.extend(files)

    if not data_files:
        return {"data": []}

    # Sort files by modification time
    data_files.sort(key=lambda x: x.stat().st_mtime, reverse=True)

    # If no specific keyword provided, we find the keyword of the latest search file
    # and restrict the gallery to only show results for that keyword
    if not keyword:
        latest_keyword = None
        for f in data_files:
            name = f.stem
            parts = name.split("_")
            if len(parts) >= 4 and parts[0] == "search":
                start_idx = 3
                if len(parts) >= 5 and parts[3].isdigit() and len(parts[3]) == 4:
                    start_idx = 4
                latest_keyword = "_".join(parts[start_idx:])
                break
        
        if latest_keyword:
            filtered_files = []
            for f in data_files:
                name = f.stem
                parts = name.split("_")
                if len(parts) >= 4 and parts[0] == "search":
                    start_idx = 3
                    if len(parts) >= 5 and parts[3].isdigit() and len(parts[3]) == 4:
                        start_idx = 4
                    if "_".join(parts[start_idx:]) == latest_keyword:
                        filtered_files.append(f)
            data_files = filtered_files

    # Only look at the latest few files to be efficient
    for file_path in data_files[:10]:
        try:
            if file_path.suffix == ".json":
                with open(file_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, list):
                        all_records.extend(data)
                    elif isinstance(data, dict):
                        all_records.append(data)
            elif file_path.suffix == ".txt":  # JSONL
                with open(file_path, "r", encoding="utf-8") as f:
                    for line in f:
                        if line.strip():
                            try:
                                all_records.append(json.loads(line))
                            except:
                                continue
        except Exception:
            continue
        
        if len(all_records) >= limit * 3:
            break

    # Sort records by liked count (heuristic for quality)
    def get_likes(record):
        likes = record.get("liked_count", "0")
        if isinstance(likes, str):
            if "万" in likes:
                return int(float(likes.replace("万", "")) * 10000)
            return int(likes) if likes.isdigit() else 0
        return likes if isinstance(likes, int) else 0

    # Filter out records without images
    all_records = [r for r in all_records if r.get("image_list")]
    
    # Sort by likes descending
    all_records.sort(key=get_likes, reverse=True)

    return {"data": all_records[:limit]}
