import { letterWords } from './text.js';

export interface SecretNameRules {
  readonly words: readonly string[];
  readonly stems: readonly string[];
  readonly suffixes: readonly string[];
  readonly phrases: readonly (readonly string[])[];
}

export class SecretNames {
  static readonly WORDS: readonly string[] = Object.freeze([
    'pass',
    'passwd',
    'password',
    'passphrase',
    'passcode',
    'pw',
    'pwd',
    'pin',
    'secret',
    'token',
    'auth',
    'authorization',
    'credential',
    'credentials',
    'session',
    'sessionid',
    'sid',
    'otp',
    'totp',
    'ssn',
    'cvv',
    'cvc',
    'csc',
    'jwt',
    'bearer',
    'signature',
    'apikey',
    'csrf',
    'xsrf',
  ]);
  static readonly STEMS: readonly string[] = Object.freeze(['password', 'passwd', 'passphrase']);
  static readonly SUFFIXES: readonly string[] = Object.freeze(['token', 'secret', 'apikey', 'passcode', 'sessionid', 'cvc', 'cvv', 'cardnumber']);
  static readonly KEY_QUALIFIERS: readonly string[] = Object.freeze([
    'api', 'access', 'secret', 'private', 'app', 'rp', 'reset', 'activation', 'recovery', 'confirmation', 'verification',
    'license', 'session', 'encryption', 'signing', 'master', 'subscription', 'sas', 'shared',
  ]);
  static readonly CODE_QUALIFIERS: readonly string[] = Object.freeze([
    'reset', 'verification', 'confirmation', 'activation', 'recovery', 'backup', 'security', 'mfa', 'sms', 'login', 'factor', 'invite', 'magic',
  ]);
  static readonly PHRASES: readonly (readonly string[])[] = Object.freeze([
    ...SecretNames.KEY_QUALIFIERS.map((qualifier) => Object.freeze([qualifier, 'key'])),
    ...SecretNames.CODE_QUALIFIERS.map((qualifier) => Object.freeze([qualifier, 'code'])),
    Object.freeze(['card', 'number']),
    Object.freeze(['cc', 'number']),
  ]);
  static readonly PAGE_FUNCTION = `function (rules, name) {
  var words = String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(function (word) { return word.toLowerCase(); })
    .reduce(function (all, word) { return all.concat(word.split(/[0-9]+/)); }, [])
    .filter(Boolean);
  function fused(word) {
    for (var p = 0; p < rules.phrases.length; p++) if (rules.phrases[p].join('') === word) return true;
    return false;
  }
  function secretWord(word) {
    if (rules.words.indexOf(word) >= 0 || fused(word)) return true;
    for (var s = 0; s < rules.stems.length; s++) if (word.indexOf(rules.stems[s]) >= 0) return true;
    for (var x = 0; x < rules.suffixes.length; x++) {
      var suffix = rules.suffixes[x];
      if (word.length >= suffix.length && word.slice(word.length - suffix.length) === suffix) return true;
    }
    return false;
  }
  for (var w = 0; w < words.length; w++) if (secretWord(words[w])) return true;
  for (var q = 0; q < rules.phrases.length; q++) {
    var phrase = rules.phrases[q];
    for (var i = 0; i + phrase.length <= words.length; i++) {
      var all = true;
      for (var j = 0; j < phrase.length; j++) if (words[i + j] !== phrase[j]) all = false;
      if (all) return true;
    }
  }
  return false;
}`;

  static readonly #FUSED: ReadonlySet<string> = new Set(SecretNames.PHRASES.map((phrase) => phrase.join('')));

  static rules(): SecretNameRules {
    return { words: SecretNames.WORDS, stems: SecretNames.STEMS, suffixes: SecretNames.SUFFIXES, phrases: SecretNames.PHRASES };
  }

  static isSecret(name: string): boolean {
    const words = letterWords(name);
    if (words.length === 0) return false;
    if (words.some((word) => SecretNames.#secretWord(word))) return true;
    return SecretNames.PHRASES.some((phrase) => SecretNames.#hasPhrase(words, phrase));
  }

  static #secretWord(word: string): boolean {
    return (
      SecretNames.WORDS.includes(word) ||
      SecretNames.#FUSED.has(word) ||
      SecretNames.STEMS.some((stem) => word.includes(stem)) ||
      SecretNames.SUFFIXES.some((suffix) => word.endsWith(suffix))
    );
  }

  static #hasPhrase(words: readonly string[], phrase: readonly string[]): boolean {
    for (let i = 0; i + phrase.length <= words.length; i++) {
      if (phrase.every((part, j) => words[i + j] === part)) return true;
    }
    return false;
  }
}
