import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { Curl, ShellScript, Text } from '../src/shared/index.js';

function bash(command: string): Promise<string> {
  return new Promise<string>((resolve, reject) =>
    execFile('bash', ['-c', command], { env: { LANG: 'C' } }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );
}

describe('ShellScript', () => {
  test('ascii encodes non-ASCII characters per quoting context', () => {
    assert.equal(ShellScript.ascii("echo 'caf\u00e9'"), "echo 'caf'$'\\303\\251'''");
    assert.equal(ShellScript.ascii('echo "caf\u00e9"'), `echo "caf"$'\\303\\251'""`);
    assert.equal(ShellScript.ascii('echo caf\u00e9'), "echo caf$'\\303\\251'");
    assert.equal(ShellScript.ascii('echo \\\u00e9'), "echo $'\\303\\251'");
    assert.equal(ShellScript.ascii('echo "\\\u00e9"'), `echo "\\\\"$'\\303\\251'""`);
    assert.equal(ShellScript.ascii("echo '\\' \u00e9"), "echo '\\' $'\\303\\251'");
  });

  test('indent only indents lines that start outside quotes', () => {
    assert.equal(ShellScript.indent("curl 'a\nb' \\\n  -x", 2), "  curl 'a\nb' \\\n    -x");
    assert.equal(ShellScript.indent('x "a\\\nb"\ny', 2), '  x "a\\\nb"\n  y');
  });

  test('the encoded strings evaluate to the original bytes in bash', async () => {
    const value = "a'b\"c\u00e9 \u{1F600} $x `y` \\z\nnext";
    const command = ShellScript.ascii(`printf '%s' ${Text.shellQuote(value)}`);
    assert.ok(Text.isAscii(command));
    assert.equal(await bash(command), value);
  });

  test('ascii encodes control characters other than line feed, so the text is printable ASCII', async () => {
    assert.equal(ShellScript.ascii("echo 'a\tb'"), "echo 'a'$'\\011''b'");
    assert.equal(ShellScript.ascii('echo "a\rb"'), `echo "a"$'\\015'"b"`);
    assert.equal(ShellScript.ascii("echo 'a\x7fb'"), "echo 'a'$'\\177''b'");
    assert.equal(ShellScript.ascii("echo 'a\nb'"), "echo 'a\nb'");
    const value = 'tab\tcr\rbell\x07esc\x1b[31mdel\x7f nul-free \u00e9\nend';
    const command = ShellScript.ascii(`printf '%s' ${Text.shellQuote(value)} "x\ty"`);
    assert.ok(Text.isAscii(command));
    assert.ok(!/[\x00-\x09\x0b-\x1f\x7f]/.test(command), command);
    assert.equal(await bash(command), value + 'x\ty');
  });

  test('oneLine joins a multi-line definition into one line that bash runs the same way', async () => {
    assert.equal(ShellScript.oneLine(['f() {', '  if true; then', '    echo a', '  else', '    echo b', '  fi', '  for x in 1 2; do', '    case $x in', '      1) echo one ;;', '      *) echo other ;;', '    esac', '  done', '}']), 'f() { if true; then echo a; else echo b; fi; for x in 1 2; do case $x in 1) echo one ;; *) echo other ;; esac; done; }');
    for (const encoding of ['component', 'form', 'json'] as const) {
      const lines = Curl.encoderHelper(encoding);
      const value = 'a "b" \\c\nd\te &=+/ \u00e9 \u007f';
      const multi = await bash(`${lines.join('\n')}\nV=${Text.shellQuote(value)}; ${Curl.ENCODING_HELPERS[encoding]} V`);
      const single = await bash(`${Curl.encoderDefinition(encoding)}; V=${Text.shellQuote(value)}; ${Curl.ENCODING_HELPERS[encoding]} V`);
      assert.equal(single, multi, encoding);
      assert.ok(!Curl.encoderDefinition(encoding).includes('\n'));
    }
  });
});
