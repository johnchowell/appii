import { Http } from '../shared/index.js';
import type { Header, ResourceType } from '../model/index.js';

export interface ResourceTypeHints {
  method: string;
  url: string;
  requestHeaders: Header[];
  status?: number;
  mimeType?: string;
}

export class ResourceTypeMapper {
  static readonly BROWSER_TYPES: Readonly<Record<string, ResourceType>> = {
    document: 'document',
    stylesheet: 'stylesheet',
    image: 'image',
    media: 'media',
    font: 'font',
    script: 'script',
    texttrack: 'media',
    xhr: 'xhr',
    fetch: 'fetch',
    eventsource: 'eventsource',
    websocket: 'websocket',
    manifest: 'manifest',
    signedexchange: 'document',
    prefetch: 'other',
    ping: 'other',
    beacon: 'other',
    cspviolationreport: 'other',
    preflight: 'other',
    fedcm: 'other',
    webtransport: 'other',
    wasm: 'other',
    webbundle: 'other',
    other: 'other',
  };

  static readonly FETCH_DESTINATIONS: Readonly<Record<string, ResourceType>> = {
    document: 'document',
    frame: 'document',
    iframe: 'document',
    style: 'stylesheet',
    script: 'script',
    worker: 'script',
    sharedworker: 'script',
    serviceworker: 'script',
    audioworklet: 'script',
    paintworklet: 'script',
    xslt: 'script',
    image: 'image',
    font: 'font',
    audio: 'media',
    video: 'media',
    track: 'media',
    manifest: 'manifest',
    report: 'other',
    embed: 'other',
    object: 'other',
    webidentity: 'other',
  };

  static readonly MIME_RULES: readonly { pattern: RegExp; type: ResourceType }[] = [
    { pattern: /^text\/event-stream$/, type: 'eventsource' },
    { pattern: /^text\/css$/, type: 'stylesheet' },
    { pattern: /^(?:text|application)\/(?:x-)?(?:java|ecma)script$|^text\/jscript$|^application\/wasm$/, type: 'script' },
    { pattern: /^image\//, type: 'image' },
    { pattern: /^font\/|^application\/(?:font-|x-font-)|^application\/vnd\.ms-fontobject$/, type: 'font' },
    { pattern: /^(?:audio|video)\/|^text\/vtt$/, type: 'media' },
    { pattern: /^application\/manifest\+json$/, type: 'manifest' },
  ];

  static fromBrowser(type: string): ResourceType {
    const key = type.toLowerCase().replace(/[^a-z]/g, '');
    return ResourceTypeMapper.BROWSER_TYPES[key] ?? 'other';
  }

  static infer(hints: ResourceTypeHints): ResourceType {
    const headers = hints.requestHeaders;
    const mime = Http.mimeEssence(hints.mimeType);
    if (hints.status === 101 || /^wss?:/i.test(hints.url) || (Http.getHeader(headers, 'upgrade') ?? '').toLowerCase() === 'websocket') return 'websocket';
    if (mime === 'text/event-stream') return 'eventsource';
    const xhr = (Http.getHeader(headers, 'x-requested-with') ?? '').toLowerCase() === 'xmlhttprequest';
    const dest = (Http.getHeader(headers, 'sec-fetch-dest') ?? '').toLowerCase();
    if (dest === 'empty') return xhr ? 'xhr' : 'fetch';
    const fromDest = dest ? ResourceTypeMapper.FETCH_DESTINATIONS[dest] : undefined;
    if (fromDest) return fromDest;
    if ((Http.getHeader(headers, 'sec-fetch-mode') ?? '').toLowerCase() === 'navigate') return 'document';
    if (xhr) return 'xhr';
    if (mime === 'text/html' || mime === 'application/xhtml+xml') {
      const accept = Http.mimeEssence((Http.getHeader(headers, 'accept') ?? '').split(',')[0]);
      return accept === 'text/html' ? 'document' : 'fetch';
    }
    for (const rule of ResourceTypeMapper.MIME_RULES) if (rule.pattern.test(mime)) return rule.type;
    if (mime && Http.isTextMime(mime)) return 'fetch';
    if (!Http.isSafeMethod(hints.method)) return 'fetch';
    return 'other';
  }
}
