import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import assert from 'node:assert';
import test from 'node:test';

function buildMd() {
  const md = new MarkdownIt();
  md.use(taskLists, { enabled: true });
  return md;
}

test('Task list: unchecked item renders checkbox input without checked attribute', () => {
  const md = buildMd();
  const html = md.render('- [ ] unchecked item\n');
  assert.match(html, /class="contains-task-list"/);
  assert.match(html, /class="task-list-item/);
  assert.match(html, /<input[^>]*type="checkbox"/);
  assert.doesNotMatch(html, /checked=""/);
});

test('Task list: checked item renders checkbox input with checked attribute', () => {
  const md = buildMd();
  const html = md.render('- [x] checked item\n');
  assert.match(html, /class="contains-task-list"/);
  assert.match(html, /<input[^>]*checked/);
});

test('Task list: uppercase [X] is treated as checked', () => {
  const md = buildMd();
  const html = md.render('- [X] uppercase checked\n');
  assert.match(html, /<input[^>]*checked/);
});

test('Task list: mixed checked and unchecked items in one list', () => {
  const md = buildMd();
  const html = md.render('- [x] done\n- [ ] not done\n');
  const checkedCount = (html.match(/checked/g) || []).length;
  const uncheckedInputs = (html.match(/<input[^>]*type="checkbox"/g) || []).length;
  assert.equal(checkedCount, 1);
  assert.equal(uncheckedInputs, 2);
});

test('Task list: nested structure from HackMD ToDo example', () => {
  const md = buildMd();
  const src = [
    '## ToDo List:',
    '- [ ] ToDos',
    '  - [x] Buy some salad',
    '  - [ ] Brush teeth',
    '  - [x] Drink some water',
  ].join('\n') + '\n';

  const html = md.render(src);

  // Heading rendered normally
  assert.match(html, /<h2>ToDo List:<\/h2>/);

  // Outer and inner lists carry the task-list class
  const taskListCount = (html.match(/class="contains-task-list"/g) || []).length;
  assert(taskListCount >= 2, 'expected at least two contains-task-list elements (outer + inner)');

  // Correct checked/unchecked counts: Buy some salad + Drink some water = 2 checked
  const checkedCount = (html.match(/checked/g) || []).length;
  assert.equal(checkedCount, 2, 'expected 2 checked items');

  // Total checkboxes: ToDos + Buy + Brush + Drink = 4
  const inputCount = (html.match(/<input/g) || []).length;
  assert.equal(inputCount, 4, 'expected 4 checkbox inputs');
});

test('Task list: plain list items are not converted to checkboxes', () => {
  const md = buildMd();
  const html = md.render('- just a plain item\n- another item\n');
  assert.doesNotMatch(html, /class="contains-task-list"/);
  assert.doesNotMatch(html, /<input/);
});

test('Task list: without plugin, [ ] stays as plain text', () => {
  const md = new MarkdownIt(); // no plugin
  const html = md.render('- [ ] unchecked\n');
  assert.doesNotMatch(html, /<input/);
  assert.match(html, /\[ \]/);
});

test('Task list: enabled:true makes checkboxes interactive (no disabled attribute)', () => {
  const md = buildMd();
  const html = md.render('- [ ] interactive\n');
  assert.doesNotMatch(html, /disabled/);
});

test('Task list: items carry task-list-item-checkbox CSS class', () => {
  const md = buildMd();
  const html = md.render('- [x] styled\n');
  assert.match(html, /class="task-list-item-checkbox"/);
});
