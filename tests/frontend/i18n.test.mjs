import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {EN} from '../../extension/lib/translations.js';
import {setLanguage, getLanguage, t, translateText, formatAppliedTime} from '../../extension/lib/i18n.js';
import {automaticLabel, badgeFor, groupSubtitle, headline, actionLabel} from '../../extension/lib/stateModel.js';

const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
for (const [source, english] of Object.entries(EN)) {
    assert.deepEqual(placeholders(source), placeholders(english), source);
    assert.ok(!/\p{Script=Han}/u.test(english), source);
}
console.log(`ok   ${Object.keys(EN).length} English messages and matching placeholders`);

const walk = url => readdirSync(url, {withFileTypes: true}).flatMap(entry => {
    const next = new URL(entry.name + (entry.isDirectory() ? '/' : ''), url);
    return entry.isDirectory() ? walk(next) : entry.name.endsWith('.js') ? [next] : [];
});
for (const path of walk(new URL('../../extension/', import.meta.url))) {
    for (const m of readFileSync(path, 'utf8').matchAll(/\bt\(['"]([^'"\n]+)['"]/g)) {
        if (/\p{Script=Han}/u.test(m[1])) assert.ok(Object.hasOwn(EN, m[1]), `${path}: ${m[1]}`);
    }
}
console.log('ok   all literal translated UI messages have an English entry');

assert.equal(setLanguage('system', ['zh_CN.UTF-8', 'zh', 'C']), 'zh');
assert.equal(setLanguage('system', ['en_US', 'zh_CN']), 'en');
assert.equal(setLanguage('system', ['fr_FR', 'en']), 'en');
assert.equal(setLanguage('system', ['C']), 'en');
assert.equal(setLanguage('zh', ['en_US']), 'zh');
assert.equal(t('已管理 {count} 个图标', {count: 53}), '已管理 53 个图标');
assert.equal(setLanguage('en', ['zh_CN']), 'en');
assert.equal(t('已管理 {count} 个图标', {count: 53}), 'Managed icons: 53');
console.log('ok   system detection, explicit choices and number interpolation');

const codes=JSON.parse(readFileSync(new URL('../../contracts/response.schema.json',import.meta.url))).$defs.error.properties.code.enum;
for (const code of codes) assert.ok(!/\p{Script=Han}/u.test(actionLabel({code})),code);
assert.equal(automaticLabel({automatic:'on'}),'On');
assert.equal(badgeFor({action:'add_plate'}).label,'New tile');
assert.equal(groupSubtitle({action:'add_plate',classification:'glyph',target_ratio:.83,inner_target_ratio:.581}),
    'Standalone logo · Tile 83% · Logo 58%');
assert.ok(!/\p{Script=Han}/u.test(headline({installed:true,automatic:'partial',summary:{managed_icons:53},revision:'a'.repeat(64)}).main));
assert.equal(formatAppliedTime(null),'Not applied yet');
assert.equal(formatAppliedTime('invalid'),'Not applied yet');
console.log('ok   17 backend error codes, statuses, ratios and missing timestamps');
setLanguage('zh');
assert.equal(getLanguage(),'zh');
assert.equal(translateText('91'),'91');
assert.equal(translateText('DockNormalized'),'DockNormalized');
assert.equal(translateText('Saved: 83% target · ±2% tolerance · 70% inner'),
    '已保存：83% 目标 · ±2% 偏差 · 70% 内层');
assert.equal(actionLabel({code:'BUSY'}),'后台正在处理图标，请稍后重试');
console.log('ok   switching back to Chinese restores original messages');
console.log('5/5 passed');
