'use strict';

(function exposeItemTheme(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ItemTheme = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createItemTheme(root) {
  const STORAGE_KEY = 'item-dashboard-theme';
  const LIGHT_LOGO = '/assets/brand/item-logo-light.svg';
  const DARK_LOGO = '/assets/brand/item-logo-dark.svg';
  let systemListenerBound = false;

  function normalizeTheme(value) {
    return value === 'dark' ? 'dark' : 'light';
  }

  function systemTheme() {
    return root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function savedTheme() {
    try {
      const value = root.localStorage && root.localStorage.getItem(STORAGE_KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch (_) {
      return null;
    }
  }

  function currentTheme() {
    const doc = root.document;
    if (doc && doc.documentElement.classList.contains('dark')) return 'dark';
    return 'light';
  }

  function translate(key, fallback) {
    const i18n = root.ItemI18n;
    if (!i18n || typeof i18n.t !== 'function') return fallback;
    return i18n.t(key, {defaultValue:fallback}) || fallback;
  }

  function syncControls(theme) {
    const doc = root.document;
    if (!doc) return;
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    doc.querySelectorAll('[data-theme-toggle]').forEach(button => {
      const switchLabel = nextTheme === 'light'
        ? translate('theme.switchToLight', 'Switch to light mode')
        : translate('theme.switchToDark', 'Switch to dark mode');
      button.setAttribute('aria-label', switchLabel);
      button.setAttribute('aria-pressed', String(theme === 'dark'));
      button.setAttribute('title', switchLabel);
      const label = button.querySelector('[data-theme-label]');
      if (label) label.textContent = theme === 'dark'
        ? translate('theme.dark', 'Dark mode')
        : translate('theme.light', 'Light mode');
    });
    doc.querySelectorAll('[data-item-logo]').forEach(image => {
      image.src = theme === 'dark' ? DARK_LOGO : LIGHT_LOGO;
    });
  }

  function applyTheme(value, options) {
    const theme = normalizeTheme(value);
    const doc = root.document;
    if (!doc) return theme;
    doc.documentElement.classList.toggle('dark', theme === 'dark');
    doc.documentElement.dataset.theme = theme;
    doc.documentElement.style.colorScheme = theme;
    if (options && options.persist) {
      try { root.localStorage.setItem(STORAGE_KEY, theme); } catch (_) {}
    }
    syncControls(theme);
    if (options && options.notify && typeof root.CustomEvent === 'function') {
      root.dispatchEvent(new root.CustomEvent('item-theme-change', {detail:{theme}}));
    }
    return theme;
  }

  function initializeTheme() {
    return applyTheme(savedTheme() || systemTheme());
  }

  function toggleTheme() {
    return applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', {persist:true, notify:true});
  }

  function bind() {
    syncControls(currentTheme());
    if (!root.document) return;
    root.document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      if (button.dataset.themeBound === 'true') return;
      button.dataset.themeBound = 'true';
      button.addEventListener('click', toggleTheme);
    });
    if (!systemListenerBound && root.matchMedia) {
      const preference = root.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = event => {
        if (!savedTheme()) applyTheme(event.matches ? 'dark' : 'light', {notify:true});
      };
      if (preference.addEventListener) preference.addEventListener('change', handleChange);
      else if (preference.addListener) preference.addListener(handleChange);
      systemListenerBound = true;
    }
    if (!root.__itemThemeLanguageListenerBound && root.addEventListener) {
      root.addEventListener('item-language-change', () => syncControls(currentTheme()));
      root.__itemThemeLanguageListenerBound = true;
    }
  }

  return {STORAGE_KEY, LIGHT_LOGO, DARK_LOGO, normalizeTheme, savedTheme, systemTheme, currentTheme, applyTheme, initializeTheme, toggleTheme, syncControls, bind};
});
