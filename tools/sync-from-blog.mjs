/**
 * 从博客仓库把绘图代码同步过来。
 *
 * 分工:**博客仓库是这些代码的源头**(渲染核心、构建期插件、以及它们的全部测试都在那边),
 * 这个扩展仓库只做"消费":把三份文件拉进来并提交,于是扩展仓库本身是自包含的 ——
 * 别人 clone 下来不需要博客仓库也能打包、能跑测试。
 *
 * 用法:
 *   node tools/sync-from-blog.mjs <博客仓库路径>
 *   BLOG_DIR=D:\path\to\blog node tools/sync-from-blog.mjs
 *   node tools/sync-from-blog.mjs <博客仓库路径> --check   # 只检查是否一致
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const checkOnly = process.argv.includes('--check');

const blog = path.resolve(args[0] || process.env.BLOG_DIR || '');
if (!blog || !existsSync(path.join(blog, 'scripts', 'plot.js'))) {
  console.error('用法:node tools/sync-from-blog.mjs <博客仓库路径>');
  console.error('  (那个路径下应该有 scripts/plot.js 和 themes/cos-cross/source/js/plot.js)');
  console.error('  也可以设环境变量 BLOG_DIR。');
  process.exit(2);
}

const themePlot = path.join(blog, 'themes', 'cos-cross', 'source', 'js', 'plot.js');
const themeCss = path.join(blog, 'themes', 'cos-cross', 'source', 'css', 'style.css');
const builder = path.join(blog, 'scripts', 'plot.js');
for (const p of [themePlot, themeCss, builder]) {
  if (!existsSync(p)) {
    console.error(`找不到 ${p} —— 路径指对了吗?`);
    process.exit(2);
  }
}

const changed = [];
function emit(rel, content) {
  const full = path.join(root, rel);
  const old = existsSync(full) ? readFileSync(full, 'utf8') : null;
  if (old === content) return;
  if (!checkOnly) {
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  changed.push(rel);
}

/* ---------- 1. 渲染核心 ---------- */
emit('preview/plot.js', readFileSync(themePlot, 'utf8'));

/* ---------- 2. 代码块 → 容器 HTML 的构建器 ---------- */
emit('vendor/plot-build.cjs', readFileSync(builder, 'utf8'));

/* ---------- 3. 样式(主题变量 + 绘图那一段 + 预览专有的报错框) ---------- */

const cssLines = readFileSync(themeCss, 'utf8').split('\n');

function blockFrom(marker) {
  const start = cssLines.findIndex((l) => l.includes(marker));
  if (start < 0) throw new Error(`style.css 里找不到 ${marker}`);
  const open = cssLines.findIndex((l, i) => i >= start && l.trimEnd().endsWith('{'));
  let end = open;
  while (end < cssLines.length && cssLines[end].trim() !== '}') end += 1;
  return cssLines.slice(start, end + 1).join('\n');
}

function section(markerText) {
  const start = cssLines.findIndex((l) => l.includes(markerText));
  if (start < 0) throw new Error(`style.css 里找不到 ${markerText}`);
  let end = start + 1;
  while (end < cssLines.length && !cssLines[end].startsWith('/* ---------- ')) end += 1;
  return cssLines.slice(start, end).join('\n').trimEnd();
}

// 变量限定在 .plot 上,不去污染 VSCode 预览的全局样式
const vars = blockFrom(':root {').replace(/^:root\s*\{/, '.plot {');
const lightVars = blockFrom('[data-theme="light"] {')
  .replace(/^\[data-theme="light"\]\s*\{/, 'body.vscode-light .plot {');
const plotSection = section('函数图像(scripts/plot.js').replace(/\[data-theme="light"\]/g, 'body.vscode-light');

const header = [
  '/*',
  ' * 自动生成,别手改 —— 改博客仓库的 themes/cos-cross/source/css/style.css,',
  ' * 然后在这个仓库里跑 `node tools/sync-from-blog.mjs <博客路径>`。',
  ' * 内容 = 主题的设计变量(限定在 .plot 上)+ 绘图那一段样式 + 预览专有的报错框。',
  ' */',
  '',
].join('\n');

/** 报错框只在预览里有(网站上解析失败是构建期报错,页面根本不会生成) */
const errorBoxCss = `
/* 预览专有:代码块解析失败时的红框(不是从主题同步来的) */
.plot-preview-error {
  border: 1px solid rgba(255, 107, 107, .5);
  border-left-width: 4px;
  border-radius: 8px;
  background: rgba(255, 107, 107, .08);
  padding: 10px 14px;
  margin: 1em 0;
  font: 13px/1.6 var(--vscode-editor-font-family, monospace);
}
.plot-preview-error-title { font-weight: 700; color: #ff6b6b; margin-bottom: 6px; }
.plot-preview-error-msg,
.plot-preview-error-src {
  margin: 6px 0 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(0, 0, 0, .25);
  white-space: pre-wrap;
  overflow-x: auto;
}
.plot-preview-error-msg { color: #ffb4b4; }
.plot-preview-error-hint { margin-top: 8px; color: var(--text-3); }
.plot-preview-error-src { color: var(--text-2); }
`;

emit('preview/plot.css', `${header}${vars}\n\n${lightVars}\n\n${plotSection}\n${errorBoxCss}`);

/* ---------- 结果 ---------- */

if (checkOnly) {
  if (changed.length) {
    console.error('❌ 和博客仓库不一致:');
    changed.forEach((c) => console.error(`   - ${c}`));
    console.error('   跑一下:node tools/sync-from-blog.mjs <博客路径>');
    process.exit(1);
  }
  console.log('✅ 三份文件和博客仓库一致');
} else if (changed.length) {
  changed.forEach((c) => console.log(`   更新  ${c}`));
  console.log(`同步完成,${changed.length} 个文件有变化。记得提交。`);
} else {
  console.log('已经是最新的。');
}
