import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('http://localhost:3001', { waitUntil: 'load', timeout: 20000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: '/private/tmp/claude-501/-Users-jia-Desktop-------------/aac92638-5828-47ff-8d0d-48e1365cf908/scratchpad/initial.png', fullPage: true });
console.log('title:', await page.title());
await browser.close();
