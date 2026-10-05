import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LaunchOptions } from 'playwright';
import { BrowserLauncher, CaptureSession, CookieParser, TrafficRecorder } from '../src/capture/index.js';
import type { LaunchedBrowser } from '../src/capture/index.js';
import { AppiiError, Text } from '../src/shared/index.js';

const XSERVER = [
  'browserType.launch: Target page, context or browser has been closed',
  'Browser logs:',
  'Looks like you launched a headed browser without having a XServer running.',
  "Set either 'headless: true' or use 'xvfb-run <your-playwright-app>' before running Playwright.",
].join('\n');

class NoDisplayLauncher extends BrowserLauncher {
  override launchOptions(): LaunchOptions {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== 'DISPLAY' && key !== 'WAYLAND_DISPLAY') env[key] = value;
    return { ...super.launchOptions(), headless: false, env };
  }
}

class FailingLauncher extends BrowserLauncher {
  override async launch(): Promise<LaunchedBrowser> {
    throw BrowserLauncher.launchError(new Error(XSERVER));
  }
}

describe('browser launch diagnostics', () => {
  test('launchError names the real cause and gives the install hint only when the browser is missing', () => {
    const display = BrowserLauncher.launchError(new Error(XSERVER));
    assert.equal(display.code, 'BROWSER');
    assert.equal(display.message, 'Cannot open a browser window: no display (X server) is available');
    assert.match(Text.errorMessage(display.cause), /XServer/);
    assert.equal(BrowserLauncher.launchError(new Error('browserType.launch: Missing X server or $DISPLAY')).message, BrowserLauncher.NO_DISPLAY_MESSAGE);
    const missing = BrowserLauncher.launchError(new Error("browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1/chrome-linux/chrome\nPlease run npx playwright install"));
    assert.equal(missing.message, 'Cannot launch Chromium: Chromium is not installed. Install it with "npx playwright install chromium"');
    const configured = BrowserLauncher.launchError(new Error("browserType.launch: Failed to launch chromium because executable doesn't exist at /opt/chrome"), '/opt/chrome');
    assert.equal(configured.message, 'Cannot launch Chromium: the browser file /opt/chrome does not exist');
    const other = BrowserLauncher.launchError(new Error('browserType.launch: Browser closed.\n==== logs ====\nsandbox failure'));
    assert.equal(other.message, 'Cannot launch Chromium: Browser closed.');
    assert.doesNotMatch(other.message, /install|executable path/i);
    assert.equal(BrowserLauncher.launchError(new Error('spawn EACCES'), '/opt/chrome').message, 'Cannot launch Chromium from /opt/chrome: spawn EACCES');
  });

  test('a real headed launch without a display reports the missing X server and keeps the Playwright error as the cause', { timeout: 60_000 }, async () => {
    const err = await new NoDisplayLauncher({ headless: false }).launch().then(
      (launched) => launched.browser.close().then(() => assert.fail('a headed browser started without a display')),
      (failure: unknown) => failure,
    );
    assert.ok(err instanceof AppiiError);
    assert.equal(err.message, BrowserLauncher.NO_DISPLAY_MESSAGE);
    assert.match(Text.errorMessage(err.cause), /XServer|X server|DISPLAY/);
  });

  test('a real launch with a missing executable names the file', async () => {
    await assert.rejects(new BrowserLauncher({ headless: true, executablePath: '/nonexistent/appii-chrome' }).launch(), (err: unknown) => err instanceof AppiiError && err.message === 'Cannot launch Chromium: the browser file /nonexistent/appii-chrome does not exist');
  });
});

describe('CaptureSession onReady', () => {
  test('is never called when the browser cannot start', async () => {
    let ready = 0;
    const session = new CaptureSession({ url: 'http://127.0.0.1:9/', headless: true, onReady: () => ready++ }, { launcher: new FailingLauncher({ headless: true }), recorder: new TrafficRecorder(), cookies: new CookieParser() });
    await assert.rejects(session.run(), (err: unknown) => err instanceof AppiiError && err.message === BrowserLauncher.NO_DISPLAY_MESSAGE);
    assert.equal(ready, 0);
  });

  test('is called once, after the browser is ready and before the first request', { timeout: 60_000 }, async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>t</title><p>ok</p>');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      const events: string[] = [];
      const capture = await CaptureSession.create({ url, headless: true, idleMs: 200, onReady: () => events.push('ready'), onExchange: (exchange) => events.push(exchange.request.url) }).run();
      assert.equal(events[0], 'ready');
      assert.equal(events.filter((event) => event === 'ready').length, 1);
      assert.ok(events.includes(url));
      assert.ok(capture.exchanges.some((exchange) => exchange.request.url === url));
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});
