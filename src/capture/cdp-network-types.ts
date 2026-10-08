export type CdpHeaders = Record<string, string>;

export interface CdpTiming {
  requestTime: number;
  dnsStart?: number;
  dnsEnd?: number;
  connectStart?: number;
  sslStart?: number;
  connectEnd?: number;
  sendStart?: number;
  receiveHeadersEnd?: number;
}

export interface CdpRequest {
  url: string;
  urlFragment?: string;
  method: string;
  headers: CdpHeaders;
  postData?: string;
  hasPostData?: boolean;
  postDataEntries?: { bytes?: string }[];
}

export interface CdpResponse {
  url: string;
  status: number;
  statusText: string;
  headers: CdpHeaders;
  mimeType?: string;
  remoteIPAddress?: string;
  remotePort?: number;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  fromPrefetchCache?: boolean;
  serviceWorkerResponseSource?: string;
  timing?: CdpTiming;
  encodedDataLength?: number;
}

export interface CdpRequestWillBeSent {
  requestId: string;
  request: CdpRequest;
  timestamp: number;
  wallTime: number;
  type?: string;
  redirectResponse?: CdpResponse;
  redirectHasExtraInfo?: boolean;
}

export interface CdpResponseReceived {
  requestId: string;
  timestamp: number;
  type?: string;
  response: CdpResponse;
  hasExtraInfo?: boolean;
}

export interface CdpDataReceived {
  requestId: string;
  dataLength: number;
  encodedDataLength?: number;
  data?: string;
}

export interface CdpRequestPaused {
  requestId: string;
  request: CdpRequest;
  resourceType?: string;
  responseErrorReason?: string;
  responseStatusCode?: number;
  responseHeaders?: { name: string; value: string }[];
  networkId?: string;
}

export interface CdpStreamedContent {
  bufferedData: string;
}

export interface CdpLoadingFinished {
  requestId: string;
  timestamp: number;
  encodedDataLength?: number;
}

export interface CdpLoadingFailed {
  requestId: string;
  timestamp: number;
  errorText: string;
  canceled?: boolean;
}

export interface CdpServedFromCache {
  requestId: string;
}

export interface CdpResponseBody {
  body: string;
  base64Encoded: boolean;
}

export interface CdpPostData {
  postData: string;
}

export interface CdpTargetInfo {
  targetId: string;
  type: string;
  url: string;
}

export interface CdpFrameTree {
  frameTree: { frame: { id: string; url: string; urlFragment?: string } };
}

export interface CdpResourceContent {
  content: string;
  base64Encoded: boolean;
}

export interface CdpScriptParsed {
  scriptId: string;
  url: string;
}

export interface CdpScriptSource {
  scriptSource: string;
}
