'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadTheme({saved, systemDark = false} = {}) {
  const stored = new Map();
  if (saved) stored.set('item-dashboard-theme', saved);
  const classes = new Set();
  const mediaListeners = [];
  const controls = [];
  const logos = [];
  const root = {
    localStorage: {
      getItem(key) { return stored.has(key) ? stored.get(key) : null; },
      setItem(key, value) { stored.set(key, value); }
    },
    matchMedia() {
      return {
        matches:systemDark,
        addEventListener(type, listener) { if (type === 'change') mediaListeners.push(listener); }
      };
    },
    document: {
      documentElement: {
        classList: {
          contains(name) { return classes.has(name); },
          toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }
        },
        dataset: {},
        style: {}
      },
      querySelectorAll(selector) {
        if (selector === '[data-theme-toggle]') return controls;
        if (selector === '[data-item-logo]') return logos;
        return [];
      }
    },
    dispatchEvent() {},
    CustomEvent: class CustomEvent {}
  };
  const previous = {
    document: global.document,
    localStorage: global.localStorage,
    matchMedia: global.matchMedia,
    dispatchEvent: global.dispatchEvent,
    CustomEvent: global.CustomEvent,
    ItemTheme: global.ItemTheme
  };
  const modulePath = require.resolve('../public/assets/js/theme');
  delete require.cache[modulePath];
  Object.assign(global, root);
  const theme = require(modulePath);
  return {
    theme, root, stored, classes, mediaListeners, controls, logos,
    restore() {
      delete require.cache[modulePath];
      Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) delete global[key];
        else global[key] = value;
      });
    }
  };
}

test('saved preference wins over system preference', () => {
  const env = loadTheme({saved:'light', systemDark:true});
  try {
    assert.equal(env.theme.initializeTheme(), 'light');
    assert.equal(env.classes.has('dark'), false);
    assert.equal(env.root.document.documentElement.style.colorScheme, 'light');
  } finally { env.restore(); }
});

test('system preference is used when no preference is saved', () => {
  const env = loadTheme({systemDark:true});
  try {
    assert.equal(env.theme.initializeTheme(), 'dark');
    assert.equal(env.classes.has('dark'), true);
  } finally { env.restore(); }
});

test('toggle persists the new theme', () => {
  const env = loadTheme({saved:'dark'});
  try {
    env.theme.initializeTheme();
    assert.equal(env.theme.toggleTheme(), 'light');
    assert.equal(env.stored.get(env.theme.STORAGE_KEY), 'light');
    assert.equal(env.classes.has('dark'), false);
  } finally { env.restore(); }
});

test('controls and logos expose the current theme accessibly', () => {
  const env = loadTheme({saved:'dark'});
  const attrs = {};
  const label = {textContent:''};
  const control = {
    dataset:{},
    setAttribute(name, value) { attrs[name] = value; },
    querySelector() { return label; },
    addEventListener() {}
  };
  const logo = {src:''};
  env.controls.push(control);
  env.logos.push(logo);
  try {
    env.theme.initializeTheme();
    env.theme.bind();
    assert.equal(attrs['aria-label'], 'Switch to light mode');
    assert.equal(attrs['aria-pressed'], 'true');
    assert.equal(label.textContent, 'Dark mode');
    assert.equal(logo.src, env.theme.DARK_LOGO);
  } finally { env.restore(); }
});

test('system changes apply only while no saved preference exists', () => {
  const env = loadTheme({systemDark:false});
  try {
    env.theme.initializeTheme();
    env.theme.bind();
    assert.equal(env.mediaListeners.length, 1);
    env.mediaListeners[0]({matches:true});
    assert.equal(env.classes.has('dark'), true);
    env.theme.toggleTheme();
    env.mediaListeners[0]({matches:true});
    assert.equal(env.classes.has('dark'), false);
  } finally { env.restore(); }
});
