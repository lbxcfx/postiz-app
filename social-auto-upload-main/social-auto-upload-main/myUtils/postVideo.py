import asyncio
from pathlib import Path

from conf import BASE_DIR
from uploader.douyin_uploader.main import DouYinVideo
from uploader.ks_uploader.main import KSVideo
from uploader.tencent_uploader.main import TencentVideo
from uploader.xiaohongshu_uploader.main import XiaoHongShuVideo, XiaoHongShuImage
from utils.constant import TencentZoneTypes
from utils.files_times import generate_schedule_time_next_day

USER_DATA_DIR_PREFIX = "user_data_dir::"


def _cookie_paths(account_file):
    resolved = []
    for file in account_file:
        value = str(file or "").strip()
        if not value:
            continue
        if value.startswith(USER_DATA_DIR_PREFIX):
            resolved.append(value)
            continue
        path = Path(value)
        if path.is_absolute():
            resolved.append(path)
            continue
        resolved.append(Path(BASE_DIR / "cookiesFile" / value))
    return resolved


def _video_paths(files):
    return [Path(BASE_DIR / "videoFile" / file) for file in files]


def post_video_tencent(
    title,
    files,
    tags,
    account_file,
    category=TencentZoneTypes.LIFESTYLE.value,
    enableTimer=False,
    videos_per_day=1,
    daily_times=None,
    start_days=0,
    is_draft=False,
):
    account_file = _cookie_paths(account_file)
    files = _video_paths(files)
    if enableTimer:
        publish_datetimes = generate_schedule_time_next_day(
            len(files), videos_per_day, daily_times, start_days
        )
    else:
        publish_datetimes = [0 for _ in range(len(files))]

    for index, file in enumerate(files):
        for cookie in account_file:
            print(f"file path: {file}")
            print(f"title: {title}")
            print(f"tags: {tags}")
            app = TencentVideo(
                title, str(file), tags, publish_datetimes[index], cookie, category, is_draft
            )
            asyncio.run(app.main(), debug=False)

    return True


def post_video_DouYin(
    title,
    files,
    tags,
    account_file,
    category=TencentZoneTypes.LIFESTYLE.value,
    enableTimer=False,
    videos_per_day=1,
    daily_times=None,
    start_days=0,
    thumbnail_path="",
    productLink="",
    productTitle="",
):
    account_file = _cookie_paths(account_file)
    files = _video_paths(files)
    if enableTimer:
        publish_datetimes = generate_schedule_time_next_day(
            len(files), videos_per_day, daily_times, start_days
        )
    else:
        publish_datetimes = [0 for _ in range(len(files))]

    for index, file in enumerate(files):
        for cookie in account_file:
            print(f"file path: {file}")
            print(f"title: {title}")
            print(f"tags: {tags}")
            app = DouYinVideo(
                title,
                str(file),
                tags,
                publish_datetimes[index],
                cookie,
                thumbnail_path,
                productLink,
                productTitle,
            )
            asyncio.run(app.main(), debug=False)

    return True


def post_video_ks(
    title,
    files,
    tags,
    account_file,
    category=TencentZoneTypes.LIFESTYLE.value,
    enableTimer=False,
    videos_per_day=1,
    daily_times=None,
    start_days=0,
):
    account_file = _cookie_paths(account_file)
    files = _video_paths(files)
    if enableTimer:
        publish_datetimes = generate_schedule_time_next_day(
            len(files), videos_per_day, daily_times, start_days
        )
    else:
        publish_datetimes = [0 for _ in range(len(files))]

    for index, file in enumerate(files):
        for cookie in account_file:
            print(f"file path: {file}")
            print(f"title: {title}")
            print(f"tags: {tags}")
            app = KSVideo(title, str(file), tags, publish_datetimes[index], cookie)
            asyncio.run(app.main(), debug=False)

    return True


def post_video_xhs(
    title,
    files,
    tags,
    account_file,
    category=TencentZoneTypes.LIFESTYLE.value,
    enableTimer=False,
    videos_per_day=1,
    daily_times=None,
    start_days=0,
):
    account_file = _cookie_paths(account_file)
    files = _video_paths(files)
    if not account_file:
        raise ValueError("No Xiaohongshu account cookie file provided")
    if not files:
        raise ValueError("No Xiaohongshu video file provided")

    if enableTimer:
        publish_datetimes = generate_schedule_time_next_day(
            len(files), videos_per_day, daily_times, start_days
        )
    else:
        publish_datetimes = [0 for _ in range(len(files))]

    for index, file in enumerate(files):
        publish_datetime = publish_datetimes[index]
        for cookie in account_file:
            print(f"title: {title}")
            print(f"video: {file}")
            print(f"tags: {tags}")
            app = XiaoHongShuVideo(title, file, tags, publish_datetime, cookie)
            asyncio.run(app.main(), debug=False)

    return True


def post_image_xhs(
    title,
    images,
    tags,
    account_file,
    description="",
    enableTimer=False,
    videos_per_day=1,
    daily_times=None,
    start_days=0,
):
    account_file = _cookie_paths(account_file)
    if not account_file:
        raise ValueError("No Xiaohongshu account cookie file provided")

    image_paths = []
    for img in images:
        img_path = Path(img)
        if img_path.is_absolute() and img_path.exists():
            image_paths.append(img_path)
            continue

        img_in_image_dir = Path(BASE_DIR / "imageFile" / img)
        img_in_video_dir = Path(BASE_DIR / "videoFile" / img)
        if img_in_image_dir.exists():
            image_paths.append(img_in_image_dir)
        elif img_in_video_dir.exists():
            image_paths.append(img_in_video_dir)
        else:
            print(f"warning: image file not found: {img}")

    if not image_paths:
        raise FileNotFoundError(f"No valid image file found in request: {images}")

    if enableTimer:
        publish_datetimes = generate_schedule_time_next_day(
            1, videos_per_day, daily_times, start_days
        )
        publish_datetime = publish_datetimes[0] if publish_datetimes else 0
    else:
        publish_datetime = 0

    for cookie in account_file:
        print(f"title: {title}")
        print(f"images: {image_paths}")
        print(f"description: {description}")
        print(f"tags: {tags}")
        app = XiaoHongShuImage(
            title, image_paths, tags, publish_datetime, cookie, description
        )
        asyncio.run(app.main(), debug=False)

    return True
