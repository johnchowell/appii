import type { CookieRole } from '../model/index.js';

export interface CookieRule {
  role: CookieRole;
  pattern: RegExp;
}

export class CookieClassifier {
  static readonly PREFIX: RegExp = /^__(?:host|secure)-/i;
  static readonly RULES: readonly CookieRule[] = [
    { role: 'csrf', pattern: /csrf|xsrf|request-?verification-?token|anti-?forgery/i },
    {
      role: 'tracking',
      pattern:
        /^(?:_ga(?:_.+)?|_gid|_gat(?:_.+)?|_gcl_.+|__utm[a-z]+|_fbp|_fbc|ajs_.+|mp_.+|_hj.+|amplitude.*|amp_.+|_uetsid|_uetvid|_clck|_clsk|_pk_.+|_ttp|_tt_.+|_scid.*|_pin_unauth|__hssc|__hstc|__hssrc|hubspotutk|_mkto_trk|optimizely.+|_dc_gtm_.+|_rdt_uuid|muid|_li_.+|li_sugr|li_gc|bcookie|bscookie|_parsely.+|_sp_id.*|_sp_ses.*|__qca|_derived_epik|ide|test_cookie|_vwo.+|_vis_opt.+|_dd_s|intercom-.+)$/i,
    },
    {
      role: 'session',
      pattern:
        /^(?:sid|sess|sessid|session|sessionid|session_id|session-id|_session|_session_id|connect\.sid|phpsessid|jsessionid|asp\.net_sessionid|aspsessionid[a-z]*|cfid|cftoken|express:sess|koa:sess|koa\.sess|__session|.+[_.-]session(?:[_-]?id)?|.+[_-]sess(?:id)?)$/i,
    },
    {
      role: 'auth',
      pattern:
        /^(?:auth|auth[_-]?token|authtoken|token|jwt|access[_-]?token|refresh[_-]?token|id[_-]?token|remember|remember[_-].+|rememberme|logged[_-]?in|login|identity|bearer|api[_-]?key|.+[_-]auth|auth[_-].+|.+[_-]token|next-auth\..+)$/i,
    },
    {
      role: 'preference',
      pattern:
        /^(?:theme|color[_-]?scheme|dark[_-]?mode|lang|language|locale|i18n.*|next_locale|consent|cookieconsent.*|cookie[_-]?consent.*|cookielawinfo.*|optanon.+|euconsent.*|tz|timezone|currency|country|region|prefs?|preferences|ui[_-].+|sidebar.*|font[_-]?size|dismissed.*)$/i,
    },
  ];

  classify(name: string): CookieRole {
    const bare = name.replace(CookieClassifier.PREFIX, '');
    return CookieClassifier.RULES.find((rule) => rule.pattern.test(bare))?.role ?? 'unknown';
  }
}
