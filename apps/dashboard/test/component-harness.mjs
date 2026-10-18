import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { transformWithOxc } from 'vite';

// No DOM/test-renderer dependency is installed. Exercise the actual component's
// handlers/effects with a minimal lifecycle driver, alongside browser acceptance.
export async function loadComponents() {
  await mkdir(resolve('node_modules/.tmp'), { recursive: true });
  const directory = await mkdtemp(resolve('node_modules/.tmp/dashboard-test-'));
  await writeFile(
    join(directory, 'hooks.mjs'),
    `export const useState=(...a)=>globalThis.__dashboardTestHooks.useState(...a);
export const useEffect=(...a)=>globalThis.__dashboardTestHooks.useEffect(...a);
export const useMemo=(f)=>f();`,
  );
  const source =
    (await readFile('src/App.tsx', 'utf8'))
      .replace("from 'react'", "from './hooks.mjs'")
      .replace(
        "from './detail-requests'",
        `from '${pathToFileURL(resolve('src/detail-requests.ts')).href}'`,
      ) + '\nexport { DeploymentDetail };';
  const { code } = await transformWithOxc(source, 'App.tsx', {
    jsx: { runtime: 'automatic' },
  });
  await writeFile(join(directory, 'App.mjs'), code);
  return {
    components: await import(pathToFileURL(join(directory, 'App.mjs'))),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function expand(node) {
  if (node == null || typeof node === 'boolean') return null;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') return expand(node.type(node.props));
  return { ...node, props: { ...node.props, children: expand(node.props.children) } };
}

function descendants(node) {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (node == null || typeof node !== 'object') return [];
  return [node, ...descendants(node.props.children)];
}

export function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node == null || typeof node === 'boolean') return '';
  return typeof node !== 'object' ? String(node) : text(node.props.children);
}

export function mount(App) {
  const slots = [];
  const pending = [];
  let cursor = 0;
  let scheduled = false;
  let disposed = false;
  let tree;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [
        slots[index].value,
        (next) => {
          const value = typeof next === 'function' ? next(slots[index].value) : next;
          if (Object.is(value, slots[index].value)) return;
          slots[index].value = value;
          if (!scheduled) {
            scheduled = true;
            queueMicrotask(() => {
              scheduled = false;
              render();
            });
          }
        },
      ];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      const old = slots[index];
      if (old && deps.every((value, i) => Object.is(value, old.deps[i]))) return;
      slots[index] = { deps, cleanup: old?.cleanup };
      pending.push(() => {
        slots[index].cleanup?.();
        slots[index].cleanup = callback();
      });
    },
  };
  function render() {
    if (disposed) return;
    globalThis.__dashboardTestHooks = hooks;
    cursor = 0;
    tree = App();
    for (const effect of pending.splice(0)) effect();
  }
  render();
  return {
    text: () => text(expand(tree)),
    button(label) {
      const found = descendants(expand(tree)).find(
        (node) =>
          node.type === 'button' &&
          (node.props['aria-label'] === label || text(node).trim() === label),
      );
      if (!found) throw new Error(`Missing button: ${label}`);
      return found.props;
    },
    selectProject(id) {
      const select = descendants(expand(tree)).find(
        (node) =>
          node.type === 'select' && node.props['aria-label'] === 'Select project',
      );
      if (!select) throw new Error('Missing project selector');
      select.props.onChange({ target: { value: id } });
    },
    close() {
      disposed = true;
      for (const slot of slots) slot?.cleanup?.();
      delete globalThis.__dashboardTestHooks;
    },
  };
}
