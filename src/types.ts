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

export type ResourceType =
  | 'document'
  | 'xhr'
  | 'fetch'
  | 'script'
  | 'stylesheet'
  | 'image'
  | 'font'
  | 'media'
  | 'websocket'
  | 'manifest'
  | 'eventsource'
  | 'other';

export type CaptureSource = 'browser' | 'har';

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

export type SameSite = 'Strict' | 'Lax' | 'None';

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

export type FieldKind = 'input' | 'select' | 'textarea' | 'button';

export type FormMethod = 'GET' | 'POST' | 'DIALOG';

export type FormEnctype = 'application/x-www-form-urlencoded' | 'multipart/form-data' | 'text/plain';

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
  method: FormMethod;
  enctype: FormEnctype;
  acceptCharset?: string;
  noValidate: boolean;
  target?: string;
  fields: FormField[];
  submitters: FormField[];
  tokenFields: string[];
}

export type JsonSchema = { [key: string]: unknown };

export type ParamLocation = 'path' | 'query' | 'header' | 'cookie';

export interface ParamInfo {
  name: string;
  in: ParamLocation;
  required: boolean;
  schema: JsonSchema;
  examples: string[];
}

export type BodyKind = 'json' | 'form' | 'multipart' | 'graphql' | 'html' | 'text' | 'binary' | 'empty';

export interface BodyShape {
  mimeType: string;
  kind: BodyKind;
  schema?: JsonSchema;
  examples: unknown[];
}

export interface EndpointResponse {
  status: number;
  count: number;
  body?: BodyShape;
  headers: string[];
}

export type TokenSource = 'cookie' | 'meta' | 'hidden-field' | 'response' | 'unknown';

export interface CsrfToken {
  location: 'header' | 'body' | 'query';
  name: string;
  source: TokenSource;
  sourceName?: string;
  sourceUrl?: string;
}

export interface EndpointAuth {
  cookies: string[];
  headers: string[];
  bearer: boolean;
  csrf: CsrfToken[];
}

export interface EndpointForm {
  pageUrl: string;
  selector: string;
  enctype: FormEnctype;
  fields: FormField[];
  submitters: FormField[];
  tokenFields: string[];
}

export type EndpointKind = 'json' | 'form' | 'graphql' | 'document' | 'other';

export interface EndpointSample {
  exchangeId: string;
  url: string;
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
  responses: EndpointResponse[];
  auth: EndpointAuth;
  form?: EndpointForm;
  resourceTypes: ResourceType[];
  samples: EndpointSample[];
  count: number;
}

export type CookieRole = 'session' | 'auth' | 'csrf' | 'preference' | 'tracking' | 'unknown';

export interface CookieInfo {
  name: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: SameSite | null;
  session: boolean;
  expires: string | null;
  role: CookieRole;
  setBy: string[];
  usedBy: string[];
  valueExample: string;
}

export interface ApiModel {
  version: 1;
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
