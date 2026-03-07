# -*- coding: utf-8 -*-
"""
Postiz integration API blueprint.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sqlite3
import threading
import uuid
from pathlib import Path
from queue import Queue

from flask import Blueprint, jsonify, request, send_from_directory
from playwright.async_api import async_playwright

from conf import BASE_DIR, LOCAL_CHROME_HEADLESS
from myUtils.auth import check_cookie
from myUtils.login import douyin_cookie_gen, xiaohongshu_cookie_gen
from myUtils.postVideo import post_image_xhs, post_video_DouYin, post_video_xhs
from myUtils.xhs_api_publish import (
    publish_image_note_with_api,
    should_fallback_to_xhs_api,
)

postiz_api = Blueprint("postiz_api", __name__, url_prefix="/api/v1")

# Active login sessions:
# { session_id: {queue, platform, platform_type, account_name, status, qrcode_url} }
login_sessions: dict[str, dict] = {}


def _db_path() -> Path:
    return Path(BASE_DIR / "db" / "database.db")


def _resolve_service_headless() -> bool:
    if LOCAL_CHROME_HEADLESS:
        return True
    if os.name == "nt":
        return False
    return not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


async def export_storage_state_from_user_data_dir(
    platform: str, user_data_dir: str, storage_path: Path
) -> None:
    platform_urls = {
        "xiaohongshu": "https://creator.xiaohongshu.com/creator-micro/content/upload",
        "douyin": "https://creator.douyin.com/creator-micro/content/upload",
    }
    target_url = platform_urls.get(platform)
    if not target_url:
        raise ValueError(f"unsupported platform: {platform}")

    storage_path.parent.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as playwright:
        context = await playwright.chromium.launch_persistent_context(
            user_data_dir=user_data_dir,
            headless=_resolve_service_headless(),
            args=[
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        try:
            page = await context.new_page()
            await page.goto(target_url, wait_until="domcontentloaded")
            await page.wait_for_timeout(1500)
            await context.storage_state(path=str(storage_path))
        finally:
            await context.close()


@postiz_api.route("/health", methods=["GET"])
def health_check():
    return jsonify(
        {
            "status": "healthy",
            "service": "social-auto-upload",
            "version": "1.0.0",
        }
    ), 200


@postiz_api.route("/platforms", methods=["GET"])
def get_platforms():
    return (
        jsonify(
            {
                "code": 200,
                "data": [
                    {
                        "id": "douyin",
                        "name": "Douyin",
                        "type": 3,
                        "icon": "douyin",
                        "supported_media": ["video"],
                        "max_video_size_mb": 128,
                        "max_title_length": 30,
                    },
                    {
                        "id": "xiaohongshu",
                        "name": "Xiaohongshu",
                        "type": 1,
                        "icon": "xiaohongshu",
                        "supported_media": ["video", "image"],
                        "max_video_size_mb": 100,
                        "max_title_length": 20,
                    },
                ],
            }
        ),
        200,
    )


@postiz_api.route("/accounts", methods=["GET"])
def get_accounts():
    platform = request.args.get("platform")
    type_map = {"douyin": 3, "xiaohongshu": 1}
    platform_type = type_map.get(platform or "")

    try:
        with sqlite3.connect(_db_path()) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            if platform and platform_type:
                cursor.execute("SELECT * FROM user_info WHERE type = ?", (platform_type,))
            else:
                cursor.execute("SELECT * FROM user_info")

            rows = cursor.fetchall()

        type_names = {1: "xiaohongshu", 2: "weixin", 3: "douyin", 4: "kuaishou"}
        accounts = []
        for row in rows:
            row_dict = dict(row)
            row_dict["platform"] = type_names.get(row_dict.get("type"), "unknown")
            accounts.append(row_dict)

        return jsonify({"code": 200, "msg": "success", "data": accounts}), 200
    except Exception as e:
        return jsonify({"code": 500, "msg": f"get accounts failed: {e}", "data": None}), 500


@postiz_api.route("/accounts/import-user-data", methods=["POST"])
def import_account_from_user_data():
    data = request.get_json(silent=True) or {}
    platform = str(data.get("platform") or "xiaohongshu").strip().lower()
    user_data_dir = str(data.get("user_data_dir") or "").strip()
    account_name = str(data.get("account_name") or f"imported_{uuid.uuid4().hex[:8]}").strip()

    type_map = {"douyin": 3, "xiaohongshu": 1}
    platform_type = type_map.get(platform)

    if not platform_type:
        return jsonify({"code": 400, "msg": "unsupported platform", "data": None}), 400

    if not user_data_dir:
        return jsonify({"code": 400, "msg": "missing user_data_dir", "data": None}), 400

    profile_dir = Path(user_data_dir)
    if not profile_dir.exists():
        return (
            jsonify({"code": 400, "msg": f"user_data_dir not found: {user_data_dir}", "data": None}),
            400,
        )

    storage_filename = f"{uuid.uuid4()}.json"
    storage_path = Path(BASE_DIR / "cookiesFile" / storage_filename)

    try:
        asyncio.run(
            export_storage_state_from_user_data_dir(
                platform=platform,
                user_data_dir=str(profile_dir),
                storage_path=storage_path,
            )
        )
        is_valid = asyncio.run(check_cookie(platform_type, storage_filename))
        status = 1 if is_valid else 0
        stored_file_ref = (
            storage_filename
            if is_valid
            else f"user_data_dir::{str(profile_dir)}"
        )
        if not is_valid:
            storage_path.unlink(missing_ok=True)

        with sqlite3.connect(_db_path()) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute(
                "SELECT id FROM user_info WHERE type = ? AND lower(userName) = lower(?) ORDER BY id DESC LIMIT 1",
                (platform_type, account_name),
            )
            existing = cursor.fetchone()
            if not existing:
                cursor.execute(
                    "SELECT id FROM user_info WHERE type = ? AND filePath = ? ORDER BY id DESC LIMIT 1",
                    (platform_type, stored_file_ref),
                )
                existing = cursor.fetchone()
            if existing:
                account_id = int(existing["id"])
                cursor.execute(
                    """
                    UPDATE user_info
                    SET filePath = ?, userName = ?, status = ?
                    WHERE id = ?
                    """,
                    (stored_file_ref, account_name, status, account_id),
                )
            else:
                cursor.execute(
                    """
                    INSERT INTO user_info (type, filePath, userName, status)
                    VALUES (?, ?, ?, ?)
                    """,
                    (platform_type, stored_file_ref, account_name, status),
                )
                account_id = cursor.lastrowid
            conn.commit()

        return (
            jsonify(
                {
                    "code": 200,
                    "msg": "account imported" if is_valid else "account imported (cookie not validated for publish page)",
                    "data": {
                        "id": account_id,
                        "platform": platform,
                        "userName": account_name,
                        "filePath": stored_file_ref,
                        "status": status,
                        "valid": is_valid,
                    },
                }
            ),
            200,
        )
    except Exception as e:
        return jsonify({"code": 500, "msg": f"import failed: {e}", "data": None}), 500


@postiz_api.route("/accounts/<int:account_id>/validate", methods=["POST"])
def validate_account(account_id: int):
    try:
        with sqlite3.connect(_db_path()) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM user_info WHERE id = ?", (account_id,))
            row = cursor.fetchone()

            if not row:
                return jsonify({"code": 404, "msg": "account not found", "data": None}), 404

            row_dict = dict(row)
            is_valid = asyncio.run(check_cookie(row_dict["type"], row_dict["filePath"]))

            cursor.execute(
                "UPDATE user_info SET status = ? WHERE id = ?",
                (1 if is_valid else 0, account_id),
            )
            conn.commit()

        return jsonify({"code": 200, "msg": "success", "data": {"id": account_id, "valid": is_valid}}), 200
    except Exception as e:
        return jsonify({"code": 500, "msg": f"validate failed: {e}", "data": None}), 500


@postiz_api.route("/login/init", methods=["POST"])
def init_login():
    data = request.get_json(silent=True) or {}
    platform = data.get("platform")
    account_name = data.get("account_name", f"account_{uuid.uuid4().hex[:8]}")

    platform_types = {"douyin": 3, "xiaohongshu": 1}
    platform_type = platform_types.get(platform)
    if not platform_type:
        return jsonify({"code": 400, "msg": "unsupported platform", "data": None}), 400

    session_id = str(uuid.uuid4())
    status_queue: Queue = Queue()
    login_sessions[session_id] = {
        "queue": status_queue,
        "platform": platform,
        "platform_type": platform_type,
        "account_name": account_name,
        "status": "pending",
        "qrcode_url": None,
    }

    thread = threading.Thread(
        target=run_login_async,
        args=(session_id, platform_type, account_name, status_queue),
        daemon=True,
    )
    thread.start()

    return (
        jsonify(
            {
                "code": 200,
                "msg": "login session created",
                "data": {
                    "session_id": session_id,
                    "platform": platform,
                    "account_name": account_name,
                },
            }
        ),
        200,
    )


@postiz_api.route("/login/status/<session_id>", methods=["GET"])
def get_login_status(session_id: str):
    session = login_sessions.get(session_id)
    if not session:
        return jsonify({"code": 404, "msg": "session not found", "data": None}), 404

    messages = []
    queue = session["queue"]
    while not queue.empty():
        msg = queue.get()
        messages.append(msg)

        msg_lower = str(msg).lower()
        if "success" in msg_lower or msg == "200":
            session["status"] = "success"
        elif "failed" in msg_lower or "error" in msg_lower or msg == "500":
            session["status"] = "failed"
        elif "qrcode" in msg_lower:
            session["status"] = "waiting_scan"

    if messages and messages[-1] == "200":
        session["status"] = "success"

    return (
        jsonify(
            {
                "code": 200,
                "msg": "success",
                "data": {
                    "session_id": session_id,
                    "status": session["status"],
                    "platform": session["platform"],
                    "messages": messages,
                },
            }
        ),
        200,
    )


@postiz_api.route("/login/cancel/<session_id>", methods=["POST"])
def cancel_login(session_id: str):
    if session_id in login_sessions:
        del login_sessions[session_id]
        return jsonify({"code": 200, "msg": "session canceled", "data": None}), 200
    return jsonify({"code": 404, "msg": "session not found", "data": None}), 404


@postiz_api.route("/douyin/publish", methods=["POST"])
def publish_douyin():
    data = request.get_json(silent=True) or {}
    account_id = data.get("account_id")
    video_url = data.get("video_url")
    title = data.get("title", "")
    tags = data.get("tags", [])
    scheduled_time = data.get("scheduled_time")
    thumbnail_url = data.get("thumbnail_url")
    product_link = data.get("product_link", "")
    product_title = data.get("product_title", "")

    if not account_id or not video_url:
        return jsonify({"code": 400, "msg": "missing account_id or video_url", "data": None}), 400

    try:
        with sqlite3.connect(_db_path()) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM user_info WHERE id = ? AND type = 3", (account_id,))
            account = cursor.fetchone()
            if not account:
                return jsonify({"code": 404, "msg": "douyin account not found", "data": None}), 404

        account_list = [dict(account)["filePath"]]
        file_list = [video_url]
        enable_timer = scheduled_time is not None

        thread = threading.Thread(
            target=lambda: post_video_DouYin(
                title=title,
                files=file_list,
                tags=tags,
                account_file=account_list,
                category=None,
                enableTimer=enable_timer,
                videos_per_day=1,
                daily_times=[10],
                start_days=0,
                thumbnail_path=thumbnail_url,
                productLink=product_link,
                productTitle=product_title,
            ),
            daemon=True,
        )
        thread.start()

        return (
            jsonify(
                {
                    "code": 200,
                    "msg": "publish task submitted",
                    "data": {"account_id": account_id, "platform": "douyin", "status": "processing"},
                }
            ),
            200,
        )
    except Exception as e:
        return jsonify({"code": 500, "msg": f"publish failed: {e}", "data": None}), 500


@postiz_api.route("/xiaohongshu/publish", methods=["POST"])
def publish_xiaohongshu():
    data = request.get_json(silent=True) or {}
    account_id = data.get("account_id")
    video_url = data.get("video_url")
    title = data.get("title", "")
    tags = data.get("tags", [])
    scheduled_time = data.get("scheduled_time")

    if not account_id or not video_url:
        return jsonify({"code": 400, "msg": "missing account_id or video_url", "data": None}), 400

    try:
        with sqlite3.connect(_db_path()) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM user_info WHERE id = ? AND type = 1", (account_id,))
            account = cursor.fetchone()
            if not account:
                return jsonify({"code": 404, "msg": "xiaohongshu account not found", "data": None}), 404
            account_dict = dict(account)

        source_path = Path(video_url)
        if source_path.is_absolute() and source_path.exists():
            dest_filename = f"{uuid.uuid4().hex}_{source_path.name}"
            dest_path = Path(BASE_DIR / "videoFile" / dest_filename)
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(source_path), str(dest_path))
            file_list = [dest_filename]
        else:
            file_list = [video_url]

        account_file_list = [account_dict["filePath"]]
        enable_timer = scheduled_time is not None

        post_video_xhs(
            title=title,
            files=file_list,
            tags=tags,
            account_file=account_file_list,
            category=None,
            enableTimer=enable_timer,
            videos_per_day=1,
            daily_times=[10],
            start_days=0,
        )

        return (
            jsonify(
                {
                    "code": 200,
                    "msg": "publish success",
                    "data": {
                        "account_id": account_id,
                        "platform": "xiaohongshu",
                        "status": "published",
                    },
                }
            ),
            200,
        )
    except Exception as e:
        return jsonify({"code": 500, "msg": f"publish failed: {e}", "data": None}), 500


@postiz_api.route("/xiaohongshu/publish-image", methods=["POST"])
def publish_xiaohongshu_image():
    data = request.get_json(silent=True) or {}
    account_id = data.get("account_id")
    image_urls = data.get("image_urls", [])
    title = data.get("title", "")
    tags = data.get("tags", [])
    description = data.get("description", "")
    scheduled_time = data.get("scheduled_time")

    if not image_urls and data.get("image_url"):
        image_urls = [data.get("image_url")]

    if not account_id or not image_urls:
        return jsonify({"code": 400, "msg": "missing account_id or image_urls", "data": None}), 400

    try:
        with sqlite3.connect(_db_path()) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM user_info WHERE id = ? AND type = 1", (account_id,))
            account = cursor.fetchone()
            if not account:
                return jsonify({"code": 404, "msg": "xiaohongshu account not found", "data": None}), 404
            account_dict = dict(account)

        image_dir = Path(BASE_DIR / "imageFile")
        image_dir.mkdir(parents=True, exist_ok=True)

        processed_images: list[str] = []
        for img_url in image_urls:
            source_path = Path(img_url)
            if source_path.is_absolute() and source_path.exists():
                dest_filename = f"{uuid.uuid4().hex}_{source_path.name}"
                dest_path = image_dir / dest_filename
                shutil.copy2(str(source_path), str(dest_path))
                processed_images.append(dest_filename)
            else:
                processed_images.append(img_url)

        account_file_list = [account_dict["filePath"]]
        enable_timer = scheduled_time is not None

        publish_method = "creator_web_automation"
        fallback_note = None
        try:
            post_image_xhs(
                title=title,
                images=processed_images,
                tags=tags,
                account_file=account_file_list,
                description=description,
                enableTimer=enable_timer,
                videos_per_day=1,
                daily_times=[10],
                start_days=0,
            )
        except Exception as creator_error:
            if not should_fallback_to_xhs_api(creator_error):
                raise

            fallback_note = publish_image_note_with_api(
                account_file=str(account_dict.get("filePath") or ""),
                title=title,
                description=description,
                tags=tags,
                image_paths=processed_images,
                scheduled_time=scheduled_time,
            )
            publish_method = "xhs_api_fallback"

        return (
            jsonify(
                {
                    "code": 200,
                    "msg": "publish success",
                    "data": {
                        "account_id": account_id,
                        "platform": "xiaohongshu",
                        "type": "image",
                        "image_count": len(processed_images),
                        "status": "published",
                        "publish_method": publish_method,
                        "note": fallback_note,
                    },
                }
            ),
            200,
        )
    except Exception as e:
        return jsonify({"code": 500, "msg": f"publish failed: {e}", "data": None}), 500


@postiz_api.route("/media/upload", methods=["POST"])
def upload_media():
    if "file" not in request.files:
        return jsonify({"code": 400, "msg": "file is required", "data": None}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"code": 400, "msg": "filename is empty", "data": None}), 400

    try:
        file_uuid = str(uuid.uuid4())
        ext = file.filename.rsplit(".", 1)[-1] if "." in file.filename else ""
        new_filename = f"{file_uuid}.{ext}" if ext else file_uuid

        filepath = Path(BASE_DIR / "videoFile" / new_filename)
        filepath.parent.mkdir(parents=True, exist_ok=True)
        file.save(str(filepath))

        file_size = os.path.getsize(filepath)
        return (
            jsonify(
                {
                    "code": 200,
                    "msg": "upload success",
                    "data": {
                        "file_id": file_uuid,
                        "filename": new_filename,
                        "original_name": file.filename,
                        "size_bytes": file_size,
                        "size_mb": round(file_size / (1024 * 1024), 2),
                        "url": f"/api/v1/media/{new_filename}",
                    },
                }
            ),
            200,
        )
    except Exception as e:
        return jsonify({"code": 500, "msg": f"upload failed: {e}", "data": None}), 500


@postiz_api.route("/media/<filename>", methods=["GET"])
def get_media(filename: str):
    if ".." in filename or filename.startswith("/"):
        return jsonify({"code": 400, "msg": "invalid filename", "data": None}), 400
    file_path = Path(BASE_DIR / "videoFile")
    return send_from_directory(str(file_path), filename)


def run_login_async(session_id: str, platform_type: int, account_name: str, status_queue: Queue):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        if platform_type == 3:
            loop.run_until_complete(douyin_cookie_gen(account_name, status_queue))
        elif platform_type == 1:
            loop.run_until_complete(xiaohongshu_cookie_gen(account_name, status_queue))
    except Exception as e:
        status_queue.put(f"error: {e}")
    finally:
        loop.close()
        # Keep final state queryable for one minute.
        import time

        time.sleep(60)
        if session_id in login_sessions:
            del login_sessions[session_id]
