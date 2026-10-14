# 真实预览介绍图 / Actual preview overview

`icon-normalizer-overview-actual.svg` 直接嵌入后台 `preview` 返回的原始与候选 PNG，
使用相同的 128px 画布槽位展示六款真实应用。SVG 文本与布局为原生代码，图标不经 AI 重绘。
`icon-normalizer-overview-actual.png` 使用 Rsvg/Cairo 从 SVG 渲染，分辨率为 1440 × 1030 px。

图中展示 ChatGPT、Cursor、Discord、Telegram、Chrome 和 Firefox，并逐项标注主体最长边占比。
图中参数为标准预设（88% / ±2 个百分点 / 72%），仅通过预览草稿传入，不修改用户配置。
本版的归一化指标是主体最长边与画布边长的比例，不等同于相同的视觉面积或视觉重量。

The SVG embeds the backend's original and proposed PNG responses for six real applications,
using equal 128px canvas slots. The layout and text are native SVG code; the icons are not
redrawn by AI. The PNG is rendered from the SVG with Rsvg/Cairo at 1440 × 1030 px.

Each icon is labeled with its measured longest-edge coverage. The Standard preset
(88% target, ±2 percentage points of tolerance, 72% inner logo) is supplied as a preview draft
without changing user settings. Equal longest-edge coverage does not guarantee equal
perceptual area or visual weight.

项目署名为 TengJoe。应用图标与商标归各自权利人所有，不表示第三方认可或背书。

Project attribution: TengJoe. Application icons and trademarks belong to their respective
owners; their inclusion does not imply endorsement.
