const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const calls = [], listeners = {};
const noop = () => {};
const element = {classList: {toggle: noop}, setAttribute: noop, addEventListener: (name, fn) => {listeners['brand:' + name] = fn;}};
const context = { URL, URLSearchParams, console, readLoadedAccount: () => 'SavedUser', location: {hash: '#dashboard', search: ''},
  document: {querySelectorAll: () => [], querySelector: () => element, getElementById: () => null},
  window: {addEventListener: (name, fn) => {listeners[name] = fn;}},
  history: {replaceState: (_, __, hash) => {context.location.hash = hash;}},
};
const source = fs.readFileSync('js/router.js', 'utf8');
for (const name of source.matchAll(/:\s*(\w+(?:Tool|Shell|Gate))[,\n]/g)) context[name[1]] = {activate: p => calls.push([name[1], p.get('u')])};
vm.createContext(context);
vm.runInContext(source, context);
assert.deepEqual(calls.at(-1), ['DashboardTool', 'SavedUser']);
function navigate(from, to, tool, username) {
  context.location.hash = to;
  listeners.hashchange({oldURL: 'https://example.test/' + from});
  assert.deepEqual(calls.at(-1), [tool, username]);
}
navigate('#dashboard?u=Alice', '#home', 'ToolkitShell', 'Alice');
navigate('#home?u=Bob&tool=profit', '#dashboard', 'DashboardTool', 'Bob');
navigate('#dashboard?u=Bob', '#home?u=Carol', 'ToolkitShell', 'Carol');
navigate('#home?u=Carol', '#community', 'ToolkitShell', 'Carol');
navigate('#community', '#dashboard', 'DashboardTool', 'Carol');
console.log('Account follows navigation in both directions; explicit accounts win and community preserves selection.');

listeners['brand:click']();
navigate('#dashboard?u=Carol', '#dashboard', 'DashboardTool', null);
assert.equal(context.location.hash, '#dashboard');
navigate('#dashboard', '#home', 'ToolkitShell', null);
console.log('Brand reset clears the selected account.');
