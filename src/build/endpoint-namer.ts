import type { Endpoint } from '../model/index.js';
import { Http, Text } from '../shared/index.js';

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
  static readonly BY_WORD = 'By';
  static readonly AND_WORD = 'And';
  static readonly INDEX_DOCUMENT: RegExp = /^index\.html?$/i;
  static readonly DOCUMENT_EXTENSION: RegExp = /\.html?$/i;
  static readonly ITEM_PHRASE_WORDS = 3;

  static segments(path: string): Segment[] {
    const parts = path.split('/').filter((segment) => segment !== '');
    return parts
      .filter((segment) => parts.length === 1 || !EndpointNamer.INDEX_DOCUMENT.test(segment))
      .map((segment) => {
        const whole = /^\{([^{}]+)\}$/.exec(segment);
        if (whole) return { text: whole[1] ?? '', param: true };
        return { text: Http.decodeComponent(segment.replace(/\{[^{}]*\}/g, '')).replace(EndpointNamer.DOCUMENT_EXTENSION, ''), param: false };
      });
  }

  static isPlural(word: string): boolean {
    return Text.singularizePhrase(word).toLowerCase() !== word.toLowerCase();
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
    const kept = new Map<string, Candidate>();
    for (const [base, group] of groups) {
      const usable = group.filter((candidate) => Text.isIdentifier(candidate.base));
      const preferred = usable.find((candidate) => candidate.endpoint.kind !== 'graphql') ?? usable[0];
      if (preferred) kept.set(base, preferred);
    }
    const taken = new Set(kept.keys());
    for (const candidate of candidates) {
      const owner = kept.get(candidate.base);
      if (owner === candidate) {
        candidate.endpoint.name = candidate.base;
        continue;
      }
      const by = owner ? EndpointNamer.#byParams(candidate, owner) : undefined;
      if (by !== undefined && Text.isIdentifier(by) && !taken.has(by)) {
        taken.add(by);
        candidate.endpoint.name = by;
      } else {
        candidate.endpoint.name = Text.uniqueName(EndpointNamer.#identifier(candidate.qualified), taken);
      }
    }
  }

  static #byParams(candidate: Candidate, owner: Candidate): string | undefined {
    const known = new Set(EndpointNamer.#params(owner.endpoint));
    const extra = EndpointNamer.#params(candidate.endpoint).filter((name) => !known.has(name));
    if (extra.length === 0) return undefined;
    return `${candidate.base}${EndpointNamer.BY_WORD}${extra.map((name) => Text.pascalCase(name)).join(EndpointNamer.AND_WORD)}`;
  }

  static #params(endpoint: Endpoint): string[] {
    return EndpointNamer.segments(endpoint.path)
      .filter((segment) => segment.param)
      .map((segment) => segment.text);
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
      const resource = words.length > 0 ? words : [EndpointNamer.HOME_WORD];
      const tail = Text.words(resource[resource.length - 1] ?? '');
      return EndpointNamer.#camel(['get', ...resource, ...(tail[tail.length - 1] === EndpointNamer.PAGE_WORD ? [] : [EndpointNamer.PAGE_WORD])]);
    }
    const collection = parent !== undefined && !parent.param && EndpointNamer.isPlural(parent.text) && !EndpointNamer.STOP_SEGMENTS.test(parent.text);
    const itemVerb = EndpointNamer.ITEM_VERBS[method];
    if (last && !last.param && parent && collection && itemVerb && Text.words(last.text).length >= EndpointNamer.ITEM_PHRASE_WORDS) {
      const prefix = qualified ? literals.slice(0, -2) : [];
      return EndpointNamer.#camel([itemVerb, ...prefix, Text.singularizePhrase(parent.text), last.text]);
    }
    const collectionVerb = EndpointNamer.COLLECTION_VERBS[method];
    if (last && !last.param && collectionVerb && EndpointNamer.isPlural(last.text) && !EndpointNamer.STOP_SEGMENTS.test(last.text)) {
      const prefix = qualified ? literals.slice(0, -1) : [];
      return EndpointNamer.#camel([collectionVerb, ...prefix, collectionVerb === 'list' ? last.text : Text.singularizePhrase(last.text)]);
    }
    if (last?.param && parent && collection && itemVerb && last.text !== Text.camelCase(parent.text)) {
      const prefix = qualified ? literals.slice(0, -1) : [];
      return EndpointNamer.#camel([itemVerb, ...prefix, Text.singularizePhrase(parent.text)]);
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
      words.push(next?.param && i === segments.length - 2 ? Text.singularizePhrase(segment.text) : segment.text);
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
