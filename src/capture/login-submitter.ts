import { errors } from 'playwright';
import type { ElementHandle, JSHandle, Page, Request } from 'playwright';
import { AppiiError, Http, Text } from '../shared/index.js';
import { Helpers } from './helpers.js';

export interface LoginField {
  name: string;
  value: string;
}

export interface LoginSubmitOptions {
  timeoutMs: number;
  settle: () => Promise<void>;
}

export type LoginTrigger = 'button' | 'enter';

export interface LoginSubmission {
  method: string;
  url: string;
  status?: number;
}

export interface LoginOutcome {
  pageUrl: string;
  action: string;
  method: string;
  fields: string[];
  trigger: LoginTrigger;
  submission?: LoginSubmission;
  finalUrl: string;
  warnings: string[];
}

interface ControlInfo {
  tag: string;
  type: string;
  value: string;
  disabled: boolean;
  visible: boolean;
}

interface FormInfo {
  pageUrl: string;
  action: string;
  method: string;
  controls: ControlInfo[][];
  submit: { visible: boolean } | null;
}

interface FoundForm {
  info: FormInfo;
  controls: ElementHandle[][];
  submit: ElementHandle | undefined;
}

interface SurveyForm {
  action: string;
  method: string;
  names: string[];
}

interface Survey {
  pageUrl: string;
  forms: SurveyForm[];
  loose: string[];
}

interface Remaining {
  present: boolean;
  emptyPassword: boolean;
}

interface Plan {
  submitter: ElementHandle | undefined;
  enter: ElementHandle | undefined;
  secrets: string[];
  filled: string[];
}

export class LoginSubmitter {
  static readonly TEXT_TYPES: ReadonlySet<string> = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number']);
  static readonly CHOICE_TYPES: ReadonlySet<string> = new Set(['checkbox', 'radio']);
  static readonly SUBMIT_TYPES: ReadonlySet<string> = new Set(['submit', 'image']);
  static readonly SELECT_TAG = 'select';
  static readonly BUTTON_TAG = 'button';
  static readonly INPUT_TAG = 'input';
  static readonly TEXTAREA_TAG = 'textarea';
  static readonly HIDDEN_TYPE = 'hidden';
  static readonly FILE_TYPE = 'file';
  static readonly PASSWORD_TYPE = 'password';
  static readonly ENTER_KEY = 'Enter';
  static readonly NO_BODY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
  static readonly CLIENT_ERROR_MIN = 400;
  static readonly CLIENT_ERROR_MAX = 499;
  static readonly HIDDEN_VALUE = '<hidden>';

  static readonly PRELUDE = `
  var HTML_NS = 'http://www.w3.org/1999/xhtml';
  var formProto = HTMLFormElement.prototype;
  function getter(proto, name) { return Object.getOwnPropertyDescriptor(proto, name).get; }
  var formElements = getter(formProto, 'elements');
  var formAction = getter(formProto, 'action');
  var formMethod = getter(formProto, 'method');
  function isHtml(el, name) { return el.namespaceURI === HTML_NS && el.localName === name; }
  function eachElement(visit) {
    var stack = [document];
    while (stack.length > 0) {
      var node = stack.pop();
      if (node.nodeType === 1) visit(node);
      var kids = node.children || [];
      for (var i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      if (node.nodeType === 1 && node.shadowRoot) stack.push(node.shadowRoot);
    }
  }
  function isSubmit(c) {
    if (isHtml(c, 'button')) return c.type === 'submit';
    return isHtml(c, 'input') && (c.type === 'submit' || c.type === 'image');
  }
  function controlsOf(form) {
    var list = Array.prototype.slice.call(formElements.call(form));
    var root = form.getRootNode();
    var inputs = root.querySelectorAll ? root.querySelectorAll('input') : [];
    for (var i = 0; i < inputs.length; i++) if (inputs[i].type === 'image' && inputs[i].form === form) list.push(inputs[i]);
    list.sort(function (a, b) {
      if (a === b) return 0;
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    return list;
  }
  function named(list) {
    var map = new Map();
    for (var i = 0; i < list.length; i++) {
      var name = list[i].name;
      if (typeof name !== 'string' || name === '') continue;
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(list[i]);
    }
    return map;
  }
  function forms() {
    var found = [];
    eachElement(function (el) { if (isHtml(el, 'form')) found.push(el); });
    return found;
  }
  function visible(el) {
    return typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0;
  }
  function fillable(c) {
    return !isSubmit(c) && !(isHtml(c, 'input') && c.type === 'hidden');
  }
  function matching(names) {
    var all = forms();
    var out = [];
    for (var f = 0; f < all.length; f++) {
      var list = controlsOf(all[f]);
      var map = named(list);
      if (names.every(function (n) { return map.has(n); })) out.push({ form: all[f], list: list, map: map });
    }
    return out;
  }`;

  static readonly FIND_FUNCTION = `function (args) {${LoginSubmitter.PRELUDE}
  var candidates = matching(args.names);
  for (var i = 0; i < candidates.length; i++) {
    var item = candidates[i];
    var shown = args.names.every(function (n) {
      var targets = item.map.get(n).filter(fillable);
      return targets.length === 0 || targets.some(visible);
    });
    if (args.visible && !shown) continue;
    var submit = item.list.filter(isSubmit)[0] || null;
    var controls = args.names.map(function (n) { return item.map.get(n); });
    return {
      form: item.form,
      controls: controls,
      submit: submit,
      info: {
        pageUrl: location.href,
        action: formAction.call(item.form),
        method: formMethod.call(item.form),
        controls: controls.map(function (list) {
          return list.map(function (c) {
            var choice = isHtml(c, 'input') && (c.type === 'checkbox' || c.type === 'radio');
            return { tag: c.localName, type: String(c.type || ''), value: choice || isSubmit(c) ? String(c.value) : '', disabled: c.disabled === true, visible: visible(c) };
          });
        }),
        submit: submit ? { visible: visible(submit) } : null
      }
    };
  }
  return null;
}`;

  static readonly SURVEY_FUNCTION = `function () {${LoginSubmitter.PRELUDE}
  var all = forms();
  var listed = new Set();
  var out = [];
  for (var f = 0; f < all.length; f++) {
    var list = controlsOf(all[f]);
    for (var i = 0; i < list.length; i++) listed.add(list[i]);
    out.push({ action: formAction.call(all[f]), method: formMethod.call(all[f]), names: Array.from(named(list).keys()) });
  }
  var loose = [];
  eachElement(function (el) {
    if (!(isHtml(el, 'input') || isHtml(el, 'select') || isHtml(el, 'textarea') || isHtml(el, 'button')) || listed.has(el) || el.form) return;
    if (typeof el.name === 'string' && el.name !== '' && loose.indexOf(el.name) < 0) loose.push(el.name);
  });
  return { pageUrl: location.href, forms: out, loose: loose };
}`;

  static readonly REMAINING_FUNCTION = `function (args) {${LoginSubmitter.PRELUDE}
  var candidates = matching(args.names);
  for (var i = 0; i < candidates.length; i++) {
    var passwords = candidates[i].list.filter(function (c) { return isHtml(c, 'input') && c.type === 'password'; });
    if (passwords.length === 0) continue;
    return { present: true, emptyPassword: passwords.some(function (c) { return c.value === ''; }) };
  }
  return { present: candidates.length > 0, emptyPassword: false };
}`;

  static create(): LoginSubmitter {
    return new LoginSubmitter();
  }

  static expression(source: string, args?: unknown): string {
    return `(${source})(${args === undefined ? '' : JSON.stringify(args)})`;
  }

  async submit(page: Page, fields: readonly LoginField[], options: LoginSubmitOptions): Promise<LoginOutcome> {
    if (fields.length === 0) throw new AppiiError('BAD_INPUT', 'Login needs at least one field name');
    const names = [...new Set(fields.map((field) => field.name))];
    const found = await this.#find(page, names, options.timeoutMs);
    const plan = await this.#fill(found, fields, names, options.timeoutMs);
    const requests: Request[] = [];
    const onRequest = (request: Request): void => {
      requests.push(request);
    };
    const before = page.url();
    page.on('request', onRequest);
    let trigger: LoginTrigger;
    try {
      trigger = await this.#press(found, plan, options.timeoutMs);
      await options.settle();
      await page.waitForLoadState('load', { timeout: options.timeoutMs }).catch(() => undefined);
    } finally {
      page.off('request', onRequest);
    }
    const submission = await this.#submission(requests, plan.secrets, options.timeoutMs);
    const finalUrl = page.url();
    const remaining = await this.#remaining(page, names);
    return {
      pageUrl: found.info.pageUrl,
      action: found.info.action,
      method: found.info.method.toUpperCase(),
      fields: plan.filled,
      trigger,
      ...(submission === undefined ? {} : { submission }),
      finalUrl,
      warnings: LoginSubmitter.#warnings(submission, remaining, requests.length === 0 && finalUrl === before),
    };
  }

  async #find(page: Page, names: readonly string[], timeoutMs: number): Promise<FoundForm> {
    let handle: JSHandle;
    try {
      handle = await page.waitForFunction(LoginSubmitter.expression(LoginSubmitter.FIND_FUNCTION, { names, visible: true }), undefined, { timeout: timeoutMs });
    } catch (err) {
      if (!(err instanceof errors.TimeoutError)) throw new AppiiError('CAPTURE', `Cannot look for the login form: ${Text.errorMessage(err, { firstLine: true })}`);
      const hidden = await page.evaluate(`${LoginSubmitter.expression(LoginSubmitter.FIND_FUNCTION, { names, visible: false })} !== null`).catch(() => false);
      if (hidden === true) {
        throw new AppiiError('CAPTURE', `The form with ${LoginSubmitter.#names(names)} on ${page.url()} did not become visible within ${LoginSubmitter.#seconds(timeoutMs)}`);
      }
      throw new AppiiError('CAPTURE', LoginSubmitter.#notFound(names, await this.#survey(page), timeoutMs));
    }
    const info = (await (await handle.getProperty('info')).jsonValue()) as FormInfo;
    const lists = await LoginSubmitter.#items(await handle.getProperty('controls'));
    const controls = await Promise.all(lists.map(async (list) => (await LoginSubmitter.#items(list)).flatMap((item) => LoginSubmitter.#element(item))));
    const submit = LoginSubmitter.#element(await handle.getProperty('submit'));
    return { info, controls, submit: submit[0] };
  }

  async #survey(page: Page): Promise<Survey> {
    const empty: Survey = { pageUrl: page.url(), forms: [], loose: [] };
    const result = await page.evaluate(LoginSubmitter.expression(LoginSubmitter.SURVEY_FUNCTION)).catch(() => empty);
    return (result ?? empty) as Survey;
  }

  async #remaining(page: Page, names: readonly string[]): Promise<Remaining> {
    const none: Remaining = { present: false, emptyPassword: false };
    const result = await page.evaluate(LoginSubmitter.expression(LoginSubmitter.REMAINING_FUNCTION, { names })).catch(() => none);
    return (result ?? none) as Remaining;
  }

  async #fill(found: FoundForm, fields: readonly LoginField[], names: readonly string[], timeoutMs: number): Promise<Plan> {
    const plan: Plan = { submitter: undefined, enter: undefined, secrets: [], filled: [] };
    const hide = (text: string): string => LoginSubmitter.#hide(text, fields);
    for (const field of fields) {
      const index = names.indexOf(field.name);
      const infos = found.info.controls[index] ?? [];
      const handles = found.controls[index] ?? [];
      const submitters = infos.flatMap((info, i) => (LoginSubmitter.#isSubmit(info) ? [i] : []));
      if (submitters.length > 0) {
        const chosen = submitters.find((i) => infos[i]?.value === field.value) ?? (submitters.length === 1 ? submitters[0] : undefined);
        if (chosen === undefined) throw new AppiiError('CAPTURE', `--login ${field.name}: no submit button named ${field.name} has the given value`);
        plan.submitter = LoginSubmitter.#handle(handles, chosen, field.name);
        continue;
      }
      const choices = infos.flatMap((info, i) => (info.tag === LoginSubmitter.INPUT_TAG && LoginSubmitter.CHOICE_TYPES.has(info.type) ? [i] : []));
      if (choices.length > 0) {
        const chosen = choices.find((i) => infos[i]?.value === field.value);
        if (chosen === undefined) throw new AppiiError('CAPTURE', `--login ${field.name}: no checkbox or radio button named ${field.name} has the given value`);
        const box = LoginSubmitter.#handle(handles, chosen, field.name);
        await LoginSubmitter.#act(field.name, hide, timeoutMs, () => box.check({ timeout: timeoutMs }));
        plan.filled.push(field.name);
        continue;
      }
      const target = infos.findIndex((info) => !info.disabled && LoginSubmitter.#fillable(info));
      if (target < 0) throw new AppiiError('CAPTURE', LoginSubmitter.#unfillable(field.name, infos));
      const info = infos[target]!;
      const handle = LoginSubmitter.#handle(handles, target, field.name);
      if (info.tag === LoginSubmitter.SELECT_TAG) {
        await LoginSubmitter.#act(field.name, hide, timeoutMs, () => handle.selectOption(field.value, { timeout: timeoutMs }));
      } else {
        await LoginSubmitter.#act(field.name, hide, timeoutMs, () => handle.fill(field.value, { timeout: timeoutMs }));
        if (info.tag === LoginSubmitter.INPUT_TAG && LoginSubmitter.TEXT_TYPES.has(info.type)) plan.enter = handle;
        if (info.type === LoginSubmitter.PASSWORD_TYPE) plan.secrets.push(field.value);
      }
      plan.filled.push(field.name);
    }
    if (plan.secrets.length === 0) plan.secrets.push(...fields.map((field) => field.value).filter((value) => value !== ''));
    return plan;
  }

  async #press(found: FoundForm, plan: Plan, timeoutMs: number): Promise<LoginTrigger> {
    const button = plan.submitter ?? (found.info.submit?.visible === true ? found.submit : undefined);
    if (button !== undefined) {
      await LoginSubmitter.#act('the submit button', (text) => text, timeoutMs, () => button.click({ timeout: timeoutMs }));
      return 'button';
    }
    if (plan.enter === undefined) {
      throw new AppiiError('CAPTURE', 'Cannot submit the login form: it has no visible submit button and no filled text field to press Enter in');
    }
    const enter = plan.enter;
    await LoginSubmitter.#act('the last filled field', (text) => text, timeoutMs, () => enter.press(LoginSubmitter.ENTER_KEY, { timeout: timeoutMs }));
    return 'enter';
  }

  async #submission(requests: readonly Request[], secrets: readonly string[], timeoutMs: number): Promise<LoginSubmission | undefined> {
    const chosen =
      requests.find((request) => LoginSubmitter.#carries(request, secrets)) ??
      requests.find((request) => LoginSubmitter.#topNavigation(request)) ??
      requests.find((request) => !LoginSubmitter.NO_BODY_METHODS.has(request.method()));
    if (chosen === undefined) return undefined;
    const response = await Helpers.settle(chosen.response(), timeoutMs);
    return { method: chosen.method(), url: chosen.url(), ...(response ? { status: response.status() } : {}) };
  }

  static #topNavigation(request: Request): boolean {
    try {
      return request.isNavigationRequest() && request.frame().parentFrame() === null;
    } catch {
      return false;
    }
  }

  static #carries(request: Request, secrets: readonly string[]): boolean {
    let body = '';
    try {
      body = request.postData() ?? '';
    } catch {
      body = '';
    }
    const text = `${request.url()}\n${body}`;
    return secrets.some((secret) => LoginSubmitter.#forms(secret).some((form) => text.includes(form)));
  }

  static #forms(value: string): string[] {
    const encoded = encodeURIComponent(value);
    return [...new Set([value, encoded, encoded.replace(/%20/g, '+'), JSON.stringify(value).slice(1, -1)])];
  }

  static #warnings(submission: LoginSubmission | undefined, remaining: Remaining, silent: boolean): string[] {
    const out: string[] = [];
    const status = submission?.status;
    if (submission !== undefined && status !== undefined && status >= LoginSubmitter.CLIENT_ERROR_MIN && status <= LoginSubmitter.CLIENT_ERROR_MAX) {
      out.push(`the login submission ${submission.method} ${LoginSubmitter.#withoutQuery(submission.url)} answered ${status}; the credentials are probably wrong`);
    }
    if (remaining.present && remaining.emptyPassword) out.push('the login form is still on the page with an empty password after submitting; the credentials were probably not accepted');
    if (silent) out.push('submitting the login form sent no request and stayed on the same page');
    return out;
  }

  static #handle(handles: readonly ElementHandle[], index: number, name: string): ElementHandle {
    const handle = handles[index];
    if (handle === undefined) throw new AppiiError('CAPTURE', `--login ${name}: the control named ${name} left the page before it could be filled`);
    return handle;
  }

  static #withoutQuery(url: string): string {
    const parsed = Http.parseUrl(url);
    return parsed === undefined ? url : `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  }

  static async #act(name: string, hide: (text: string) => string, timeoutMs: number, action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (err) {
      const reason = err instanceof errors.TimeoutError ? `it did not become ready within ${LoginSubmitter.#seconds(timeoutMs)}` : hide(Text.errorMessage(err, { firstLine: true }));
      throw new AppiiError('CAPTURE', `Cannot use ${name.startsWith('the ') ? name : `the login field ${name}`}: ${reason}`);
    }
  }

  static #hide(text: string, fields: readonly LoginField[]): string {
    let out = text;
    for (const field of fields) if (field.value !== '') out = out.split(field.value).join(LoginSubmitter.HIDDEN_VALUE);
    return out;
  }

  static #isSubmit(info: ControlInfo): boolean {
    if (info.tag === LoginSubmitter.BUTTON_TAG) return info.type === 'submit';
    return info.tag === LoginSubmitter.INPUT_TAG && LoginSubmitter.SUBMIT_TYPES.has(info.type);
  }

  static #fillable(info: ControlInfo): boolean {
    if (info.tag === LoginSubmitter.SELECT_TAG || info.tag === LoginSubmitter.TEXTAREA_TAG) return true;
    return info.tag === LoginSubmitter.INPUT_TAG && info.type !== LoginSubmitter.HIDDEN_TYPE && info.type !== LoginSubmitter.FILE_TYPE && !LoginSubmitter.CHOICE_TYPES.has(info.type);
  }

  static #unfillable(name: string, infos: readonly ControlInfo[]): string {
    const kinds = [...new Set(infos.map((info) => (info.tag === LoginSubmitter.INPUT_TAG ? `input type=${info.type}` : info.tag)))].join(', ');
    if (infos.length > 0 && infos.every((info) => info.disabled)) return `--login ${name}: the control named ${name} is disabled`;
    return `--login ${name}: the control named ${name} (${kinds}) cannot be filled like a user would; give text, password, select, checkbox or radio controls`;
  }

  static #notFound(names: readonly string[], survey: Survey, timeoutMs: number): string {
    const head = `No form on ${survey.pageUrl} has controls named ${LoginSubmitter.#names(names)} (waited ${LoginSubmitter.#seconds(timeoutMs)})`;
    const forms = survey.forms.map((form, i) => `form ${i + 1} (${form.method.toUpperCase()} ${form.action}): ${form.names.length === 0 ? 'no named controls' : form.names.join(', ')}`);
    const parts = [head, forms.length === 0 ? 'the page has no forms' : `forms found: ${forms.join('; ')}`];
    if (survey.loose.length > 0) parts.push(`controls outside any form: ${survey.loose.join(', ')}`);
    return parts.join('. ');
  }

  static #names(names: readonly string[]): string {
    return names.join(', ');
  }

  static #seconds(ms: number): string {
    return Text.formatDuration(ms);
  }

  static async #items(handle: JSHandle): Promise<JSHandle[]> {
    const properties = await handle.getProperties();
    return [...properties.entries()].filter(([key]) => /^[0-9]+$/.test(key)).sort((a, b) => Number(a[0]) - Number(b[0])).map(([, value]) => value);
  }

  static #element(handle: JSHandle): ElementHandle[] {
    const element = handle.asElement();
    return element === null ? [] : [element];
  }
}
