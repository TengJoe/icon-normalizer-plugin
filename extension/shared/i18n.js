// SPDX-License-Identifier: GPL-3.0-or-later
// GI-free translation boundary shared by Shell, preferences and Node tests.
import {EN} from './translations.js';

export const LANGUAGE_CHOICES = ['system', 'zh', 'en'];
let language = 'zh';

export function setLanguage(choice = 'system', systemLanguages = ['en']) {
    if (choice === 'zh' || choice === 'en') language = choice;
    else {
        const primary = systemLanguages.find(name => name !== 'C' && name !== 'POSIX') ?? 'en';
        language = /^zh(?:[_-]|$)/i.test(primary) ? 'zh' : 'en';
    }
    return language;
}

export function initLanguage(settings, systemLanguages) {
    return setLanguage(settings.get_string('ui-language'), systemLanguages);
}

export function getLanguage() { return language; }

export function t(message, parameters = {}) {
    const template = language === 'en' ? EN[message] ?? message : message;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.hasOwn(parameters, name) ? String(parameters[name]) : match);
}

// Relabel existing UI text without replacing GTK pages or their animation state.
// Numeric-only templates are deliberately excluded: spin values are user data.
const patterns = Object.entries(EN).flatMap(([source, english]) => {
    if (!source.includes('{')) return [];
    return [source, english].flatMap(template => {
        if (template.replace(/\{\w+\}/g, '').trim().length < 3) return [];
        const names = [];
        let pattern = '';
        let position = 0;
        for (const match of template.matchAll(/\{(\w+)\}/g)) {
            pattern += template.slice(position, match.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            pattern += '(.+?)'; names.push(match[1]); position = match.index + match[0].length;
        }
        pattern += template.slice(position).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return [{source, names, regex: new RegExp('^' + pattern + '$')}];
    });
});

export function translateText(text) {
    if (Object.hasOwn(EN, text)) return t(text);
    for (const [source, english] of Object.entries(EN)) {
        if (!source.includes('{') && text === english) return t(source);
    }
    for (const {source, names, regex} of patterns) {
        const match = text.match(regex);
        if (!match) continue;
        const parameters = Object.fromEntries(names.map((name, index) => [name, match[index + 1]]));
        for (const name of ['classification', 'origin', 'preset', 'automatic', 'status']) {
            if (parameters[name]) parameters[name] = translateText(parameters[name]);
        }
        return t(source, parameters);
    }
    return text;
}

export function formatAppliedTime(value) {
    if (!value) return t('尚未应用');
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return t('尚未应用');
    return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
}
