from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    
    # Track console errors
    errors = []
    page.on("pageerror", lambda err: errors.append(err.message))
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    
    try:
        page.goto("http://localhost:8080/web-dashboard/src/index.html")
        page.wait_for_timeout(2000)
        
        # Check if clusters are defined and merging happened
        stats = page.evaluate("""() => {
            return {
                clusterCount: typeof clusters !== 'undefined' ? clusters.length : 'undefined',
                allReportsCount: typeof allReports !== 'undefined' ? allReports.length : 'undefined'
            }
        }""")
        print(f"Stats: {stats}")
        
        if errors:
            print("Console Errors:")
            for e in errors:
                print(f"  - {e}")
        else:
            print("No console errors detected.")
            
    except Exception as e:
        print(f"Error: {e}")
    finally:
        browser.close()
