import MarkdownIt from 'markdown-it';
import assert from 'node:assert';
import fs from 'node:fs';
import test from 'node:test';
import Papa from 'papaparse';

// Mirror the fence-rule logic from src/extension.ts extendMarkdownIt
function parseFenceCodeParams(lang) {
  const attrMatch = lang.match(/{(.*)}/);
  const params = {};
  if (attrMatch && attrMatch.length >= 2) {
    const attrs = attrMatch[1];
    const paraMatch = attrs.match(
      /([#.](\S+?)\s)|((\S+?)\s*=\s*("(.+?)"|'(.+?)'|\[[^\]]*\]|\{[}]*\}|(\S+)))/g
    );
    if (paraMatch) {
      paraMatch.forEach((param) => {
        param = param.trim();
        if (param[0] === '#') {
          params['id'] = param.slice(1);
        } else if (param[0] === '.') {
          params['class'] = (params['class'] || []).concat(param.slice(1));
        } else {
          const offset = param.indexOf('=');
          const id = param.substring(0, offset).trim().toLowerCase();
          let val = param.substring(offset + 1).trim();
          const valStart = val[0];
          const valEnd = val[val.length - 1];
          if (
            ['"', "'"].includes(valStart) &&
            ['"', "'"].includes(valEnd) &&
            valStart === valEnd
          ) {
            val = val.substring(1, val.length - 1);
          }
          params[id] = val;
        }
      });
    }
  }
  return params;
}

function parseFenceParamValue(value) {
  if (typeof value !== 'string') {
    return value;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }

  return value;
}

function renderCsvPreviewTable(content, params, md) {
  const parseOptions = {};
  Object.keys(params).forEach((key) => {
    if (key === 'id' || key === 'class' || key === 'title' || key === 'type') {
      return;
    }
    parseOptions[key] = parseFenceParamValue(params[key]);
  });

  if (!Object.prototype.hasOwnProperty.call(parseOptions, 'delimiter')) {
    parseOptions.delimiter = ',';
  }

  const parsed = Papa.parse(content.trim(), parseOptions);
  const escaped = (text) => md.utils.escapeHtml(String(text ?? ''));
  const header = Boolean(parseOptions.header);
  let headers = [];
  let rows;

  if (header) {
    headers = Array.isArray(parsed.meta?.fields) ? parsed.meta.fields : [];
    rows = Array.isArray(parsed.data)
      ? parsed.data.map((row) => headers.map((key) => row?.[key]))
      : [];
  } else {
    rows = Array.isArray(parsed.data) ? parsed.data : [];
  }

  let html = '<table class="csv-preview-table">';
  if (header && headers.length) {
    html += '<thead><tr>';
    headers.forEach((column) => {
      html += `<th>${escaped(column)}</th>`;
    });
    html += '</tr></thead>';
  }

  html += '<tbody>';
  rows.forEach((row) => {
    html += '<tr>';
    row.forEach((cell) => {
      html += `<td>${escaped(cell)}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';

  return html;
}

function buildMd() {
  const md = new MarkdownIt();
  const defaultFenceRule =
    md.renderer.rules.fence ||
    function (tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };
  md.renderer.rules.fence = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    const info = token.info ? token.info.trim() : '';
    if (info.split(/\s+/)[0] === 'csvpreview') {
      const params = parseFenceCodeParams(info);
      return renderCsvPreviewTable(token.content, params, md);
    }
    return defaultFenceRule(tokens, idx, options, env, self);
  };
  return md;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('CSV preview: basic table with header', () => {
  const md = buildMd();
  const src = [
    '```csvpreview {header="true"}',
    'firstName,lastName,email',
    'John,Doe,john@doe.com',
    '```',
  ].join('\n') + '\n';

  const html = md.render(src);

  assert.match(html, /<table/);
  assert.match(html, /<thead/);
  assert.match(html, /<th[^>]*>.*firstName.*<\/th>/s);
  assert.match(html, /<th[^>]*>.*lastName.*<\/th>/s);
  assert.match(html, /<th[^>]*>.*email.*<\/th>/s);
  assert.match(html, /<td[^>]*>.*John.*<\/td>/s);
  assert.match(html, /<td[^>]*>.*Doe.*<\/td>/s);
  assert.match(html, /<td[^>]*>.*john@doe\.com.*<\/td>/s);
});

test('CSV preview: table without header', () => {
  const md = buildMd();
  const src = ['```csvpreview', 'a,b', '1,2', '```'].join('\n') + '\n';

  const html = md.render(src);

  assert.match(html, /<table/);
  assert.doesNotMatch(html, /<thead/);
  assert.match(html, /<td[^>]*>.*a.*<\/td>/s);
  assert.match(html, /<td[^>]*>.*1.*<\/td>/s);
});

test('CSV preview: full HackMD example with four columns', () => {
  const md = buildMd();
  const src = [
    '```csvpreview {header="true"}',
    'firstName,lastName,email,phoneNumber',
    'John,Doe,john@doe.com,0123456789',
    'Jane,Doe,jane@doe.com,9876543210',
    'James,Bond,james.bond@mi6.co.uk,0612345678',
    '```',
  ].join('\n') + '\n';

  const html = md.render(src);

  assert.match(html, /<table/);
  assert.match(html, /<thead/);
  // All header columns present
  for (const col of ['firstName', 'lastName', 'email', 'phoneNumber']) {
    assert.match(html, new RegExp(`<th[^>]*>[^<]*${col}[^<]*</th>`, 's'));
  }
  // All data rows present
  assert.match(html, /John/);
  assert.match(html, /Jane/);
  assert.match(html, /James/);
  assert.match(html, /james\.bond@mi6\.co\.uk/);
  assert.match(html, /0612345678/);
});

test('CSV preview: multi-row table has correct row count', () => {
  const md = buildMd();
  const src = [
    '```csvpreview {header="true"}',
    'name,value',
    'alpha,1',
    'beta,2',
    'gamma,3',
    '```',
  ].join('\n') + '\n';

  const html = md.render(src);

  // 3 data rows → 3 <tr> in <tbody>
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  assert.ok(tbodyMatch, 'expected a <tbody>');
  const rowCount = (tbodyMatch[1].match(/<tr>/g) || []).length;
  assert.equal(rowCount, 3);
});

test('CSV preview: non-csvpreview fenced block is unaffected', () => {
  const md = buildMd();
  const src = ['```javascript', 'console.log("hello");', '```'].join('\n') + '\n';

  const html = md.render(src);

  assert.doesNotMatch(html, /<table/);
  assert.match(html, /<code/);
  assert.match(html, /console\.log/);
});

test('CSV preview: bare csvpreview (no attributes) defaults to no header', () => {
  const md = buildMd();
  const src = ['```csvpreview', 'col1,col2', 'val1,val2', '```'].join('\n') + '\n';

  const html = md.render(src);

  assert.match(html, /<table/);
  assert.doesNotMatch(html, /<thead/);
});

test('CSV preview: header=false attribute is treated as no header', () => {
  const md = buildMd();
  const src = [
    '```csvpreview {header="false"}',
    'col1,col2',
    'val1,val2',
    '```',
  ].join('\n') + '\n';

  const html = md.render(src);

  assert.match(html, /<table/);
  assert.doesNotMatch(html, /<thead/);
});

test('CSV preview: delimiter option is passed to Papa Parse', () => {
  const md = buildMd();
  const src = [
    '```csvpreview {header="true" delimiter="."}',
    'firstName.lastName.email',
    'John.Doe.john@doe.com',
    '```',
  ].join('\n') + '\n';

  const html = md.render(src);

  assert.match(html, /<th[^>]*>[^<]*firstName[^<]*<\/th>/);
  assert.match(html, /<th[^>]*>[^<]*lastName[^<]*<\/th>/);
  assert.match(html, /<th[^>]*>[^<]*email[^<]*<\/th>/);
  assert.match(html, /<td[^>]*>[^<]*John[^<]*<\/td>/);
  assert.match(html, /<td[^>]*>[^<]*Doe[^<]*<\/td>/);
});

test('CSV preview: output is not wrapped in <pre><code>', () => {
  const md = buildMd();
  const src = [
    '```csvpreview {header="true"}',
    'x,y',
    '1,2',
    '```',
  ].join('\n') + '\n';

  const html = md.render(src);

  assert.doesNotMatch(html, /<pre/);
  assert.doesNotMatch(html, /<code/);
  assert.match(html, /<table/);
});

test('CSV preview: table stylesheet adds horizontal gaps between columns', () => {
  const css = fs.readFileSync(new URL('../../src/css/markdown.css', import.meta.url), 'utf8');

  assert.match(css, /\.vscode-body\s+table\s+th\s*,\s*\n\s*\.vscode-body\s+table\s+td\s*\{/);
  assert.match(css, /padding\s*:\s*6px\s+12px\s*;/);
});
