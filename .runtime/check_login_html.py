from pathlib import Path

path = Path(
    "/home/lbx/postiz-app/MediaCrawler/runtime/login_debug/login_by_mobile_no_dialog_20260218_094939.html"
)
text = path.read_text(encoding="utf-8", errors="ignore")
keys = [
    "login-btn",
    "登录",
    "手机号登录",
    "获取验证码",
    "login-container",
    "IP存在风险",
    "300012",
    "avatar",
]
for key in keys:
    print(f"{key}: {key in text}")
print(f"length: {len(text)}")

needle = "login-btn"
idx = 0
count = 0
while True:
    i = text.find(needle, idx)
    if i < 0 or count >= 5:
        break
    start = max(0, i - 120)
    end = min(len(text), i + 180)
    print(f"\n--- hit {count+1} ---")
    print(text[start:end])
    idx = i + len(needle)
    count += 1

needle2 = "side-bar-component login-btn"
i2 = text.find(needle2)
print("\nside-bar-component login-btn idx:", i2)
if i2 >= 0:
    s = max(0, i2 - 200)
    e = min(len(text), i2 + 500)
    print(text[s:e])
