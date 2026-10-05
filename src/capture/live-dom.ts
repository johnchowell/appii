import type { Page } from 'playwright';
import type { PageSnapshot } from '../model/index.js';

interface SerializeRules {
  valueTypes: readonly string[];
  sensitiveAutocomplete: readonly string[];
}

interface SerializedDocument {
  url: string;
  title: string;
  html: string;
}

export class LiveDom {
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
  if (!live) return { url: doc.URL, title: doc.title, html: '' };
  var inert = doc.implementation.createHTMLDocument('');
  var copy = inert.importNode(live, true);
  function sensitive(el) {
    var tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/[\\t\\n\\f\\r ]+/);
    for (var k = 0; k < tokens.length; k++) if (rules.sensitiveAutocomplete.indexOf(tokens[k]) >= 0) return true;
    return false;
  }
  function optionDisabled(option) {
    var parent = option.parentElement;
    return option.disabled || (parent instanceof HTMLOptGroupElement && parent.disabled);
  }
  var selector = 'input, textarea, select';
  var sources = live.querySelectorAll(selector);
  var targets = copy.querySelectorAll(selector);
  var count = Math.min(sources.length, targets.length);
  for (var i = 0; i < count; i++) {
    var el = sources[i];
    var out = targets[i];
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
      var options = el.options;
      var outOptions = out.options;
      if (options.length !== outOptions.length) continue;
      var j;
      if (el.multiple) {
        for (j = 0; j < options.length; j++) {
          if (options[j].selected === options[j].defaultSelected) continue;
          if (options[j].selected) outOptions[j].setAttribute('selected', '');
          else outOptions[j].removeAttribute('selected');
        }
      } else {
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
        if (el.selectedIndex !== fallback) {
          for (j = 0; j < outOptions.length; j++) {
            if (j === el.selectedIndex) outOptions[j].setAttribute('selected', '');
            else outOptions[j].removeAttribute('selected');
          }
        }
      }
    }
  }
  var doctype = doc.doctype ? '<!DOCTYPE ' + doc.doctype.name + '>' : '';
  return { url: doc.URL, title: doc.title, html: doctype + copy.outerHTML };
}`;

  readonly #page: Page;

  constructor(page: Page) {
    this.#page = page;
  }

  async serialize(): Promise<string> {
    return (await this.#capture()).html;
  }

  async snapshot(): Promise<PageSnapshot> {
    const doc = await this.#capture();
    return { url: doc.url, title: doc.title, capturedAt: new Date().toISOString(), html: doc.html };
  }

  static expression(): string {
    const rules: SerializeRules = { valueTypes: LiveDom.VALUE_MODE_TYPES, sensitiveAutocomplete: LiveDom.SENSITIVE_AUTOCOMPLETE };
    return `(${LiveDom.PAGE_FUNCTION})(${JSON.stringify(rules)})`;
  }

  async #capture(): Promise<SerializedDocument> {
    const result: unknown = await this.#page.evaluate(LiveDom.expression());
    const doc = (result ?? {}) as Partial<SerializedDocument>;
    return {
      url: typeof doc.url === 'string' ? doc.url : this.#page.url(),
      title: typeof doc.title === 'string' ? doc.title : '',
      html: typeof doc.html === 'string' ? doc.html : '',
    };
  }
}
