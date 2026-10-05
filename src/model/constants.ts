export const MODEL_VERSION = 2;
export const CAPTURE_VERSION = 1;

export const RESOURCE_TYPES = Object.freeze([
  'document',
  'xhr',
  'fetch',
  'script',
  'stylesheet',
  'image',
  'font',
  'media',
  'websocket',
  'manifest',
  'eventsource',
  'other',
] as const);

export const CAPTURE_SOURCES = Object.freeze(['browser', 'har'] as const);

export const SERVED_BY_VALUES = Object.freeze(['service-worker', 'cache'] as const);

export const CACHE_KINDS = Object.freeze(['memory', 'disk', 'prefetch'] as const);

export const SAME_SITE_VALUES = Object.freeze(['Strict', 'Lax', 'None'] as const);

export const FIELD_KINDS = Object.freeze(['input', 'select', 'textarea', 'button'] as const);

export const FORM_METHODS = Object.freeze(['GET', 'POST', 'DIALOG'] as const);

export const FORM_ENCTYPES = Object.freeze(['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'] as const);

export const PARAM_LOCATIONS = Object.freeze(['path', 'query', 'header', 'cookie'] as const);

export const BODY_KINDS = Object.freeze(['json', 'form', 'multipart', 'graphql', 'html', 'text', 'binary', 'empty'] as const);

export const TOKEN_SOURCES = Object.freeze(['cookie', 'meta', 'hidden-field', 'response', 'unknown'] as const);

export const CSRF_LOCATIONS = Object.freeze(['header', 'body', 'query'] as const);

export const ENDPOINT_KINDS = Object.freeze(['json', 'form', 'graphql', 'document', 'other'] as const);

export const COOKIE_ROLES = Object.freeze(['session', 'auth', 'csrf', 'preference', 'tracking', 'unknown'] as const);

export const CREDENTIAL_COOKIE_ROLES = Object.freeze(['session', 'auth'] as const);
