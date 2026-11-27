import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { MAX_RETAINED_ANOMALIES, parseJUnitXml, type JUnitXmlParseResult } from '../../src/gate/adapters/junit-xml.ts';

const root = new URL('../../', import.meta.url);
const MAX_BYTES = 16 * 1024 * 1024;

interface S9Scenario {
  readonly scenario: string;
  readonly exitCode: number;
  readonly xmlMissing?: boolean;
  readonly xmlSample?: string;
  readonly suiteAttributes?: ReadonlyArray<Record<string, string>>;
  readonly cases?: ReadonlyArray<{ classname: string | null; name: string | null; statuses: string[] }>;
}
interface S9Evidence {
  readonly results: S9Scenario[];
}
const evidence = JSON.parse(await readFile(new URL('docs/evidence/s9-python-pytest.json', root), 'utf8')) as S9Evidence;

function countsAttrs(tests: number, failures = 0, errors = 0, skipped = 0): string {
  return `tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}"`;
}

function wrap(body: string, attrs = countsAttrs(1)): string {
  return `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" ${attrs}>${body}</testsuite></testsuites>`;
}

function expectRejected(input: string | Uint8Array, needle: string): JUnitXmlParseResult {
  const result = parseJUnitXml(input);
  assert.equal(result.ok, false, needle);
  assert.equal(result.tests, 0);
  assert.equal(result.failures, 0);
  assert.equal(result.errors, 0);
  assert.deepEqual(result.counts, { pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0, suites: 0, tests: 0 });
  assert.ok(result.anomalies.some((anomaly) => anomaly.includes(needle)), `${needle} in ${JSON.stringify(result.anomalies)}`);
  return result;
}

// ---------------------------------------------------------------------------
// S9 authentic artifacts (docs/evidence/s9-python-pytest.json)
// ---------------------------------------------------------------------------

test('PY-04: all 11 authentic S9 XML samples recount exactly as recorded', () => {
  const withXml = evidence.results.filter((entry): entry is S9Scenario & { xmlSample: string } => typeof entry.xmlSample === 'string');
  assert.equal(withXml.length, 11, 'S9 must contribute exactly 11 XML samples');
  for (const scenario of withXml) {
    const cases = scenario.cases ?? [];
    const expectedFailures = cases.filter((entry) => entry.statuses.includes('failure')).length;
    const expectedErrors = cases.filter((entry) => entry.statuses.includes('error')).length;
    const expectedSkipped = cases.filter((entry) => entry.statuses.includes('skipped')).length;
    const expectedTests = cases.length;
    const declared = scenario.suiteAttributes?.[0] ?? {};
    const result = parseJUnitXml(scenario.xmlSample);

    assert.equal(result.tests, expectedTests, scenario.scenario);
    assert.equal(result.failures, expectedFailures, scenario.scenario);
    assert.equal(result.errors, expectedErrors, scenario.scenario);
    assert.deepEqual(result.counts, {
      pass: expectedTests - expectedFailures - expectedErrors - expectedSkipped,
      fail: expectedFailures + expectedErrors,
      skipped: expectedSkipped,
      todo: 0,
      cancelled: 0,
      suites: scenario.suiteAttributes?.length ?? 1,
      tests: expectedTests,
    }, scenario.scenario);
    assert.equal(Number(declared.failures ?? 0), expectedFailures, scenario.scenario);
    assert.equal(Number(declared.errors ?? 0), expectedErrors, scenario.scenario);
    assert.equal(Number(declared.skipped ?? 0), expectedSkipped, scenario.scenario);
    if (scenario.scenario === 'interrupt') {
      // Authentic inconsistent XML: suite tests="0" but one empty testcase exists.
      assert.notEqual(Number(declared.tests ?? 0), expectedTests);
      assert.equal(result.ok, false);
      assert.ok(result.anomalies.some((anomaly) => anomaly.startsWith('count_mismatch:testsuite[0].tests')), scenario.xmlSample);
    } else {
      assert.equal(Number(declared.tests ?? 0), expectedTests, `${scenario.scenario}: declared tests match recount`);
    }

    if (scenario.scenario === 'no_tests') {
      assert.equal(result.ok, false);
      assert.deepEqual(result.anomalies, ['no_tests']);
    } else if (scenario.scenario !== 'interrupt') {
      assert.equal(result.ok, true, `${scenario.scenario}: ${JSON.stringify(result.anomalies)}`);
      assert.deepEqual(result.anomalies, []);
    }
  }
});

test('PY-04: S9 scenarios that produced no XML cannot manufacture counts', () => {
  const missing = evidence.results.filter((entry) => entry.xmlMissing === true).map((entry) => entry.scenario).sort();
  assert.deepEqual(missing, ['internal_error', 'usage_error']);
  for (const scenario of missing) expectRejected('', 'missing_root');
});

// ---------------------------------------------------------------------------
// Accepted xunit2 shapes
// ---------------------------------------------------------------------------

test('PY-04: multiple suites aggregate and keep statuses exclusive', () => {
  const xml = `<?xml version="1.0"?>
    <testsuites name="pytest tests" ${countsAttrs(4, 1, 1, 1)}>
      <testsuite name="a" ${countsAttrs(2, 1, 0, 0)}>
        <testcase classname="test_a" name="passes" time="0.001" />
        <testcase classname="test_a" name="fails" time="0.002">
          <failure message="boom">assert 1 == 2 &amp; &gt; &lt; &#65; &#x41; &#x1F600; 中文 \uFFFD 😀 <!--status note-->tail</failure>
        </testcase>
      </testsuite>
      <testsuite name="b" ${countsAttrs(2, 0, 1, 1)}>
        <testcase classname="test_b" name="errors"><error type="RuntimeError" message="fixture boom" /></testcase>
        <testcase classname="test_b" name="skips"><skipped type="pytest.xfail" message="expected" /></testcase>
      </testsuite>
    </testsuites>`;
  const result = parseJUnitXml(xml);
  assert.equal(result.ok, true, JSON.stringify(result.anomalies));
  assert.deepEqual(result.counts, { pass: 1, fail: 2, skipped: 1, todo: 0, cancelled: 0, suites: 2, tests: 4 });
  assert.equal(result.tests, 4);
  assert.equal(result.failures, 1);
  assert.equal(result.errors, 1);
  assert.deepEqual(result.anomalies, []);
});

test('PY-04: a bare testsuite root is accepted and cross-checked', () => {
  const result = parseJUnitXml(`<testsuite name="solo" ${countsAttrs(1)}><testcase name="t" /></testsuite>`);
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, { pass: 1, fail: 0, skipped: 0, todo: 0, cancelled: 0, suites: 1, tests: 1 });
});

test('PY-04: BOM, CRLF, declaration, comments, tabs and single quotes are valid payload', () => {
  const xml = '\uFEFF<?xml version="1.0" encoding="utf-8"?>\r\n'
    + '<!-- leading -->\r\n'
    + '<testsuites>\r\n'
    + '\t<testsuite name=\'pytest\' ' + countsAttrs(1) + '>\r\n'
    + '\t\t<!-- inner -->\r\n'
    + '\t\t<testcase classname="test_sample" name="test_pass" time="0.000" />\r\n'
    + '\t</testsuite>\r\n'
    + '</testsuites>\r\n'
    + '<!-- trailing -->\r\n';
  const result = parseJUnitXml(xml);
  assert.equal(result.ok, true, JSON.stringify(result.anomalies));
  assert.equal(result.counts.pass, 1);
});

test('PY-04: valid non-count payload is ignored, including CDATA and multiline text', () => {
  const xml = wrap(`
    <properties><property name="env" value="s9">ignored &amp; text</property><property name="empty" /></properties>
    <testcase classname="test_sample" name="test_pass">
      <system-out><![CDATA[stdout with <xml> & raw ]]></system-out>
      <system-err>line one
line two &lt;tag&gt;</system-err>
    </testcase>
    <testcase name="with_out"><system-out /><system-err /></testcase>
    <system-out>suite out</system-out>
    <system-err />
    <properties />
  `, countsAttrs(2));
  const result = parseJUnitXml(xml);
  assert.equal(result.ok, true, JSON.stringify(result.anomalies));
  assert.equal(result.tests, 2);
  assert.equal(result.counts.pass, 2);
});

test('PY-04: an empty or self-closing testsuites document never counts as success', () => {
  for (const xml of ['<testsuites />', '<testsuites></testsuites>', '<testsuites><testsuite ' + countsAttrs(0) + ' /></testsuites>']) {
    const result = parseJUnitXml(xml);
    assert.equal(result.ok, false);
    assert.deepEqual(result.anomalies, ['no_tests']);
    assert.equal(result.tests, 0);
  }
  const bareSuite = parseJUnitXml(`<testsuite ${countsAttrs(0)} />`);
  assert.equal(bareSuite.ok, false);
  assert.deepEqual(bareSuite.anomalies, ['no_tests']);
});

test('PY-04: count attributes accept plain decimal integers including leading zeros', () => {
  const result = parseJUnitXml(`<testsuite ${countsAttrs(1)}><testcase name="t" /></testsuite>`.replace('tests="1"', 'tests="01"'));
  assert.equal(result.ok, true, JSON.stringify(result.anomalies));
  assert.equal(result.counts.tests, 1);
});

test('PY-04: comments and whitespace-only CDATA are valid at container level', () => {
  const result = parseJUnitXml(wrap('<!-- note --><![CDATA[ \n\t ]]><testcase name="t" />'));
  assert.equal(result.ok, true, JSON.stringify(result.anomalies));
  assert.equal(result.counts.pass, 1);
});

test('PY-04: a suite may declare only tests, leaving other aggregates absent', () => {
  const result = parseJUnitXml('<testsuite tests="1"><testcase name="t" /></testsuite>');
  assert.equal(result.ok, true, JSON.stringify(result.anomalies));
  assert.equal(result.counts.tests, 1);
});

test('PY-04: attributes may be absent; only present aggregate claims are cross-checked', () => {
  const result = parseJUnitXml('<testsuite><testcase name="t" /></testsuite>');
  assert.equal(result.ok, true);
  assert.equal(result.counts.pass, 1);
});

test('PY-04: partial root aggregate attributes are checked without inventing missing ones', () => {
  const result = parseJUnitXml(`<testsuites tests="1" failures="0"><testsuite ${countsAttrs(1)}><testcase name="t" /></testsuite></testsuites>`);
  assert.equal(result.ok, true, JSON.stringify(result.anomalies));
});

test('PY-04: XML declaration variants are limited to the initial one', () => {
  for (const xml of [
    `<?xml?><testsuite ${countsAttrs(1)}><testcase name="t" /></testsuite>`,
    `<testsuite ${countsAttrs(1)}><testcase name="t" /></testsuite>`,
  ]) {
    const result = parseJUnitXml(xml);
    assert.equal(result.ok, true, JSON.stringify(result.anomalies));
  }
});

test('PY-04: Uint8Array input is decoded as strict UTF-8 and BOMs are stripped', () => {
  const body = `<testsuite ${countsAttrs(1)}><testcase name="t" /></testsuite>`;
  const plain = new TextEncoder().encode(body);
  const withBom = new Uint8Array([0xEF, 0xBB, 0xBF, ...plain]);
  assert.equal(parseJUnitXml(plain).ok, true);
  assert.equal(parseJUnitXml(withBom).ok, true);
});

// ---------------------------------------------------------------------------
// Size and depth limits (ADR-014 §4.4)
// ---------------------------------------------------------------------------

test('PY-04: exactly 16 MiB is accepted and one byte more is rejected', () => {
  const head = '<testsuites><testsuite ' + countsAttrs(1) + '><testcase name="t" /></testsuite>';
  const tail = '</testsuites>';
  const padding = MAX_BYTES - Buffer.byteLength(head + tail, 'utf8');
  assert.ok(padding > 0);
  const boundary = head + ' '.repeat(padding) + tail;
  assert.equal(Buffer.byteLength(boundary, 'utf8'), MAX_BYTES);
  assert.equal(parseJUnitXml(boundary).ok, true);

  expectRejected(boundary + ' ', 'input_too_large');
  expectRejected(new Uint8Array(MAX_BYTES + 1), 'input_too_large');
});

test('PY-04: depth 64 is parsed and depth 65 is rejected', () => {
  const chain = (levels: number): string => '<testsuites>' + '<x>'.repeat(levels - 1) + '</x>'.repeat(levels - 1) + '</testsuites>';
  const atLimit = parseJUnitXml(chain(64));
  assert.equal(atLimit.ok, false);
  assert.ok(atLimit.anomalies.some((anomaly) => anomaly.includes('unsupported_element')), JSON.stringify(atLimit.anomalies));

  const overLimit = parseJUnitXml(chain(65));
  assert.equal(overLimit.ok, false);
  assert.ok(overLimit.anomalies.some((anomaly) => anomaly.includes('depth_exceeded')), JSON.stringify(overLimit.anomalies));
});

// ---------------------------------------------------------------------------
// Bounded retention on pathological input (16 MiB class)
// ---------------------------------------------------------------------------

test('PY-04: anomaly retention stops at the cap and summarizes the dropped remainder', () => {
  const suites = (count: number): string => '<testsuites>' + Array.from(
    { length: count },
    (_, index) => `<testsuite name="s${index}" tests="2"><testcase name="t" /></testsuite>`,
  ).join('') + '</testsuites>';

  const atCap = parseJUnitXml(suites(MAX_RETAINED_ANOMALIES));
  assert.equal(atCap.ok, false);
  assert.equal(atCap.anomalies.length, MAX_RETAINED_ANOMALIES);
  assert.equal(atCap.anomalies[MAX_RETAINED_ANOMALIES - 1], `count_mismatch:testsuite[${MAX_RETAINED_ANOMALIES - 1}].tests:declared=2:actual=1`);

  const overCap = parseJUnitXml(suites(MAX_RETAINED_ANOMALIES + 5));
  assert.equal(overCap.ok, false);
  assert.equal(overCap.anomalies.length, MAX_RETAINED_ANOMALIES + 1);
  assert.equal(overCap.anomalies[0], 'count_mismatch:testsuite[0].tests:declared=2:actual=1');
  assert.equal(overCap.anomalies[MAX_RETAINED_ANOMALIES], `anomaly_cap_reached:kept=${MAX_RETAINED_ANOMALIES}:dropped=5`);
  // Aggregates are unaffected by the diagnostic cap.
  assert.equal(overCap.counts.suites, MAX_RETAINED_ANOMALIES + 5);
  assert.equal(overCap.counts.tests, MAX_RETAINED_ANOMALIES + 5);
  assert.equal(overCap.counts.pass, MAX_RETAINED_ANOMALIES + 5);
});

test('PY-04: hundreds of thousands of empty suites keep exact aggregates and one anomaly', () => {
  const suites = 200_000;
  const suite = '<testsuite name="pytest" tests="0" failures="0" errors="0" skipped="0"/>';
  const xml = `<testsuites>${suite.repeat(suites)}</testsuites>`;
  assert.ok(Buffer.byteLength(xml, 'utf8') < MAX_BYTES, 'fixture stays inside the 16 MiB input ceiling');

  const result = parseJUnitXml(xml);
  assert.equal(result.ok, false);
  assert.deepEqual(result.anomalies, ['no_tests']);
  assert.deepEqual(result.counts, { pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0, suites, tests: 0 });
  // Suites are folded into totals as they close: the returned value stays
  // aggregate-sized instead of carrying one record per suite.
  assert.ok(JSON.stringify(result).length < 512, JSON.stringify(result));
});

test('PY-04: forged counts across hundreds of thousands of suites stay capped and fail closed', () => {
  const suites = 200_000;
  // One forged `tests` claim per suite: without the cap this retains 200k
  // diagnostic strings; with it only the first MAX_RETAINED_ANOMALIES survive.
  const xml = `<testsuites>${'<testsuite tests="2"/>'.repeat(suites)}</testsuites>`;
  assert.ok(Buffer.byteLength(xml, 'utf8') < MAX_BYTES, 'fixture stays inside the 16 MiB input ceiling');

  const result = parseJUnitXml(xml);
  assert.equal(result.ok, false);
  assert.equal(result.counts.suites, suites);
  assert.equal(result.tests, 0);
  assert.equal(result.counts.pass, 0);
  assert.equal(result.counts.fail, 0);
  assert.equal(result.anomalies.length, MAX_RETAINED_ANOMALIES + 1);
  assert.equal(result.anomalies[0], 'count_mismatch:testsuite[0].tests:declared=2:actual=0');
  assert.equal(result.anomalies[MAX_RETAINED_ANOMALIES - 1], `count_mismatch:testsuite[${MAX_RETAINED_ANOMALIES - 1}].tests:declared=2:actual=0`);
  // 200k forged claims plus `no_tests`, minus the retained prefix.
  assert.equal(result.anomalies[MAX_RETAINED_ANOMALIES], `anomaly_cap_reached:kept=${MAX_RETAINED_ANOMALIES}:dropped=${suites + 1 - MAX_RETAINED_ANOMALIES}`);
  assert.ok(JSON.stringify(result).length < 8192, `payload=${JSON.stringify(result).length}`);
});

// ---------------------------------------------------------------------------
// Structural rejection
// ---------------------------------------------------------------------------

test('PY-04: unknown elements are rejected, not silently ignored', () => {
  expectRejected('<foo />', 'unsupported_element');
  expectRejected('<testsuites><properties /></testsuites>', 'unsupported_element');
  expectRejected(wrap('<failure message="wrong place">x</failure>'), 'unsupported_element');
  expectRejected(wrap('<testcase name="t"><property name="p" /></testcase>'), 'unsupported_element');
  expectRejected(wrap('<testcase name="t"><failure><nested /></failure></testcase>'), 'unsupported_element');
  expectRejected(wrap('<properties><other /></properties><testcase name="t" />'), 'unsupported_element');
});

test('PY-04: unknown subtrees are fully consumed before rejection (well-formedness still enforced)', () => {
  expectRejected('<foo a="1">text &amp; <!--c--><![CDATA[cd]]><bar><baz /></bar>tail</foo>', 'unsupported_element');
  expectRejected('<testsuites><foo>', 'unclosed_foo');
  expectRejected('<testsuites><foo></foo></testsuites>', 'unsupported_element');
  expectRejected('<testsuites><foo><!--unterminated</foo></testsuites>', 'unterminated_comment');
  expectRejected('<testsuites><foo><![CDATA[x</foo></testsuites>', 'unterminated_cdata');
});

test('PY-04: document structure errors are fail-closed', () => {
  expectRejected('', 'missing_root');
  expectRejected('   \r\n\t ', 'missing_root');
  expectRejected('hello', 'expected_element');
  expectRejected('<testsuites /><second />', 'trailing_content');
  expectRejected('<testsuites />junk', 'trailing_content');
  expectRejected('<!ELEMENT testsuites ANY><testsuites />', 'declaration');
  expectRejected('<!doctype testsuites><testsuites />', 'declaration');
});

test('PY-04: malformed tags and attributes are rejected', () => {
  expectRejected('<>', 'element_name');
  expectRejected('<1suite />', 'element_name');
  expectRejected('<testsuite', 'unterminated_tag');
  expectRejected('<testsuite name="a"', 'unterminated_tag');
  expectRejected('<testsuite / >', 'self_close');
  expectRejected('<testsuite name="a"name="b" />', 'missing_attribute_separator');
  expectRejected('<testsuite name "a" />', 'attribute_value');
  expectRejected('<testsuite name=unquoted />', 'unquoted_attribute');
  expectRejected('<testsuite name="<bad" />', 'attribute_lt');
  expectRejected('<testsuite name="unterminated />', 'unterminated_attribute');
  expectRejected('<testsuite name="a" name="b" />', 'duplicate_attribute');
  expectRejected('<testsuite name="a"></testsuites>', 'mismatched_tag');
  expectRejected('<testsuite name="a"></testsuite junk>', 'close_tag');
  expectRejected('<testsuite name="a"><testcase name="t"></testsuite>', 'mismatched_tag');
  expectRejected('<testsuite name="a">junk</testsuite>', 'unexpected_text');
  expectRejected('<testsuite name="a">junk', 'unexpected_text');
  expectRejected('<testsuite name="a">   ', 'unclosed_testsuite');
  expectRejected('<testsuite name="a"><![CDATA[junk]]></testsuite>', 'unexpected_text');
  expectRejected('<testsuite name="a"><!--unterminated</testsuite>', 'unterminated_comment');
  expectRejected('<testsuite name="a"><!-- bad -- comment --></testsuite>', 'comment_dashes');
  expectRejected('<testsuite name="a"><testcase name="t"><![CDATA[x</testcase></testsuite>', 'unterminated_cdata');
  expectRejected('<testsuite name="a"><testcase name="t"><failure>', 'unclosed_failure');
  expectRejected('<testsuite name="a">', 'unclosed_testsuite');
  expectRejected('<testsuite name="a"><testcase name="t"><failure><nested></failure></testcase></testsuite>', 'mismatched_tag');
});

test('PY-04: entity references outside the XML predefined/numeric set are rejected', () => {
  const cases: Array<[string, string]> = [
    ['&amp', 'unterminated_entity'],
    ['&;', 'empty_entity'],
    ['&#;', 'invalid_entity'],
    ['&#x;', 'invalid_entity'],
    ['&#xG;', 'invalid_entity'],
    ['&#1A;', 'invalid_entity'],
    ['&#0;', 'invalid_entity'],
    ['&#xD800;', 'invalid_entity'],
    ['&#x110000;', 'invalid_entity'],
    ['&#99999999999999999999;', 'invalid_entity'],
    ['&nbsp;', 'unknown_entity'],
  ];
  for (const [entity, needle] of cases) expectRejected(wrap(`<testcase name="t"><failure>${entity}</failure></testcase>`), needle);
  expectRejected('<testsuite name="&nbsp;">', 'unknown_entity');
  expectRejected('<testsuite>&amp;</testsuite>', 'unexpected_text');
});

test('PY-04: invalid characters and invalid UTF-8 are rejected', () => {
  expectRejected('<testsuite name="a"><testcase name="t"><failure>\u0000</failure></testcase></testsuite>', 'control:U+0000');
  expectRejected('<testsuite name="del"><testcase name="t"><failure>\u007F</failure></testcase></testsuite>', 'control:U+007F');
  expectRejected('<testsuite name="noncharacter"><testcase name="t"><failure>\uFFFE</failure></testcase></testsuite>', 'noncharacter:U+FFFE');
  expectRejected('\uD800', 'lone_high_surrogate');
  expectRejected('\uD800\uE000', 'lone_high_surrogate');
  expectRejected('x\uDC00', 'lone_low_surrogate');
  expectRejected('y\uE000', 'expected_element');
  expectRejected(new Uint8Array([0x3C, 0xFF, 0x3E]), 'invalid_utf8');
});

test('PY-04: processing instructions and DOCTYPE/ENTITY declarations are rejected', () => {
  expectRejected('<?xml-stylesheet href="x"?><testsuites />', 'processing_instruction');
  expectRejected('<testsuites><?pi data?></testsuites>', 'processing_instruction');
  expectRejected('<testsuites><?xml version="1.0"?></testsuites>', 'processing_instruction');
  expectRejected(' \n<?xml version="1.0"?><testsuites />', 'processing_instruction');
  expectRejected('<?xml version="1.0"', 'xml_declaration');
  expectRejected('<?xml < ?><testsuites />', 'xml_declaration');
  expectRejected('<?xml version="1.0"?><!DOCTYPE testsuites [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><testsuites />', 'doctype');
  expectRejected('<!DOCTYPE testsuites><testsuites />', 'doctype');
  expectRejected('<!ENTITY xxe "boom"><testsuites />', 'entity_declaration');
});

test('PY-04: count attributes reject fractional, negative, non-finite and unsafe values', () => {
  for (const value of ['-1', '1.5', 'NaN', 'Infinity', '9007199254740992', '', '+1', '1e3']) {
    expectRejected(`<testsuite name="a" tests="${value}" />`, 'invalid_count');
  }
});

test('PY-04: forged suite count attributes fail closed while keeping the recount', () => {
  const cases: Array<[string, string]> = [
    [countsAttrs(2), 'testsuite[0].tests:declared=2:actual=1'],
    [countsAttrs(1, 1), 'testsuite[0].failures:declared=1:actual=0'],
    [countsAttrs(1, 0, 1), 'testsuite[0].errors:declared=1:actual=0'],
    [countsAttrs(1, 0, 0, 1), 'testsuite[0].skipped:declared=1:actual=0'],
  ];
  for (const [attrs, needle] of cases) {
    const result = parseJUnitXml(wrap('<testcase name="t" />', attrs));
    assert.equal(result.ok, false);
    assert.equal(result.tests, 1);
    assert.ok(result.anomalies.some((anomaly) => anomaly.includes(needle)), `${needle}: ${JSON.stringify(result.anomalies)}`);
  }
});

test('PY-04: forged root aggregate attributes fail closed', () => {
  const result = parseJUnitXml(`<testsuites ${countsAttrs(2)}><testsuite ${countsAttrs(1)}><testcase name="t" /></testsuite></testsuites>`);
  assert.equal(result.ok, false);
  assert.ok(result.anomalies.some((anomaly) => anomaly.includes('testsuites.tests:declared=2:actual=1')));
});

test('PY-04: contradictory count attributes fail closed', () => {
  const result = parseJUnitXml(wrap('<testcase name="t" />', countsAttrs(1, 1, 1)));
  assert.equal(result.ok, false);
  assert.ok(result.anomalies.some((anomaly) => anomaly.startsWith('contradictory_counts:testsuite[0]')));
});

test('PY-04: a testcase with mixed or repeated statuses fails closed', () => {
  for (const body of [
    '<testcase name="t"><failure /><error /></testcase>',
    '<testcase name="t"><error /><skipped /></testcase>',
    '<testcase name="t"><failure /><failure /></testcase>',
  ]) {
    expectRejected(wrap(body), 'testcase_multiple_statuses');
  }
});

test('PY-04: an inconsistent real interrupt artifact is rejected', () => {
  const interrupt = evidence.results.find((entry) => entry.scenario === 'interrupt');
  assert.ok(interrupt?.xmlSample);
  const result = parseJUnitXml(interrupt.xmlSample);
  assert.equal(result.ok, false);
  assert.equal(result.tests, 1);
  assert.ok(result.anomalies.some((anomaly) => anomaly.includes('count_mismatch:testsuite[0].tests:declared=0:actual=1')));
});

test('PY-04: non-XML runtime input is rejected without throwing', () => {
  const result = parseJUnitXml(null as unknown as string);
  assert.equal(result.ok, false);
  assert.deepEqual(result.anomalies, ['invalid_xml:internal']);
});

test('PY-04: parser output is shaped like Evidence counts and has no exit-code input', () => {
  const result = parseJUnitXml(wrap('<testcase name="t" />'));
  assert.deepEqual(Object.keys(result).sort(), ['anomalies', 'counts', 'errors', 'failures', 'ok', 'tests']);
  assert.deepEqual(Object.keys(result.counts).sort(), ['cancelled', 'fail', 'pass', 'skipped', 'suites', 'tests', 'todo']);
  for (const value of Object.values(result.counts)) assert.ok(Number.isInteger(value) && value >= 0);
  assert.equal(result.counts.fail, result.failures + result.errors);
  assert.equal(result.counts.tests, result.tests);
});
