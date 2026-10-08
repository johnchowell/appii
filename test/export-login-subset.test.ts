import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CurlExporter, HtmlExporter, MarkdownExporter, OpenApiExporter, PostmanExporter, TypeScriptExporter } from '../src/export/index.js';
import type { Exporter } from '../src/export/index.js';
import { LoginModels } from './helpers/login-models.js';

class SubsetCase {
  static readonly ORIGIN = 'https://quotes.example.test';
  static readonly MISSING = 'Log in first with POST /login (not in this export; add it with --endpoints postLogin).';

  static readonly FULL: readonly (readonly [string, () => Exporter, string])[] = Object.freeze([
    ['curl', () => new CurlExporter(), '# getAccountPage: Log in first with postLogin.'],
    ['markdown', () => new MarkdownExporter(), 'Log in first with [\\#4 postLogin](#4-post-login) (POST /login).'],
    ['html', () => new HtmlExporter(), 'Log in first with <a href="#endpoint-4">#4 <code>postLogin</code></a> (POST /login).'],
    ['postman', () => new PostmanExporter(), 'Log in first with \\"'],
    ['openapi', () => new OpenApiExporter(), 'Log in first with postLogin (POST /login).'],
    ['typescript', () => new TypeScriptExporter(), 'Log in first with client.postLogin().'],
  ]);

  static count(text: string, part: string): number {
    return text.split(part).length - 1;
  }
}

describe('an export without the login names it by method and path and says how to add it (QL4-3)', () => {
  for (const [format, exporter, full] of SubsetCase.FULL) {
    test(`${format}: --endpoints getAccountPage points to POST /login, which is not in the export`, () => {
      const model = LoginModels.form(SubsetCase.ORIGIN);
      const subset = exporter().export(model, { endpoints: ['getAccountPage'] });
      assert.equal(subset.endpointCount, 1);
      assert.ok(subset.content.includes(SubsetCase.MISSING), subset.content);
      assert.equal(SubsetCase.count(subset.content, 'postLogin'), SubsetCase.count(subset.content, '--endpoints postLogin'), 'the login is named only in the note');
      for (const absent of ['#4-post-login', 'endpoint-4', 'client.postLogin', 'Post login']) assert.ok(!subset.content.includes(absent), `${format}: ${absent}`);
      const whole = exporter().export(model).content;
      assert.ok(whole.includes(full), `${format}: ${full}`);
      assert.ok(!whole.includes('not in this export'), format);
    });
  }

  test('OpenAPI: the cookie scheme names the login and logout operations that are not in the export, and the plain list of setters stays short', () => {
    const doc = JSON.parse(new OpenApiExporter().export(LoginModels.form(SubsetCase.ORIGIN), { endpoints: ['getAccountPage'] }).content) as { components: { securitySchemes: Record<string, { description?: string }> } };
    const description = Object.values(doc.components.securitySchemes).map((scheme) => scheme.description ?? '').find((text) => text.includes('cookie session')) ?? '';
    assert.match(description, /The login operation POST \/login \(not in this export; add it with --endpoints postLogin\) issues it\./);
    assert.match(description, /The logout operation GET \/logout \(not in this export; add it with --endpoints getLogout\) revokes it\./);
    assert.doesNotMatch(description, /set by [^.]*not in this export/);
  });
});
