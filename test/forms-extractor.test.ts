import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import type { Browser } from 'playwright';
import type { FormDescriptor, FormField } from '../src/model/index.js';
import { FormExtractor, HtmlMicrosyntax, TokenDetector } from '../src/forms/index.js';
import { AppiiError, Samples } from '../src/shared/index.js';
import { startFixtureSite } from './fixtures/site.js';
import { PageServer } from './forms-harness.js';

const PAGE = 'https://example.com/dir/page.html?x=1#top';
const extractor = new FormExtractor();

function all(form: FormDescriptor | undefined): FormField[] {
  assert.ok(form, 'form exists');
  return [...form.fields, ...form.submitters].sort((a, b) => a.order - b.order);
}

function names(form: FormDescriptor | undefined): string[] {
  return all(form).map((field) => field.name);
}

function get(form: FormDescriptor | undefined, name: string): FormField {
  const found = all(form).find((field) => field.name === name);
  assert.ok(found, `field ${name} exists`);
  return found;
}

function selectorTarget(html: string, form: FormDescriptor): string | undefined {
  const $ = load(html);
  const matches = $(form.selector);
  assert.equal(matches.length, 1, `selector ${form.selector} is unique`);
  return matches.attr('data-i');
}

describe('FormExtractor on fixture pages', () => {
  test('login page: hidden token, labels, constraints, submitter and GET search form', async () => {
    const site = await startFixtureSite();
    try {
      const url = site.origin + '/login';
      const html = await (await fetch(url)).text();
      const forms = extractor.extract(html, url);
      assert.equal(forms.length, 2);
      const [login, search] = forms;
      assert.ok(login && search);
      assert.equal(login.index, 0);
      assert.equal(login.id, 'login');
      assert.equal(login.selector, 'form#login');
      assert.equal(login.pageUrl, url);
      assert.equal(login.action, site.origin + '/login');
      assert.equal(login.method, 'POST');
      assert.equal(login.enctype, 'application/x-www-form-urlencoded');
      assert.equal(login.noValidate, false);
      assert.deepEqual(login.tokenFields, ['csrf_token']);
      assert.deepEqual(names(login), ['csrf_token', 'email', 'password', 'remember', 'action']);
      const csrf = get(login, 'csrf_token');
      assert.equal(csrf.type, 'hidden');
      assert.match(csrf.value, /^[0-9a-f]{32}$/);
      assert.equal(csrf.label, undefined);
      const email = get(login, 'email');
      assert.deepEqual(
        { type: email.type, required: email.required, label: email.label, autocomplete: email.autocomplete, id: email.id, order: email.order },
        { type: 'email', required: true, label: 'Email', autocomplete: 'username', id: 'email', order: 1 },
      );
      const password = get(login, 'password');
      assert.equal(password.minLength, 8);
      assert.equal(password.label, 'Password');
      assert.equal(password.value, '');
      const remember = get(login, 'remember');
      assert.deepEqual(
        { type: remember.type, value: remember.value, checked: remember.checked, label: remember.label },
        { type: 'checkbox', value: 'yes', checked: false, label: 'Remember me' },
      );
      assert.equal(login.submitters.length, 1);
      const action = login.submitters[0];
      assert.deepEqual(
        { name: action?.name, kind: action?.kind, type: action?.type, value: action?.value, label: action?.label, formNoValidate: action?.formNoValidate },
        { name: 'action', kind: 'button', type: 'submit', value: 'login', label: 'Sign in', formNoValidate: false },
      );
      assert.equal(search.method, 'GET');
      assert.equal(search.action, site.origin + '/search');
      assert.equal(search.selector, ':root > body:nth-child(2) > form:nth-child(3)');
      assert.equal(load(html)(search.selector).attr('class'), 'search');
      const q = get(search, 'q');
      assert.deepEqual({ type: q.type, required: q.required, placeholder: q.placeholder }, { type: 'search', required: true, placeholder: 'Search' });
      assert.equal(search.submitters[0]?.name, '');
      assert.equal(search.submitters[0]?.label, 'Go');
    } finally {
      await site.close();
    }
  });

  test('signup page: multipart form with every constraint kind', async () => {
    const site = await startFixtureSite();
    try {
      const url = site.origin + '/signup';
      const html = await (await fetch(url)).text();
      const [signup] = extractor.extract(html, url);
      assert.ok(signup);
      assert.equal(signup.enctype, 'multipart/form-data');
      assert.deepEqual(signup.tokenFields, []);
      assert.deepEqual(signup.fields.map((field) => field.name), [
        'username', 'email', 'age', 'website', 'birthday', 'country', 'plan', 'plan', 'interests', 'bio', 'terms', 'avatar', 'locked',
        'disabled_field', 'readonly_field',
      ]);
      const username = get(signup, 'username');
      assert.equal(username.pattern, '[a-z0-9_]{3,16}');
      assert.equal(username.title, '3-16 lowercase letters, digits or underscore');
      assert.equal(username.label, username.title);
      const age = get(signup, 'age');
      assert.deepEqual({ type: age.type, min: age.min, max: age.max, step: age.step }, { type: 'number', min: '13', max: '120', step: '1' });
      const birthday = get(signup, 'birthday');
      assert.deepEqual({ min: birthday.min, max: birthday.max }, { min: '1900-01-01', max: '2026-12-31' });
      const country = get(signup, 'country');
      assert.equal(country.type, 'select-one');
      assert.equal(country.value, '');
      assert.equal(country.placeholder, 'Choose...');
      assert.deepEqual(country.options, [
        { value: '', label: 'Choose...', selected: true, disabled: false },
        { value: 'us', label: 'United States', selected: false, disabled: false },
        { value: 'ca', label: 'Canada', selected: false, disabled: false },
        { value: 'xx', label: 'Nowhere', selected: false, disabled: true },
      ]);
      const plans = signup.fields.filter((field) => field.name === 'plan');
      assert.deepEqual(plans.map((p) => [p.value, p.checked, p.label]), [['free', true, 'Free'], ['pro', false, 'Pro']]);
      const interests = get(signup, 'interests');
      assert.equal(interests.type, 'select-multiple');
      assert.equal(interests.multiple, true);
      assert.equal(interests.value, 'a');
      assert.deepEqual(interests.options?.map((o) => o.selected), [true, false, true]);
      const bio = get(signup, 'bio');
      assert.equal(bio.kind, 'textarea');
      assert.equal(bio.value, 'Hello\nworld');
      assert.equal(bio.maxLength, 200);
      assert.deepEqual([get(signup, 'terms').required, get(signup, 'terms').value], [true, 'on']);
      assert.equal(get(signup, 'avatar').accept, 'image/*');
      assert.equal(get(signup, 'locked').disabled, true);
      assert.equal(get(signup, 'disabled_field').disabled, true);
      assert.equal(get(signup, 'readonly_field').readOnly, true);
      assert.deepEqual(signup.submitters.map((s) => [s.name, s.value, s.formNoValidate, s.formAction]), [
        ['intent', 'create', false, undefined],
        ['intent', 'draft', true, site.origin + '/signup?draft=1'],
      ]);
    } finally {
      await site.close();
    }
  });
});

describe('FormExtractor on tricky markup', () => {
  test('form attribute wins over ancestry and controls outside forms join their owner in tree order', () => {
    const html = `<input name="early" form="b">
      <form id="a"><input name="inside"><input name="other" form="b"><input name="bad" form="missing"><input name="empty" form=""><input name="dup" form="dup"></form>
      <div id="dup"></div><form id="dup"></form>
      <input name="outside" form="a"><form id="b"><input name="b1"></form><input name="orphan">`;
    const forms = extractor.extract(html, PAGE);
    assert.equal(forms.length, 3);
    assert.deepEqual(names(forms[0]), ['inside', 'outside']);
    assert.deepEqual(all(forms[0]).map((field) => field.order), [0, 1]);
    assert.deepEqual(names(forms[1]), []);
    assert.deepEqual(names(forms[2]), ['early', 'other', 'b1']);
  });

  test('disabled fieldsets exempt only the first legend child, also when nested', () => {
    const html = `<form>
      <fieldset disabled>
        <legend><input name="legend1"><fieldset><input name="legend_nested"></fieldset></legend>
        <legend><input name="legend2"></legend>
        <input name="inner">
        <fieldset><legend><input name="nested_legend"></legend></fieldset>
      </fieldset>
      <fieldset><legend>Ok</legend><fieldset disabled><legend><input name="inner_ok"></legend><input name="inner_off"></fieldset></fieldset>
      <fieldset disabled><div><legend><input name="not_child_legend"></legend></div></fieldset>
      <input name="own" disabled>
    </form>`;
    const [form] = extractor.extract(html, PAGE);
    const disabled = Object.fromEntries(all(form).map((field) => [field.name, field.disabled]));
    assert.deepEqual(disabled, {
      legend1: false,
      legend_nested: false,
      legend2: true,
      inner: true,
      nested_legend: true,
      inner_ok: false,
      inner_off: true,
      not_child_legend: true,
      own: true,
    });
  });

  test('actions resolve against the first base href; empty and missing actions use the document URL', () => {
    const html = `<head><base target="_blank"><base href="https://cdn.example.org/app/"><base href="/second/"></head>
      <form action="submit"></form><form action=""></form><form></form><form action="  ../up?q=1#h  "></form>
      <form action="http://[bad"></form><form action="//other.example/p"></form>`;
    const forms = extractor.extract(html, PAGE);
    assert.deepEqual(forms.map((form) => form.action), [
      'https://cdn.example.org/app/submit',
      PAGE,
      PAGE,
      'https://cdn.example.org/up?q=1#h',
      'http://[bad',
      'https://other.example/p',
    ]);
    const relative = extractor.extract('<form action="next"></form>', PAGE);
    assert.equal(relative[0]?.action, 'https://example.com/dir/next');
  });

  test('method and enctype fall back to GET and urlencoded for invalid values', () => {
    const html = `<form method="PoSt" enctype="Multipart/Form-Data"></form><form method="put" enctype="application/json"></form>
      <form method="dialog" enctype="text/plain" novalidate accept-charset="utf-8" target="_self"></form>`;
    const forms = extractor.extract(html, PAGE);
    assert.deepEqual(forms.map((form) => [form.method, form.enctype, form.noValidate]), [
      ['POST', 'multipart/form-data', false],
      ['GET', 'application/x-www-form-urlencoded', false],
      ['DIALOG', 'text/plain', true],
    ]);
    assert.equal(forms[2]?.acceptCharset, 'utf-8');
    assert.equal(forms[2]?.target, '_self');
  });

  test('duplicate ids and names fall back to unique structural selectors', () => {
    const html = `<div id="wrap"><form id="x" data-i="0"></form><form id="X" data-i="1"></form></div>
      <section><form name="search" data-i="2"></form><p></p><form name="search" data-i="3"></form></section>
      <form id="solo" data-i="4"></form><form name="only" data-i="5"></form><form data-i="6"></form>
      <template><form id="solo2"></form></template><form id="solo2" data-i="7"></form>`;
    const forms = extractor.extract(html, PAGE);
    assert.equal(forms.length, 8);
    forms.forEach((form, i) => assert.equal(selectorTarget(html, form), String(i), form.selector));
    assert.equal(forms[0]?.selector, '#wrap > form:nth-child(1)');
    assert.equal(forms[2]?.selector, ':root > body:nth-child(2) > section:nth-child(2) > form:nth-child(1)');
    assert.equal(forms[4]?.selector, 'form#solo');
    assert.equal(forms[5]?.selector, 'form[name="only"]');
    assert.equal(forms[7]?.selector, ':root > body:nth-child(2) > form:nth-child(7)');
  });

  test('unknown and mixed-case input types normalize like the DOM type IDL', () => {
    const html = `<form><input type="DateTime" name="a"><input type="EMAIL" name="b"><input type="" name="c"><input name="d">
      <input type=" email" name="e"><input type="Submit" name="f"><input type="IMAGE" name="g"><input type="reset" name="h"><input type="button" name="i"></form>`;
    const [form] = extractor.extract(html, PAGE);
    assert.deepEqual(form?.fields.map((field) => [field.name, field.type]), [
      ['a', 'text'], ['b', 'email'], ['c', 'text'], ['d', 'text'], ['e', 'text'],
    ]);
    assert.deepEqual(form?.submitters.map((field) => [field.name, field.type, field.order]), [['f', 'submit', 5], ['g', 'image', 6]]);
  });

  test('options: text values, labels, disabled optgroups and selectedness', () => {
    const html = `<form>
      <select name="s1"><option>  Foo \n  Bar </option><option label="Lbl">text</option><option label="">fallback</option><option value=" raw ">x</option></select>
      <select name="s2"><optgroup label="g" disabled><option>no1</option><option>no2</option></optgroup><option>yes</option></select>
      <select name="s3"><option selected>a</option><option selected>b</option><option>c</option></select>
      <select name="s4" size="3"><option>a</option><option>b</option></select>
      <select name="s5" size="0"><option disabled>x</option><option>y</option></select>
      <select name="s6" multiple><option selected>a</option><option>b</option><option selected disabled>c</option></select>
      <select name="s7" multiple><option>a</option></select>
      <select name="s8"><option disabled>only</option></select>
      <select name="s9"><option>a<script>ignored()</script></option></select>
      <select name="s10" required><optgroup label="g"><option value="">In group</option></optgroup><option>z</option></select>
      <select name="s11" required size="2"><option value="">Pick</option><option>z</option></select>
      <select name="s12" required><option value="">Pick</option><option>z</option></select>
      <select name="s13"></select>
    </form>`;
    const [form] = extractor.extract(html, PAGE);
    const s1 = get(form, 's1');
    assert.deepEqual(s1.options?.map((o) => [o.value, o.label]), [['Foo Bar', 'Foo Bar'], ['text', 'Lbl'], ['fallback', 'fallback'], [' raw ', 'x']]);
    assert.equal(s1.value, 'Foo Bar');
    const s2 = get(form, 's2');
    assert.deepEqual(s2.options?.map((o) => [o.value, o.disabled, o.selected]), [['no1', true, false], ['no2', true, false], ['yes', false, true]]);
    assert.equal(s2.value, 'yes');
    assert.deepEqual(get(form, 's3').options?.map((o) => o.selected), [false, true, false]);
    assert.equal(get(form, 's3').value, 'b');
    assert.equal(get(form, 's4').value, '');
    assert.equal(get(form, 's5').value, 'y');
    assert.equal(get(form, 's6').value, 'a');
    assert.deepEqual(get(form, 's6').options?.map((o) => o.selected), [true, false, true]);
    assert.equal(get(form, 's7').value, '');
    assert.equal(get(form, 's8').value, '');
    assert.equal(get(form, 's9').value, 'a');
    assert.equal(get(form, 's10').placeholder, undefined);
    assert.equal(get(form, 's11').placeholder, undefined);
    assert.equal(get(form, 's12').placeholder, 'Pick');
    assert.deepEqual(get(form, 's13').options, []);
    assert.equal(get(form, 's13').value, '');
  });

  test('textarea drops exactly one leading newline and normalizes line breaks', () => {
    const html = `<form><textarea name="a">\nfirst</textarea><textarea name="b">\n\nsecond\r\nline</textarea><textarea name="c"></textarea><textarea name="d">&lt;b&gt;</textarea></form>`;
    const [form] = extractor.extract(html, PAGE);
    assert.deepEqual(form?.fields.map((field) => field.value), ['first', '\nsecond\nline', '', '<b>']);
    assert.ok(form?.fields.every((field) => field.kind === 'textarea' && field.type === 'textarea' && !field.hasValueAttribute));
  });

  test('multiple forms with the same name get distinct indices and selectors', () => {
    const html = `<form name="f" data-i="0"><input name="a"></form><form name="f" data-i="1"><input name="b"></form>`;
    const forms = extractor.extract(html, PAGE);
    assert.deepEqual(forms.map((form) => [form.index, form.name, names(form)]), [[0, 'f', ['a']], [1, 'f', ['b']]]);
    assert.notEqual(forms[0]?.selector, forms[1]?.selector);
    forms.forEach((form, i) => assert.equal(selectorTarget(html, form), String(i)));
  });

  test('value sanitization, checkedness and radio groups', () => {
    const html = `<form>
      <input name="t" value="a&#10;b"><input type="number" name="n" value="1e400"><input type="range" name="r" min="0" max="10" step="3" value="10">
      <input type="email" name="e" value=" x@y.z "><input type="color" name="c" value="#ABCDEF"><input type="file" name="f" value="x">
      <input type="checkbox" name="cb"><input type="checkbox" name="cb2" value="" checked>
      <input type="radio" name="r1" value="a" checked><input type="radio" name="r1" value="b" checked><input type="radio" name="r1" value="c">
      <input type="radio" name="" checked><input type="radio" name="" checked>
      <input type="hidden" name="h" value="  raw\n"><input type="checkbox" name="ro" readonly required><input type="range" name="rr" required>
    </form>`;
    const [form] = extractor.extract(html, PAGE);
    assert.equal(get(form, 't').value, 'ab');
    assert.equal(get(form, 'n').value, '');
    assert.equal(get(form, 'r').value, '9');
    assert.equal(get(form, 'e').value, 'x@y.z');
    assert.equal(get(form, 'c').value, '#abcdef');
    assert.equal(get(form, 'f').value, '');
    assert.deepEqual([get(form, 'cb').value, get(form, 'cb').checked, get(form, 'cb').hasValueAttribute], ['on', false, false]);
    assert.deepEqual([get(form, 'cb2').value, get(form, 'cb2').checked], ['', true]);
    assert.deepEqual(form?.fields.filter((field) => field.name === 'r1').map((field) => field.checked), [false, true, false]);
    assert.deepEqual(form?.fields.filter((field) => field.type === 'radio' && field.name === '').map((field) => field.checked), [true, true]);
    assert.equal(get(form, 'h').value, '  raw\n');
    assert.deepEqual([get(form, 'ro').readOnly, get(form, 'ro').required], [false, true]);
    assert.equal(get(form, 'rr').required, false);
  });

  test('attributes are kept only where they apply, with HTML integer parsing', () => {
    const html = `<form><input name="t" pattern="[a-z]+" min="1" maxlength="10abc" minlength=" 3" placeholder="p" dirname="t.dir" multiple>
      <input type="number" name="n" pattern="x" min="1" max="9" step="any" maxlength="4" placeholder="num">
      <input type="checkbox" name="c" placeholder="no" accept="x" dirname="c.dir"><input type="file" name="f" accept="image/png" multiple>
      <input type="email" name="e" multiple maxlength="-1"><textarea name="ta" minlength="2" dirname="ta.dir" placeholder="write"></textarea>
      <input type="hidden" name="h" dirname="h.dir" required><button name="b" dirname="b.dir">B</button>
      <input type="submit" name="s" dirname="s.dir"></form>`;
    const [form] = extractor.extract(html, PAGE);
    const t = get(form, 't');
    assert.deepEqual(
      [t.pattern, t.min, t.maxLength, t.minLength, t.placeholder, t.dirName, t.multiple],
      ['[a-z]+', undefined, 10, 3, 'p', 't.dir', false],
    );
    const n = get(form, 'n');
    assert.deepEqual([n.pattern, n.min, n.max, n.step, n.maxLength, n.placeholder], [undefined, '1', '9', 'any', undefined, 'num']);
    const c = get(form, 'c');
    assert.deepEqual([c.placeholder, c.accept, c.dirName], [undefined, undefined, undefined]);
    assert.deepEqual([get(form, 'f').accept, get(form, 'f').multiple], ['image/png', true]);
    assert.deepEqual([get(form, 'e').multiple, get(form, 'e').maxLength], [true, undefined]);
    assert.deepEqual([get(form, 'ta').minLength, get(form, 'ta').dirName, get(form, 'ta').placeholder], [2, 'ta.dir', 'write']);
    assert.deepEqual([get(form, 'h').dirName, get(form, 'h').required], ['h.dir', false]);
    assert.equal(get(form, 'b').dirName, undefined);
    assert.equal(get(form, 's').dirName, 's.dir');
  });

  test('labels: for attribute, wrapping label, aria-label, aria-labelledby, button text and title', () => {
    const html = `<div id="dupe">first</div>
      <form>
        <label for="a">Label A</label><input id="a" name="a">
        <label>Wrapped <span>text</span><input name="b"> tail <select name="other"><option>opt</option></select></label>
        <label for="h">Hidden label</label><input id="h" type="hidden" name="h">
        <label for="dupe">Dup</label><input id="dupe" name="dupe">
        <label for="c">One</label><label for="c">Two</label><input id="c" name="c">
        <label for="x"><input name="not_labelled"></label>
        <input name="aria" aria-label="  Aria   name ">
        <span id="l1">Part</span><span id="l2">two</span><input name="by" aria-labelledby="l1 missing l2">
        <input name="titled" title="Title text">
        <input name="none">
        <button name="btn"><b>Bold</b> button</button>
        <input type="submit" name="sub"><input type="submit" name="sub2" value="Send"><input type="image" name="img" alt="Picture">
        <label>Area <textarea name="ta">ignored text</textarea></label>
      </form>`;
    const [form] = extractor.extract(html, PAGE);
    const labels = Object.fromEntries(all(form).map((field) => [field.name, field.label]));
    assert.deepEqual(labels, {
      a: 'Label A',
      b: 'Wrapped text tail',
      other: undefined,
      h: undefined,
      dupe: undefined,
      c: 'One Two',
      not_labelled: undefined,
      aria: 'Aria name',
      by: 'Part two',
      titled: 'Title text',
      none: undefined,
      btn: 'Bold button',
      sub: 'Submit',
      sub2: 'Send',
      img: 'Picture',
      ta: 'Area',
    });
  });

  test('submitters: button types, commandfor, form overrides and image buttons', () => {
    const html = `<form action="/f" method="post">
      <button>Default</button><button type="reset" name="r">R</button><button type="button" name="b">B</button>
      <button commandfor="p" command="show-popover" name="cmd">Cmd</button><button type="submit" commandfor="p" name="explicit">E</button>
      <button name="go" value="1" formaction="" formmethod="BOGUS" formenctype="text/plain" formnovalidate>Go</button>
      <button name="alt" formaction="other?x=1" formmethod="post" formenctype="multipart/form-data">Alt</button>
      <input type="image" name="img" src="i.png" alt="Img" formaction="/img">
      <button name="off" disabled>Off</button>
    </form>`;
    const [form] = extractor.extract(html, PAGE);
    assert.deepEqual(form?.fields, []);
    assert.deepEqual(
      form?.submitters.map((s) => [s.name, s.kind, s.type, s.formAction, s.formMethod, s.formEnctype, s.formNoValidate, s.disabled]),
      [
        ['', 'button', 'submit', undefined, undefined, undefined, false, false],
        ['explicit', 'button', 'submit', undefined, undefined, undefined, false, false],
        ['go', 'button', 'submit', PAGE, 'GET', 'text/plain', true, false],
        ['alt', 'button', 'submit', 'https://example.com/dir/other?x=1', 'POST', 'multipart/form-data', false, false],
        ['img', 'input', 'image', 'https://example.com/img', undefined, undefined, false, false],
        ['off', 'button', 'submit', undefined, undefined, undefined, false, true],
      ],
    );
    assert.deepEqual(form?.submitters.map((s) => s.order), [0, 4, 5, 6, 7, 8]);
  });

  test('excludes template contents, foreign content, datalist descendants; includes forms in foreignObject', () => {
    const html = `<template><form><input name="tpl"></form></template>
      <form id="main"><datalist id="d"><option value="x"><input name="in_datalist"></datalist><input name="kept" list="d">
      <svg><input name="svg_input"></svg><object name="obj"></object><output name="out"></output><fieldset name="fs"></fieldset></form>
      <svg><foreignObject><form id="fo"><input name="fo_input"></form></foreignObject></svg>`;
    const forms = extractor.extract(html, PAGE);
    assert.deepEqual(forms.map((form) => form.id), ['main', 'fo']);
    assert.deepEqual(names(forms[0]), ['kept']);
    assert.equal(get(forms[0], 'kept').order, 1);
    assert.deepEqual(names(forms[1]), ['fo_input']);
  });

  test('password values are redacted unless explicitly revealed; token fields are detected', () => {
    const html = `<form><input type="password" name="pw" value="hunter2"><input type="password" name="empty">
      <input type="hidden" name="authenticity_token" value="t1"><input type="hidden" name="user[_token]" value="t2">
      <input type="hidden" name="csrf" value="t3" disabled><input type="text" name="csrf_text" value="t4"><input type="hidden" name="plain" value="p"></form>`;
    const [form] = extractor.extract(html, PAGE);
    assert.equal(get(form, 'pw').value, Samples.REDACTED);
    assert.equal(get(form, 'empty').value, '');
    assert.deepEqual(form?.tokenFields, ['authenticity_token', 'user[_token]']);
    const [revealed] = FormExtractor.create({ revealPasswords: true }).extract(html, PAGE);
    assert.equal(get(revealed, 'pw').value, 'hunter2');
  });

  test('collaborators can be substituted through the deps object', () => {
    class NoTokens extends TokenDetector {
      override isTokenField(): boolean {
        return false;
      }
    }
    const custom = new FormExtractor({ tokens: new NoTokens() });
    const [form] = custom.extract('<form><input type="hidden" name="csrf_token" value="x"></form>', PAGE);
    assert.deepEqual(form?.tokenFields, []);
  });

  test('invalid page URLs are rejected with a BAD_INPUT error', () => {
    assert.throws(() => extractor.extract('<form></form>', 'relative/page'), (err: unknown) => err instanceof AppiiError && err.code === 'BAD_INPUT');
  });

  test('documents without forms and fragments are handled', () => {
    assert.deepEqual(extractor.extract('', PAGE), []);
    assert.deepEqual(extractor.extract('<p>no forms</p><input name="loose">', PAGE), []);
    const [form] = extractor.extract('<form><input name=a>', PAGE);
    assert.deepEqual(names(form), ['a']);
  });
});

const TRICKY_HTML = `<!doctype html><html><head><title>tricky</title><base href="/base/dir/"></head><body>
<input name="before" form="f1" value="b">
<div id="dup"></div>
<form id="f1" action="submit/one" method="post">
  <input name="text1" value=" keep
 me">
  <input type="EMAIL" name="mail" value=" a@b.c ">
  <input type="email" multiple name="mails" value=" a@b.c , d@e.f ">
  <input type="url" name="site" value=" https://example.com/ ">
  <input type="number" name="n1" value="abc"><input type="number" name="n2" value="1e2"><input type="number" name="n3" value="-0">
  <input type="range" name="r1"><input type="range" name="r2" min="0" max="10" step="3" value="10"><input type="range" name="r3" step="7" value="-50">
  <input type="range" name="r4" min="0" max="1" step="0.1" value="0.3"><input type="range" name="r5" value="150" step="4"><input type="range" name="r6" min="-10" max="10" step="4" value="-8">
  <input type="range" name="r7" min="5" max="7" step="10"><input type="range" name="r8" min="0" max="100" step="0.3333"><input type="range" name="r9" min="0.5" max="2.5">
  <input type="date" name="d1" value="2020-02-30"><input type="date" name="d2" value="2024-02-29">
  <input type="datetime-local" name="dl" value="2020-01-01 10:00:00"><input type="datetime-local" name="dl2" value="2020-01-01T10:00:00.250">
  <input type="color" name="c1" value="#ABCDEF"><input type="color" name="c2" value="blue">
  <input type="time" name="t1" value="10:00:00.1234"><input type="time" name="t2" value="23:59:59.999">
  <input type="week" name="w1" value="2026-W53"><input type="week" name="w2" value="2027-W53">
  <input type="month" name="m1" value="2020-13"><input type="month" name="m2" value="2020-01">
  <input type="checkbox" name="cb" checked><input type="checkbox" name="cb2" value="">
  <input type="radio" name="rad" value="a" checked><input type="radio" name="rad" value="b" checked><input type="radio" name="rad" value="c">
  <input type="bogus" name="unknown" value="u">
  <input type="hidden" name="h" value=" raw
 value ">
  <input name="" value="unnamed"><input value="noname">
  <input type="file" name="upload" value="C:\\fakepath\\x">
  <input type="password" name="pw" value="hunter2">
  <input name="ml" maxlength="10abc" minlength=" 3"><input name="ml2" maxlength="-5" minlength="x">
  <textarea name="ta">

lead</textarea>
  <select name="s1"><option>  Foo   Bar </option><option value="v">V</option></select>
  <select name="s2"><optgroup label="g" disabled><option>no1</option><option>no2</option></optgroup><option label="Yes label">yes</option></select>
  <select name="s3"><option selected>a</option><option selected>b</option></select>
  <select name="s4" size="3"><option>a</option><option>b</option></select>
  <select name="s5" size="0"><option disabled>x</option><option>y</option></select>
  <select name="s6" multiple><option selected>a</option><option>b</option><option selected disabled>c</option></select>
  <select name="s7" required><option value="">Pick</option><option>z</option></select>
  <fieldset disabled>
    <legend><input name="legend1"><fieldset><input name="legend_nested"></fieldset></legend>
    <legend><input name="legend2"></legend>
    <input name="fs_inner">
  </fieldset>
  <fieldset><legend>ok</legend><fieldset disabled><legend><input name="inner_ok"></legend><input name="inner_off"></fieldset></fieldset>
  <datalist id="dl1"><option value="x"><input name="in_datalist"></datalist>
  <input name="ro" readonly value="r">
  <input name="dis" disabled value="d">
  <input name="other_form" form="f2">
  <input name="missing_form" form="nope">
  <input name="dup_form" form="dup">
  <label for="lab1">For label</label><input id="lab1" name="lab1">
  <label>Wrapped <input id="lab2" name="lab2"> tail</label>
  <button>Default</button>
  <button type="reset" name="rs">Reset</button>
  <button type="button" name="bt">Btn</button>
  <button commandfor="x" command="show-popover" name="cmd">Cmd</button>
  <button type="submit" name="go" value="1" formaction="" formmethod="BOGUS" formenctype="text/plain" formnovalidate>Go</button>
  <button name="alt" formaction="../alt?x=1" formmethod="dialog" formenctype="MULTIPART/FORM-DATA">Alt</button>
  <input type="submit" name="s_noval">
  <input type="image" name="img" alt="Image go" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
  <input type="reset" name="ir">
</form>
<form id="f2" name="dupname"><input name="f2field"></form>
<form name="dupname" action=""><table><tr><td><input name="in_table"></td></tr></table></form>
<form id="f1"><label>Label <select name="labelled"><option>opt text</option></select></label></form>
<form id="1 weird&quot;id" name="w&quot;n"><input name="weird"></form>
<form id="caf&#233;"><input name="accented"></form>
<template><form><input name="template_input"></form></template>
<input name="no_form">
<svg><foreignObject><form method="dialog"><input name="in_svg_fo"></form></foreignObject></svg>
</body></html>`;

interface LiveControl {
  formIndex: number;
  tag: string;
  name: string;
  type: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  inDatalist: boolean;
  minLength: number;
  maxLength: number;
  labels: string[];
  options?: { value: string; label: string; selected: boolean; disabled: boolean }[];
  formAction?: string;
  formMethod?: string;
  formEnctype?: string;
  formNoValidate?: boolean;
}

interface LiveForm {
  action: string;
  method: string;
  enctype: string;
}

describe('FormExtractor matches Chromium', () => {
  let browser: Browser | undefined;
  let server: PageServer | undefined;

  before(async () => {
    server = await PageServer.start();
    browser = await PageServer.launchBrowser();
  });

  after(async () => {
    await browser?.close();
    await server?.close();
  });

  async function live(url: string): Promise<{ forms: LiveForm[]; controls: LiveControl[]; content: string; url: string; selectors: (sel: string[]) => Promise<number[]>; close: () => Promise<void> }> {
    assert.ok(browser);
    const page = await browser.newPage();
    await page.goto(url);
    const data = await page.evaluate(() => {
      const forms = Array.from(document.forms);
      const controls = Array.from(document.querySelectorAll('input, select, textarea, button')).map((el) => {
        const control = el as unknown as {
          form: HTMLFormElement | null;
          getAttribute(name: string): string | null;
          type: string;
          value: string;
          checked: boolean;
          minLength: number;
          maxLength: number;
          labels: NodeListOf<HTMLLabelElement> | null;
          options: HTMLOptionsCollection;
          formAction: string;
          formMethod: string;
          formEnctype: string;
          formNoValidate: boolean;
        };
        const out: Record<string, unknown> = {
          formIndex: control.form ? forms.indexOf(control.form) : -1,
          tag: el.localName,
          name: control.getAttribute('name') ?? '',
          type: control.type,
          value: control.value,
          checked: el.localName === 'input' ? control.checked : false,
          disabled: el.matches(':disabled'),
          inDatalist: el.closest('datalist') !== null,
          minLength: 'minLength' in control ? control.minLength : -1,
          maxLength: 'maxLength' in control ? control.maxLength : -1,
          labels: control.labels ? Array.from(control.labels).map((label) => label.textContent ?? '') : [],
        };
        if (el.localName === 'select') {
          out.options = Array.from(control.options).map((option) => ({
            value: option.value,
            label: option.label,
            selected: option.selected,
            disabled: option.matches(':disabled'),
          }));
        }
        if (el.hasAttribute('formaction')) out.formAction = control.formAction;
        if (el.hasAttribute('formmethod')) out.formMethod = control.formMethod;
        if (el.hasAttribute('formenctype')) out.formEnctype = control.formEnctype;
        if (control.type === 'submit' || control.type === 'image') out.formNoValidate = control.formNoValidate;
        return out;
      });
      return { forms: forms.map((form) => ({ action: form.action, method: form.method, enctype: form.enctype })), controls };
    });
    return {
      forms: data.forms,
      controls: data.controls as unknown as LiveControl[],
      content: await page.content(),
      url: page.url(),
      selectors: (sels: string[]) =>
        page.evaluate((list) => list.map((sel) => {
          const found = document.querySelectorAll(sel);
          return found.length === 1 && found[0] instanceof HTMLFormElement ? Array.from(document.forms).indexOf(found[0]) : -1;
        }), sels),
      close: () => page.close(),
    };
  }

  function compare(descriptors: FormDescriptor[], state: { forms: LiveForm[]; controls: LiveControl[] }, lossyTextarea: boolean): void {
    assert.equal(descriptors.length, state.forms.length);
    descriptors.forEach((descriptor, index) => {
      const form = state.forms[index];
      assert.ok(form);
      assert.equal(descriptor.index, index);
      assert.equal(descriptor.action, form.action, `action of form ${index}`);
      assert.equal(descriptor.method, form.method.toUpperCase(), `method of form ${index}`);
      assert.equal(descriptor.enctype, form.enctype, `enctype of form ${index}`);
      const associated = state.controls.filter((control) => control.formIndex === index);
      const expected = associated
        .map((control, order) => ({ control, order }))
        .filter(({ control }) => {
          const inert = control.tag === 'button' ? control.type !== 'submit' : control.type === 'reset' || control.type === 'button';
          return !inert && !control.inDatalist;
        });
      const ours = all(descriptor);
      assert.deepEqual(ours.map((field) => field.order), expected.map((entry) => entry.order), `controls of form ${index}`);
      ours.forEach((field, i) => {
        const control = expected[i]?.control;
        assert.ok(control);
        const where = `${index}/${field.name || control.tag}`;
        assert.equal(field.name, control.name, where);
        assert.equal(field.type, control.type, where);
        assert.equal(field.checked, control.checked, where);
        assert.equal(field.disabled, control.disabled, where);
        if (field.type === 'password') assert.equal(field.value, control.value === '' ? '' : Samples.REDACTED, where);
        else if (!(lossyTextarea && field.kind === 'textarea' && control.value.startsWith('\n'))) assert.equal(field.value, control.value, where);
        if (['text', 'search', 'tel', 'url', 'email', 'password', 'textarea'].includes(field.type)) {
          assert.equal(field.minLength ?? -1, control.minLength, `${where} minLength`);
          assert.equal(field.maxLength ?? -1, control.maxLength, `${where} maxLength`);
        }
        if (control.options) assert.deepEqual(field.options, control.options, where);
        if (control.formAction !== undefined) assert.equal(field.formAction, control.formAction, where);
        if (control.formMethod !== undefined) assert.equal(field.formMethod?.toLowerCase(), control.formMethod, where);
        if (control.formEnctype !== undefined) assert.equal(field.formEnctype, control.formEnctype, where);
        if (control.formNoValidate !== undefined) assert.equal(field.formNoValidate, control.formNoValidate, where);
        if (/^lab\d$/.test(field.name)) assert.equal(field.label, HtmlMicrosyntax.collapse(control.labels.join(' ')), where);
      });
    });
  }

  test('form owners, types, sanitized values, disabled state, options and submitter overrides', async () => {
    assert.ok(server);
    const url = server.page('/a/b/tricky.html', TRICKY_HTML) + '?x=1#frag';
    const state = await live(url);
    try {
      compare(extractor.extract(TRICKY_HTML, state.url), state, false);
      const fromContent = extractor.extract(state.content, state.url);
      compare(fromContent, state, true);
      const resolved = await state.selectors(fromContent.map((form) => form.selector));
      assert.deepEqual(resolved, fromContent.map((form) => form.index));
      assert.ok(fromContent.some((form) => form.selector.includes('\\31 ')));
      assert.ok(fromContent.some((form) => form.selector === 'form#caf\\e9 '));
    } finally {
      await state.close();
    }
  });

  test('action, method and enctype of page.content() equal form.action/method/enctype for every base URL setup', async () => {
    assert.ok(server);
    const actions = [undefined, '', ' ', 'rel', '../up?q=1', '?only=query', '#frag', 'https://other.example/x', '//proto.example/y', '  spaced  ', 'javascript:void(0)', 'mailto:a@b.c', 'caf\u00e9?q=\u00fc'];
    const methods = ['post', 'GET', 'Dialog', 'bogus', undefined, 'PoSt'];
    const enctypes = ['multipart/form-data', 'TEXT/PLAIN', 'bogus', undefined, 'application/x-www-form-urlencoded'];
    const forms = actions
      .map((action, i) => {
        const attrs = [
          action === undefined ? '' : ` action="${action}"`,
          methods[i % methods.length] === undefined ? '' : ` method="${methods[i % methods.length]}"`,
          enctypes[i % enctypes.length] === undefined ? '' : ` enctype="${enctypes[i % enctypes.length]}"`,
        ].join('');
        return `<form${attrs}><input name="f${i}"></form>`;
      })
      .join('\n');
    const bases = ['', '<base href="/base/dir/">', '<base href="https://cdn.example.org/app/">', '<base target="x"><base href="sub/">', '<base href="data:text/html,x">'];
    for (const [i, base] of bases.entries()) {
      const html = `<!doctype html><html><head><meta charset="utf-8">${base}</head><body>${forms}</body></html>`;
      const url = server.page(`/p${i}/dir/page.html`, html) + '?a=1#h';
      const state = await live(url);
      try {
        for (const source of [html, state.content]) {
          const descriptors = extractor.extract(source, state.url);
          assert.deepEqual(
            descriptors.map((d) => [d.action, d.method, d.enctype]),
            state.forms.map((f) => [f.action, f.method.toUpperCase(), f.enctype]),
            `base setup ${i}`,
          );
        }
      } finally {
        await state.close();
      }
    }
  });
});
