import type { Endpoint } from '../model/index.js';
import { Text } from '../shared/index.js';
import { Helpers } from './helpers.js';

interface Segment {
  readonly text: string;
  readonly param: boolean;
}

interface Candidate {
  readonly endpoint: Endpoint;
  readonly base: string;
  readonly qualified: string;
}

export class EndpointNamer {
  static readonly STOP_SEGMENTS: RegExp = /^(?:api|apis|rest|rpc|json|ajax|public|v[0-9]+(?:\.[0-9]+)*)$/i;
  static readonly COLLECTION_VERBS: Readonly<Record<string, string>> = { GET: 'list', POST: 'create' };
  static readonly ITEM_VERBS: Readonly<Record<string, string>> = { GET: 'get', PUT: 'update', PATCH: 'update', DELETE: 'delete' };
  static readonly HOME_WORD = 'home';
  static readonly ROOT_WORD = 'root';
  static readonly PAGE_WORD = 'page';
  static readonly IDENTIFIER_SUFFIX = 'Endpoint';

  static segments(path: string): Segment[] {
    return path
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => {
        const whole = /^\{([^{}]+)\}$/.exec(segment);
        if (whole) return { text: whole[1] ?? '', param: true };
        return { text: Helpers.decode(segment.replace(/[{}]/g, '')), param: false };
      });
  }

  static isPlural(word: string): boolean {
    return Text.singularize(word).toLowerCase() !== word.toLowerCase();
  }

  name(endpoints: Endpoint[]): void {
    const ids = new Set<string>();
    for (const endpoint of endpoints) endpoint.id = Text.uniqueName(this.slug(endpoint), ids, '-');
    const candidates: Candidate[] = endpoints.map((endpoint) => ({ endpoint, base: this.baseName(endpoint), qualified: this.qualifiedName(endpoint) }));
    const groups = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
      const list = groups.get(candidate.base);
      if (list) list.push(candidate);
      else groups.set(candidate.base, [candidate]);
    }
    const keep = new Set<Candidate>();
    for (const group of groups.values()) {
      const usable = group.filter((candidate) => Text.isIdentifier(candidate.base));
      const preferred = usable.find((candidate) => candidate.endpoint.kind !== 'graphql') ?? usable[0];
      if (preferred) keep.add(preferred);
    }
    const taken = new Set([...keep].map((candidate) => candidate.base));
    for (const candidate of candidates) {
      candidate.endpoint.name = keep.has(candidate) ? candidate.base : Text.uniqueName(EndpointNamer.#identifier(candidate.qualified), taken);
    }
  }

  slug(endpoint: Endpoint): string {
    const words = EndpointNamer.segments(endpoint.path).map((segment) => (segment.param ? segment.text.toLowerCase() : segment.text));
    if (words.length === 0) words.push(EndpointNamer.ROOT_WORD);
    if (endpoint.operationName) words.push(endpoint.operationName.toLowerCase());
    return Text.kebabCase([endpoint.method.toLowerCase(), ...words].join(' ')) || EndpointNamer.ROOT_WORD;
  }

  baseName(endpoint: Endpoint): string {
    return this.#name(endpoint, false);
  }

  qualifiedName(endpoint: Endpoint): string {
    return this.#name(endpoint, true);
  }

  #name(endpoint: Endpoint, qualified: boolean): string {
    const segments = EndpointNamer.segments(endpoint.path);
    const literals = segments.filter((segment) => !segment.param).map((segment) => segment.text);
    const meaningful = literals.filter((text) => !EndpointNamer.STOP_SEGMENTS.test(text));
    const method = endpoint.method.toUpperCase();
    const verb = endpoint.method.toLowerCase();
    if (endpoint.kind === 'graphql') {
      if (endpoint.operationName) return EndpointNamer.#camel(qualified ? [...literals, endpoint.operationName] : [endpoint.operationName]);
      return EndpointNamer.#camel([verb, ...(qualified ? literals : meaningful.length > 0 ? meaningful : literals)]);
    }
    const last = segments[segments.length - 1];
    const parent = segments[segments.length - 2];
    if (endpoint.kind === 'document' && method === 'GET') {
      const words = EndpointNamer.#resource(segments, qualified);
      return EndpointNamer.#camel(['get', ...(words.length > 0 ? words : [EndpointNamer.HOME_WORD]), EndpointNamer.PAGE_WORD]);
    }
    const collectionVerb = EndpointNamer.COLLECTION_VERBS[method];
    if (last && !last.param && collectionVerb && EndpointNamer.isPlural(last.text) && !EndpointNamer.STOP_SEGMENTS.test(last.text)) {
      const prefix = qualified ? literals.slice(0, -1) : [];
      return EndpointNamer.#camel([collectionVerb, ...prefix, collectionVerb === 'list' ? last.text : Text.singularize(last.text)]);
    }
    const itemVerb = EndpointNamer.ITEM_VERBS[method];
    if (last?.param && parent && !parent.param && itemVerb && EndpointNamer.isPlural(parent.text) && !EndpointNamer.STOP_SEGMENTS.test(parent.text)) {
      const prefix = qualified ? literals.slice(0, -1) : [];
      return EndpointNamer.#camel([itemVerb, ...prefix, Text.singularize(parent.text)]);
    }
    const words = qualified ? literals : meaningful.length > 0 ? meaningful : literals;
    return EndpointNamer.#camel([verb, ...(words.length > 0 ? words : [EndpointNamer.ROOT_WORD])]);
  }

  static #resource(segments: readonly Segment[], qualified: boolean): string[] {
    const words: string[] = [];
    segments.forEach((segment, i) => {
      if (segment.param) return;
      if (!qualified && EndpointNamer.STOP_SEGMENTS.test(segment.text)) return;
      const next = segments[i + 1];
      words.push(next?.param && i === segments.length - 2 ? Text.singularize(segment.text) : segment.text);
    });
    return words;
  }

  static #identifier(name: string): string {
    return Text.isIdentifier(name) ? name : `${name}${EndpointNamer.IDENTIFIER_SUFFIX}`;
  }

  static #camel(words: readonly string[]): string {
    const name = Text.camelCase(words.join(' '));
    return name === '' ? EndpointNamer.ROOT_WORD : name;
  }
}
