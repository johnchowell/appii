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

export type CaptureSource = 'browser' | 'http' | 'har';

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

export interface SelectOption {
  value: string;
  label: string;
  selected: boolean;
  disabled: boolean;
}

export type FieldKind = 'input' | 'select' | 'textarea' | 'button';

export interface FormField {
  name: string;
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
  autocomplete?: string;
  id?: string;
  formAction?: string;
  formMethod?: FormMethod;
  formEnctype?: FormEnctype;
  formNoValidate?: boolean;
}

export type FormMethod = 'GET' | 'POST' | 'DIALOG';

export type FormEnctype = 'application/x-www-form-urlencoded' | 'multipart/form-data' | 'text/plain';

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

export interface PageTokens {
  meta: Record<string, string>;
  cookies: string[];
}

export interface FileValue {
  filename: string;
  contentType?: string;
  dataBase64: string;
}

export type FormValue = string | string[] | boolean | FileValue | FileValue[];

export type FormValues = Record<string, FormValue>;

export interface FormDataEntry {
  name: string;
  value: string | FileValue;
}

export type ValidityFlag =
  | 'valueMissing'
  | 'typeMismatch'
  | 'patternMismatch'
  | 'tooLong'
  | 'tooShort'
  | 'rangeUnderflow'
  | 'rangeOverflow'
  | 'stepMismatch'
  | 'badInput'
  | 'customError';

export interface FieldValidation {
  name: string;
  type: string;
  value: string | string[];
  valid: boolean;
  flags: ValidityFlag[];
  message: string;
}

export interface FormValidationResult {
  source: 'emulated' | 'browser';
  valid: boolean;
  fields: FieldValidation[];
  unknownValues: string[];
}

export interface ServerFieldError {
  field?: string;
  message: string;
  source: 'json' | 'html';
  path?: string;
}

export interface SubmissionResult {
  form: FormDescriptor;
  entries: FormDataEntry[];
  clientValidation: FormValidationResult;
  submitted: boolean;
  chain: Exchange[];
  finalUrl?: string;
  status?: number;
  serverErrors: ServerFieldError[];
  accepted: boolean;
  cookiesSet: Cookie[];
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

export interface InferredResponse {
  status: number;
  count: number;
  body?: BodyShape;
  headers: string[];
}

export interface AuthHints {
  cookies: string[];
  headers: string[];
  csrfHeaders: string[];
  bearer: boolean;
}

export interface InferredEndpoint {
  key: string;
  method: string;
  origin: string;
  pathTemplate: string;
  operationName?: string;
  pathParams: ParamInfo[];
  queryParams: ParamInfo[];
  headerParams: ParamInfo[];
  requestBody?: BodyShape;
  responses: InferredResponse[];
  auth: AuthHints;
  resourceTypes: ResourceType[];
  sampleIds: string[];
  count: number;
}

export interface HttpResponseView {
  url: string;
  status: number;
  statusText: string;
  headers: Header[];
  text: string;
  bytes: Uint8Array;
  json(): unknown;
}
