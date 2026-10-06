export class HtmlReportAssets {
  static readonly CSS = String.raw`:root {
  color-scheme: light dark;
  --bg: #fcfcfb;
  --surface: #ffffff;
  --surface-2: #f3f2ee;
  --text: #0b0b0b;
  --muted: #52514e;
  --border: #e2e0da;
  --accent: #2a78d6;
  --accent-ink: #ffffff;
  --param: #8a3fb8;
  --good: #0ca30c;
  --info: #2a78d6;
  --warning: #c98500;
  --critical: #d03b3b;
  --get: #0f7b0f;
  --post: #b4501c;
  --put: #256abf;
  --patch: #6a4fc8;
  --delete: #c02f2f;
  --other: #52514e;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141413;
    --surface: #1a1a19;
    --surface-2: #262624;
    --text: #f4f3ef;
    --muted: #c3c2b7;
    --border: #383835;
    --accent: #3987e5;
    --accent-ink: #0b0b0b;
    --param: #c79bea;
    --good: #2bb52b;
    --info: #3987e5;
    --warning: #fab219;
    --critical: #e66767;
    --get: #3fb53f;
    --post: #e8834f;
    --put: #5598e7;
    --patch: #9085e9;
    --delete: #e66767;
    --other: #a5a49b;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--sans); }
a { color: var(--accent); }
code, pre, .mono { font-family: var(--mono); font-size: 13px; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 16px; }
header.top { background: var(--surface); border-bottom: 1px solid var(--border); padding: 24px 0 16px; }
header.top h1 { margin: 0 0 4px; font-size: 26px; line-height: 1.2; word-break: break-word; }
.sub { margin: 0 0 16px; color: var(--muted); }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0 0 16px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; word-break: break-all; }
.stats { display: flex; flex-wrap: wrap; gap: 12px; list-style: none; margin: 0; padding: 0; }
.stats li { background: var(--surface-2); border-radius: 8px; padding: 8px 14px; min-width: 110px; }
.stats .value { display: block; font-size: 22px; font-weight: 600; }
.stats .label { color: var(--muted); font-size: 13px; }
nav.toc { padding: 12px 0; display: flex; flex-wrap: wrap; gap: 16px; }
section { margin: 24px 0 40px; }
h2 { font-size: 20px; margin: 0 0 12px; }
h3 { font-size: 15px; margin: 18px 0 8px; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
figure.chart { margin: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; min-width: 0; }
figure.chart figcaption { font-weight: 600; margin-bottom: 10px; }
.bars { list-style: none; margin: 0; padding: 0; }
.bar-row { display: grid; grid-template-columns: minmax(0, 42%) 1fr 3.5em; gap: 8px; align-items: center; padding: 3px 0; }
.bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--muted); }
.bar-track { height: 14px; }
.bar { display: block; height: 14px; min-width: 2px; border-radius: 0 4px 4px 0; background: var(--accent); }
.bar.tone-2xx { background: var(--good); }
.bar.tone-3xx { background: var(--info); }
.bar.tone-4xx { background: var(--warning); }
.bar.tone-5xx { background: var(--critical); }
.bar.tone-other { background: var(--other); }
.bar-value { text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; }
.empty { color: var(--muted); font-style: italic; }
.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.filters input, .filters select { font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; }
.filters input { flex: 1 1 260px; min-width: 0; }
#count { color: var(--muted); }
ol.endpoints { list-style: none; margin: 0; padding: 0; }
li.endpoint { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 8px; }
li.endpoint[hidden] { display: none; }
li.endpoint > details > summary { cursor: pointer; padding: 10px 12px; display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; list-style: none; }
li.endpoint > details > summary::-webkit-details-marker { display: none; }
li.endpoint > details[open] > summary { border-bottom: 1px solid var(--border); }
.num { color: var(--muted); font-variant-numeric: tabular-nums; min-width: 2.2em; }
.method { display: inline-block; min-width: 4.6em; text-align: center; border-radius: 5px; padding: 1px 6px; font: 600 12px/1.6 var(--mono); color: #ffffff; background: var(--other); }
.method.get { background: var(--get); }
.method.post { background: var(--post); }
.method.put { background: var(--put); }
.method.patch { background: var(--patch); }
.method.delete { background: var(--delete); }
@media (prefers-color-scheme: dark) { .method { color: #0b0b0b; } }
.path { font-family: var(--mono); word-break: break-all; flex: 1 1 240px; min-width: 0; }
.path .param { color: var(--param); font-weight: 600; }
.path .origin { color: var(--muted); }
.name { color: var(--muted); font-family: var(--mono); font-size: 13px; overflow-wrap: anywhere; min-width: 0; }
.badge { display: inline-block; border: 1px solid var(--border); border-radius: 999px; padding: 0 8px; font-size: 12px; color: var(--muted); white-space: nowrap; }
.badge.auth { border-color: var(--accent); color: var(--accent); }
.badge.csrf { border-color: var(--warning); color: var(--text); }
.badge.status-2xx { border-color: var(--good); }
.badge.status-4xx { border-color: var(--warning); }
.badge.status-5xx { border-color: var(--critical); }
.hits { margin-left: auto; color: var(--muted); font-size: 13px; white-space: nowrap; }
.detail { padding: 12px 14px 16px; }
.detail dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 0; }
.detail dl.meta dt { color: var(--muted); }
.detail dl.meta dd { margin: 0; word-break: break-all; }
.scroll { overflow-x: auto; max-width: 100%; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-weight: 600; white-space: nowrap; }
td code { overflow-wrap: anywhere; }
p.variables { color: var(--muted); overflow-wrap: anywhere; }
pre { background: var(--surface-2); border-radius: 8px; padding: 10px 12px; overflow: auto; max-height: 420px; margin: 6px 0; white-space: pre; }
details.raw > summary { cursor: pointer; color: var(--accent); margin: 6px 0; }
.copy-block { position: relative; }
.copy { position: absolute; top: 6px; right: 6px; font: inherit; font-size: 12px; border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
footer { color: var(--muted); font-size: 13px; padding: 24px 0 40px; border-top: 1px solid var(--border); }
@media (max-width: 640px) {
  body { font-size: 14px; }
  header.top h1 { font-size: 21px; }
  .facts, .detail dl.meta { grid-template-columns: 1fr; }
  .facts dd, .detail dl.meta dd { margin-bottom: 6px; }
  .bar-row { grid-template-columns: minmax(0, 38%) 1fr 3em; }
  .hits { margin-left: 0; }
  .stats li { flex: 1 1 40%; }
}`;

  static readonly SCRIPT = String.raw`(function () {
  var search = document.getElementById('q');
  var method = document.getElementById('method');
  var kind = document.getElementById('kind');
  var count = document.getElementById('count');
  var items = Array.prototype.slice.call(document.querySelectorAll('li.endpoint'));
  function apply() {
    var text = search ? search.value.trim().toLowerCase() : '';
    var m = method ? method.value : '';
    var k = kind ? kind.value : '';
    var shown = 0;
    items.forEach(function (item) {
      var ok = (!text || item.getAttribute('data-search').indexOf(text) !== -1) &&
        (!m || item.getAttribute('data-method') === m) &&
        (!k || item.getAttribute('data-kind') === k);
      item.hidden = !ok;
      if (ok) shown++;
    });
    if (count) count.textContent = shown + ' of ' + items.length + ' endpoints';
  }
  [search, method, kind].forEach(function (control) {
    if (control) control.addEventListener('input', apply);
  });
  document.addEventListener('click', function (event) {
    var button = event.target && event.target.closest ? event.target.closest('button.copy') : null;
    if (!button) return;
    var target = document.getElementById(button.getAttribute('data-target'));
    if (!target) return;
    var text = target.textContent || '';
    var done = function () {
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = 'Copy'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {});
    } else {
      var range = document.createRange();
      range.selectNodeContents(target);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  });
  apply();
})();`;
}
