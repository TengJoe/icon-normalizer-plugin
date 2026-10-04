// SPDX-License-Identifier: GPL-3.0-or-later
// Status→copy mapping; the translator is GI-free and unit-testable in node.
// The backend is the single source of truth — this module only renders its output.
import {t} from './i18n.js';

export function supportsProfilesAndThemes(status) {
    const version = typeof status?.backend_version === 'string'
        ? status.backend_version.match(/^(\d+)\.(\d+)\.(\d+)$/) : null;
    return Boolean(version && (Number(version[1]) > 3 ||
        Number(version[1]) === 3 && Number(version[2]) >= 1));
}

export const AUTOMATIC_LABELS = {
    on: '已开启',
    off: '已关闭',
    partial: '部分开启',
    unknown: '状态未知',
};

export const CLASSIFICATION_LABELS = {
    'plate-rect': '圆角底板',
    'plate-circle': '圆形底板',
    glyph: '单体Logo',
    artwork: '不规则插画',
};

export const FILTERS = [
    { id: 'all', label: '全部' },
    { id: 'changed', label: '需调整' },
    { id: 'keep', label: '保持' },
    { id: 'skipped', label: '已跳过' },
    { id: 'plate', label: '补底板' },
    { id: 'excluded', label: '已排除' },
];

export function automaticLabel(status) {
    if (!status) return t(AUTOMATIC_LABELS.unknown);
    return t(AUTOMATIC_LABELS[status.automatic] ?? AUTOMATIC_LABELS.unknown);
}

function actionText(group, targetRatio) {
    const target = Number.isFinite(targetRatio) ? Math.round(targetRatio * 100) : null;
    switch (group?.action) {
        case 'enlarge':
            return target === null ? t('放大') : t('→ {target}%（放大）', {target});
        case 'shrink':
            return target === null ? t('缩小') : t('→ {target}%（缩小）', {target});
        case 'add_plate':
            return target === null || !Number.isFinite(group.inner_target_ratio) ? t('补充底板')
                : t('底板 {target}% · Logo {inner}%', {target, inner: Math.round(group.inner_target_ratio * 100)});
        case 'keep':
            return t('死区内 · 保留原素材');
        case 'skipped':
            return t('已跳过');
        case 'excluded':
            return t('本轮排除');
        case 'unresolved':
        case 'retain_previous':
            return t('源素材缺失');
        default:
            return '';
    }
}

export function groupSubtitle(group) {
    const cls = t(CLASSIFICATION_LABELS[group?.classification] ?? group?.classification ?? '');
    const action = actionText(group, group?.target_ratio);
    return action ? `${cls} · ${action}` : cls;
}

export function badgeFor(group) {
    switch (group?.action) {
        case 'enlarge':
        case 'shrink':
            return { label: t(group.action === 'enlarge' ? '放大' : '缩小'), css: 'badge-enlarge' };
        case 'add_plate':
            return { label: t('补底板'), css: 'badge-add-plate' };
        case 'keep':
            return { label: t('保持'), css: 'badge-keep' };
        case 'skipped':
            return { label: t('已跳过'), css: 'badge-skipped' };
        case 'excluded':
            return { label: t('已排除'), css: 'badge-skipped' };
        case 'unresolved':
        case 'retain_previous':
            return { label: t('待处理'), css: 'badge-warn' };
        default:
            return { label: '—', css: 'badge-keep' };
    }
}

export function groupMatchesFilter(group, filterId) {
    switch (filterId) {
        case 'changed':
            return ['enlarge', 'shrink'].includes(group?.action);
        case 'keep':
            return group?.action === 'keep';
        case 'skipped':
            return group?.action === 'skipped' || group?.skipped === true;
        case 'plate':
            return group?.action === 'add_plate';
        case 'excluded':
            // Leftover launchers from uninstalled software (exec_missing /
            // Hidden masks): inventory only, never normalized.
            return group?.action === 'excluded';
        case 'all':
        default:
            // Default view hides the excluded leftovers — they are noise
            // unless the user is hunting stale desktop entries.
            return group?.action !== 'excluded';
    }
}

export function groupMatchesSearch(group, needle) {
    if (!needle) return true;
    const haystack = `${group?.names?.join(' ') ?? ''} ${group?.icon_name ?? ''}`.toLowerCase();
    return haystack.includes(needle);
}

export function headline(status) {
    if (!status) return { main: t('后台状态未知'), sub: '' };
    if (status.installed === false) {
        return { main: t('后台未安装'), sub: t('请先运行 tools/install.py 安装后端') };
    }
    const bits = [t('自动维护：{status}', {status: automaticLabel(status)})];
    if (status.revision) bits.push(t('策略 {revision}', {revision: String(status.revision).slice(0, 8)}));
    if (status.recovery_pending) bits.push(t('有待恢复事务'));
    if (status.stale && status.last_apply_at) bits.push(t('结果已过期'));
    return { main: bits.join(' · '), sub: subLine(status) };
}

function subLine(status) {
    if (!status) return '';
    const theme = status.active_theme ? t('主题 {theme}', {theme: status.active_theme}) : '';
    const managed = Number.isFinite(status.summary?.managed_icons)
        ? ' · ' + t('已管理 {count} 个图标', {count: status.summary.managed_icons})
        : '';
    const applied = status.last_apply_at
        ? ' · ' + t('已应用 {time}', {time: String(status.last_apply_at).slice(0, 16).replace('T', ' ')})
        : '';
    return `${theme}${managed}${applied}`;
}

export function actionLabel(error) {
    if (!error) return t('操作失败');
    const map = {
        BUSY: '后台正在处理图标，请稍后重试',
        REVISION_CONFLICT: '策略已被其他窗口修改；请刷新后重试',
        STALE_SOURCE: '源素材已更新；请刷新扫描',
        RECOVERY_REQUIRED: '存在未完成事务；请执行一次“立即应用”以恢复',
        NOT_INSTALLED: '后台未安装',
        DEPENDENCY_MISSING: '后端依赖缺失；请查看 doctor 输出',
        INVALID_CONFIG: '配置超出允许范围',
        AUTOMATION_FAILED: 'systemd 触发器操作失败',
        TIMEOUT: '操作超时；写操作结果未确认',
        OWNERSHIP_CONFLICT: '检测到外部修改；请先复核冲突文件',
        SPAWN_FAILED: '无法启动后端进程',
        IO_ERROR: '后端通信失败',
        INTERNAL_ERROR: '后端内部错误',
        INVALID_REQUEST: '请求无效',
        UNSUPPORTED_VERSION: '协议版本不兼容',
        UNSUPPORTED_ENVIRONMENT: '当前环境不受支持',
        NOT_FOUND: '图标未找到；请重新检查',
        SOURCE_UNAVAILABLE: '源素材不可用；请重新检查',
    };
    return t(map[error.code] ?? error.message ?? '操作失败');
}

export function operationExitHint(envelope) {
    if (envelope === null || envelope === undefined) return t('结果尚未确认');
    if (envelope.ok) return '';
    return actionLabel(envelope.error);
}
