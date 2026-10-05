export type CdpHeaders = Record<string, string>;

export interface CdpTiming {
  requestTime: number;
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

export interface CdpRequestExtraInfo {
  requestId: string;
  headers: CdpHeaders;
}

export interface CdpResponseExtraInfo {
  requestId: string;
  headers: CdpHeaders;
  statusCode?: number;
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
