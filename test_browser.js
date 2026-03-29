const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
  await page.goto('http://127.0.0.1:8080/web-dashboard/src/index.html');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'test_shot.png' });
  await browser.close();
})();
