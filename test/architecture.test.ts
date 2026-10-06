import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { API, TypeFlags } from 'typescript/unstable/sync';
import type { Project } from 'typescript/unstable/sync';
import { LanguageVariant, SyntaxKind, createScanner, getLeadingCommentRanges } from 'typescript/unstable/ast';
import type { Expression, Node, ParameterDeclaration, SourceFile } from 'typescript/unstable/ast';
import {
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isClassDeclaration,
  isConstructorDeclaration,
  isExportDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isMethodDeclaration,
  isNewExpression,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isRegularExpressionLiteral,
  isReturnStatement,
  isStringLiteral,
  isVariableStatement,
} from 'typescript/unstable/ast/is';

interface TextFile {
  path: string;
  text: string;
}

interface SharedBody {
  name: string;
  text: string;
}

type FunctionLike = Node & { readonly body?: Node; readonly parameters: readonly ParameterDeclaration[]; readonly name?: Node };

class SourceTree {
  static readonly ROOT = 'src';
  static readonly SHARED = 'shared';
  static readonly DOMAINS = ['build', 'capture', 'cli', 'export', 'forms', 'present'];
  static readonly EMITTED_RUNTIME = new Set(['src/export/ts-client-runtime.ts']);
  static readonly WRAPPERS = new Set([SyntaxKind.AsExpression, SyntaxKind.SatisfiesExpression, SyntaxKind.ParenthesizedExpression, SyntaxKind.TypeAssertionExpression, SyntaxKind.NonNullExpression]);
  static readonly COMMENTS = new Set([SyntaxKind.SingleLineCommentTrivia, SyntaxKind.MultiLineCommentTrivia]);
  static readonly IMMUTABLE = TypeFlags.StringLike | TypeFlags.NumberLike | TypeFlags.BooleanLike | TypeFlags.BigIntLike | TypeFlags.EnumLike | TypeFlags.Undefined | TypeFlags.Null | TypeFlags.ESSymbolLike;
  static readonly api = new API({ cwd: process.cwd() });
  static readonly project: Project = SourceTree.#open();

  static #open(): Project {
    const project = SourceTree.api.updateSnapshot({ openProjects: ['tsconfig.json'] }).getProjects()[0];
    assert.ok(project, 'tsconfig.json opens as a project');
    return project;
  }

  static files(dir: string = SourceTree.ROOT): TextFile[] {
    const out: TextFile[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...SourceTree.files(path));
      else if (entry.name.endsWith('.ts')) out.push({ path: relative('.', path).split(sep).join('/'), text: readFileSync(path, 'utf8') });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  static domainFiles(): TextFile[] {
    return SourceTree.files().filter((file) => SourceTree.DOMAINS.some((domain) => file.path.startsWith(`src/${domain}/`)) && !SourceTree.EMITTED_RUNTIME.has(file.path));
  }

  static sources(): SourceFile[] {
    const program = SourceTree.project.program;
    return SourceTree.files().map((file) => {
      const source = program.getSourceFile(join(process.cwd(), file.path));
      assert.ok(source, `${file.path} is part of the program`);
      return source;
    });
  }

  static path(file: SourceFile): string {
    return relative('.', file.fileName).split(sep).join('/');
  }

  static domainOf(path: string): string {
    return path.split('/')[1] ?? '';
  }

  static isDomainCode(file: SourceFile): boolean {
    const path = SourceTree.path(file);
    return SourceTree.DOMAINS.includes(SourceTree.domainOf(path)) && !SourceTree.EMITTED_RUNTIME.has(path);
  }

  static where(node: Node): string {
    const file = node.getSourceFile();
    const start = node.getStart(file);
    const line = file.getLineStarts().filter((offset) => offset <= start).length;
    return `${SourceTree.path(file)}:${line}`;
  }

  static children(node: Node): Node[] {
    const out: Node[] = [];
    node.forEachChild(
      (child) => {
        out.push(child);
      },
      (nodes) => {
        out.push(...nodes);
      },
    );
    return out.sort((a, b) => a.pos - b.pos);
  }

  static visit(node: Node, visitor: (node: Node) => void): void {
    visitor(node);
    for (const child of SourceTree.children(node)) SourceTree.visit(child, visitor);
  }

  static hasModifier(node: Node, kind: SyntaxKind): boolean {
    const modifiers = (node as Node & { readonly modifiers?: readonly Node[] }).modifiers ?? [];
    return modifiers.some((modifier) => modifier.kind === kind);
  }

  static unwrap(expression: Expression): Expression {
    let current: Node = expression;
    while (SourceTree.WRAPPERS.has(current.kind)) current = (current as Node & { readonly expression: Expression }).expression;
    return current as Expression;
  }

  static isFreeze(expression: Expression): boolean {
    const call = SourceTree.unwrap(expression);
    return isCallExpression(call) && call.expression.getText() === 'Object.freeze';
  }

  static statefulRegex(expression: Expression | undefined): boolean {
    if (expression === undefined) return false;
    const value = SourceTree.unwrap(expression);
    if (!isRegularExpressionLiteral(value)) return false;
    const flags = value.text.slice(value.text.lastIndexOf('/') + 1);
    return flags.includes('g') || flags.includes('y');
  }

  static functionLike(node: Node): node is FunctionLike {
    return isMethodDeclaration(node) || isFunctionDeclaration(node) || isArrowFunction(node) || isFunctionExpression(node);
  }

  static tokens(root: Node, trivia: boolean, onToken: (kind: SyntaxKind, text: string, start: number) => void, onLeaf: (leaf: Node) => void): void {
    const text = root.getSourceFile().text;
    const scan = (start: number, end: number): void => {
      if (end <= start) return;
      const scanner = createScanner(!trivia, LanguageVariant.Standard, text, start, end - start);
      for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) onToken(token, scanner.getTokenText(), scanner.getTokenStart());
    };
    const walk = (node: Node, from: number): void => {
      const children = SourceTree.children(node);
      if (children.length === 0) {
        onLeaf(node);
        return;
      }
      let at = from;
      for (const child of children) {
        scan(at, child.pos);
        walk(child, child.pos);
        at = Math.max(at, child.end);
      }
      scan(at, node.end);
    };
    walk(root, trivia ? root.pos : root.getStart(root.getSourceFile()));
  }

  static comments(file: SourceFile): number[] {
    const found = new Set<number>();
    SourceTree.tokens(
      file,
      true,
      (kind, _text, start) => {
        if (SourceTree.COMMENTS.has(kind)) found.add(start);
      },
      (leaf) => {
        for (const range of getLeadingCommentRanges(file.text, leaf.pos) ?? []) found.add(range.pos);
      },
    );
    return [...found].sort((a, b) => a - b);
  }
}

class BodyFingerprint {
  static readonly MIN_TOKENS = 8;
  static readonly SELF = '$self';
  static readonly NAMESPACE_EXPORT: RegExp = /export \* as (\w+) from/g;
  static readonly namespaces: ReadonlySet<string> = BodyFingerprint.#namespaces();

  static #namespaces(): Set<string> {
    const text = readFileSync(join(SourceTree.ROOT, SourceTree.SHARED, 'index.ts'), 'utf8');
    return new Set([...text.matchAll(BodyFingerprint.NAMESPACE_EXPORT)].map((match) => match[1] ?? ''));
  }

  static of(node: FunctionLike): string | undefined {
    if (node.body === undefined) return undefined;
    const names = new Map<string, string>();
    for (const parameter of node.parameters) BodyFingerprint.#bind(parameter.name, names);
    const tokens: string[] = [];
    BodyFingerprint.#tokens(BodyFingerprint.#expression(node.body), names, tokens);
    const normalized = BodyFingerprint.#receivers(tokens, BodyFingerprint.#owner(node));
    return normalized.length >= BodyFingerprint.MIN_TOKENS ? normalized.join(' ') : undefined;
  }

  static #owner(node: Node): string | undefined {
    for (let current: Node | undefined = node.parent; current !== undefined; current = current.parent) {
      if (isClassDeclaration(current)) return current.name?.text;
    }
    return undefined;
  }

  static #receivers(tokens: readonly string[], owner: string | undefined): string[] {
    const out: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] ?? '';
      const member = tokens[i + 1] === '.' && tokens[i - 1] !== '.';
      if (member && BodyFingerprint.namespaces.has(token)) {
        i++;
        continue;
      }
      out.push(member && token === owner ? BodyFingerprint.SELF : token);
    }
    return out;
  }

  static #expression(body: Node): Node {
    if (!isBlock(body)) return body;
    const [only] = body.statements;
    if (body.statements.length !== 1 || only === undefined) return body;
    return isReturnStatement(only) && only.expression !== undefined ? only.expression : body;
  }

  static #bind(name: Node, names: Map<string, string>): void {
    if (isIdentifier(name)) {
      names.set(name.text, `$${names.size}`);
      return;
    }
    SourceTree.visit(name, (inner) => {
      if (inner !== name && isIdentifier(inner) && !names.has(inner.text)) names.set(inner.text, `$${names.size}`);
    });
  }

  static #tokens(node: Node, names: ReadonlyMap<string, string>, out: string[]): void {
    SourceTree.tokens(
      node,
      false,
      (_kind, text) => out.push(text),
      (leaf) => out.push(isIdentifier(leaf) ? (names.get(leaf.text) ?? leaf.text) : leaf.getText()),
    );
  }
}

after(() => SourceTree.api.close());

describe('architecture', () => {
  test('generic helpers live once in src/shared and are not copied into the domain namespaces', () => {
    const rules: [string, RegExp][] = [
      ['a private copy of a Shared helper', /\bstatic\s+#?(?:parseUrl|isPotentiallyTrustworthy|isLoopbackHost|isIpAddress|bareHost|errorMessage|statusCodes|statuses|isRedacted|stripBom|decode|matchPath|asciiJson|setOwn)\s*\(|\bstatic\s+#(?:short|summary|parse)\s*\(\s*(?:value|problems|items)\b/],
      ['a safe URL parse or percent decode', /try\s*\{\s*return\s+(?:new URL|decodeURIComponent)\(/],
      ['the loopback host rules', /0:0:0:0:0:0:0:1|\b(?:LOOPBACK_NAMES|SECURE_SCHEMES)\s*[:=]|endsWith\('\.localhost'\)/],
      ['ASCII JSON serialization', /toAscii\(\s*(?:JSON\.stringify|Json\.prettyJson)\(/],
      ['byte order mark handling', /charCodeAt\(0\)\s*===\s*0xfeff/i],
      ['sorted unique response statuses', /new Set\(\s*\w+\.responses\.map\(/],
      ['in-band {{placeholder}} parsing', /\\\{\\\{\[a-z0-9_\]\+\\\}\\\}|hasPlaceholder/],
      ['digit-run word splitting (Text.letterWords)', /\.split\(\/\[0-9\]\+\/\)|\bstatic\s+#words\s*\(/],
      ['the request body media type table (Shared.RequestBodies)', /\b(?:MEDIA_RANGE|DEFAULT_MEDIA)\s*[:=]/],
    ];
    const found: string[] = [];
    for (const file of SourceTree.domainFiles()) {
      for (const [label, pattern] of rules) if (pattern.test(file.text)) found.push(`${file.path}: ${label}`);
    }
    assert.deepEqual(found, []);
  });

  test('no function body in a domain namespace repeats a public Shared function, whatever the names, its own class name or a Shared namespace prefix', () => {
    const shared: SharedBody[] = [];
    const sources = SourceTree.sources();
    for (const file of sources.filter((source) => SourceTree.domainOf(SourceTree.path(source)) === SourceTree.SHARED)) {
      SourceTree.visit(file, (node) => {
        const exported = isFunctionDeclaration(node) && SourceTree.hasModifier(node, SyntaxKind.ExportKeyword);
        const method = isMethodDeclaration(node) && SourceTree.hasModifier(node, SyntaxKind.StaticKeyword) && node.name.kind !== SyntaxKind.PrivateIdentifier;
        if (!(exported || method) || !SourceTree.functionLike(node)) return;
        const text = BodyFingerprint.of(node);
        if (text !== undefined) shared.push({ name: `${SourceTree.path(file)} ${node.name?.getText() ?? ''}`, text });
      });
    }
    const copies: string[] = [];
    for (const file of sources.filter((source) => SourceTree.isDomainCode(source))) {
      SourceTree.visit(file, (node) => {
        if (!SourceTree.functionLike(node)) return;
        const text = BodyFingerprint.of(node);
        const twin = text === undefined ? undefined : shared.find((body) => body.text === text);
        if (twin !== undefined) copies.push(`${SourceTree.where(node)} repeats ${twin.name}`);
      });
    }
    assert.ok(shared.length > 50, `only ${shared.length} Shared bodies were found`);
    assert.deepEqual(copies, []);
  });

  test('every class whose constructor takes collaborators or wires defaults has a static create() factory', () => {
    const missing: string[] = [];
    for (const file of SourceTree.sources()) {
      SourceTree.visit(file, (node) => {
        if (!isClassDeclaration(node) || SourceTree.hasModifier(node, SyntaxKind.AbstractKeyword)) return;
        const ctor = node.members.find((member) => isConstructorDeclaration(member));
        if (ctor === undefined || !isConstructorDeclaration(ctor)) return;
        const takesDeps = ctor.parameters.some((parameter) => parameter.name.getText() === 'deps' || /Deps\b/.test(parameter.type?.getText() ?? ''));
        let wires = false;
        if (ctor.body !== undefined) {
          SourceTree.visit(ctor.body, (inner) => {
            if (!isBinaryExpression(inner) || inner.operatorToken.kind !== SyntaxKind.EqualsToken || !inner.left.getText().startsWith('this.')) return;
            const value = SourceTree.unwrap(inner.right);
            if (isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.QuestionQuestionToken && isNewExpression(SourceTree.unwrap(value.right))) wires = true;
          });
        }
        if (!takesDeps && !wires) return;
        const create = node.members.some((member) => isMethodDeclaration(member) && member.name.getText() === 'create' && SourceTree.hasModifier(member, SyntaxKind.StaticKeyword));
        if (!create) missing.push(`${SourceTree.where(node)} ${node.name?.text ?? '(anonymous)'}`);
      });
    }
    assert.deepEqual(missing, []);
  });

  test('cross-domain imports, re-exports and dynamic imports go through the namespace barrels', () => {
    const deep: string[] = [];
    for (const file of SourceTree.sources()) {
      const path = SourceTree.path(file);
      const domain = SourceTree.domainOf(path);
      const check = (node: Node, specifier: Node | undefined): void => {
        if (specifier === undefined || !(isStringLiteral(specifier) || specifier.kind === SyntaxKind.NoSubstitutionTemplateLiteral)) return;
        const value = (specifier as Node & { readonly text: string }).text;
        if (!value.startsWith('.')) return;
        const target = posix.normalize(posix.join(posix.dirname(path), value));
        const nested = target.split('/').length > 2;
        if (nested && SourceTree.domainOf(target) !== domain && posix.basename(target) !== 'index.js') deep.push(`${SourceTree.where(node)}: ${value}`);
      };
      SourceTree.visit(file, (node) => {
        if (isImportDeclaration(node) || isExportDeclaration(node)) check(node, node.moduleSpecifier);
        else if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) check(node, node.arguments[0]);
        else if (node.kind === SyntaxKind.ImportType) {
          const argument = (node as Node & { readonly argument: Node & { readonly literal?: Node } }).argument;
          check(node, argument.literal);
        }
      });
    }
    assert.deepEqual(deep, []);
  });

  test('each source file exports at most one class', () => {
    const crowded: string[] = [];
    for (const file of SourceTree.sources()) {
      const classes = file.statements.filter((statement) => isClassDeclaration(statement) && SourceTree.hasModifier(statement, SyntaxKind.ExportKeyword));
      if (classes.length > 1) crowded.push(`${SourceTree.path(file)}: ${classes.length} exported classes`);
    }
    assert.deepEqual(crowded, []);
  });

  test('modules and classes keep no mutable state that other code can change', () => {
    const problems: string[] = [];
    const stateful = new Set<string>();
    const checked: { node: Node; label: string }[] = [];
    for (const file of SourceTree.sources()) {
      for (const statement of file.statements) {
        if (!isVariableStatement(statement)) continue;
        const list = statement.declarationList;
        if ((list.flags & 3) !== 2) {
          problems.push(`${SourceTree.where(statement)}: module-level let or var`);
          continue;
        }
        for (const declaration of list.declarations) {
          const init = declaration.initializer;
          if (init === undefined) continue;
          if (SourceTree.statefulRegex(init)) stateful.add(declaration.name.getText());
          const value = SourceTree.unwrap(init);
          if (SourceTree.isFreeze(init) || isArrowFunction(value) || isFunctionExpression(value) || isRegularExpressionLiteral(value)) continue;
          checked.push({ node: declaration.name, label: `${SourceTree.where(declaration)}: module-level ${declaration.name.getText()} is a mutable object; wrap it in Object.freeze` });
        }
      }
      SourceTree.visit(file, (node) => {
        if (!isPropertyDeclaration(node) || !SourceTree.hasModifier(node, SyntaxKind.StaticKeyword)) return;
        if (!SourceTree.hasModifier(node, SyntaxKind.ReadonlyKeyword)) problems.push(`${SourceTree.where(node)}: static ${node.name.getText()} is not readonly`);
        const owner = node.parent;
        if (SourceTree.statefulRegex(node.initializer) && isClassDeclaration(owner)) stateful.add(`${owner.name?.text ?? ''}.${node.name.getText()}`);
      });
    }
    const types = SourceTree.project.checker.getTypeAtLocation(checked.map((item) => item.node));
    checked.forEach((item, i) => {
      if (((types[i]?.flags ?? 0) & SourceTree.IMMUTABLE) === 0) problems.push(item.label);
    });
    for (const file of SourceTree.sources()) {
      SourceTree.visit(file, (node) => {
        if (!isPropertyAccessExpression(node) || !['test', 'exec', 'lastIndex'].includes(node.name.getText())) return;
        if (stateful.has(node.expression.getText())) problems.push(`${SourceTree.where(node)}: a shared /g or /y pattern keeps lastIndex between calls`);
      });
    }
    assert.deepEqual(problems, []);
  });

  test('source files are ASCII only and carry no comments', () => {
    const problems: string[] = [];
    for (const file of SourceTree.files()) if (/[^\x00-\x7f]/.test(file.text)) problems.push(`${file.path}: non-ASCII`);
    for (const file of SourceTree.sources()) {
      for (const offset of SourceTree.comments(file)) {
        const line = file.getLineStarts().filter((start) => start <= offset).length;
        problems.push(`${SourceTree.path(file)}:${line}: comment`);
      }
    }
    for (const file of [...SourceTree.files('test'), ...['README.md', 'package.json'].map((path) => ({ path, text: readFileSync(path, 'utf8') }))]) {
      if (/[^\x00-\x7f]/.test(file.text)) problems.push(`${file.path}: non-ASCII`);
    }
    assert.deepEqual(problems, []);
  });
});
