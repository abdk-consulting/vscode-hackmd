import MarkdownIt from 'markdown-it';
import chords from 'markdown-it-chords';
import assert from 'node:assert';
import test from 'node:test';

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
          params.id = param.slice(1);
        } else if (param[0] === '.') {
          params.class = (params.class || []).concat(param.slice(1));
        } else {
          const offset = param.indexOf('=');
          const id = param.substring(0, offset).trim().toLowerCase();
          let val = param.substring(offset + 1).trim();
          const valStart = val[0];
          const valEnd = val[val.length - 1];
          if (['"', "'"].includes(valStart) && ['"', "'"].includes(valEnd) && valStart === valEnd) {
            val = val.substring(1, val.length - 1);
          }
          params[id] = val;
        }
      });
    }
  }
  return params;
}

function renderFretboardBlock(content, params, md) {
  const lines = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0);

  if (!lines.length) {
    return '<div class="fretboard-preview"></div>';
  }

  const escaped = (text) => md.utils.escapeHtml(String(text ?? ''));
  const maybeFret = lines[lines.length - 1].trim();
  const baseFret = /^\d+$/.test(maybeFret) ? maybeFret : '';
  const boardRows = baseFret ? lines.slice(0, -1) : lines;
  const typeClass = typeof params.type === 'string' && params.type ? ` fretboard-${escaped(params.type)}` : '';
  const title = typeof params.title === 'string' ? params.title : '';

  let html = `<div class="fretboard-preview${typeClass}">`;
  if (title) {
    html += `<div class="fretboard-title">${escaped(title)}</div>`;
  }

  html += '<table class="fretboard-table"><tbody>';
  boardRows.forEach((line) => {
    html += '<tr>';
    line.split('').forEach((char) => {
      if (char === '-') {
        html += '<td class="fretboard-cell fretboard-empty"></td>';
      } else if (char === 'o') {
        html += '<td class="fretboard-cell fretboard-open">○</td>';
      } else if (char === 'O') {
        html += '<td class="fretboard-cell fretboard-filled">●</td>';
      } else if (char === '*') {
        html += '<td class="fretboard-cell fretboard-root">★</td>';
      } else {
        html += `<td class="fretboard-cell fretboard-mark">${escaped(char)}</td>`;
      }
    });
    html += '</tr>';
  });
  html += '</tbody></table>';

  if (baseFret) {
    html += `<div class="fretboard-base-fret">${escaped(baseFret)}</div>`;
  }

  html += '</div>';
  return html;
}

function buildMd() {
  const md = new MarkdownIt();
  md.use(chords);

  const defaultFenceRule =
    md.renderer.rules.fence ||
    function (tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };

  md.renderer.rules.fence = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    const info = token.info ? token.info.trim() : '';
    const language = info.split(/\s+/)[0];

    if (language === 'fretboard') {
      const params = parseFenceCodeParams(info);
      return renderFretboardBlock(token.content, params, md);
    }

    return defaultFenceRule(tokens, idx, options, env, self);
  };

  return md;
}

test('Fretboard: block is rendered to fretboard preview container', () => {
  const md = buildMd();
  const src = [
    '```fretboard {title="horizontal, 6 frets, with nut", type="h6"}',
    '-oO-*-',
    '--o-o-',
    '-o-oo-',
    '-o-oO-',
    '-oo-o-',
    '-*O-o-',
    '  3',
    '```',
  ].join('\n') + '\n';

  const html = md.render(src);

  assert.match(html, /class="fretboard-preview fretboard-h6"/);
  assert.match(html, /class="fretboard-title">horizontal, 6 frets, with nut<\/div>/);
  assert.match(html, /class="fretboard-base-fret">3<\/div>/);
  assert.match(html, /class="fretboard-cell fretboard-open">○<\/td>/);
  assert.match(html, /class="fretboard-cell fretboard-filled">●<\/td>/);
  assert.match(html, /class="fretboard-cell fretboard-root">★<\/td>/);
});

test('Fretboard: non-fretboard fenced blocks are untouched', () => {
  const md = buildMd();
  const src = ['```javascript', 'console.log("hi")', '```'].join('\n') + '\n';

  const html = md.render(src);

  assert.doesNotMatch(html, /fretboard-preview/);
  assert.match(html, /<pre><code class="language-javascript">/);
});

test('Fretboard: markdown-it-chords inline parser remains active', () => {
  const md = buildMd();
  const html = md.render('[C]Hello');

  assert.match(html, /class="chord"/);
});
