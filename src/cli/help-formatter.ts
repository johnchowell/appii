import type { ParseArgsOptionDescriptor, ParseArgsOptionsConfig } from 'node:util';
import { Meta } from '../shared/index.js';
import type { Ansi } from '../shared/index.js';
import { TextLayout } from '../present/index.js';
import type { OptionDoc, OptionDocs } from './option-group.js';

export type HelpRow = readonly [term: string, description: string];

export interface HelpFormatterOptions {
  ansi: Ansi;
  width: number;
}

export interface HelpTopic {
  name: string;
  summary: string;
  usage: string;
  options: ParseArgsOptionsConfig;
  docs?: OptionDocs;
  examples?: readonly string[];
}

export interface HelpOptionSet {
  options: ParseArgsOptionsConfig;
  docs: OptionDocs;
}

export class HelpFormatter {
  static readonly INDENT = 2;
  static readonly GAP = 2;
  static readonly MAX_TERM_WIDTH = 30;
  static readonly MAX_COMMAND_WIDTH = 42;
  static readonly MIN_DESCRIPTION_WIDTH = 24;
  static readonly SHORT_PAD = '    ';
  static readonly SHORT_FLAG: RegExp = /^-[A-Za-z0-9], /;
  static readonly TAGLINE = 'turn a website into a usable API description';
  static readonly GLOBAL_ROWS: readonly HelpRow[] = [['--version', 'Print the version']];
  static readonly WORKFLOW: readonly HelpRow[] = [
    [`${Meta.APP_NAME} capture https://example.com`, 'Record the traffic while you browse the site'],
    [`${Meta.APP_NAME} build capture.json`, 'Infer endpoints, auth, cookies and form rules into api.json'],
    [`${Meta.APP_NAME} list api.json`, 'Review the endpoints, one endpoint in detail, or the cookies'],
    [`${Meta.APP_NAME} export api.json --format openapi`, 'Write an OpenAPI spec, a client, a script or a report'],
  ];

  readonly #ansi: Ansi;
  readonly #width: number;

  constructor(options: HelpFormatterOptions) {
    this.#ansi = options.ansi;
    this.#width = TextLayout.checkWidth(options.width);
  }

  static flags(name: string, config: ParseArgsOptionDescriptor, doc?: OptionDoc): string {
    if (doc?.flag !== undefined) return doc.flag;
    const short = config.short ? `-${config.short}, ` : '';
    const value = config.type === 'string' ? ` <${doc?.value ?? 'value'}>` : '';
    return `${short}--${name}${value}${config.multiple === true ? '...' : ''}`;
  }

  static optionRows(set: HelpOptionSet): HelpRow[] {
    return Object.entries(set.options).map(([name, config]): HelpRow => {
      const doc = set.docs[name];
      return [HelpFormatter.flags(name, config, doc), doc?.description ?? ''];
    });
  }

  static align(rows: readonly HelpRow[]): HelpRow[] {
    if (!rows.some(([flags]) => HelpFormatter.SHORT_FLAG.test(flags))) return [...rows];
    return rows.map(([flags, description]): HelpRow => [HelpFormatter.SHORT_FLAG.test(flags) ? flags : HelpFormatter.SHORT_PAD + flags, description]);
  }

  command(topic: HelpTopic, common: HelpOptionSet): string {
    const own: HelpOptionSet = { options: topic.options, docs: topic.docs ?? {} };
    const sections = [
      this.#title(`${Meta.APP_NAME} ${topic.name}`, topic.summary),
      this.section('Usage', this.#commands(topic.usage.split('\n'))),
    ];
    if (Object.keys(topic.options).length > 0) sections.push(this.section('Options', this.rows(HelpFormatter.align(HelpFormatter.optionRows(own)))));
    sections.push(this.section('Common options', this.rows(HelpFormatter.align(HelpFormatter.optionRows(common)))));
    if (topic.examples && topic.examples.length > 0) sections.push(this.section('Examples', this.#commands(topic.examples)));
    return sections.join('\n\n');
  }

  overview(topics: readonly HelpTopic[], common: HelpOptionSet, extra: readonly HelpRow[] = []): string {
    return [
      this.#title(`${Meta.APP_NAME} ${Meta.appVersion()}`, HelpFormatter.TAGLINE),
      this.section('Usage', this.#commands([`${Meta.APP_NAME} <command> [options]`])),
      this.section('Commands', this.rows(topics.map((topic) => [topic.name, topic.summary]))),
      this.section('Workflow', this.rows(HelpFormatter.WORKFLOW, HelpFormatter.MAX_COMMAND_WIDTH)),
      this.section('Common options', this.rows(HelpFormatter.align([...HelpFormatter.optionRows(common), ...extra]))),
      this.#wrap(`Run '${Meta.APP_NAME} help <command>' for the options of a command.`).join('\n'),
    ].join('\n\n');
  }

  section(title: string, lines: readonly string[]): string {
    return [this.#ansi.bold(`${title}:`), ...lines].join('\n');
  }

  rows(entries: readonly HelpRow[], maxTerm: number = HelpFormatter.MAX_TERM_WIDTH): string[] {
    if (entries.length === 0) return [];
    const indent = ' '.repeat(HelpFormatter.INDENT);
    const termWidth = Math.min(maxTerm, Math.max(...entries.map(([term]) => term.length)));
    const column = HelpFormatter.INDENT + termWidth + HelpFormatter.GAP;
    const room = this.#width - column;
    const lines: string[] = [];
    for (const [rawTerm, rawDescription] of entries) {
      const term = TextLayout.clean(rawTerm);
      const description = TextLayout.clean(rawDescription);
      if (room < HelpFormatter.MIN_DESCRIPTION_WIDTH) {
        lines.push(indent + term);
        const inner = HelpFormatter.INDENT * 2;
        if (description !== '') for (const piece of TextLayout.wrap(description, this.#width - inner)) lines.push(' '.repeat(inner) + piece);
        continue;
      }
      const pieces = description === '' ? [] : TextLayout.wrap(description, room);
      if (term.length > termWidth) {
        lines.push(indent + term);
        for (const piece of pieces) lines.push(' '.repeat(column) + piece);
        continue;
      }
      const [first, ...rest] = pieces;
      lines.push(first === undefined ? indent + term : indent + term.padEnd(termWidth + HelpFormatter.GAP) + first);
      for (const piece of rest) lines.push(' '.repeat(column) + piece);
    }
    return lines.map((line) => TextLayout.fit(line, this.#width));
  }

  #title(name: string, summary: string): string {
    return this.#wrap(`${this.#ansi.bold(name)} - ${summary}`, `${name} - ${summary}`).join('\n');
  }

  #commands(lines: readonly string[]): string[] {
    const indent = ' '.repeat(HelpFormatter.INDENT);
    const continued = ' '.repeat(HelpFormatter.INDENT * 2);
    return lines.flatMap((line) =>
      TextLayout.wrap(TextLayout.clean(line), Math.max(1, this.#width - HelpFormatter.INDENT * 2)).map((piece, i) => (i === 0 ? indent : continued) + piece),
    );
  }

  #wrap(styled: string, plain: string = styled): string[] {
    if (plain.length <= this.#width) return [styled];
    return TextLayout.wrap(TextLayout.clean(plain), this.#width);
  }
}
