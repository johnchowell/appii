import type { ApiModel, CsrfToken, Endpoint } from '../model/index.js';
import { Curl, EndpointIndex, Meta, Samples } from '../shared/index.js';
import { CurlBearerScript } from './curl-bearer-script.js';
import { CurlExporter } from './curl-exporter.js';
import { CurlSessionScript } from './curl-session-script.js';
import { Helpers } from './helpers.js';
import { LoginGuide } from './login-guide.js';
import type { CodeMarkup } from './login-guide.js';

export interface SessionSteps {
  readonly steps: readonly string[];
  readonly lead: string;
  readonly commands: readonly string[];
  readonly notes: readonly string[];
}

export interface SessionMarkup {
  readonly code: CodeMarkup;
  readonly url: (value: string) => string;
}

export class SessionGuide {
  static readonly TITLE = 'Session steps';
  static readonly SCRIPT = Samples.CURL_SCRIPT;
  static readonly MODEL_FILE = 'api.json';
  static readonly FORMAT = 'curl';
  static readonly VALUE = 'VALUE';
  static readonly FOR_TOKENS = 'The example above leaves these steps to you; the curl export does them with a cookie jar:';
  static readonly FOR_LOGIN = 'The example above sends the login on its own; the curl export sends it with a cookie jar:';
  static readonly LOGIN_JAR = 'It keeps the cookies the login sets in its jar, so the functions you call after it are logged in.';
  static readonly LOGIN_INPUTS = 'It stops and names the variable when the user name or the password is missing.';

  readonly #functions: ReadonlyMap<string, string>;

  static create(model: ApiModel): SessionGuide {
    const names = new CurlExporter().functionNames(model.endpoints);
    return new SessionGuide(new Map([...names].map(([endpoint, name]): [string, string] => [endpoint.id, name])));
  }

  constructor(functions: ReadonlyMap<string, string>) {
    this.#functions = functions;
  }

  static bound(token: CsrfToken, code: CodeMarkup): string {
    const cookies = token.sessionCookies ?? [];
    if (cookies.length === 0) return '';
    return `bound to the ${cookies.length === 1 ? 'cookie' : 'cookies'} ${cookies.map(code).join(', ')}`;
  }

  static fetched(endpoint: Endpoint): CsrfToken[] {
    return endpoint.auth.csrf.filter((token) => Samples.fetchedToken(token, endpoint));
  }

  static step(token: CsrfToken, endpoint: Endpoint, markup: SessionMarkup): string {
    const name = markup.code(token.sourceName ?? token.name);
    const read = token.source === 'hidden-field' ? `read the hidden field ${name}` : token.source === 'meta' ? `read the meta tag ${name}` : `read ${name} from its response`;
    const cookies = token.sessionCookies ?? [];
    const send = cookies.length > 0 ? `send it with the ${cookies.length === 1 ? 'cookie' : 'cookies'} ${cookies.map(markup.code).join(', ')} from the same session` : 'send it';
    return `The token ${markup.code(token.name)} changes with the session: request GET ${markup.url(Helpers.tokenPage(token, endpoint) ?? '')}, ${read}, and ${send}.`;
  }

  static arguments(endpoint: Endpoint): string[] {
    const login = LoginGuide.isLogin(endpoint) ? endpoint.login : undefined;
    if (!login) return [];
    const names = [login.identifier, login.password].filter((name): name is string => name !== undefined && name !== '');
    return names.every((name) => CurlExporter.ASSIGNABLE_NAME.test(name) && Curl.SAFE_WORD.test(name)) ? names.map((name) => `${name}=${SessionGuide.VALUE}`) : [];
  }

  steps(endpoint: Endpoint, markup: SessionMarkup, file: string = SessionGuide.MODEL_FILE): SessionSteps | undefined {
    const tokens = SessionGuide.fetched(endpoint);
    const login = LoginGuide.isLogin(endpoint) ? endpoint.login : undefined;
    if (tokens.length === 0 && login === undefined) return undefined;
    const name = this.#functions.get(endpoint.id) ?? endpoint.name;
    const commands = [
      `${Meta.APP_NAME} export ${file} --format ${SessionGuide.FORMAT} -o ${SessionGuide.SCRIPT}`,
      ['bash', SessionGuide.SCRIPT, name, ...SessionGuide.arguments(endpoint)].join(' '),
    ];
    const notes: string[] = [];
    if (login !== undefined) {
      if (login.issues.cookies.length > 0 || !LoginGuide.issued(login)) notes.push(SessionGuide.LOGIN_JAR);
      if (login.issues.tokens.length > 0) notes.push(`It saves the bearer token from the response in the token file ${markup.code(CurlBearerScript.FILE_VARIABLE)}, so the functions you call after it send it.`);
      notes.push(SessionGuide.LOGIN_INPUTS);
    }
    return {
      steps: tokens.map((token) => SessionGuide.step(token, endpoint, markup)),
      lead: tokens.length > 0 ? SessionGuide.FOR_TOKENS : SessionGuide.FOR_LOGIN,
      commands,
      notes,
    };
  }
}
