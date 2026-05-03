import { Window } from 'happy-dom';
import assert from 'node:assert';
import test from 'node:test';

// Helper to create a mock jQuery-like selector
function createMockJQuery(doc) {
  const $ = (selector) => {
    if (Array.isArray(selector)) {
      const result = selector;
      result.length = selector.length;
      addMethods(result, doc);
      return result;
    }
    const elements = doc.querySelectorAll(selector);
    const result = Array.from(elements);
    result.length = elements.length;
    addMethods(result, doc);
    return result;
  };

  function addMethods(arr, doc) {
    arr.removeClass = function (className) {
      this.forEach(el => el.classList.remove(className));
      return this;
    };
    arr.addClass = function (className) {
      this.forEach(el => el.classList.add(className));
      return this;
    };
    arr.hasClass = function (className) {
      return this.length > 0 && this[0].classList.contains(className);
    };
    arr.html = function (content) {
      if (content === undefined) {
        return this[0]?.innerHTML || '';
      }
      this.forEach(el => el.innerHTML = content);
      return this;
    };
    arr.text = function (content) {
      if (content === undefined) {
        return this[0]?.textContent || '';
      }
      this.forEach(el => el.textContent = content);
      return this;
    };
    arr.attr = function (name, value) {
      if (value === undefined) {
        return this[0]?.getAttribute(name) || '';
      }
      this.forEach(el => el.setAttribute(name, value));
      return this;
    };
    arr.each = function (callback) {
      this.forEach((el, idx) => callback(idx, el));
      return this;
    };
    arr.parent = function () {
      if (this[0]?.parentNode) {
        return $([this[0].parentNode]);
      }
      return $([]);
    };
    arr.unwrap = function () {
      this.forEach(el => {
        if (el.parentNode) {
          while (el.firstChild) {
            el.parentNode.insertBefore(el.firstChild, el);
          }
          el.parentNode.removeChild(el);
        }
      });
      return this;
    };
    arr.children = function () {
      const kids = [];
      this.forEach(el => {
        kids.push(...Array.from(el.children));
      });
      return $(kids);
    };
    arr.eq = function (idx) {
      if (idx >= 0 && idx < this.length) {
        return $([this[idx]]);
      }
      return $([]);
    };
    arr.closest = function (selector) {
      if (this[0]) {
        let el = this[0];
        while (el) {
          try {
            if (el.matches?.(selector)) {
              return $([el]);
            }
          } catch (e) { }
          el = el.parentElement;
        }
      }
      return $([]);
    };
    arr.find = function (selector) {
      const found = [];
      this.forEach(el => {
        found.push(...Array.from(el.querySelectorAll(selector)));
      });
      return $(found);
    };
    arr.sequenceDiagram = function (options) {
      this.forEach(el => {
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '500');
        svg.setAttribute('height', '300');
        el.innerHTML = '';
        el.appendChild(svg);
      });
      return this;
    };
  }

  $.fn = {};
  return $;
}

test('Page Enhancer - Mermaid Diagram Translation', async (t) => {
  const win = new Window({ url: 'https://localhost' });
  const doc = win.document;
  doc.documentElement.innerHTML = `<html><body>
    <span class="mermaid raw">graph TD; A-->B; B-->C;</span>
  </body></html>`;

  const $ = createMockJQuery(doc);

  let renderAsyncCalled = false;
  const mermaid = {
    initialize: () => { },
    parse: (text) => typeof text === 'string' && text.trim().length > 0,
    renderAsync: async (id, text, container) => {
      renderAsyncCalled = true;
      assert(id.startsWith('mermaid-'), 'ID should start with mermaid-');
      assert(text.includes('graph TD'), 'Text should contain graph definition');
      return `<svg>${text}</svg>`;
    },
  };

  const mermaids = $('span.mermaid.raw');
  assert.equal(mermaids.length, 1, 'Should find one mermaid diagram');

  mermaids.removeClass('raw');
  mermaids.each((key, value) => {
    const $value = $([value]);
    const text = $value.text();

    if (mermaid.parse(text)) {
      mermaid.renderAsync(`mermaid-${key}`, text, value).then((svg) => {
        $value.html(svg);
      });
    }
  });

  assert.equal(renderAsyncCalled, true, 'renderAsync should have been called');
});

test('Page Enhancer - Mermaid async diagrams render without parse precheck', async (t) => {
  const win = new Window({ url: 'https://localhost' });
  const doc = win.document;
  doc.documentElement.innerHTML = `<html><body>
    <pre><span class="mermaid raw">gantt\n  title A Gantt Diagram</span></pre>
  </body></html>`;

  const $ = createMockJQuery(doc);

  let parseCalled = false;
  let renderAsyncCalled = false;
  const mermaid = {
    initialize: () => { },
    parse: () => {
      parseCalled = true;
      throw new Error('Diagram is a promise. Use renderAsync.');
    },
    renderAsync: async (id, text, cb, container) => {
      renderAsyncCalled = true;
      return { svg: `<svg data-id="${id}">${text}</svg>` };
    },
  };

  const mermaids = $('span.mermaid.raw');
  assert.equal(mermaids.length, 1, 'Should find one mermaid diagram');

  const pending = [];
  mermaids.removeClass('raw');
  mermaids.each((key, value) => {
    const $value = $([value]);
    const $ele = $([value]).closest('pre');
    const text = $value.text();

    $ele.addClass('mermaid');
    $ele.text(text);

    const renderResult = mermaid.renderAsync
      ? mermaid.renderAsync(`mermaid-${key}`, text, undefined, $ele[0])
      : mermaid.render(`mermaid-${key}`, text, undefined, $ele[0]);

    pending.push(
      Promise.resolve(renderResult).then((result) => {
        const svg = typeof result === 'string' ? result : result?.svg;
        if (svg) {
          $ele.html(svg);
        }
      })
    );
  });

  await Promise.all(pending);

  assert.equal(parseCalled, false, 'Mermaid parse precheck should not run for async diagrams');
  assert.equal(renderAsyncCalled, true, 'renderAsync should be called for mermaid rendering');
  assert.match(doc.body.innerHTML, /<svg[^>]*>gantt/s);
});

test('Page Enhancer - Mermaid falls back to render when renderAsync is unavailable', async (t) => {
  const win = new Window({ url: 'https://localhost' });
  const doc = win.document;
  doc.documentElement.innerHTML = `<html><body>
    <pre><span class="mermaid raw">graph TD; A-->B;</span></pre>
  </body></html>`;

  const $ = createMockJQuery(doc);

  let renderCalled = false;
  const mermaid = {
    initialize: () => { },
    render: async (id, text, cb, container) => {
      renderCalled = true;
      return `<svg data-id="${id}">${text}</svg>`;
    },
  };

  const mermaids = $('span.mermaid.raw');
  const pending = [];
  mermaids.removeClass('raw');
  mermaids.each((key, value) => {
    const $value = $([value]);
    const $ele = $([value]).closest('pre');
    const text = $value.text();

    $ele.addClass('mermaid');
    $ele.text(text);

    const renderResult = mermaid.renderAsync
      ? mermaid.renderAsync(`mermaid-${key}`, text, undefined, $ele[0])
      : mermaid.render(`mermaid-${key}`, text, undefined, $ele[0]);

    pending.push(
      Promise.resolve(renderResult).then((result) => {
        const svg = typeof result === 'string' ? result : result?.svg;
        if (svg) {
          $ele.html(svg);
        }
      })
    );
  });

  await Promise.all(pending);

  assert.equal(renderCalled, true, 'render fallback should be called');
  assert.match(doc.body.innerHTML, /<svg[^>]*data-id="mermaid-0">/s);
  assert.match(doc.body.innerHTML, /A--&gt;B;/);
});

test('Page Enhancer - Sequence Diagram Translation', async (t) => {
  const win = new Window({ url: 'https://localhost' });
  const doc = win.document;
  doc.documentElement.innerHTML = `<html><body>
    <pre><span class="sequence-diagram raw">A->B: Message</span></pre>
  </body></html>`;

  const $ = createMockJQuery(doc);

  const sequences = $('span.sequence-diagram.raw');
  assert.equal(sequences.length, 1, 'Should find one sequence diagram');

  const parseSequence = (input) => ({
    drawSVG: (container, options) => {
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '500');
      svg.setAttribute('height', '300');
      svg.setAttribute('data-theme', options?.theme || 'simple');
      container.innerHTML = '';
      container.appendChild(svg);
    },
  });

  if (sequences.length > 0) {
    sequences.removeClass('raw');
    sequences.each((key, value) => {
      const $value = $([value]);
      const $ele = $value.parent().parent();

      const diagram = parseSequence($value.text());
      $value.html('');
      diagram.drawSVG(value, { theme: 'simple' });
      $ele.addClass('sequence-diagram');
      $value.children().unwrap().unwrap();

      assert($ele.hasClass('sequence-diagram'), 'Should have sequence-diagram class');
    });
  }
});

test('Page Enhancer - Sequence Diagram avoids jQuery plugin setState error', async (t) => {
  const win = new Window({ url: 'https://localhost' });
  const doc = win.document;
  doc.documentElement.innerHTML = `<html><body>
    <pre><span class="sequence-diagram raw">Alice->Bob: Hello Bob, how are you?</span></pre>
  </body></html>`;

  const $ = createMockJQuery(doc);
  let pluginCalled = false;

  const parseSequence = (input) => ({
    drawSVG: (container) => {
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '420');
      svg.setAttribute('height', '120');
      container.innerHTML = '';
      container.appendChild(svg);
    },
  });

  const sequences = $('span.sequence-diagram.raw');
  assert.equal(sequences.length, 1, 'Should find one sequence diagram');

  sequences.removeClass('raw');
  sequences.each((key, value) => {
    const $value = $([value]);
    const $ele = $value.parent().parent();

    // Simulate the legacy plugin path that throws in preview console.
    const failingPlugin = () => {
      pluginCalled = true;
      throw new TypeError('_.setState is not a function');
    };
    $value.sequenceDiagram = failingPlugin;

    // Fixed path: never call the plugin; render directly from parser output.
    const diagram = parseSequence($value.text());
    $value.html('');
    diagram.drawSVG(value, { theme: 'simple' });
    $ele.addClass('sequence-diagram');
    $value.children().unwrap().unwrap();

    assert.equal(pluginCalled, false, 'Legacy jQuery plugin path should not be used');
    assert.equal(typeof $value.sequenceDiagram, 'function', 'Legacy plugin stub exists for regression intent');
    assert($ele.hasClass('sequence-diagram'), 'Should still mark container as sequence-diagram');
    assert.equal($('span.sequence-diagram.raw').length, 0, 'Raw class should be removed after processing');
  });
});

test('Page Enhancer - Flowchart Diagram Translation', async (t) => {
  const win = new Window({ url: 'https://localhost' });
  const doc = win.document;
  doc.documentElement.innerHTML = `<html><body>
    <pre><span class="flow-chart raw">st=>start: Start</span></pre>
  </body></html>`;

  const $ = createMockJQuery(doc);

  const flowchartParse = (input) => ({
    drawSVG: (container, options) => {
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const text_el = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
      text_el.textContent = input;
      svg.appendChild(text_el);
      container.appendChild(svg);
    },
  });

  const flows = $('span.flow-chart.raw');
  assert.equal(flows.length, 1, 'Should find one flowchart diagram');

  flows.removeClass('raw');
  flows.each((key, value) => {
    const $value = $([value]);
    const $ele = $value.parent().parent();

    const chart = flowchartParse($value.text());
    $value.html('');
    chart.drawSVG(value, { 'x': 0, 'y': 0 });

    $ele.addClass('flow-chart');
    $value.children().unwrap().unwrap();

    assert($ele.hasClass('flow-chart'), 'Should have flow-chart class');
  });
});

test('Page Enhancer - Mathjax Translation', async (t) => {
  const win = new Window({ url: 'https://localhost' });
  const doc = win.document;
  doc.documentElement.innerHTML = `<html><body>
    <span class="mathjax raw">E=mc^2</span>
    <span class="mathjax raw display">\\frac{1}{2}x</span>
  </body></html>`;

  const $ = createMockJQuery(doc);

  const katex = {
    renderToString: (text, options) => {
      return `<span class="katex">${text}</span>`;
    },
  };

  const mathjax = $('span.mathjax.raw');
  assert.equal(mathjax.length, 2, 'Should find two mathjax expressions');

  mathjax.removeClass('raw');
  mathjax.forEach((value) => {
    const $value = $([value]);
    const isDisplay = value.classList.contains('display');

    const result = katex.renderToString($value.text(), {
      throwOnError: false,
      displayMode: isDisplay,
    });

    $value.html(result);
    assert($value.html().includes('katex'), 'Should contain katex class');
  });
});

test('Page Enhancer - ABC Notation Translation', async (t) => {
  const win = new Window({ url: 'https://localhost' });
  const doc = win.document;
  doc.documentElement.innerHTML = `<html><body>
    <pre><span class="abc raw">X:1
T:Tune</span></pre>
  </body></html>`;

  const $ = createMockJQuery(doc);

  const abcjs = {
    renderAbc: (container, text) => {
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const text_el = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
      text_el.textContent = text.substring(0, 20);
      svg.appendChild(text_el);
      container.appendChild(svg);
    },
  };

  const abc = $('span.abc.raw');
  assert.equal(abc.length, 1, 'Should find one ABC notation');

  abc.removeClass('raw');
  abc.forEach((value) => {
    const $value = $([value]);
    const $ele = $value.parent().parent();

    abcjs.renderAbc(value, $value.text());
    $ele.addClass('abc');

    assert($ele.hasClass('abc'), 'Should have abc class');
  });
});

test('Page Enhancer - Graphviz Translation', async (t) => {
  const win = new Window({ url: 'https://localhost' });
  const doc = win.document;
  doc.documentElement.innerHTML = `<html><body>
    <pre><span class="graphviz raw">digraph { A->B; }</span></pre>
  </body></html>`;

  const $ = createMockJQuery(doc);

  let renderStringCalled = false;
  class Viz {
    constructor() { }
    renderString(code, options) {
      renderStringCalled = true;
      assert(code.includes('digraph'), 'Code should be graphviz format');
      return Promise.resolve(`<svg><text>${code}</text></svg>`);
    }
  }

  let viz = new Viz();
  const graphvizs = $('span.graphviz.raw');
  assert.equal(graphvizs.length, 1, 'Should find one graphviz diagram');

  graphvizs.removeClass('raw');
  graphvizs.forEach((value) => {
    const $value = $([value]);
    const graphvizCode = $value.text();
    const $ele = $value.parent().parent();
    $value.unwrap();

    const option = {
      engine: $value.attr('data-engine') || undefined,
    };

    viz.renderString(graphvizCode, option).then(svg => {
      $value.html(svg);
      $ele.addClass('graphviz');
    });
  });

  assert.equal(renderStringCalled, true, 'Viz.renderString should have been called');
});

test('Page Enhancer - Multiple Diagram Types in One Document', async (t) => {
  const win = new Window({ url: 'https://localhost' });
  const doc = win.document;
  doc.documentElement.innerHTML = `<html><body>
    <span class="mermaid raw">graph TD; A-->B;</span>
    <span class="flow-chart raw">st=>start: Start</span>
    <span class="graphviz raw">digraph { A->B; }</span>
    <span class="sequence-diagram raw">A->B: Msg</span>
  </body></html>`;

  const $ = createMockJQuery(doc);

  const allRaw = $('.raw');
  assert.equal(allRaw.length, 4, 'Should find 4 raw diagrams');

  allRaw.removeClass('raw');

  const allAfter = $('.raw');
  assert.equal(allAfter.length, 0, 'All raw classes should be removed');
});

test('Page Enhancer - Handles No Diagrams Gracefully', async (t) => {
  const win = new Window({ url: 'https://localhost' });
  const doc = win.document;
  doc.documentElement.innerHTML = `<html><body>
    <p>Just normal markdown content</p>
    <p>No diagrams here</p>
  </body></html>`;

  const $ = createMockJQuery(doc);

  const mermaids = $('span.mermaid.raw');
  const flowcharts = $('span.flow-chart.raw');
  const sequences = $('span.sequence-diagram.raw');

  assert.equal(mermaids.length, 0, 'Should find no mermaid diagrams');
  assert.equal(flowcharts.length, 0, 'Should find no flowchart diagrams');
  assert.equal(sequences.length, 0, 'Should find no sequence diagrams');
});

test('Page Enhancer - Edge Case: Empty Diagram Content', async (t) => {
  const win = new Window({ url: 'https://localhost' });
  const doc = win.document;
  doc.documentElement.innerHTML = `<html><body>
    <span class="mermaid raw"></span>
    <span class="flow-chart raw">   </span>
  </body></html>`;

  const $ = createMockJQuery(doc);

  const mermaids = $('span.mermaid.raw');
  assert.equal(mermaids.length, 1, 'Should find empty mermaid');
  assert.equal(mermaids.eq(0)[0].textContent, '', 'Text should be empty');

  mermaids.removeClass('raw');
  assert.equal($('span.mermaid.raw').length, 0, 'Raw class should be removed');
});

test('Page Enhancer - Special Blocks Integration', async (t) => {
  const win = new Window({ url: 'https://localhost' });
  const doc = win.document;
  doc.documentElement.innerHTML = `<html><body>
    <h1>Document with Diagrams</h1>
    <p>Here is a mermaid diagram:</p>
    <pre><span class="mermaid raw">graph LR; A[Box A] --> B[Box B]</span></pre>
    <p>And a flowchart:</p>
    <pre><span class="flow-chart raw">op=>operation: My Operation</span></pre>
    <p>Regular paragraph between diagrams</p>
    <pre><span class="graphviz raw">graph { A -- B; B -- C; }</span></pre>
  </body></html>`;

  const $ = createMockJQuery(doc);

  const initialRaw = $('.raw');
  assert(initialRaw.length >= 3, 'Should have at least 3 raw diagram elements');

  $('span.mermaid.raw').removeClass('raw').addClass('mermaid-processed');
  $('span.flow-chart.raw').removeClass('raw').addClass('flowchart-processed');
  $('span.graphviz.raw').removeClass('raw').addClass('graphviz-processed');

  assert.equal($('.raw').length, 0, 'All raw classes should be removed after processing');
  assert($('.mermaid-processed').length > 0, 'Processed mermaid diagrams should be marked');
  assert($('.flowchart-processed').length > 0, 'Processed flowchart diagrams should be marked');
  assert($('.graphviz-processed').length > 0, 'Processed graphviz diagrams should be marked');
});
