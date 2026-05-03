// page renderer script

import 'bootstrap3/dist/css/bootstrap.min.css';
import 'katex/dist/katex.css';
import 'prismjs/themes/prism.css';
import './css/github-gist.css';
import './css/mermaid.css';

import './css/font-awesome.min.css';
import './css/markdown.css';
import './css/style.css';

import * as abcjs from 'abcjs';
import * as katex from 'katex';
import mermaid from 'mermaid';
import * as S from 'string';
import Viz from 'viz.js';
import { Module, render } from 'viz.js/full.render.js';

declare const require: (moduleName: string) => any;

let flowchartParse:
  | ((input: string) => { drawSVG: (container: HTMLElement, options?: Record<string, unknown>) => void })
  | null
  | undefined;

function getFlowchartParse() {
  if (flowchartParse !== undefined) {
    return flowchartParse;
  }

  try {
    // Avoid loading flowchart.js package root because it initializes a jQuery plugin at import time.
    // In VS Code markdown preview this can throw and abort the entire enhancer script.
    flowchartParse = require('flowchart.js/src/flowchart.parse');
  } catch (err) {
    flowchartParse = null;
    console.warn('flowchart parser unavailable', err);
  }

  return flowchartParse;
}

function init() {
  try {
    updateMermaid();
    updateFlowcharts();
    updateSequences();
    updateGraphviz();
    updateMathjax();
    updateABC();
    updateExtraTags();
    updateLineNumbers();
  } catch (err) {
    console.error(err);
  }
}

window.addEventListener('vscode.markdown.updateContent', init);

init();

function updateLineNumbers() {
  // update continue line numbers
  const linenumberdivs = $('.gutter.linenumber').toArray();
  for (let i = 0; i < linenumberdivs.length; i++) {
    if ($(linenumberdivs[i]).hasClass('continue')) {
      const startnumber = linenumberdivs[i - 1]
        ? parseInt(
          $(linenumberdivs[i - 1])
            .find('> span')
            .last()
            .attr('data-linenumber')
        )
        : 0;
      $(linenumberdivs[i])
        .find('> span')
        .each((key, value) => {
          $(value).attr('data-linenumber', startnumber + key + 1);
        });
    }
  }
}

function updateABC() {
  $('span.abc.raw')
    .removeClass('raw')
    .each((key, value) => {
      let $value;
      try {
        $value = $(value);
        const $ele = $(value).parent().parent();

        abcjs.renderAbc(value, $value.text());

        $ele.addClass('abc');
        $value.children().unwrap().unwrap();
        const svg = $ele.find('> svg');
        svg[0].setAttribute('viewBox', `0 0 ${svg.attr('width')} ${svg.attr('height')}`);
        svg[0].setAttribute('preserveAspectRatio', 'xMidYMid meet');
      } catch (err) {
        $value.unwrap();
        $value.parent().append(`<div class="alert alert-warning">${S(err).escapeHTML().s}</div>`);
        console.warn(err);
      }
    });
}

function updateMathjax() {
  $('span.mathjax.raw')
    .removeClass('raw')
    .each(function (key, value) {
      const $value = $(value);
      const $ele = $(value).parent().parent();
      $value.unwrap();

      let result;
      if ($(value).hasClass('display')) {
        result = katex.renderToString($value.text(), {
          throwOnError: false,
          displayMode: true,
        });
      } else {
        result = katex.renderToString($value.text(), {
          throwOnError: false,
        });
      }

      $value.html(result);
      $value.children().unwrap();
    });
}

function updateSequences() {
  const sequences = $('span.sequence-diagram.raw');
  if (!sequences.length) { return; }

  try {
    // Avoid loading js-sequence-diagrams at module level — it registers a jQuery plugin
    // ($.fn.sequenceDiagram) immediately, which can crash before jQuery is ready.
    require('js-sequence-diagrams');
  } catch (e) {
    console.warn('js-sequence-diagrams unavailable:', e);
    return;
  }

  sequences.removeClass('raw');
  sequences.each((key, value) => {
    let $ele;
    try {
      const $value = $(value);
      $ele = $(value).parent().parent();

      const sequence = $value as any;
      sequence.sequenceDiagram({
        theme: 'simple',
      });

      $ele.addClass('sequence-diagram');
      $value.children().unwrap().unwrap();
      const svg = $ele.find('> svg');
      svg[0].setAttribute('viewBox', `0 0 ${svg.attr('width')} ${svg.attr('height')}`);
      svg[0].setAttribute('preserveAspectRatio', 'xMidYMid meet');
    } catch (err) {
      // $value.unwrap()
      // $value.parent().append(`<div class="alert alert-warning">${S(err).escapeHTML().s}</div>`)
      // console.warn(err)
      $ele.addClass('sequence-diagram');
    }
  });
}

function updateFlowcharts() {
  const parseFlowchart = getFlowchartParse();
  if (!parseFlowchart) {
    return;
  }

  const flows = $('span.flow-chart.raw');
  flows.removeClass('raw');
  flows.each((key, value) => {
    let $ele;
    try {
      const $value = $(value);
      $ele = $(value).parent().parent();

      const chart = parseFlowchart($value.text());
      $value.html('');
      chart.drawSVG(value, {
        'line-width': 2,
        fill: 'none',
        'font-size': 16,
        'font-family': "'Andale Mono', monospace",
      });
      $ele.addClass('flow-chart');
      $value.children().unwrap().unwrap();
    } catch (err) {
      // $value.unwrap()
      // $value.parent().append(`<div class="alert alert-warning">${S(err).escapeHTML().s}</div>`)
      // console.warn(err)
      $ele.addClass('flow-chart');
    }
  });
}

function updateMermaid() {
  const mermaids = $('span.mermaid.raw');
  if (!mermaids.length) { return; }

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
  });

  mermaids.removeClass('raw');
  mermaids.each((key, value) => {
    let $ele;
    try {
      const $value = $(value);
      $ele = $(value).closest('pre');

      const text = $value.text();

      if (mermaid.parse(text)) {
        $ele.addClass('mermaid');
        $ele.text(text);
        // Use renderAsync to avoid internal state machine issues
        mermaid.renderAsync(`mermaid-${key}`, text, $ele[0] as any).then((svg) => {
          $ele.html(svg);
        }).catch((err) => {
          console.warn('mermaid renderAsync error:', err);
        });
      }
    } catch (err) {
      console.warn('mermaid error:', err);
      $ele?.addClass('mermaid');
    }
  });
}

function updateGraphviz() {
  let viz = new Viz({ Module, render });
  const graphvizs = $('span.graphviz.raw');
  graphvizs.removeClass('raw');
  graphvizs.each(function (key, value) {
    try {
      const $value = $(value);
      const $ele = $(value).parent().parent();
      $value.unwrap();
      const option = {
        engine: $value.attr('data-engine') || undefined,
      };
      viz
        .renderString($value.text(), option)
        .then((result) => {
          if (!result) {
            throw Error('viz.js output empty graph');
          }
          $value.html(result);
          $ele.addClass('graphviz');
          $value.children().unwrap();
        })
        .catch((err) => {
          viz = new Viz({ Module, render: init });

          // $value.parent().append(`<div class="alert alert-warning">${S(err).escapeHTML().s}</div>`)
          // console.warn(err)
        });
    } catch (err) {
      // $value.parent().append(`<div class="alert alert-warning">${S(err).escapeHTML().s}</div>`)
      // console.warn(err)
    }
  });
}

function updateExtraTags() {
  // regex for extra tags
  const spaceregex = /\s*/;
  const notinhtmltagregex = /(?![^<]*>|[^<>]*<\/)/;
  let coloregex = /\[color=([#|(|)|\s|,|\w]*?)\]/;
  coloregex = new RegExp(coloregex.source + notinhtmltagregex.source, 'g');
  let nameregex = /\[name=(.*?)\]/;
  let timeregex = /\[time=([:|,|+|-|(|)|\s|\w]*?)\]/;
  const nameandtimeregex = new RegExp(
    nameregex.source + spaceregex.source + timeregex.source + notinhtmltagregex.source,
    'g'
  );
  nameregex = new RegExp(nameregex.source + notinhtmltagregex.source, 'g');
  timeregex = new RegExp(timeregex.source + notinhtmltagregex.source, 'g');

  function replaceExtraTags(html) {
    html = html.replace(coloregex, '<span class="color" data-color="$1"></span>');
    html = html.replace(
      nameandtimeregex,
      '<small><i class="fa fa-user"></i> $1 <i class="fa fa-clock-o"></i> $2</small>'
    );
    html = html.replace(nameregex, '<small><i class="fa fa-user"></i> $1</small>');
    html = html.replace(timeregex, '<small><i class="fa fa-clock-o"></i> $1</small>');
    return html;
  }

  $('blockquote')
    .removeClass('.raw')
    .each(function (_, elem) {
      const p = $(elem).find('p');
      p[0].innerHTML = replaceExtraTags(p[0].innerHTML);

      // color tag in blockquote will change its left border color
      const blockquoteColor = $(elem).find('.color');
      blockquoteColor.each((key, value) => {
        $(value).closest('blockquote').css('border-left-color', $(value).attr('data-color'));
      });
    });
}
