export class HeaderPolicy {
  static readonly BROWSER_HEADERS: ReadonlySet<string> = new Set([
    'user-agent',
    'accept',
    'cookie',
    'referer',
    'origin',
    'host',
    'connection',
    'content-length',
    'content-type',
    'content-encoding',
    'cache-control',
    'pragma',
    'priority',
    'upgrade-insecure-requests',
    'dnt',
    'te',
    'range',
    'keep-alive',
    'transfer-encoding',
    'trailer',
    'expect',
    'upgrade',
    'via',
    'purpose',
    'x-client-data',
    'save-data',
    'device-memory',
    'dpr',
    'viewport-width',
    'width',
    'downlink',
    'ect',
    'rtt',
    'service-worker',
    'service-worker-navigation-preload',
    'early-data',
    'attribution-reporting-eligible',
    'x-devtools-emulate-network-conditions-client-id',
  ]);
  static readonly BROWSER_PREFIXES: readonly string[] = [':', 'accept-', 'sec-', 'if-', 'proxy-', 'access-control-request-'];
  static readonly AUTH_HEADERS: ReadonlySet<string> = new Set([
    'authorization',
    'x-authorization',
    'x-api-key',
    'api-key',
    'apikey',
    'x-apikey',
    'x-auth',
    'x-auth-token',
    'x-access-token',
    'x-refresh-token',
    'x-id-token',
    'x-session-token',
    'x-user-token',
    'x-token',
    'x-amz-security-token',
    'x-goog-api-key',
    'x-rapidapi-key',
    'ocp-apim-subscription-key',
    'x-functions-key',
    'private-token',
  ]);
  static readonly AUTH_PATTERN: RegExp = /(?:^|-)(?:api-?key|auth-?token|access-?token|session-?token|id-?token)$/;
  static readonly CSRF_PATTERN: RegExp = /csrf|xsrf|request-?verification-?token|anti-?forgery/i;
  static readonly NOTABLE_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
    'content-type',
    'location',
    'set-cookie',
    'www-authenticate',
    'retry-after',
    'link',
    'content-disposition',
    'refresh',
    'allow',
  ]);
  static readonly NOTABLE_RESPONSE_PATTERN: RegExp = /^(?:x-)?rate-?limit|csrf|xsrf/i;

  isParam(name: string): boolean {
    const lower = name.toLowerCase();
    if (lower === '' || HeaderPolicy.BROWSER_HEADERS.has(lower)) return false;
    return !HeaderPolicy.BROWSER_PREFIXES.some((prefix) => lower.startsWith(prefix));
  }

  isAuth(name: string): boolean {
    const lower = name.toLowerCase();
    return HeaderPolicy.AUTH_HEADERS.has(lower) || HeaderPolicy.AUTH_PATTERN.test(lower);
  }

  isCsrf(name: string): boolean {
    return HeaderPolicy.CSRF_PATTERN.test(name);
  }

  isNotableResponse(name: string): boolean {
    const lower = name.toLowerCase();
    return HeaderPolicy.NOTABLE_RESPONSE_HEADERS.has(lower) || HeaderPolicy.NOTABLE_RESPONSE_PATTERN.test(lower);
  }
}
