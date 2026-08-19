'use strict';

(function exposeItemI18n(root, factory) {
  let engine = root && root.i18next;
  let english = null;
  if (typeof module === 'object' && module.exports) {
    engine = require('i18next');
    english = require('../locales/en.json');
    module.exports = factory(root, engine, english);
  } else if (root) {
    root.ItemI18n = factory(root, engine, english);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createItemI18n(root, i18next, bundledEnglish) {
  const DEFAULT_LOCALE = 'en';
  const RTL_LOCALES = new Set(['ar']);
  const STORAGE_PREFIX = 'item-dashboard-locale:';
  const LOCALES = Object.freeze([
    {code:'en', name:'English', nativeName:'English'},
    {code:'es', name:'Spanish', nativeName:'Español'},
    {code:'zh-CN', name:'Chinese (Simplified)', nativeName:'简体中文'},
    {code:'zh-TW', name:'Chinese (Traditional)', nativeName:'繁體中文'},
    {code:'fr', name:'French', nativeName:'Français'},
    {code:'de', name:'German', nativeName:'Deutsch'},
    {code:'pt', name:'Portuguese', nativeName:'Português'},
    {code:'it', name:'Italian', nativeName:'Italiano'},
    {code:'ja', name:'Japanese', nativeName:'日本語'},
    {code:'ko', name:'Korean', nativeName:'한국어'},
    {code:'vi', name:'Vietnamese', nativeName:'Tiếng Việt'},
    {code:'fil', name:'Filipino', nativeName:'Filipino'},
    {code:'hi', name:'Hindi', nativeName:'हिन्दी'},
    {code:'ar', name:'Arabic', nativeName:'العربية'}
  ]);
  const localeCodes = new Set(LOCALES.map(locale => locale.code));
  let englishResources = bundledEnglish || {};
  let currentUserNamespace = 'guest';
  let readyPromise = null;
  let selectorBound = false;
  let runtimeMessagesBound = false;
  let moduleObserver = null;
  const moduleTextKeys = new WeakMap();
  const moduleAttributeKeys = new WeakMap();
  const translatedDescriptors = new Map();
  let moduleEnglishIndex = null;
  let moduleEnglishTemplates = null;
  const MODULE_VIEW_IDS = Object.freeze([
    'view-dashboard','view-robots','view-cycle','view-countApproval','view-countCalendar',
    'view-scheduler','view-inventory','view-tasks','view-replenish','view-replenSuggest','view-alerts',
    'view-calendar','view-consolidation','view-vlg','view-locationTag','view-locTagReq',
    'view-abcSlotting','view-reports','view-settings','view-gis'
  ]);
  const GENERATED_UI_SELECTOR = '.modal-overlay,[role="dialog"],.toast,.popover';

  function normalizeLocale(value) {
    const raw = String(value || '').trim().replaceAll('_', '-');
    if (localeCodes.has(raw)) return raw;
    const lower = raw.toLowerCase();
    const exact = LOCALES.find(locale => locale.code.toLowerCase() === lower);
    if (exact) return exact.code;
    if (lower === 'zh' || lower.startsWith('zh-hans')) return 'zh-CN';
    if (lower.startsWith('zh-hant')) return 'zh-TW';
    const base = lower.split('-')[0];
    const baseMatch = LOCALES.find(locale => locale.code.toLowerCase() === base);
    return baseMatch ? baseMatch.code : DEFAULT_LOCALE;
  }

  function normalizeNamespace(value) {
    const clean = String(value == null ? '' : value).trim();
    return clean || 'guest';
  }

  function storageKey(identity) {
    return STORAGE_PREFIX + encodeURIComponent(normalizeNamespace(identity));
  }

  function storedLocale(identity) {
    try {
      const stored = root.localStorage && root.localStorage.getItem(storageKey(identity == null ? currentUserNamespace : identity));
      return stored && normalizeLocale(stored) === stored ? stored : null;
    } catch (_) {
      return null;
    }
  }

  function resourceValue(resources, key) {
    return String(key || '').split('.').reduce((value, part) => value && value[part], resources);
  }

  function interpolateFallback(value, options) {
    return String(value).replace(/{{\s*([\w.-]+)\s*}}/g, (_, name) => {
      const replacement = resourceValue(options || {}, name);
      return replacement == null ? '' : String(replacement);
    });
  }

  function t(key, options) {
    const english = resourceValue(englishResources, key);
    const fallback = english == null ? (options && options.defaultValue) : english;
    if (i18next && i18next.isInitialized) {
      const translated = i18next.t(key, Object.assign({defaultValue:fallback == null ? '' : fallback}, options || {}));
      if (translated && translated !== key) {
        rememberDescriptor(key, options, translated);
        return translated;
      }
    }
    const value = fallback == null ? '' : interpolateFallback(fallback, options);
    rememberDescriptor(key, options, value);
    return value;
  }

  function rememberDescriptor(key, options, value) {
    if (!/^(?:modules|screens|runtime|status|common|enums)\./.test(String(key || '')) || !value) return;
    translatedDescriptors.set(String(value).trim(), {key, options:Object.assign({}, options || {})});
    if (translatedDescriptors.size > 2500) translatedDescriptors.delete(translatedDescriptors.keys().next().value);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }

  function html(key, options) {
    const safeOptions = {};
    Object.entries(options || {}).forEach(([name, value]) => { safeOptions[name] = escapeHtml(value); });
    return t(key, safeOptions);
  }

  function currentLocale() {
    return normalizeLocale(i18next && i18next.language ? i18next.language : storedLocale() || DEFAULT_LOCALE);
  }

  function localeName(code, nativeOnly) {
    const locale = LOCALES.find(item => item.code === normalizeLocale(code)) || LOCALES[0];
    return nativeOnly || locale.name === locale.nativeName ? locale.nativeName : locale.nativeName + ' · ' + locale.name;
  }

  function applyDocumentLanguage(locale) {
    const doc = root.document;
    const normalized = normalizeLocale(locale || currentLocale());
    if (doc && doc.documentElement) {
      doc.documentElement.lang = normalized;
      doc.documentElement.dir = RTL_LOCALES.has(normalized) ? 'rtl' : 'ltr';
    }
    return normalized;
  }

  function translatableNodes(rootNode, selector) {
    const values = [];
    if (!rootNode) return values;
    if (rootNode.matches && rootNode.matches(selector)) values.push(rootNode);
    if (rootNode.querySelectorAll) values.push(...rootNode.querySelectorAll(selector));
    return values;
  }

  function setElementText(element, value) {
    const next = String(value == null ? '' : value);
    if (element.textContent !== next) element.textContent = next;
  }

  function setElementAttribute(element, attribute, value) {
    const next = String(value == null ? '' : value);
    if (element.getAttribute(attribute) !== next) element.setAttribute(attribute, next);
  }

  function translateDom(rootNode) {
    const doc = root.document;
    const scope = rootNode || doc;
    if (!scope) return;
    translatableNodes(scope, '[data-i18n]').forEach(element => setElementText(element, t(element.dataset.i18n)));
    const attributes = [
      ['data-i18n-placeholder', 'placeholder'],
      ['data-i18n-aria-label', 'aria-label'],
      ['data-i18n-title', 'title']
    ];
    attributes.forEach(([selector, attribute]) => {
      translatableNodes(scope, '[' + selector + ']').forEach(element => setElementAttribute(element, attribute, t(element.getAttribute(selector))));
    });
    translateModuleDom(scope);
  }

  function flattenEnglish(value, prefix, out) {
    Object.entries(value || {}).forEach(([name, child]) => {
      const key = prefix ? prefix + '.' + name : name;
      if (typeof child === 'string') {
        if (!child.includes('{{') && !out.has(child.trim())) out.set(child.trim(), key);
      } else if (child && typeof child === 'object') flattenEnglish(child, key, out);
    });
    return out;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function flattenModuleTemplates(value, prefix, out) {
    Object.entries(value || {}).forEach(([name, child]) => {
      const key = prefix ? prefix + '.' + name : name;
      if (typeof child === 'string' && child.includes('{{')) {
        const names = [];
        const parts = child.split(/({{\s*[\w.-]+\s*}})/g).filter(Boolean);
        const source = parts.map(part => {
          const match = part.match(/^{{\s*([\w.-]+)\s*}}$/);
          if (!match) return escapeRegExp(part);
          names.push(match[1]);
          return '(.+?)';
        }).join('');
        out.push({key, names, expression:new RegExp('^' + source + '$')});
      } else if (child && typeof child === 'object') {
        flattenModuleTemplates(child, key, out);
      }
    });
    return out;
  }

  function englishModuleIndex() {
    if (!moduleEnglishIndex) {
      moduleEnglishIndex = flattenEnglish(englishResources.modules || {}, 'modules', new Map());
      flattenEnglish(englishResources.screens || {}, 'screens', moduleEnglishIndex);
      flattenEnglish(englishResources.runtime || {}, 'runtime', moduleEnglishIndex);
      flattenEnglish(englishResources.status || {}, 'status', moduleEnglishIndex);
      flattenEnglish(englishResources.common || {}, 'common', moduleEnglishIndex);
    }
    return moduleEnglishIndex;
  }

  function englishModuleTemplates() {
    if (!moduleEnglishTemplates) {
      moduleEnglishTemplates = flattenModuleTemplates(englishResources.modules || {}, 'modules', []);
      flattenModuleTemplates(englishResources.runtime || {}, 'runtime', moduleEnglishTemplates);
    }
    return moduleEnglishTemplates;
  }

  function moduleKeyForText(value) {
    return englishModuleIndex().get(String(value == null ? '' : value).trim()) || '';
  }

  function moduleDescriptorForText(value) {
    const text = String(value == null ? '' : value).trim();
    const remembered = translatedDescriptors.get(text);
    if (remembered) return remembered;
    const exact = moduleKeyForText(text);
    if (exact) return {key:exact, options:{}};
    for (const template of englishModuleTemplates()) {
      const match = text.match(template.expression);
      if (!match) continue;
      const options = {};
      template.names.forEach((name, index) => { options[name] = match[index + 1]; });
      return {key:template.key, options};
    }
    return null;
  }

  function translateRuntimeString(value) {
    const raw = String(value == null ? '' : value);
    const descriptor = moduleDescriptorForText(raw);
    if (descriptor) return t(descriptor.key, descriptor.options);
    const candidates = [...englishModuleIndex().entries()]
      .filter(([key, english]) => key.startsWith('runtime.') && english.length >= 4 && raw.includes(english))
      .sort((left, right) => right[1].length - left[1].length);
    let translated = raw;
    candidates.forEach(([key, english]) => { translated = translated.replaceAll(english, t(key)); });
    return translated;
  }

  function bindRuntimeMessages() {
    if (runtimeMessagesBound) return;
    runtimeMessagesBound = true;
    ['alert','confirm','prompt'].forEach(name => {
      const original = root[name];
      if (typeof original !== 'function' || original.__itemI18nWrapped) return;
      const wrapped = function localizedNativeMessage(message, ...args) {
        return original.call(root, translateRuntimeString(message), ...args);
      };
      wrapped.__itemI18nWrapped = true;
      wrapped.__itemI18nOriginal = original;
      root[name] = wrapped;
    });
  }

  function translateModuleTextNode(node) {
    if (!node || node.nodeType !== 3 || !node.parentElement) return;
    if (/^(SCRIPT|STYLE|CODE|PRE)$/.test(node.parentElement.tagName || '')) return;
    const raw = node.nodeValue || '';
    const trimmed = raw.trim();
    if (!trimmed) return;
    let descriptor = moduleTextKeys.get(node);
    if (!descriptor) {
      descriptor = moduleDescriptorForText(trimmed);
      if (!descriptor) return;
      moduleTextKeys.set(node, descriptor);
    }
    const translated = t(descriptor.key, descriptor.options);
    if (!translated) return;
    const start = raw.match(/^\s*/)[0];
    const end = raw.match(/\s*$/)[0];
    const next = start + translated + end;
    if (node.nodeValue !== next) node.nodeValue = next;
  }

  function translateModuleAttributes(element) {
    if (!element || element.nodeType !== 1) return;
    const attributes = ['placeholder','aria-label','title'];
    let keys = moduleAttributeKeys.get(element);
    if (!keys) keys = {};
    attributes.forEach(attribute => {
      const value = element.getAttribute && element.getAttribute(attribute);
      if (!value) return;
      const descriptor = keys[attribute] || moduleDescriptorForText(value);
      if (!descriptor) return;
      keys[attribute] = descriptor;
      setElementAttribute(element, attribute, t(descriptor.key, descriptor.options));
    });
    moduleAttributeKeys.set(element, keys);
  }

  function translateModuleDom(rootNode) {
    const doc = root.document;
    if (!doc || !rootNode || !doc.createTreeWalker || typeof root.NodeFilter === 'undefined') return;
    const scopes = [];
    if (rootNode.id && MODULE_VIEW_IDS.includes(rootNode.id)) scopes.push(rootNode);
    if (rootNode.querySelectorAll) {
      MODULE_VIEW_IDS.forEach(id => {
        const found = rootNode.querySelector('#' + id);
        if (found) scopes.push(found);
      });
      if (rootNode.matches && rootNode.matches(GENERATED_UI_SELECTOR)) scopes.push(rootNode);
      rootNode.querySelectorAll(GENERATED_UI_SELECTOR).forEach(found => scopes.push(found));
    }
    [...new Set(scopes)].forEach(scope => {
      translatableNodes(scope, '[data-i18n]').forEach(element => setElementText(element, t(element.dataset.i18n)));
      translatableNodes(scope, '[data-i18n-enum]').forEach(element => {
        setElementText(element, enumLabel(element.dataset.i18nEnum, element.dataset.i18nValue));
      });
      translatableNodes(scope, '[data-i18n-placeholder]').forEach(element => setElementAttribute(element, 'placeholder', t(element.dataset.i18nPlaceholder)));
      translatableNodes(scope, '[data-i18n-aria-label]').forEach(element => setElementAttribute(element, 'aria-label', t(element.dataset.i18nAriaLabel)));
      translateModuleAttributes(scope);
      scope.querySelectorAll('*').forEach(translateModuleAttributes);
      const walker = doc.createTreeWalker(scope, root.NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) { translateModuleTextNode(node); node = walker.nextNode(); }
    });
  }

  function bindModuleObserver() {
    const doc = root.document;
    if (!doc || moduleObserver || typeof root.MutationObserver !== 'function') return;
    const target = doc.body;
    if (!target) return;
    moduleObserver = new root.MutationObserver(mutations => {
      const affectedViews = new Set();
      mutations.forEach(mutation => mutation.addedNodes.forEach(node => {
        const scope = node.nodeType === 1 ? node : node.parentElement;
        if (!scope) return;
        const view = scope.closest ? scope.closest('#' + MODULE_VIEW_IDS.join(',#') + ',' + GENERATED_UI_SELECTOR) : null;
        if (view) affectedViews.add(view);
      }));
      affectedViews.forEach(view => translateModuleDom(view));
    });
    moduleObserver.observe(target, {subtree:true,childList:true});
    translateModuleDom(doc);
  }

  function searchLocales(query) {
    const needle = String(query || '').trim().toLocaleLowerCase();
    if (!needle) return LOCALES.slice();
    return LOCALES.filter(locale => [locale.code, locale.name, locale.nativeName]
      .some(value => value.toLocaleLowerCase().includes(needle)));
  }

  function renderSelectorOptions(query) {
    const doc = root.document;
    const list = doc && doc.getElementById('language-options');
    if (!list) return;
    const selected = currentLocale();
    const matches = searchLocales(query);
    list.innerHTML = matches.length ? matches.map(locale =>
      '<button type="button" class="language-option" role="option" data-locale="' + escapeHtml(locale.code) + '" aria-selected="' + String(locale.code === selected) + '">' +
      '<span lang="' + escapeHtml(locale.code) + '">' + escapeHtml(locale.nativeName) + '</span>' +
      (locale.name === locale.nativeName ? '' : '<small>' + escapeHtml(locale.name) + '</small>') +
      '</button>'
    ).join('') : '<div class="language-empty" role="status">' + escapeHtml(t('language.noResults')) + '</div>';
  }

  function syncSelector() {
    const doc = root.document;
    if (!doc) return;
    const triggerLabel = doc.getElementById('language-current');
    if (triggerLabel) triggerLabel.textContent = localeName(currentLocale(), true);
    const trigger = doc.getElementById('language-trigger');
    if (trigger) trigger.setAttribute('aria-label', t('language.current', {language:localeName(currentLocale(), true)}));
    const input = doc.getElementById('language-search');
    if (input) input.setAttribute('placeholder', t('language.search'));
    renderSelectorOptions(input ? input.value : '');
  }

  function closeSelector(options) {
    const doc = root.document;
    const popover = doc && doc.getElementById('language-popover');
    const trigger = doc && doc.getElementById('language-trigger');
    if (popover) popover.hidden = true;
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'false');
      if (options && options.focus) trigger.focus();
    }
  }

  function openSelector() {
    const doc = root.document;
    const popover = doc && doc.getElementById('language-popover');
    const trigger = doc && doc.getElementById('language-trigger');
    const search = doc && doc.getElementById('language-search');
    if (!popover || !trigger) return;
    popover.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    renderSelectorOptions(search ? search.value : '');
    if (search) { search.focus(); search.select(); }
  }

  function bindSelector() {
    const doc = root.document;
    if (!doc || selectorBound) return;
    const trigger = doc.getElementById('language-trigger');
    const popover = doc.getElementById('language-popover');
    const search = doc.getElementById('language-search');
    const list = doc.getElementById('language-options');
    if (!trigger || !popover || !search || !list) return;
    selectorBound = true;
    trigger.addEventListener('click', event => {
      event.stopPropagation();
      popover.hidden ? openSelector() : closeSelector({focus:true});
    });
    search.addEventListener('input', () => renderSelectorOptions(search.value));
    search.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); closeSelector({focus:true}); }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const first = list.querySelector('[role="option"]');
        if (first) first.focus();
      }
    });
    list.addEventListener('click', event => {
      const option = event.target.closest('[data-locale]');
      if (option) changeLanguage(option.dataset.locale).then(() => closeSelector({focus:true}));
    });
    list.addEventListener('keydown', event => {
      const options = Array.from(list.querySelectorAll('[role="option"]'));
      const current = options.indexOf(event.target.closest('[role="option"]'));
      if (event.key === 'Escape') { event.preventDefault(); closeSelector({focus:true}); return; }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const option = event.target.closest('[data-locale]');
        if (option) changeLanguage(option.dataset.locale).then(() => closeSelector({focus:true}));
        return;
      }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && current >= 0) {
        event.preventDefault();
        options[(current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length].focus();
      }
    });
    doc.addEventListener('click', event => {
      const shell = doc.getElementById('language-selector');
      if (shell && !shell.contains(event.target)) closeSelector();
    });
    syncSelector();
  }

  async function fetchLocale(locale) {
    if (typeof root.fetch !== 'function') throw new Error('Locale loading is unavailable');
    const response = await root.fetch('/assets/locales/' + encodeURIComponent(locale) + '.json', {cache:'no-cache'});
    if (!response.ok) throw new Error('Locale file unavailable: ' + locale);
    return response.json();
  }

  async function ensureLocale(locale) {
    const normalized = normalizeLocale(locale);
    if (i18next.hasResourceBundle && i18next.hasResourceBundle(normalized, 'translation')) return normalized;
    if (normalized === DEFAULT_LOCALE && Object.keys(englishResources).length) {
      i18next.addResourceBundle(DEFAULT_LOCALE, 'translation', englishResources, true, true);
      return normalized;
    }
    try {
      const resources = await fetchLocale(normalized);
      i18next.addResourceBundle(normalized, 'translation', resources, true, true);
      return normalized;
    } catch (_) {
      return DEFAULT_LOCALE;
    }
  }

  function notify(locale) {
    if (typeof root.CustomEvent === 'function' && root.dispatchEvent) {
      root.dispatchEvent(new root.CustomEvent('item-language-change', {detail:{locale}}));
    }
  }

  async function changeLanguage(locale, options) {
    await (readyPromise || init());
    const requested = normalizeLocale(locale);
    const available = await ensureLocale(requested);
    await i18next.changeLanguage(available);
    const active = currentLocale();
    if (!options || options.persist !== false) {
      try { root.localStorage && root.localStorage.setItem(storageKey(currentUserNamespace), active); } catch (_) {}
    }
    applyDocumentLanguage(active);
    translateDom();
    syncSelector();
    notify(active);
    return active;
  }

  async function setUserNamespace(identity) {
    currentUserNamespace = normalizeNamespace(identity);
    return changeLanguage(storedLocale(currentUserNamespace) || DEFAULT_LOCALE, {persist:false});
  }

  function enumKey(value) {
    return String(value == null ? '' : value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  }

  function enumLabel(namespace, rawValue) {
    const raw = String(rawValue == null ? '' : rawValue);
    const key = 'enums.' + String(namespace || 'status') + '.' + enumKey(raw);
    return t(key, {defaultValue:raw}) || raw;
  }

  function preserveIdentifier(value) {
    return value;
  }

  function responseLanguageInstruction() {
    return t('assistant.responseLanguageInstruction', {
      language:localeName(currentLocale(), true),
      defaultValue:'Respond in {{language}}. Preserve all identifiers, codes, and request field names exactly as provided.'
    });
  }

  async function init(options) {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      const config = options || {};
      if (!i18next) throw new Error('i18next is required');
      if (config.english) englishResources = config.english;
      if (!Object.keys(englishResources).length) {
        try { englishResources = await fetchLocale(DEFAULT_LOCALE); } catch (_) { englishResources = {}; }
      }
      moduleEnglishIndex = null;
      moduleEnglishTemplates = null;
      const selected = normalizeLocale(config.locale || storedLocale('guest') || DEFAULT_LOCALE);
      let selectedResources = null;
      if (config.resources && config.resources[selected]) selectedResources = config.resources[selected];
      else if (selected !== DEFAULT_LOCALE) {
        try { selectedResources = await fetchLocale(selected); } catch (_) {}
      }
      const resources = {en:{translation:englishResources}};
      if (selectedResources) resources[selected] = {translation:selectedResources};
      await i18next.init({
        lng:selectedResources || selected === DEFAULT_LOCALE ? selected : DEFAULT_LOCALE,
        fallbackLng:DEFAULT_LOCALE,
        supportedLngs:LOCALES.map(locale => locale.code),
        nonExplicitSupportedLngs:false,
        resources,
        showSupportNotice:false,
        // Text translations are assigned with textContent. The dedicated
        // html() helper escapes interpolation values for generated markup.
        interpolation:{escapeValue:false},
        returnNull:false,
        returnEmptyString:false
      });
      applyDocumentLanguage();
      if (root.document) {
        const ready = () => { translateDom(); bindSelector(); bindModuleObserver(); bindRuntimeMessages(); };
        if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', ready, {once:true});
        else ready();
      }
      return currentLocale();
    })();
    return readyPromise;
  }

  return {
    DEFAULT_LOCALE, LOCALES, RTL_LOCALES, STORAGE_PREFIX,
    init, t, html, escapeHtml, normalizeLocale, currentLocale, localeName,
    storageKey, storedLocale, setUserNamespace, changeLanguage,
    applyDocumentLanguage, translateDom, searchLocales, renderSelectorOptions,
    bindSelector, openSelector, closeSelector, syncSelector,
    enumLabel, preserveIdentifier, responseLanguageInstruction,
    moduleKeyForText, moduleDescriptorForText, translateRuntimeString, bindRuntimeMessages,
    translateModuleDom, bindModuleObserver, MODULE_VIEW_IDS
  };
});
