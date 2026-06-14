import path from 'path';
import os from 'os';
import fsp from 'fs/promises';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

// ── Coupang Wing 자동화 (Playwright, dev 서버 전용) ──
async function runWingDownload(
  credentials: { id: string; password: string },
  status: 'INSTRUCT' | 'ACCEPT',
  businessName: string,
): Promise<{ filePath: string; fileName: string }> {
  const { chromium } = await import('playwright');
  const statusLabel = status === 'INSTRUCT' ? '상품준비중' : '결제완료';
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wing-'));

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome', // 설치된 실제 Chrome 사용 (봇 감지 우회)
    slowMo: 200,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  });
  // navigator.webdriver 플래그 제거 (봇 탐지 우회)
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  try {
    // 1. 로그인
    await page.goto('https://wing.coupang.com');
    await page.waitForLoadState('domcontentloaded');

    const needsLogin = await page.locator('input[type="password"]').isVisible().catch(() => false);
    if (needsLogin) {
      const idInput = page.locator('input[name="vendorId"], input[id="vendorId"], input[type="text"]').first();
      await idInput.fill(credentials.id);
      await page.locator('input[type="password"]').first().fill(credentials.password);
      // 로그인 버튼 — button/a/div 등 요소 종류 무관하게 텍스트로 찾기
      await page.locator(':text-is("로그인"), [type="submit"]').first().click();
      // 최대 60초 대기 — OTP 등 추가 인증 시간 포함
      await page.waitForURL(url => !url.toString().includes('login'), { timeout: 60_000 });
    }

    // 2. 주문배송관리 이동
    await page.goto('https://wing.coupang.com/order/management');
    await page.waitForLoadState('domcontentloaded');

    // 3. 상태 탭 클릭
    const tab = page.locator(`text="${statusLabel}"`).first();
    await tab.waitFor({ state: 'visible', timeout: 15_000 });
    await tab.click();
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    // 4. 다운로드 버튼 클릭
    const dlBtn = page.locator(
      'button:has-text("엑셀 다운로드"), button:has-text("다운로드"), a:has-text("다운로드")'
    ).first();
    await dlBtn.waitFor({ state: 'visible', timeout: 10_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dlBtn.click(),
    ]);

    // 확인 모달이 뜨면 처리
    const confirmBtn = page.locator('button:has-text("확인")').first();
    if (await confirmBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await confirmBtn.click();
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `주문배송관리-${statusLabel}-${businessName}-${dateStr}.xlsx`;
    const filePath = path.join(tmpDir, fileName);
    await download.saveAs(filePath);

    return { filePath, fileName };
  } finally {
    await browser.close();
  }
}

// Vite dev 서버 미들웨어 플러그인
function wingAutomationPlugin(): Plugin {
  return {
    name: 'wing-automation',
    configureServer(server) {
      server.middlewares.use('/api/wing-download', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const { id, password, status, businessName } = JSON.parse(body);
            const { filePath, fileName } = await runWingDownload({ id, password }, status, businessName);

            const fileBuffer = await fsp.readFile(filePath);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
            res.end(fileBuffer);

            fsp.unlink(filePath).catch(() => {});
          } catch (e: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: e.message ?? '자동화 오류' }));
          }
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
      proxy: {
        '/coupang-api': {
          target: 'https://api-gateway.coupang.com',
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/coupang-api/, ''),
        },
      },
    },
    plugins: [react(), wingAutomationPlugin()],
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
  };
});
