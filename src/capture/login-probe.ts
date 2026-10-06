import { errors } from 'playwright';
import type { BrowserContext, ElementHandle, JSHandle, Page } from 'playwright';
import { Text } from '../shared/index.js';
import { LoginSubmitter } from './login-submitter.js';
import type { LoginInvalidField, LoginTrigger } from './login-submitter.js';
import { RequestBlocker } from './request-blocker.js';
import type { BlockedRequest } from './request-blocker.js';
import type { ProbeCheck } from './traffic-recorder.js';

export type ProbeWindow = (blocked: ProbeCheck) => () => void;

export type RequestBlockerStarter = (context: BrowserContext, page: Page) => Promise<RequestBlocker>;

export interface LoginProbeOptions {
  timeoutMs: number;
  settle: () => Promise<void>;
  window?: ProbeWindow;
}

export interface LoginProbeDeps {
  blocker?: RequestBlockerStarter;
}

export interface ProbeOutcome {
  pageUrl: string;
  found: boolean;
  action?: string;
  method?: string;
  fields: string[];
  trigger?: LoginTrigger;
  requests: BlockedRequest[];
  invalid?: LoginInvalidField[];
  reloaded?: string;
  warnings: string[];
}

interface ProbeControl {
  tag: string;
  type: string;
  label: string;
  minLength: number;
  maxLength: number;
  min: string;
  options: string[];
}

interface ProbeInfo {
  pageUrl: string;
  action: string;
  method: string;
  password: ProbeControl;
  identifier: ProbeControl | null;
  required: ProbeControl[];
  submit: { visible: boolean } | null;
}

interface ProbeTarget {
  control: ProbeControl;
  handle: ElementHandle;
}

interface ProbeForm {
  info: ProbeInfo;
  password: ElementHandle;
  identifier: ElementHandle | undefined;
  required: ProbeTarget[];
  submit: ElementHandle | undefined;
}

export class LoginProbe {
  static readonly USER = 'appii-probe-user';
  static readonly EMAIL = 'appii-probe@example.invalid';
  static readonly PASSWORD = 'appii-probe-password';
  static readonly TEXT = 'appii-probe';
  static readonly URL = 'https://appii-probe.invalid/';
  static readonly TEL = '5550100';
  static readonly NUMBER = '1';
  static readonly PAD = 'x';
  static readonly BLANK = 'about:blank';
  static readonly NAVIGATION_TIMEOUT_MS = 30000;
  static readonly NO_LIMIT = -1;
  static readonly ENTER_KEY = 'Enter';

  static readonly PRELUDE = `${LoginSubmitter.PRELUDE}
  var TEXT_LIKE = ['text', 'search', 'email', 'url', 'tel', 'number'];
  function tokens(el) { return String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/).filter(Boolean); }
  function isPassword(c) { return isHtml(c, 'input') && c.type === 'password'; }
  function textLike(c) { return (isHtml(c, 'input') && TEXT_LIKE.indexOf(c.type) >= 0) || isHtml(c, 'textarea'); }
  function before(a, b) { return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0; }
  function empty(c) {
    if (isHtml(c, 'input') && (c.type === 'checkbox' || c.type === 'radio')) return !c.checked;
    return c.value === '';
  }
  function loginForms() {
    var all = forms();
    var out = [];
    for (var f = 0; f < all.length; f++) {
      var list = controlsOf(all[f]);
      var passwords = list.filter(isPassword);
      if (passwords.length !== 1 || tokens(passwords[0]).indexOf('new-password') >= 0) continue;
      out.push({ form: all[f], list: list, password: passwords[0] });
    }
    return out;
  }
  function loginForm() {
    var found = loginForms();
    for (var i = 0; i < found.length; i++) {
      var item = found[i];
      if (!visible(item.password) || item.password.disabled) continue;
      var list = item.list;
      var password = item.password;
      var usable = list.filter(function (c) { return textLike(c) && !isHtml(c, 'textarea') && !c.disabled && !c.readOnly; });
      var preceding = usable.filter(function (c) { return before(c, password); });
      var identifier = usable.filter(function (c) { return tokens(c).some(function (t) { return t === 'username' || t === 'email'; }); })[0]
        || usable.filter(function (c) { return c.type === 'email'; })[0]
        || (preceding.length === 1 ? preceding[0] : null);
      var groups = [];
      var required = list.filter(function (c) {
        if (c === password || c === identifier || !c.required || c.disabled || !empty(c)) return false;
        if (isHtml(c, 'select')) return true;
        if (isHtml(c, 'input') && c.type === 'radio') {
          if (groups.indexOf(c.name) >= 0) return false;
          groups.push(c.name);
          return list.every(function (o) { return !(isHtml(o, 'input') && o.type === 'radio' && o.name === c.name && o.checked); });
        }
        if (isHtml(c, 'input') && c.type === 'checkbox') return true;
        return textLike(c) && !c.readOnly;
      });
      return { form: item.form, list: list, password: password, identifier: identifier, required: required, submit: list.filter(isSubmit)[0] || null };
    }
    return null;
  }`;

  static readonly FIND_FUNCTION = `function () {${LoginProbe.PRELUDE}
  function label(el) {
    var name = el.getAttribute('name');
    if (name) return name;
    if (el.id) return '#' + el.id;
    return el.localName + (el.type ? ' type=' + el.type : '');
  }
  function describe(c) {
    var options = isHtml(c, 'select') ? Array.prototype.filter.call(c.options, function (o) { return !o.disabled && o.value !== ''; }).map(function (o) { return o.value; }) : [];
    return { tag: c.localName, type: String(c.type || ''), label: label(c), minLength: typeof c.minLength === 'number' ? c.minLength : -1, maxLength: typeof c.maxLength === 'number' ? c.maxLength : -1, min: typeof c.min === 'string' ? c.min : '', options: options };
  }
  var item = loginForm();
  if (item === null) return null;
  return {
    password: item.password,
    identifier: item.identifier,
    required: item.required,
    submit: item.submit,
    info: {
      pageUrl: location.href,
      action: formAction.call(item.form),
      method: formMethod.call(item.form),
      password: describe(item.password),
      identifier: item.identifier ? describe(item.identifier) : null,
      required: item.required.map(describe),
      submit: item.submit ? { visible: visible(item.submit) } : null
    }
  };
}`;

  static readonly VALIDITY_FUNCTION = `function () {${LoginProbe.PRELUDE}
  var item = loginForm();
  return watchInvalid(item === null ? [] : item.list);
}`;

  readonly #blocker: RequestBlockerStarter;

  constructor(deps: LoginProbeDeps = {}) {
    this.#blocker = deps.blocker ?? RequestBlocker.start;
  }

  static create(): LoginProbe {
    return new LoginProbe({ blocker: RequestBlocker.start });
  }

  static placeholder(control: ProbeControl, identifier = false): string {
    const type = control.tag === LoginSubmitter.INPUT_TAG ? control.type : control.tag;
    if (type === 'url') return LoginProbe.URL;
    if (type === 'number') return control.min !== '' ? control.min : LoginProbe.NUMBER;
    let value = identifier ? LoginProbe.USER : LoginProbe.TEXT;
    if (type === LoginSubmitter.PASSWORD_TYPE) value = LoginProbe.PASSWORD;
    else if (type === 'email') value = LoginProbe.EMAIL;
    else if (type === 'tel') value = LoginProbe.TEL;
    if (control.minLength > value.length) value += LoginProbe.PAD.repeat(control.minLength - value.length);
    if (control.maxLength > LoginProbe.NO_LIMIT && control.maxLength < value.length) value = value.slice(0, control.maxLength);
    return value;
  }

  async run(context: BrowserContext, page: Page, options: LoginProbeOptions): Promise<ProbeOutcome> {
    const pageUrl = page.url();
    const found = await this.#find(page, options.timeoutMs);
    if (found === undefined) {
      return { pageUrl, found: false, fields: [], requests: [], warnings: [`no login form (a form with one password field that is not for a new password) appeared on ${pageUrl} within ${Text.formatDuration(options.timeoutMs)}; nothing was probed`] };
    }
    const base = { pageUrl: found.info.pageUrl, found: true, action: found.info.action, method: found.info.method.toUpperCase() };
    let blocker: RequestBlocker;
    try {
      blocker = await this.#blocker(context, page);
    } catch (err) {
      return { ...base, fields: [], requests: [], warnings: [`${Text.errorMessage(err, { firstLine: true })}; the login form was not probed`] };
    }
    const end = options.window?.((method, url) => blocker.isBlocked(method, url));
    const warnings: string[] = [];
    const fields: string[] = [];
    let trigger: LoginTrigger | undefined;
    let invalid: LoginInvalidField[] = [];
    try {
      try {
        await this.#fill(found, fields, options.timeoutMs);
        const validity = await LoginProbe.#watchValidity(page);
        trigger = await LoginProbe.#press(found, options.timeoutMs);
        await options.settle();
        invalid = await LoginSubmitter.invalidFields(validity);
      } catch (err) {
        warnings.push(`the login form could not be probed to the end: ${LoginProbe.#reason(err, options.timeoutMs)}`);
      }
      await page.goto(LoginProbe.BLANK, { timeout: LoginProbe.NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
    } finally {
      await blocker.stop();
      end?.();
    }
    const requests = [...blocker.blocked];
    if (invalid.length > 0) warnings.push(LoginSubmitter.refusal(invalid, 'the login form with placeholder values'));
    else if (requests.length === 0 && trigger !== undefined) warnings.push('submitting the login form with placeholder values started no request');
    let reloaded: string | undefined;
    try {
      await page.goto(pageUrl, { waitUntil: 'load', timeout: LoginProbe.NAVIGATION_TIMEOUT_MS });
      reloaded = pageUrl;
    } catch (err) {
      if (!(err instanceof errors.TimeoutError)) warnings.push(`the page could not be opened again after the probe: ${Text.errorMessage(err, { firstLine: true })}`);
      else reloaded = pageUrl;
    }
    await options.settle();
    return {
      ...base,
      fields,
      ...(trigger === undefined ? {} : { trigger }),
      requests,
      ...(invalid.length === 0 ? {} : { invalid }),
      ...(reloaded === undefined ? {} : { reloaded }),
      warnings,
    };
  }

  async #find(page: Page, timeoutMs: number): Promise<ProbeForm | undefined> {
    let handle: JSHandle;
    try {
      handle = await page.waitForFunction(LoginSubmitter.expression(LoginProbe.FIND_FUNCTION), undefined, { timeout: timeoutMs });
    } catch {
      return undefined;
    }
    const info = (await (await handle.getProperty('info')).jsonValue()) as ProbeInfo;
    const password = LoginProbe.#element(await handle.getProperty('password'));
    if (password === undefined) return undefined;
    const required: ProbeTarget[] = [];
    const list = await handle.getProperty('required');
    for (const [index, control] of info.required.entries()) {
      const element = LoginProbe.#element(await list.getProperty(String(index)));
      if (element !== undefined) required.push({ control, handle: element });
    }
    return {
      info,
      password,
      identifier: LoginProbe.#element(await handle.getProperty('identifier')),
      required,
      submit: LoginProbe.#element(await handle.getProperty('submit')),
    };
  }

  async #fill(found: ProbeForm, fields: string[], timeoutMs: number): Promise<void> {
    const { info } = found;
    if (found.identifier !== undefined && info.identifier !== null) {
      await found.identifier.fill(LoginProbe.placeholder(info.identifier, true), { timeout: timeoutMs });
      fields.push(info.identifier.label);
    }
    await found.password.fill(LoginProbe.placeholder(info.password), { timeout: timeoutMs });
    fields.push(info.password.label);
    for (const { control, handle } of found.required) {
      if (control.tag === LoginSubmitter.SELECT_TAG) {
        const option = control.options[0];
        if (option === undefined) continue;
        await handle.selectOption(option, { timeout: timeoutMs });
      } else if (control.tag === LoginSubmitter.INPUT_TAG && LoginSubmitter.CHOICE_TYPES.has(control.type)) {
        await handle.check({ timeout: timeoutMs });
      } else {
        await handle.fill(LoginProbe.placeholder(control), { timeout: timeoutMs });
      }
      fields.push(control.label);
    }
  }

  static async #press(found: ProbeForm, timeoutMs: number): Promise<LoginTrigger> {
    if (found.submit !== undefined && found.info.submit?.visible === true) {
      await found.submit.click({ timeout: timeoutMs });
      return 'button';
    }
    await found.password.press(LoginProbe.ENTER_KEY, { timeout: timeoutMs });
    return 'enter';
  }

  static async #watchValidity(page: Page): Promise<JSHandle | undefined> {
    try {
      return await page.evaluateHandle(LoginSubmitter.expression(LoginProbe.VALIDITY_FUNCTION));
    } catch {
      return undefined;
    }
  }

  static #reason(err: unknown, timeoutMs: number): string {
    if (err instanceof errors.TimeoutError) return `a field did not become ready within ${Text.formatDuration(timeoutMs)}`;
    return Text.errorMessage(err, { firstLine: true });
  }

  static #element(handle: JSHandle): ElementHandle | undefined {
    return handle.asElement() ?? undefined;
  }
}
