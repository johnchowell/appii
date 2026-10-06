import type { ApiModel } from '../model/index.js';
import { Text } from '../shared/index.js';

export class CurlSessionScript {
  static readonly JAR_VARIABLE = 'APPII_COOKIE_JAR';
  static readonly JAR_DEFAULT = 'appii_default_cookie_jar';
  static readonly JAR_SUFFIX = '-cookies.txt';
  static readonly JAR_HELPER = 'appii_jar';
  static readonly COOKIE_HELPER = 'appii_cookie';
  static readonly DECODE_HELPER = 'appii_unpct';
  static readonly PAGE_HELPER = 'appii_page';
  static readonly SCAN_HELPER = 'appii_html';
  static readonly TOKEN_HELPER = 'appii_token';
  static readonly HELPERS: readonly string[] = Object.freeze(['appii_jar', 'appii_cookie', 'appii_unpct', 'appii_page', 'appii_html', 'appii_token']);
  static readonly DOCUMENT_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  static readonly FETCHED_SOURCES: ReadonlySet<string> = new Set(['hidden-field', 'meta', 'response']);
  static readonly SCANNER = String.raw`function hexval(h,   i, c, v) { v = 0; h = tolower(h); if (h == "") return -1; for (i = 1; i <= length(h); i++) { c = index("0123456789abcdef", substr(h, i, 1)) - 1; if (c < 0) return -1; v = v * 16 + c } return v }
function utf8(cp) {
  if (cp < 0 || cp > 1114111) return "?"
  if (cp < 128) return sprintf("%c", cp)
  if (cp < 2048) return sprintf("%c%c", 192 + int(cp / 64), 128 + cp % 64)
  if (cp < 65536) return sprintf("%c%c%c", 224 + int(cp / 4096), 128 + int(cp / 64) % 64, 128 + cp % 64)
  return sprintf("%c%c%c%c", 240 + int(cp / 262144), 128 + int(cp / 4096) % 64, 128 + int(cp / 64) % 64, 128 + cp % 64)
}
function decode(s,   out, i, j, ent, cp) {
  out = ""
  while ((i = index(s, "&")) > 0) {
    out = out substr(s, 1, i - 1); s = substr(s, i + 1); j = index(s, ";"); cp = -1
    if (j > 1 && j <= 10) {
      ent = substr(s, 1, j - 1)
      if (ent ~ /^#[xX][0-9a-fA-F]+$/) cp = hexval(substr(ent, 3))
      else if (ent ~ /^#[0-9]+$/) cp = substr(ent, 2) + 0
      else if (ent == "amp") cp = 38
      else if (ent == "lt") cp = 60
      else if (ent == "gt") cp = 62
      else if (ent == "quot") cp = 34
      else if (ent == "apos") cp = 39
    }
    if (cp >= 0) { out = out utf8(cp); s = substr(s, j + 1) } else out = out "&"
  }
  return out s
}
function closing(t,   i, n, c, q, eq) {
  n = length(t); q = ""; eq = 0
  for (i = 1; i <= n; i++) {
    c = substr(t, i, 1)
    if (q != "") { if (c == q) q = ""; continue }
    if (eq && (c == "\"" || c == "\047")) { q = c; eq = 0; continue }
    if (c == ">") return i
    if (c == "=") eq = 1
    else if (c !~ /[ \t\n\r\f]/) eq = 0
  }
  return 0
}
function attributes(t,   n, i, j, c, name, value, q) {
  split("", A); n = length(t); i = 1
  while (i <= n && substr(t, i, 1) !~ /[ \t\n\r\f\/>]/) i++
  while (i <= n) {
    c = substr(t, i, 1)
    if (c == ">") break
    if (c ~ /[ \t\n\r\f\/]/) { i++; continue }
    name = c; i++
    while (i <= n && substr(t, i, 1) !~ /[ \t\n\r\f\/>=]/) { name = name substr(t, i, 1); i++ }
    while (i <= n && substr(t, i, 1) ~ /[ \t\n\r\f]/) i++
    value = ""
    if (substr(t, i, 1) == "=") {
      i++
      while (i <= n && substr(t, i, 1) ~ /[ \t\n\r\f]/) i++
      q = substr(t, i, 1)
      if (q == "\"" || q == "\047") {
        j = index(substr(t, i + 1), q)
        if (j == 0) { value = substr(t, i + 1); i = n + 1 } else { value = substr(t, i + 1, j - 1); i += j + 1 }
      } else {
        while (i <= n && substr(t, i, 1) !~ /[ \t\n\r\f>]/) { value = value substr(t, i, 1); i++ }
      }
    }
    name = tolower(name)
    if (!(name in A)) A[name] = decode(value)
  }
}
function json(s, key,   i, e, c, rest, out) {
  while ((i = index(s, "\"" key "\"")) > 0) {
    s = substr(s, i + length(key) + 2); rest = s
    sub(/^[ \t\r\n]*/, "", rest)
    if (substr(rest, 1, 1) != ":") continue
    rest = substr(rest, 2); sub(/^[ \t\r\n]*/, "", rest)
    if (substr(rest, 1, 1) != "\"") continue
    out = ""; i = 2
    while (i <= length(rest)) {
      c = substr(rest, i, 1)
      if (c == "\"") return out
      if (c == "\\") {
        e = substr(rest, i + 1, 1)
        if (e == "u") { out = out utf8(hexval(substr(rest, i + 2, 4))); i += 6; continue }
        out = out (e == "n" ? "\n" : e == "t" ? "\t" : e == "r" ? "\r" : e == "b" ? "\b" : e == "f" ? "\f" : e); i += 2; continue
      }
      out = out c; i++
    }
    return ""
  }
  return ""
}
function scan(html, kind, want,   n, k, part, t, tag, raw, end, rest) {
  n = split(html, P, "<"); raw = ""
  for (k = 2; k <= n; k++) {
    part = P[k]
    if (raw != "") {
      if (tolower(substr(part, 1, length(raw) + 1)) == "/" raw && substr(part, length(raw) + 2, 1) ~ /^([ \t\n\r\f\/>]|)$/) raw = ""
      continue
    }
    if (substr(part, 1, 3) == "!--") {
      rest = substr(part, 4)
      while (index(rest, "-->") == 0 && k < n) { k++; rest = rest "<" P[k] }
      continue
    }
    if (part !~ /^[A-Za-z]/) continue
    t = part
    while (closing(t) == 0 && k < n) { k++; t = t "<" P[k] }
    end = closing(t); if (end > 0) t = substr(t, 1, end)
    tag = tolower(t); sub(/[ \t\n\r\f\/>].*$/, "", tag)
    if (tag ~ /^(script|style|textarea|title|xmp|iframe|noembed|noframes)$/) { raw = tag; continue }
    if (kind == "input" && tag == "input") { attributes(t); if (A["name"] == want && ("value" in A) && A["value"] != "") return A["value"] }
    if (kind == "meta" && tag == "meta") { attributes(t); if (tolower(A["name"]) == tolower(want) && ("content" in A)) return A["content"] }
  }
  return ""
}
function headers(text,   end, sep, block, lines, m, i, c, hn, hv) {
  split("", H)
  while (text ~ /^HTTP\/[0-9.]+ [0-9][0-9][0-9]/) {
    end = index(text, "\r\n\r\n"); sep = 4
    if (end == 0 || (index(text, "\n\n") > 0 && index(text, "\n\n") < end)) { end = index(text, "\n\n"); sep = 2 }
    if (end == 0) { block = text; text = "" } else { block = substr(text, 1, end - 1); text = substr(text, end + sep) }
    split("", H); m = split(block, lines, "\n")
    for (i = 2; i <= m; i++) {
      sub(/\r$/, "", lines[i]); c = index(lines[i], ":")
      if (c == 0) continue
      hn = tolower(substr(lines[i], 1, c - 1)); hv = substr(lines[i], c + 1); sub(/^[ \t]+/, "", hv); sub(/[ \t]+$/, "", hv)
      if (!(hn in H)) H[hn] = hv
    }
  }
  return text
}
BEGIN { RS = "\001"; mode = ENVIRON["appii_mode"]; want = ENVIRON["appii_want"] }
{ body = (NR == 1) ? $0 : body "\001" $0 }
END {
  if (mode == "input" || mode == "meta") value = scan(body, mode, want)
  else {
    body = headers(body)
    value = H[tolower(want)]
    if (value == "") value = json(body, want)
    if (value == "") value = scan(body, "input", want)
    if (value == "") value = scan(body, "meta", want)
  }
  printf "%s", value
}`;

  static jarFile(model: ApiModel): string {
    return (Text.kebabCase(model.name) || 'api') + CurlSessionScript.JAR_SUFFIX;
  }

  static jarLines(model: ApiModel): string[] {
    const variable = CurlSessionScript.JAR_VARIABLE;
    return [`${CurlSessionScript.JAR_DEFAULT}="$(pwd)"/${Text.shellQuote(CurlSessionScript.jarFile(model))}`, `${variable}="\${${variable}:-$${CurlSessionScript.JAR_DEFAULT}}"`];
  }

  static helpers(cookieVariable: string): string[] {
    const jar = CurlSessionScript.JAR_VARIABLE;
    return [
      `${CurlSessionScript.JAR_HELPER}() {`,
      `  if [[ -z "$${jar}" ]]; then printf '%s\\n' '${jar} is empty: set it to the file of the cookie jar.' >&2; return 2; fi`,
      `  [[ ! -e "$${jar}" ]] || return 0`,
      `  if ! (umask 077 && : > "$${jar}") 2>/dev/null; then printf 'Cannot create the cookie jar %s: set ${jar} to a file that you can write.\\n' "$${jar}" >&2; return 2; fi`,
      '}',
      '',
      `${CurlSessionScript.COOKIE_HELPER}() {`,
      "  local wanted=\"$1\" pair name appii_line appii_value=''",
      '  local -a pairs=() appii_fields=()',
      `  IFS=';' read -r -a pairs <<< "$${cookieVariable}" || true`,
      '  for pair in "${pairs[@]+"${pairs[@]}"}"; do',
      '    pair="${pair#"${pair%%[![:space:]]*}"}"',
      '    name="${pair%%=*}"',
      '    if [[ "$pair" == *=* && "$name" == "$wanted" ]]; then',
      "      printf '%s' \"${pair#*=}\"",
      '      return 0',
      '    fi',
      '  done',
      `  [[ -r "$${jar}" ]] || return 0`,
      '  while IFS= read -r appii_line || [[ -n "$appii_line" ]]; do',
      "    appii_line=\"${appii_line%$'\\r'}\"",
      "    if [[ \"$appii_line\" == '#HttpOnly_'* ]]; then",
      "      appii_line=\"${appii_line#'#HttpOnly_'}\"",
      "    elif [[ -z \"$appii_line\" || \"$appii_line\" == '#'* ]]; then",
      '      continue',
      '    fi',
      "    IFS=$'\\t' read -r -a appii_fields <<< \"$appii_line\" || true",
      '    if [[ "${appii_fields[5]-}" == "$wanted" ]]; then appii_value="${appii_fields[6]-}"; fi',
      `  done < "$${jar}"`,
      "  printf '%s' \"$appii_value\"",
      '}',
      '',
      `${CurlSessionScript.DECODE_HELPER}() {`,
      "  local appii_text=\"$1\" appii_bad='%([^0-9A-Fa-f]|.[^0-9A-Fa-f]|.?$)'",
      '  if [[ "$appii_text" == *%* && "$appii_text" != *\\\\* && ! "$appii_text" =~ $appii_bad ]]; then',
      "    printf '%b' \"${appii_text//%/\\\\x}\"",
      '  else',
      "    printf '%s' \"$appii_text\"",
      '  fi',
      '}',
      '',
      `${CurlSessionScript.PAGE_HELPER}() {`,
      '  local appii_url="$1"',
      '  shift',
      `  ${CurlSessionScript.JAR_HELPER} || return 2`,
      `  curl -sS -L --compressed -H ${Text.shellQuote(`Accept: ${CurlSessionScript.DOCUMENT_ACCEPT}`)} -b "$${cookieVariable}" -b "$${jar}" -c "$${jar}" "$@" "$appii_url"`,
      '}',
      '',
      `${CurlSessionScript.SCAN_HELPER}() {`,
      `  appii_mode="$1" appii_want="$2" LC_ALL=C awk '`,
      ...CurlSessionScript.SCANNER.split('\n'),
      "'",
      '}',
      '',
      `${CurlSessionScript.TOKEN_HELPER}() {`,
      '  case "$1" in',
      `    hidden-field) ${CurlSessionScript.PAGE_HELPER} "$3" | ${CurlSessionScript.SCAN_HELPER} input "$2" ;;`,
      `    meta) ${CurlSessionScript.PAGE_HELPER} "$3" | ${CurlSessionScript.SCAN_HELPER} meta "$2" ;;`,
      `    response) ${CurlSessionScript.PAGE_HELPER} "$3" -i | ${CurlSessionScript.SCAN_HELPER} response "$2" ;;`,
      '  esac',
      '}',
    ];
  }
}
