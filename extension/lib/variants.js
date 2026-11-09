// Light/dark and accent variant resolution for the followed source theme.
// Port of backend/icon_normalizer/theme_follow.{parse_theme_variant,
// resolve_variant, resolve_system_variant}.
//
// The rules are deliberately conservative: a missing variant never switches to
// an unrelated theme, and only the standard Yaru family follows GNOME accents.
// SPDX-License-Identifier: GPL-3.0-or-later

/** GNOME accent names to Yaru colour suffixes; "" means the plain Yaru theme. */
export const YARU_ACCENTS = {
    blue: "blue", teal: "prussiangreen", green: "olive", yellow: "yellow",
    orange: "", red: "red", pink: "magenta", purple: "purple",
    slate: "sage", brown: "wartybrown",
};

const DARK_SUFFIX = /^(.*?)([-_])(dark|black)$/i;
const LIGHT_SUFFIX = /^(.*?)([-_])(light|white)$/i;

/**
 * Split a theme name into stem, separator and variant.
 *
 * @param {string} name theme name
 * @returns {{stem: string, sep: string|null, variant: string|null}}
 */
export function parseThemeVariant(name) {
    const dark = DARK_SUFFIX.exec(name);
    if (dark) return {stem: dark[1], sep: dark[2], variant: "dark"};
    const light = LIGHT_SUFFIX.exec(name);
    if (light) return {stem: light[1], sep: light[2], variant: "light"};
    return {stem: name, sep: null, variant: null};
}

/**
 * Best sibling theme for a colour scheme; falls back to the input.
 *
 * @param {string} baseTheme current source theme
 * @param {boolean} preferDark system prefers dark
 * @param {(name: string) => boolean} isInstalled installed-theme probe
 * @returns {string} the sibling to use, or baseTheme when none matches
 */
export function resolveVariant(baseTheme, preferDark, isInstalled) {
    if (!baseTheme) return baseTheme;
    const {stem, sep, variant} = parseThemeVariant(baseTheme);
    const separator = sep || "-";
    let candidates;
    if (preferDark) {
        if (variant === "dark") return baseTheme;
        candidates = [
            stem + separator + "dark", stem + separator + "Dark",
            stem + separator + "DARK", stem + "_dark", stem + "_Dark",
            stem + "-dark", stem + "-Dark",
        ];
    } else {
        if (variant === "light") return baseTheme;
        candidates = [
            stem,
            stem + separator + "light", stem + separator + "Light",
            stem + separator + "LIGHT", stem + "_light", stem + "_Light",
            stem + "-light", stem + "-Light",
        ];
    }
    const seen = new Set([baseTheme]);
    for (const candidate of candidates) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        if (isInstalled(candidate)) return candidate;
    }
    return baseTheme;
}

/**
 * Follow GNOME accents inside the Yaru family, else fall back to light/dark.
 *
 * @param {string} baseTheme current source theme
 * @param {boolean} preferDark system prefers dark
 * @param {string|null} accent GNOME accent name, e.g. "blue"
 * @param {(name: string) => boolean} isInstalled installed-theme probe
 * @returns {string} the theme to use as the new source
 */
export function resolveSystemVariant(baseTheme, preferDark, accent, isInstalled) {
    const {stem} = parseThemeVariant(baseTheme);
    const yaruNames = new Set(["Yaru"]);
    for (const value of Object.values(YARU_ACCENTS))
        if (value) yaruNames.add("Yaru-" + value);
    if (yaruNames.has(stem) && accent && Object.prototype.hasOwnProperty.call(YARU_ACCENTS, accent)) {
        const colour = YARU_ACCENTS[accent];
        const target = "Yaru" + (colour ? "-" + colour : "") + (preferDark ? "-dark" : "");
        if (isInstalled(target)) return target;
    }
    return resolveVariant(baseTheme, preferDark, isInstalled);
}
