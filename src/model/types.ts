import type {
  BODY_KINDS,
  CACHE_KINDS,
  CAPTURE_SOURCES,
  COOKIE_ROLES,
  CSRF_LOCATIONS,
  ENDPOINT_KINDS,
  FIELD_KINDS,
  FORM_ENCTYPES,
  FORM_METHODS,
  MODEL_VERSION,
  PARAM_LOCATIONS,
  RESOURCE_TYPES,
  SAME_SITE_VALUES,
  SERVED_BY_VALUES,
  TOKEN_SOURCES,
} from './constants.js';

export interface Header {
  name: string;
  value: string;
}

export interface BodyData {
  mimeType: string;
  encoding: 'utf8' | 'base64';
  data: string;
  size: number;
  truncated?: boolean;
}

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

export type ServedBy = (typeof SERVED_BY_VALUES)[number];

export type CacheKind = (typeof CACHE_KINDS)[number];

export interface CapturedRequest {
  method: string;
  url: string;
  headers: Header[];
  body?: BodyData;
}

export interface CapturedResponse {
  status: number;
  statusText: string;
  headers: Header[];
  body?: BodyData;
  remoteAddress?: string;
}

export interface Exchange {
  id: string;
  source: CaptureSource;
  resourceType: ResourceType;
  pageUrl?: string;
  startedAt: string;
  durationMs: number;
  request: CapturedRequest;
  response?: CapturedResponse;
  error?: string;
  redirectedFrom?: string;
  servedBy?: ServedBy;
  cacheKind?: CacheKind;
}

export interface WebSocketMessage {
  direction: 'sent' | 'received';
  at: string;
  opcode: 'text' | 'binary';
  data: string;
}

export interface WebSocketCapture {
  id: string;
  url: string;
  pageUrl?: string;
  openedAt: string;
  closedAt?: string;
  error?: string;
  messages: WebSocketMessage[];
}

export type SameSite = (typeof SAME_SITE_VALUES)[number];

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number | null;
  httpOnly: boolean;
  secure: boolean;
  sameSite: SameSite | null;
  hostOnly: boolean;
  partitionKey?: string;
}

export interface StorageSnapshot {
  origin: string;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

export interface PageSnapshot {
  url: string;
  title: string;
  capturedAt: string;
  html: string;
  characterSet?: string;
}

export interface Capture {
  version: 1;
  tool: { name: 'appii'; version: string };
  startUrl?: string;
  startedAt: string;
  endedAt: string;
  exchanges: Exchange[];
  websockets: WebSocketCapture[];
  cookies: Cookie[];
  storage: StorageSnapshot[];
  pages: PageSnapshot[];
}

export interface SelectOption {
  value: string;
  label: string;
  selected: boolean;
  disabled: boolean;
}

export type FieldKind = (typeof FIELD_KINDS)[number];

export type FormMethod = (typeof FORM_METHODS)[number];

export type FormEnctype = (typeof FORM_ENCTYPES)[number];

export interface FormField {
  name: string;
  order: number;
  kind: FieldKind;
  type: string;
  value: string;
  hasValueAttribute: boolean;
  checked: boolean;
  disabled: boolean;
  readOnly: boolean;
  required: boolean;
  multiple: boolean;
  pattern?: string;
  min?: string;
  max?: string;
  step?: string;
  minLength?: number;
  maxLength?: number;
  accept?: string;
  dirName?: string;
  options?: SelectOption[];
  label?: string;
  placeholder?: string;
  title?: string;
  autocomplete?: string;
  id?: string;
  formAction?: string;
  explicitFormAction?: boolean;
  formMethod?: FormMethod;
  formEnctype?: FormEnctype;
  formNoValidate?: boolean;
}

export interface FormDescriptor {
  index: number;
  id?: string;
  name?: string;
  selector: string;
  pageUrl: string;
  action: string;
  explicitAction?: boolean;
  method: FormMethod;
  enctype: FormEnctype;
  acceptCharset?: string;
  charset: string;
  noValidate: boolean;
  target?: string;
  fields: FormField[];
  submitters: FormField[];
  tokenFields: string[];
  endpoints?: string[];
  instances?: number;
  pages?: string[];
}

export type JsonSchema = { [key: string]: unknown };

export type ParamLocation = (typeof PARAM_LOCATIONS)[number];

export interface ParamInfo {
  name: string;
  in: ParamLocation;
  required: boolean;
  schema: JsonSchema;
  examples: string[];
}

export type BodyKind = (typeof BODY_KINDS)[number];

export interface BodyShape {
  mimeType: string;
  kind: BodyKind;
  jsonLines?: boolean;
  schema?: JsonSchema;
  examples: unknown[];
}

export interface EndpointResponse {
  status: number;
  count: number;
  body?: BodyShape;
  headers: string[];
}

export type TokenSource = (typeof TOKEN_SOURCES)[number];

export type CsrfLocation = (typeof CSRF_LOCATIONS)[number];

export interface CsrfToken {
  location: CsrfLocation;
  name: string;
  source: TokenSource;
  sourceName?: string;
  sourceUrl?: string;
  sourceMethod?: string;
}

export interface EndpointAuth {
  cookies: string[];
  headers: string[];
  bearer: boolean;
  csrf: CsrfToken[];
  anonymous?: boolean;
}

export interface EndpointForm {
  pageUrl: string;
  selector: string;
  action: string;
  method: FormMethod;
  enctype: FormEnctype;
  charset: string;
  fields: FormField[];
  submitters: FormField[];
  tokenFields: string[];
}

export type EndpointKind = (typeof ENDPOINT_KINDS)[number];

export interface EndpointSample {
  exchangeId: string;
  url: string;
  pageUrl?: string;
  status?: number;
  startedAt: string;
}

export interface Endpoint {
  id: string;
  name: string;
  key: string;
  method: string;
  origin: string;
  path: string;
  operationName?: string;
  kind: EndpointKind;
  firstParty: boolean;
  pathParams: ParamInfo[];
  queryParams: ParamInfo[];
  headerParams: ParamInfo[];
  requestBody?: BodyShape;
  otherRequestBodies?: BodyShape[];
  responses: EndpointResponse[];
  auth: EndpointAuth;
  form?: EndpointForm;
  resourceTypes: ResourceType[];
  samples: EndpointSample[];
  count: number;
}

export type CookieRole = (typeof COOKIE_ROLES)[number];

export interface CookieInfo {
  name: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: SameSite | null;
  partitionKey?: string;
  session: boolean;
  expires: string | null;
  role: CookieRole;
  setBy: string[];
  usedBy: string[];
  valueExample: string;
}

export interface ApiModel {
  version: typeof MODEL_VERSION;
  name: string;
  generatedAt: string;
  source: {
    startUrl?: string;
    file?: string;
    exchanges: number;
    capturedFrom?: string;
    capturedTo?: string;
  };
  primaryOrigin: string;
  origins: string[];
  endpoints: Endpoint[];
  cookies: CookieInfo[];
  forms: FormDescriptor[];
  websockets: { url: string; messages: number; examples: string[] }[];
}
