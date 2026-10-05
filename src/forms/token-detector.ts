import { HtmlDocument } from './html-document.js';

export class TokenDetector {
  static readonly CSRF_FRAGMENTS: readonly string[] = ['csrf', 'xsrf', 'forgery', 'request-?verification'];

  static readonly CSRF_NAMES: readonly string[] = ['authenticity_token', '_wpnonce', '_ajax_nonce'];

  static readonly CSRF_PATTERN: RegExp = new RegExp(
    `(?:${TokenDetector.CSRF_FRAGMENTS.join('|')})|(?:^|\\[)(?:${TokenDetector.CSRF_NAMES.join('|')})\\]?$`,
    'i',
  );

  static readonly FIELD_FRAGMENTS: readonly string[] = ['csrf', 'xsrf', 'nonce', 'forgery'];

  static readonly FIELD_NAMES: readonly string[] = [
    '_token',
    'token',
    'authenticity_token',
    '__requestverificationtoken',
    'requestverificationtoken',
    'form_build_id',
    'form_token',
    'form_key',
    'formkey',
    '__viewstate',
    '__viewstategenerator',
    '__viewstateencrypted',
    '__eventvalidation',
    '__previouspage',
    '__requestdigest',
    'javax.faces.viewstate',
    'struts.token',
    'org.apache.struts.taglib.html.token',
    'sesskey',
    '_sourcepage',
    '__fp',
  ];

  static readonly FIELD_PATTERN: RegExp = new RegExp(
    `(?:${TokenDetector.FIELD_FRAGMENTS.join('|')})|(?:^|\\[)(?:${TokenDetector.FIELD_NAMES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\]?$`,
    'i',
  );

  static readonly HIDDEN_NAMES: readonly string[] = ['formhash', 'canary'];

  static readonly HIDDEN_PATTERN: RegExp = new RegExp(`token\\]?$|(?:^|\\[)(?:${TokenDetector.HIDDEN_NAMES.join('|')})\\]?$`, 'i');

  static readonly HEADER_PATTERN: RegExp = /csrf|xsrf|nonce|request-?verification-?token|anti-?forgery/i;

  static readonly KNOWN_HEADERS: ReadonlySet<string> = new Set(['x-wp-nonce']);

  static readonly KNOWN_HEADER_PATTERN: RegExp = /csrf|xsrf|request-?verification-?token|anti-?forgery/i;

  static readonly META_PATTERN: RegExp = /csrf|xsrf|request-?verification-?token|anti-?forgery/i;

  isCsrfName(name: string): boolean {
    return name !== '' && TokenDetector.CSRF_PATTERN.test(name);
  }

  isTokenField(name: string): boolean {
    return name !== '' && (TokenDetector.CSRF_PATTERN.test(name) || TokenDetector.FIELD_PATTERN.test(name));
  }

  isHiddenTokenField(name: string): boolean {
    return this.isTokenField(name) || (name !== '' && TokenDetector.HIDDEN_PATTERN.test(name));
  }

  isCsrfHeader(name: string): boolean {
    return name !== '' && TokenDetector.HEADER_PATTERN.test(name);
  }

  isKnownCsrfHeader(name: string): boolean {
    return name !== '' && (TokenDetector.KNOWN_HEADER_PATTERN.test(name) || TokenDetector.KNOWN_HEADERS.has(name.toLowerCase()));
  }

  isTokenMeta(name: string): boolean {
    return name !== '' && TokenDetector.META_PATTERN.test(name);
  }

  pageTokens(html: string): Record<string, string> {
    return this.documentTokens(HtmlDocument.parse(html, 'about:blank'));
  }

  documentTokens(doc: HtmlDocument): Record<string, string> {
    const found = new Map<string, string>();
    for (const element of doc.elements) {
      if (!doc.isHtml(element, 'meta') || !doc.inDocumentTree(element)) continue;
      const name = doc.attr(element, 'name');
      const content = doc.attr(element, 'content');
      if (name === undefined || content === undefined || found.has(name) || !this.isTokenMeta(name)) continue;
      found.set(name, content);
    }
    return Object.fromEntries(found);
  }
}
