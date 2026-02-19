import asyncio
import json
from pathlib import Path

from playwright.async_api import async_playwright


async def main() -> None:
    out_dir = Path("/mnt/f/postiz-app/.runtime")
    out_dir.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--disable-blink-features=AutomationControlled"])
        context = await browser.new_context()
        page = await context.new_page()
        await page.goto("https://www.xiaohongshu.com/explore", wait_until="domcontentloaded")
        await page.wait_for_timeout(12000)

        candidates = await page.evaluate(
            """() => {
                const nodes = Array.from(document.querySelectorAll("button, a, div, span"));
                const keep = [];
                for (const n of nodes) {
                    const text = (n.innerText || "").trim().replace(/\\s+/g, " ");
                    if (!text) continue;
                    if (text.includes("登录") || text.includes("手机号") || text.includes("验证码")) {
                        keep.push({
                            tag: n.tagName.toLowerCase(),
                            className: n.className || "",
                            text: text.slice(0, 80),
                        });
                    }
                }
                return keep.slice(0, 200);
            }"""
        )

        screenshot_path = out_dir / "xhs-page.png"
        html_path = out_dir / "xhs-page.html"
        nodes_path = out_dir / "xhs-login-candidates.json"
        await page.screenshot(path=str(screenshot_path), full_page=True)
        html_path.write_text(await page.content(), encoding="utf-8")
        nodes_path.write_text(json.dumps(candidates, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"screenshot={screenshot_path}")
        print(f"html={html_path}")
        print(f"nodes={nodes_path}")
        print(f"candidate_count={len(candidates)}")

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
