import type { Endpoint, EndpointForm, FormField } from '../model/index.js';
import { Samples, Text } from '../shared/index.js';
import { FormRuleCompiler } from './form-rule-compiler.js';

export interface PlaywrightMethod {
  name: string;
  code: string;
}

export class PlaywrightActionWriter {
  static readonly RESERVED: readonly string[] = Object.freeze(['launch', 'close', 'capture', 'login', 'constructor', 'browser', 'context', 'page']);
  static readonly BODYLESS: readonly string[] = Object.freeze(['GET', 'HEAD']);
  static readonly SKIP_FILL: ReadonlySet<string> = new Set(['file']);
  static readonly CONTENT_TYPE = 'content-type';
  static readonly SUBMIT_FALLBACK = '[type="submit"], button:not([type]), [type="image"]';
  static readonly INDENT = '    ';
  static readonly BODY_VAR = '__body';

  static create(): PlaywrightActionWriter {
    return new PlaywrightActionWriter();
  }

  methodName(endpoint: Endpoint, taken: Set<string>): string {
    const base = Text.isIdentifier(endpoint.name) ? endpoint.name : Text.camelCase(endpoint.name) || 'endpoint';
    return Text.uniqueName(base, taken);
  }

  method(endpoint: Endpoint, taken: Set<string>, baseOrigin: string): PlaywrightMethod {
    const name = this.methodName(endpoint, taken);
    const secrets = new Set(Samples.loginInputs(endpoint).map(([field]) => field));
    const lines = endpoint.form
      ? this.#formLines(endpoint, endpoint.form, secrets, baseOrigin)
      : this.#isNavigation(endpoint)
        ? this.#navLines(endpoint, baseOrigin)
        : this.#scriptLines(endpoint, baseOrigin);
    return { name, code: PlaywrightActionWriter.#wrap(name, lines) };
  }

  #isNavigation(endpoint: Endpoint): boolean {
    return endpoint.method === 'GET' && endpoint.kind === 'document';
  }

  #formLines(endpoint: Endpoint, form: EndpointForm, secrets: ReadonlySet<string>, baseOrigin: string): string[] {
    const lines = [`await this.page.goto(${this.#lit(PlaywrightActionWriter.#relativize(form.pageUrl, baseOrigin))}, { waitUntil: 'load' });`, `const form = this.page.locator(${this.#lit(form.selector)});`];
    for (const field of form.fields) {
      const fill = this.#fillLine(form, field, secrets);
      if (fill !== undefined) lines.push(fill);
    }
    lines.push(`return this.capture(${this.#lit(endpoint.method)}, ${this.#lit(this.#pathPattern(endpoint))}, async () => { ${this.#submit(form)} });`);
    return lines;
  }

  #fillLine(form: EndpointForm, field: FormField, secrets: ReadonlySet<string>): string | undefined {
    const type = field.type || field.kind || 'text';
    if (field.disabled || field.readOnly || FormRuleCompiler.BARRED_TYPES.has(type) || PlaywrightActionWriter.SKIP_FILL.has(type)) return undefined;
    if (form.tokenFields.includes(field.name)) return undefined;
    const selector = this.#fieldSelector(field);
    if (selector === undefined) return undefined;
    if (type === 'radio') return field.checked ? `await ${this.#choiceLocator(field)}.check();` : undefined;
    if (type === 'checkbox') return `await ${this.#choiceLocator(field)}.setChecked(${field.checked ? 'true' : 'false'});`;
    const target = `form.locator(${this.#lit(selector)})`;
    const name = field.name || field.id || '';
    if (type === 'select-multiple') {
      const selected = (field.options ?? []).filter((option) => option.selected).map((option) => option.value);
      return `await ${target}.selectOption(readVar(vars, ${this.#lit(name)}, ${this.#array(selected)}));`;
    }
    const read = `readVar(vars, ${this.#lit(name)}, ${this.#lit(this.#defaultValue(field, secrets))})`;
    if (type === 'select-one') return `await ${target}.selectOption(String(${read}));`;
    return `await ${target}.fill(String(${read}));`;
  }

  #choiceLocator(field: FormField): string {
    const qualified = field.name !== '' && field.hasValueAttribute && field.value !== '';
    if (qualified) return `form.locator(${this.#lit(`[name="${PlaywrightActionWriter.#attr(field.name)}"][value="${PlaywrightActionWriter.#attr(field.value)}"]`)})`;
    return `form.locator(${this.#lit(this.#fieldSelector(field) ?? '')}).first()`;
  }

  #submit(form: EndpointForm): string {
    const submitter = form.submitters[0];
    const selector = submitter === undefined ? PlaywrightActionWriter.SUBMIT_FALLBACK : submitter.name ? `[name="${PlaywrightActionWriter.#attr(submitter.name)}"]` : submitter.id ? `[id="${PlaywrightActionWriter.#attr(submitter.id)}"]` : PlaywrightActionWriter.SUBMIT_FALLBACK;
    return `await form.locator(${this.#lit(selector)}).first().click();`;
  }

  #navLines(endpoint: Endpoint, baseOrigin: string): string[] {
    return [`const response = await this.page.goto(${this.#urlExpr(endpoint, baseOrigin)}, { waitUntil: 'load' });`, 'return toResult(response);'];
  }

  #scriptLines(endpoint: Endpoint, baseOrigin: string): string[] {
    const pageUrl = endpoint.samples.find((sample) => sample.pageUrl !== undefined)?.pageUrl ?? `${endpoint.origin}/`;
    return [`await this.page.goto(${this.#lit(PlaywrightActionWriter.#relativize(pageUrl, baseOrigin))}, { waitUntil: 'load' });`, `return pageFetch(this.page, ${this.#urlExpr(endpoint, baseOrigin)}, ${this.#fetchInit(endpoint)});`];
  }

  #defaultValue(field: FormField, secrets: ReadonlySet<string>): string {
    if (secrets.has(field.name) || field.type === 'password') return '';
    return field.value !== '' && !Samples.isRedacted(field.value) ? field.value : '';
  }

  #fieldSelector(field: FormField): string | undefined {
    if (field.name !== '') return `[name="${PlaywrightActionWriter.#attr(field.name)}"]`;
    if (field.id !== undefined && field.id !== '') return `[id="${PlaywrightActionWriter.#attr(field.id)}"]`;
    return undefined;
  }

  #pathPattern(endpoint: Endpoint): string {
    const source = endpoint.path
      .split(/\{[^}]+\}/)
      .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]+');
    return `^${source}$`;
  }

  #urlExpr(endpoint: Endpoint, baseOrigin: string): string {
    const parts: string[] = [];
    if (endpoint.origin !== baseOrigin) parts.push(this.#lit(endpoint.origin));
    for (const segment of endpoint.path.split(/(\{[^}]+\})/).filter((part) => part !== '')) {
      const match = /^\{([^}]+)\}$/.exec(segment);
      if (match === null) {
        parts.push(this.#lit(segment));
        continue;
      }
      const name = match[1] ?? '';
      parts.push(`encodeURIComponent(String(readVar(vars, ${this.#lit(name)}, ${this.#lit(this.#example(endpoint, name))})))`);
    }
    let expr = parts.length > 0 ? parts.join(' + ') : this.#lit(endpoint.path);
    if (endpoint.queryParams.length > 0) {
      const items = endpoint.queryParams.map((param) => {
        const example = param.examples.find((value) => !Samples.isRedacted(value)) ?? '';
        return `${this.#lit(`${param.name}=`)} + encodeURIComponent(String(readVar(vars, ${this.#lit(param.name)}, ${this.#lit(example)})))`;
      });
      expr = `${expr} + ${this.#lit('?')} + [${items.join(', ')}].join(${this.#lit('&')})`;
    }
    return expr;
  }

  #example(endpoint: Endpoint, name: string): string {
    return endpoint.pathParams.find((param) => param.name === name)?.examples.find((value) => !Samples.isRedacted(value)) ?? '';
  }

  #fetchInit(endpoint: Endpoint): string {
    const headers: [string, string][] = [];
    for (const header of endpoint.headerParams) {
      const example = header.examples.find((value) => !Samples.isRedacted(value));
      if (example !== undefined) headers.push([header.name, example]);
    }
    const body = this.#bodyString(endpoint);
    if (body !== undefined && endpoint.requestBody !== undefined && !headers.some(([key]) => key.toLowerCase() === PlaywrightActionWriter.CONTENT_TYPE)) headers.push([PlaywrightActionWriter.CONTENT_TYPE, endpoint.requestBody.mimeType]);
    const entries = [`method: ${this.#lit(endpoint.method)}`, 'credentials: "include"'];
    if (headers.length > 0) entries.push(`headers: { ${headers.map(([key, value]) => `${this.#lit(key)}: ${this.#lit(value)}`).join(', ')} }`);
    if (body !== undefined) entries.push(`body: readVar(vars, ${this.#lit(PlaywrightActionWriter.BODY_VAR)}, ${this.#lit(body)})`);
    return `{ ${entries.join(', ')} }`;
  }

  #bodyString(endpoint: Endpoint): string | undefined {
    if (PlaywrightActionWriter.BODYLESS.includes(endpoint.method)) return undefined;
    const example = endpoint.requestBody?.examples[0];
    if (example === undefined) return undefined;
    return typeof example === 'string' ? example : JSON.stringify(example);
  }

  #array(values: readonly string[]): string {
    return `[${values.map((value) => this.#lit(value)).join(', ')}]`;
  }

  #lit(value: string): string {
    return Text.jsString(value);
  }

  static #relativize(url: string, baseOrigin: string): string {
    if (baseOrigin !== '' && (url === baseOrigin || url.startsWith(`${baseOrigin}/`))) {
      const rest = url.slice(baseOrigin.length);
      return rest === '' ? '/' : rest;
    }
    return url;
  }

  static #attr(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  static #wrap(name: string, lines: readonly string[]): string {
    const body = lines.map((line) => `${PlaywrightActionWriter.INDENT}${line}`).join('\n');
    return `  async ${name}(vars = {}) {\n${body}\n  }`;
  }
}
