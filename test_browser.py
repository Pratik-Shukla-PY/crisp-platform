from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.on("console", lambda msg: print(f"Browser Console: {msg.text}"))
    page.on("pageerror", lambda err: print(f"Browser Error: {err.message}"))
    page.goto("http://localhost:8080")
    page.wait_for_selector(".feed-panel", timeout=5000)
    print("Page loaded successfully.")
    browser.close()
