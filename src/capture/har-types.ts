import type { CacheKind, Cookie, PageSnapshot, StorageSnapshot } from '../model/index.js';

export interface Har {
  log: HarLog;
}

export interface HarCreator {
  name: string;
  version: string;
  comment?: string;
}

export interface HarLog {
  version: string;
  creator: HarCreator;
  browser?: HarCreator;
  pages?: HarPage[];
  entries: HarEntry[];
  comment?: string;
  _appiiStartUrl?: string;
  _appiiStartedAt?: string;
  _appiiEndedAt?: string;
  _appiiCookies?: Cookie[];
  _appiiStorage?: StorageSnapshot[];
  _appiiPages?: PageSnapshot[];
}

export interface HarPageTimings {
  onContentLoad?: number;
  onLoad?: number;
  comment?: string;
}

export interface HarPage {
  startedDateTime: string;
  id: string;
  title: string;
  pageTimings: HarPageTimings;
  comment?: string;
}

export interface HarNameValue {
  name: string;
  value: string;
  comment?: string;
}

export type HarHeader = HarNameValue;

export type HarQueryParam = HarNameValue;

export interface HarCookie {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  comment?: string;
}

export interface HarParam {
  name: string;
  value?: string;
  fileName?: string;
  contentType?: string;
  comment?: string;
}

export interface HarPostData {
  mimeType: string;
  params?: HarParam[];
  text?: string;
  comment?: string;
  _appiiEncoding?: 'base64';
  _appiiTruncated?: boolean;
  _encoding?: string;
  _file?: string;
}

export interface HarContent {
  size: number;
  compression?: number;
  mimeType: string;
  text?: string;
  encoding?: string;
  comment?: string;
  _appiiTruncated?: boolean;
  _file?: string;
}

export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  cookies: HarCookie[];
  headers: HarHeader[];
  queryString: HarQueryParam[];
  postData?: HarPostData;
  headersSize: number;
  bodySize: number;
  comment?: string;
}

export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  cookies: HarCookie[];
  headers: HarHeader[];
  content: HarContent;
  redirectURL: string;
  headersSize: number;
  bodySize: number;
  comment?: string;
  _error?: string;
  _transferSize?: number;
  _fetchedViaServiceWorker?: boolean;
}

export interface HarCacheEntry {
  expires?: string;
  lastAccess: string;
  eTag: string;
  hitCount: number;
  comment?: string;
}

export interface HarCache {
  beforeRequest?: HarCacheEntry | null;
  afterRequest?: HarCacheEntry | null;
  comment?: string;
}

export interface HarTimings {
  blocked?: number;
  dns?: number;
  connect?: number;
  send: number;
  wait: number;
  receive: number;
  ssl?: number;
  comment?: string;
}

export interface HarWebSocketMessage {
  type: 'send' | 'receive';
  time: number;
  opcode: number;
  data: string;
}

export interface HarEntry {
  pageref?: string;
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: HarCache;
  timings: HarTimings;
  serverIPAddress?: string;
  connection?: string;
  comment?: string;
  _resourceType?: string;
  _fromCache?: string;
  _webSocketMessages?: HarWebSocketMessage[];
  _appiiId?: string;
  _appiiRedirectedFrom?: string;
  _appiiPageUrl?: string;
  _appiiError?: string;
  _appiiRemoteAddress?: string;
  _appiiClosedAt?: string;
  _appiiCacheKind?: CacheKind;
}
