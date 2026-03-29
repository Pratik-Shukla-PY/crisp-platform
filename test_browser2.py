from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    
    # Track JS errors
    has_errors = False
    def log_error(err):
        global has_errors
        has_errors = True
        print(f"JS ERROR: {err.message}")
        
    page.on("pageerror", log_error)
    
    page.goto("http://localhost:8080/web-dashboard/src/index.html")
    time.sleep(3) # Wait for network requests/clusters
    
    page.screenshot(path="test_shot_after_fix.png")
    
    if not has_errors:
       print("No JS errors detected.")
    
    browser.close()
