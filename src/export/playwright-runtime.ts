import { Text } from '../shared/index.js';

export class PlaywrightRuntime {
  static readonly BODY_LIMIT = 2000;

  static prelude(origin: string): string {
    return `import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

const BASE_URL = process.env.APPII_BASE_URL ?? ${Text.jsString(origin)};
const HEADLESS = process.env.APPII_HEADFUL === undefined;
const SLOW_MO = Number(process.env.APPII_SLOW_MO ?? '0');
const TIMEOUT = Number(process.env.APPII_TIMEOUT ?? '30000');

function readVar(vars, name, fallback) {
  if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
  const env = process.env['APPII_' + name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')];
  return env === undefined ? fallback : env;
}

async function toResult(response) {
  if (!response) return { method: undefined, url: undefined, status: undefined, headers: {}, body: undefined };
  let body;
  try {
    body = await response.text();
  } catch {
    body = undefined;
  }
  return { method: response.request().method(), url: response.url(), status: response.status(), headers: response.headers(), body };
}

async function pageFetch(page, url, init) {
  return page.evaluate(async (input) => {
    const res = await fetch(input.url, input.init);
    const body = await res.text().catch(() => undefined);
    const headers = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { method: (input.init && input.init.method) || 'GET', url: res.url, status: res.status, headers, body };
  }, { url, init });
}`;
  }

  static classHead(clientName: string): string {
    return `export class ${clientName} {
  constructor(browser, context, page) {
    this.browser = browser;
    this.context = context;
    this.page = page;
  }

  static async launch(options = {}) {
    const browser = await chromium.launch({ headless: options.headless ?? HEADLESS, slowMo: options.slowMo ?? SLOW_MO });
    const context = await browser.newContext(BASE_URL ? { baseURL: BASE_URL } : {});
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    page.setDefaultNavigationTimeout(TIMEOUT);
    return new ${clientName}(browser, context, page);
  }

  async close() {
    await this.browser.close();
  }

  async capture(method, pattern, action) {
    const matcher = new RegExp(pattern);
    const wait = this.page.waitForResponse((response) => response.request().method() === method && matcher.test(new URL(response.url()).pathname), { timeout: TIMEOUT });
    const [response] = await Promise.all([wait, action()]);
    return toResult(response);
  }`;
  }

  static main(clientName: string, names: readonly string[], hasLogin: boolean): string {
    const list = names.map((name) => Text.jsString(name)).join(', ');
    const loginGate = hasLogin ? `\n    if (vars.__login === '1' || process.env.APPII_LOGIN === '1') await client.login(vars);` : '';
    return `const ENDPOINTS = [${list}];

async function main() {
  const argv = process.argv.slice(2);
  const name = argv[0];
  if (name === undefined || name === '--list' || name === '-l') {
    for (const endpoint of ENDPOINTS) console.log(endpoint);
    return;
  }
  if (!ENDPOINTS.includes(name)) {
    console.error('unknown endpoint: ' + name + ' (run with --list)');
    process.exitCode = 1;
    return;
  }
  const vars = {};
  for (const arg of argv.slice(1)) {
    const eq = arg.indexOf('=');
    if (eq > 0) vars[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  const client = await ${clientName}.launch();
  try {${loginGate}
    const result = await client[name](vars);
    const text = typeof result.body === 'string' && result.body.length > ${PlaywrightRuntime.BODY_LIMIT} ? result.body.slice(0, ${PlaywrightRuntime.BODY_LIMIT}) + '...' : result.body;
    console.log(JSON.stringify({ method: result.method, url: result.url, status: result.status, body: text }, null, 2));
  } finally {
    await client.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}`;
  }
}
