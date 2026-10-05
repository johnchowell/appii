import type { Page } from 'playwright';
import type { PageSnapshot } from '../model/index.js';
import { SecretNames } from '../shared/index.js';
import type { SecretNameRules } from '../shared/index.js';

export interface SerializeRules {
  valueTypes: readonly string[];
  sensitiveAutocomplete: readonly string[];
  listedControls: readonly string[];
  secretNames: SecretNameRules;
  formIndex: string;
  formOwner: string;
  selector: string;
  marks?: string;
}

export interface LiveDomOptions {
  evaluate?: (expression: string) => Promise<unknown>;
  marks?: string;
}

interface SerializedDocument {
  url: string;
  title: string;
  html: string;
  characterSet: string;
}

export class LiveDom {
  static readonly FORM_INDEX_ATTRIBUTE = 'data-appii-form-index';
  static readonly FORM_OWNER_ATTRIBUTE = 'data-appii-form-owner';
  static readonly SELECTOR_ATTRIBUTE = 'data-appii-selector';

  static readonly LISTED_CONTROLS: readonly string[] = ['button', 'fieldset', 'input', 'object', 'output', 'select', 'textarea'];

  static readonly VALUE_MODE_TYPES: readonly string[] = [
    'text',
    'search',
    'url',
    'tel',
    'email',
    'date',
    'month',
    'week',
    'time',
    'datetime-local',
    'number',
    'range',
    'color',
  ];

  static readonly SENSITIVE_AUTOCOMPLETE: readonly string[] = [
    'current-password',
    'new-password',
    'one-time-code',
    'cc-number',
    'cc-csc',
    'cc-exp',
    'cc-exp-month',
    'cc-exp-year',
  ];

  static readonly PAGE_FUNCTION = `function (rules) {
  var doc = document;
  var live = doc.documentElement;
  if (!live) return { url: doc.URL, title: doc.title, html: '', characterSet: doc.characterSet };
  var HTML_NS = 'http://www.w3.org/1999/xhtml';
  var BACKSLASH = String.fromCharCode(92);
  var inert = doc.implementation.createHTMLDocument('');
  var marks = rules.marks && window[rules.marks] instanceof WeakSet ? window[rules.marks] : null;
  var copy = inert.importNode(live, true);
  var pairs = [];
  var templates = [];
  var stack = [[live, copy]];
  while (stack.length > 0) {
    var top = stack.pop();
    var from = top[0];
    var to = top[1];
    if (from.nodeType === 1) pairs.push(top);
    var shadow = from.nodeType === 1 ? from.shadowRoot : null;
    var fromKids = from.children;
    var toKids = to.children;
    var size = Math.min(fromKids.length, toKids.length);
    for (var k = size - 1; k >= 0; k--) stack.push([fromKids[k], toKids[k]]);
    if (shadow) {
      var template = inert.createElement('template');
      template.setAttribute('shadowrootmode', shadow.mode);
      if (shadow.delegatesFocus) template.setAttribute('shadowrootdelegatesfocus', '');
      if (shadow.clonable) template.setAttribute('shadowrootclonable', '');
      if (shadow.serializable) template.setAttribute('shadowrootserializable', '');
      for (var child = shadow.firstChild; child; child = child.nextSibling) template.content.appendChild(inert.importNode(child, true));
      templates.push([to, template]);
      stack.push([shadow, template.content]);
    }
  }
  function isHtml(el, name) {
    return el.namespaceURI === HTML_NS && el.localName === name;
  }
  function lower(value) {
    return value.replace(/[A-Z]+/g, function (part) { return part.toLowerCase(); });
  }
  function count(map, key) {
    map.set(key, (map.get(key) || 0) + 1);
  }
  var forms = [];
  var formIndex = new Map();
  var docForms = doc.forms;
  for (var f = 0; f < docForms.length; f++) {
    formIndex.set(docForms[f], f);
    forms.push(docForms[f]);
  }
  var ids = new Map();
  for (var p = 0; p < pairs.length; p++) {
    var node = pairs[p][0];
    var nodeId = node.getAttribute('id');
    if (nodeId) count(ids, lower(nodeId));
    if (isHtml(node, 'form') && !formIndex.has(node)) {
      formIndex.set(node, forms.length);
      forms.push(node);
    }
  }
  var formIds = new Map();
  var formNames = new Map();
  for (var g = 0; g < forms.length; g++) {
    var fid = forms[g].getAttribute('id');
    if (fid) count(formIds, lower(fid));
    var fname = forms[g].getAttribute('name');
    if (fname) count(formNames, fname);
  }
  function hex(code) {
    return BACKSLASH + code.toString(16) + ' ';
  }
  function escapeIdentifier(value) {
    var chars = Array.from(value);
    var out = '';
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      var code = ch.codePointAt(0);
      var digit = code >= 48 && code <= 57;
      var letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
      if (code === 0) out += hex(65533);
      else if ((code >= 1 && code <= 31) || code === 127) out += hex(code);
      else if (i === 0 && digit) out += hex(code);
      else if (i === 1 && digit && chars[0] === '-') out += hex(code);
      else if (i === 0 && ch === '-' && chars.length === 1) out += BACKSLASH + '-';
      else if (code >= 128) out += hex(code);
      else if (ch === '-' || ch === '_' || digit || letter) out += ch;
      else out += BACKSLASH + ch;
    }
    return out;
  }
  function escapeString(value) {
    var chars = Array.from(value);
    var out = '"';
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      var code = ch.codePointAt(0);
      if (code === 0) out += hex(65533);
      else if ((code >= 1 && code <= 31) || code === 127 || code >= 128) out += hex(code);
      else if (ch === '"' || ch === BACKSLASH) out += BACKSLASH + ch;
      else out += ch;
    }
    return out + '"';
  }
  function selectorOf(form) {
    var id = form.getAttribute('id');
    if (id && formIds.get(lower(id)) === 1) return 'form#' + escapeIdentifier(id);
    var name = form.getAttribute('name');
    if (name && formNames.get(name) === 1) return 'form[name=' + escapeString(name) + ']';
    var steps = [];
    for (var current = form; current; ) {
      var parent = current.parentElement;
      var siblings = parent;
      var holder = current.parentNode;
      if (!parent && holder && holder.nodeType === 11 && holder.host) {
        parent = holder.host;
        siblings = holder;
      }
      if (!parent) {
        steps.unshift(':root');
        break;
      }
      var stepId = current.getAttribute('id');
      if (current !== form && stepId && ids.get(lower(stepId)) === 1) {
        steps.unshift('#' + escapeIdentifier(stepId));
        break;
      }
      var position = Array.prototype.indexOf.call(siblings.children, current) + 1;
      steps.unshift(escapeIdentifier(current.localName) + ':nth-child(' + position + ')');
      current = parent;
    }
    return steps.join(' > ');
  }
  var isSecretName = ${SecretNames.PAGE_FUNCTION};
  function secretName(el) {
    var name = el.getAttribute('name');
    var id = el.getAttribute('id');
    return Boolean((name && isSecretName(rules.secretNames, name)) || (id && isSecretName(rules.secretNames, id)));
  }
  function sensitive(el) {
    if (marks && marks.has(el)) return true;
    if (secretName(el)) return true;
    var tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/[\\t\\n\\f\\r ]+/);
    for (var t = 0; t < tokens.length; t++) if (rules.sensitiveAutocomplete.indexOf(tokens[t]) >= 0) return true;
    return false;
  }
  function optionDisabled(option) {
    var parent = option.parentElement;
    return option.disabled || (parent instanceof HTMLOptGroupElement && parent.disabled);
  }
  function patchSelect(el, out) {
    var options = el.options;
    var outOptions = out.options;
    if (options.length !== outOptions.length) return;
    var j;
    if (el.multiple) {
      for (j = 0; j < options.length; j++) {
        if (options[j].selected === options[j].defaultSelected) continue;
        if (options[j].selected) outOptions[j].setAttribute('selected', '');
        else outOptions[j].removeAttribute('selected');
      }
      return;
    }
    var fallback = -1;
    for (j = 0; j < options.length; j++) if (options[j].defaultSelected) fallback = j;
    var displaySize = el.size > 0 ? el.size : 1;
    if (fallback < 0 && displaySize === 1) {
      for (j = 0; j < options.length; j++) {
        if (!optionDisabled(options[j])) {
          fallback = j;
          break;
        }
      }
    }
    if (el.selectedIndex === fallback) return;
    for (j = 0; j < outOptions.length; j++) {
      if (j === el.selectedIndex) outOptions[j].setAttribute('selected', '');
      else outOptions[j].removeAttribute('selected');
    }
  }
  function patchValue(el, out) {
    if (el instanceof HTMLInputElement) {
      var type = el.type;
      if (type === 'checkbox' || type === 'radio') {
        if (el.checked !== el.defaultChecked) {
          if (el.checked) out.setAttribute('checked', '');
          else out.removeAttribute('checked');
        }
      } else if (rules.valueTypes.indexOf(type) >= 0 && !sensitive(el) && el.value !== el.defaultValue) {
        out.setAttribute('value', el.value);
      }
    } else if (el instanceof HTMLTextAreaElement) {
      if (!sensitive(el) && el.value !== el.defaultValue) out.textContent = el.value;
    } else if (el instanceof HTMLSelectElement && out instanceof HTMLSelectElement) {
      patchSelect(el, out);
    }
  }
  for (var q = 0; q < pairs.length; q++) {
    var el = pairs[q][0];
    var out = pairs[q][1];
    if (el.namespaceURI !== HTML_NS) continue;
    if (el.localName === 'form' && formIndex.has(el)) {
      out.setAttribute(rules.formIndex, String(formIndex.get(el)));
      out.setAttribute(rules.selector, selectorOf(el));
    } else if (rules.listedControls.indexOf(el.localName) >= 0) {
      var owner = el.form;
      out.setAttribute(rules.formOwner, owner && formIndex.has(owner) ? String(formIndex.get(owner)) : '');
    }
    patchValue(el, out);
  }
  for (var r = 0; r < templates.length; r++) templates[r][0].insertBefore(templates[r][1], templates[r][0].firstChild);
  var doctype = doc.doctype ? '<!DOCTYPE ' + doc.doctype.name + '>' : '';
  return { url: doc.URL, title: doc.title, html: doctype + copy.outerHTML, characterSet: doc.characterSet };
}`;

  readonly #page: Page;
  readonly #evaluate: (expression: string) => Promise<unknown>;
  readonly #marks: string | undefined;

  constructor(page: Page, options: LiveDomOptions = {}) {
    this.#page = page;
    this.#evaluate = options.evaluate ?? ((expression) => page.evaluate(expression));
    this.#marks = options.marks;
  }

  static rules(marks?: string): SerializeRules {
    return {
      valueTypes: LiveDom.VALUE_MODE_TYPES,
      sensitiveAutocomplete: LiveDom.SENSITIVE_AUTOCOMPLETE,
      listedControls: LiveDom.LISTED_CONTROLS,
      secretNames: SecretNames.rules(),
      formIndex: LiveDom.FORM_INDEX_ATTRIBUTE,
      formOwner: LiveDom.FORM_OWNER_ATTRIBUTE,
      selector: LiveDom.SELECTOR_ATTRIBUTE,
      ...(marks === undefined ? {} : { marks }),
    };
  }

  static expression(marks?: string): string {
    return `(${LiveDom.PAGE_FUNCTION})(${JSON.stringify(LiveDom.rules(marks))})`;
  }

  async serialize(): Promise<string> {
    return (await this.#capture()).html;
  }

  async snapshot(): Promise<PageSnapshot> {
    const doc = await this.#capture();
    return { url: doc.url, title: doc.title, capturedAt: new Date().toISOString(), html: doc.html, ...(doc.characterSet === '' ? {} : { characterSet: doc.characterSet }) };
  }

  async #capture(): Promise<SerializedDocument> {
    const result: unknown = await this.#evaluate(LiveDom.expression(this.#marks));
    const doc = (result ?? {}) as Partial<SerializedDocument>;
    return {
      url: typeof doc.url === 'string' ? doc.url : this.#page.url(),
      title: typeof doc.title === 'string' ? doc.title : '',
      html: typeof doc.html === 'string' ? doc.html : '',
      characterSet: typeof doc.characterSet === 'string' ? doc.characterSet : '',
    };
  }
}
