import type { ApiModel, CsrfToken, Endpoint } from '../model/index.js';
import { EndpointIndex, Http, SampleText } from '../shared/index.js';
import { Helpers } from './helpers.js';

export interface TokenTarget {
  readonly token: CsrfToken;
  readonly variable: string;
  readonly user: Endpoint;
}

export type ScriptPlan = ReadonlyMap<Endpoint, readonly TokenTarget[]>;

export class PostmanTokenScripts {
  static readonly LANGUAGE = 'text/javascript';
  static readonly LISTEN = 'test';
  static readonly PAGE_SOURCES: ReadonlySet<string> = new Set(['hidden-field', 'meta', 'response']);
  static readonly HTML_HELPERS: readonly string[] = Object.freeze([
    "const appiiCheerio = require('cheerio');",
    'const appiiPage = appiiCheerio.load(pm.response.text());',
    "const appiiInput = (name) => appiiPage('input').filter((i, el) => appiiPage(el).attr('name') === name && (appiiPage(el).attr('value') || '') !== '').first().attr('value');",
    "const appiiMeta = (name) => appiiPage('meta').filter((i, el) => (appiiPage(el).attr('name') || '').toLowerCase() === name.toLowerCase()).first().attr('content');",
  ]);
  static readonly JSON_HELPERS: readonly string[] = Object.freeze([
    'const appiiFind = (value, key, depth) => {',
    "  if (depth > 8 || value === null || typeof value !== 'object') return undefined;",
    "  if (!Array.isArray(value) && typeof value[key] === 'string' && value[key] !== '') return value[key];",
    '  for (const item of Object.values(value)) {',
    '    const found = appiiFind(item, key, depth + 1);',
    '    if (found !== undefined) return found;',
    '  }',
    '  return undefined;',
    '};',
    'const appiiJson = () => { try { return pm.response.json(); } catch (e) { return undefined; } };',
  ]);

  static variable(token: CsrfToken): string {
    return SampleText.placeholderName(token.source === 'cookie' && token.sourceName ? token.sourceName : token.name);
  }

  plan(model: ApiModel, endpoints: readonly Endpoint[]): ScriptPlan {
    const out = new Map<Endpoint, TokenTarget[]>();
    for (const user of endpoints) {
      for (const token of user.auth.csrf) {
        const source = PostmanTokenScripts.source(model, user, token, endpoints);
        if (source === undefined || source === user) continue;
        const targets = out.get(source) ?? [];
        const variable = PostmanTokenScripts.variable(token);
        if (!targets.some((target) => target.variable === variable)) targets.push({ token, variable, user });
        out.set(source, targets);
      }
    }
    return out;
  }

  static source(model: ApiModel, user: Endpoint, token: CsrfToken, endpoints: readonly Endpoint[]): Endpoint | undefined {
    if (token.source === 'cookie') {
      const seed = token.sourceName ? Helpers.tokenSeed(model, token.sourceName) : undefined;
      return seed === undefined ? undefined : PostmanTokenScripts.#page(seed, endpoints);
    }
    if (!PostmanTokenScripts.PAGE_SOURCES.has(token.source)) return undefined;
    if (EndpointIndex.tokenRequest(token) !== undefined) return EndpointIndex.tokenSource(token, endpoints);
    const page = Helpers.tokenPage(token, user);
    return page === undefined ? undefined : PostmanTokenScripts.#page(page, endpoints);
  }

  static #page(url: string, endpoints: readonly Endpoint[]): Endpoint | undefined {
    const parsed = Http.parseUrl(url);
    if (!parsed) return undefined;
    return endpoints.find((endpoint) => endpoint.method === EndpointIndex.PAGE_LOAD_METHOD && endpoint.origin === parsed.origin && EndpointIndex.matchPath(endpoint.path, parsed.pathname) !== undefined);
  }

  exec(targets: readonly TokenTarget[]): string[] {
    const html = targets.some((target) => target.token.source !== 'cookie');
    const json = targets.some((target) => target.token.source === 'response');
    const lines: string[] = [...(html ? PostmanTokenScripts.HTML_HELPERS : []), ...(json ? PostmanTokenScripts.JSON_HELPERS : [])];
    for (const target of targets) {
      const name = JSON.stringify(target.token.sourceName ?? target.token.name);
      const variable = JSON.stringify(target.variable);
      lines.push(`{`, `  const value = ${PostmanTokenScripts.#reader(target.token, name)};`, `  if (value) pm.collectionVariables.set(${variable}, value);`, '}');
    }
    return lines;
  }

  static #reader(token: CsrfToken, name: string): string {
    if (token.source === 'cookie') return `(() => { const raw = pm.cookies.get(${name}); if (!raw) return undefined; let text = raw; try { text = decodeURIComponent(raw); } catch (e) { text = raw; } return text; })()`;
    if (token.source === 'hidden-field') return `appiiInput(${name})`;
    if (token.source === 'meta') return `appiiMeta(${name})`;
    return `pm.response.headers.get(${name}) || appiiFind(appiiJson(), ${name}, 0) || appiiInput(${name}) || appiiMeta(${name})`;
  }

  bearer(paths: readonly string[], variable: string): string[] {
    return [
      '{',
      '  const appiiBody = (() => { try { return pm.response.json(); } catch (e) { return undefined; } })();',
      "  const appiiAt = (value, path) => path.split('.').reduce((current, key) => (current !== null && typeof current === 'object' && !Array.isArray(current) && Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined), value);",
      `  const value = ${JSON.stringify(paths)}.map((path) => appiiAt(appiiBody, path)).find((item) => typeof item === 'string' && item !== '');`,
      `  if (value) pm.collectionVariables.set(${JSON.stringify(variable)}, value);`,
      '}',
    ];
  }

  event(targets: readonly TokenTarget[], extra: readonly string[] = []): Record<string, unknown>[] {
    const exec = [...(targets.length > 0 ? this.exec(targets) : []), ...extra];
    return [{ listen: PostmanTokenScripts.LISTEN, script: { type: PostmanTokenScripts.LANGUAGE, exec } }];
  }
}
