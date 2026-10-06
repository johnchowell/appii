import type { BodyKind, BodyShape, Endpoint } from '../model/index.js';
import { mimeEssence } from './http.js';

export interface RequestBodyVariant {
  readonly endpoint: Endpoint;
  readonly shape: BodyShape;
  readonly mediaType: string;
}

export class RequestBodies {
  static readonly MEDIA_RANGE: RegExp = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
  static readonly DEFAULT_MEDIA: Readonly<Record<BodyKind, string>> = Object.freeze({
    json: 'application/json',
    form: 'application/x-www-form-urlencoded',
    multipart: 'multipart/form-data',
    graphql: 'application/json',
    html: 'text/html',
    text: 'text/plain',
    binary: 'application/octet-stream',
    empty: 'application/octet-stream',
  });

  static mediaType(shape: BodyShape): string {
    const essence = mimeEssence(shape.mimeType);
    return RequestBodies.MEDIA_RANGE.test(essence) ? essence : RequestBodies.DEFAULT_MEDIA[shape.kind];
  }

  static shapes(endpoint: Endpoint): BodyShape[] {
    const seen = new Set<string>();
    const out: BodyShape[] = [];
    for (const shape of [endpoint.requestBody, ...(endpoint.otherRequestBodies ?? [])]) {
      if (shape === undefined || shape.kind === 'empty') continue;
      const media = RequestBodies.mediaType(shape);
      if (seen.has(media)) continue;
      seen.add(media);
      out.push(shape);
    }
    return out;
  }

  static variants(endpoint: Endpoint): RequestBodyVariant[] {
    return RequestBodies.shapes(endpoint)
      .filter((shape) => shape !== endpoint.requestBody)
      .map((shape) => {
        const variant: Endpoint = { ...endpoint, requestBody: shape };
        delete variant.otherRequestBodies;
        delete variant.form;
        return { endpoint: variant, shape, mediaType: RequestBodies.mediaType(shape) };
      });
  }
}
