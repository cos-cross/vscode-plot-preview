/**
 * 扩展自己的测试。不依赖博客仓库(装了 markdown-it 就顺带用真库跑一遍)。
 *
 *   node tools/test.mjs
 *   node tools/test.mjs <博客仓库路径>   # 顺带核对三份副本是不是最新的
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const blogDir = process.argv[2] || process.env.BLOG_DIR || '';

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`PASS  ${label}`); } else {
    fail += 1;
    console.log(`FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`);
  }
}
function skip(label) { console.log(`SKIP  ${label}`); }

/* ---------- 1. 自包含:三份副本都在,而且能加载 ---------- */

console.log('=== 仓库自包含 ===');
{
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const f of ['extension.js', 'preview/plot.js', 'preview/bootstrap.js', 'preview/plot.css', 'vendor/plot-build.cjs']) {
    ok(`有 ${f}`, existsSync(path.join(root, f)));
  }
  const kit = require(path.join(root, 'preview/plot.js'));
  ok('渲染核心能加载', typeof kit.mount === 'function' && typeof kit.boot === 'function');
  const build = require(path.join(root, 'vendor/plot-build.cjs'));
  ok('代码块构建器能加载', typeof build.buildPlotBlock === 'function');
  ok('顺手能算出式子', typeof kit.compile('sin(x)', ['x']) === 'function');
  ok('禁止 eval 时也有兜底', kit.__nativeCompile() === true && typeof kit.compileToClosures === 'function');

  // 这一条是实际踩过的坑:少了它 VSCode 不会调 extendMarkdownIt,
  // 扩展照样激活、样式照常注入,但预览里一直是代码块原文,一句报错都没有。
  ok('声明了 markdown.markdownItPlugins', pkg.contributes['markdown.markdownItPlugins'] === true);
  ok('声明了 previewScripts / previewStyles',
    pkg.contributes['markdown.previewScripts'].length > 0 && pkg.contributes['markdown.previewStyles'].length > 0);
  ok('入口写对了', pkg.main === './extension.js' && existsSync(path.join(root, pkg.main)));
  ok('没有运行时依赖(所以打包能跳过 npm ls)',
    !pkg.dependencies || Object.keys(pkg.dependencies).length === 0);

  const ignore = readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  ok('.vscodeignore 排掉了 .vsix 和 node_modules',
    ignore.includes('*.vsix') && ignore.includes('node_modules'));
}

/* ---------- 2. fence 钩子 ---------- */

console.log('\n=== markdown-it 的 fence 钩子 ===');
{
  const extension = require(path.join(root, 'extension.js'));
  const md = { renderer: { rules: {} } };
  const api = extension.activate(null);
  api.extendMarkdownIt(md);
  const self = { renderToken: () => 'DEFAULT-TOKEN' };
  const render = (info, content) => md.renderer.rules.fence([{ info, content }], 0, {}, { path: 'note.md' }, self);

  ok('plot2d 换成容器', render('plot2d x=[-3,3] y=[-3,3]', 'x^2+y^2=1').includes('data-kind="2d"'));
  ok('plot3d 换成容器', render('plot3d x=[-2,2] y=[-2,2] z=[-2,2]', 'sphere(0,0,0,1)').includes('data-kind="3d"'));
  ok('别的语言走默认渲染', render('python', 'print(1)') === 'DEFAULT-TOKEN');
  ok('plot2dfoo 不会误认', render('plot2dfoo', 'x') === 'DEFAULT-TOKEN');
  ok('表达式错时给红框', render('plot2d', 'nope(').includes('plot-preview-error'));

  let MarkdownIt = null;
  try { MarkdownIt = require('markdown-it'); } catch { /* 没装 */ }
  if (!MarkdownIt) {
    skip('用真的 markdown-it 跑一遍(装一下:`npm install`)');
  } else {
    const doc = [
      '```plot2d x=[-7,7] y=[-2,2]', 'sin(x)', '```', '',
      '```plot3d x=[-2,2] y=[-2,2] z=[-2,2] grid=24', 'sphere(0, 0, 0, 1)', '```', '',
      '```python', 'print(1)', '```',
    ].join('\n');
    const html = extension.activate(null).extendMarkdownIt(MarkdownIt({ html: true })).render(doc);
    ok('真 markdown-it 下渲染出 2 个容器', (html.match(/<div class="plot"/g) || []).length === 2);
    ok('python 代码块保留', /language-python/.test(html));
    ok('没有漏网的 plot 围栏', !/language-plot2d|language-plot3d/.test(html));
  }
}

/* ---------- 3. 和博客仓库是否一致(可选) ---------- */

console.log('\n=== 与博客仓库同步 ===');
if (!blogDir || !existsSync(path.join(blogDir, 'scripts', 'plot.js'))) {
  skip('没给博客仓库路径(用法:node tools/test.mjs <博客路径>)');
} else {
  const same = (a, b) => readFileSync(a, 'utf8') === readFileSync(b, 'utf8');
  ok('preview/plot.js 与主题一致',
    same(path.join(root, 'preview', 'plot.js'), path.join(blogDir, 'themes', 'cos-cross', 'source', 'js', 'plot.js')));
  ok('vendor/plot-build.cjs 与 scripts/plot.js 一致',
    same(path.join(root, 'vendor', 'plot-build.cjs'), path.join(blogDir, 'scripts', 'plot.js')));
  const css = readFileSync(path.join(root, 'preview', 'plot.css'), 'utf8');
  const themeCss = readFileSync(path.join(blogDir, 'themes', 'cos-cross', 'source', 'css', 'style.css'), 'utf8');
  // CSS 是抽取生成的,不好逐字节比 —— 抽查几个必须出现的片段
  ok('preview/plot.css 里有主题变量', css.includes('--grad-main') && themeCss.includes('--grad-main'));
  ok('preview/plot.css 里有绘图样式', css.includes('.plot-stage') && themeCss.includes('.plot-stage'));
}

/* ---------- 4. 打包前置条件 ---------- */

console.log('\n=== 打包 ===');
{
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  ok('有 publisher / name / 语义化版本',
    !!(pkg.publisher && pkg.name && /^\d+\.\d+\.\d+$/.test(pkg.version)),
    `${pkg.publisher}.${pkg.name}@${pkg.version}`);
  ok('声明了 engines.vscode', !!(pkg.engines && pkg.engines.vscode));
  ok('有 LICENSE 和 README', existsSync(path.join(root, 'LICENSE')) && existsSync(path.join(root, 'README.md')));
  const vsix = path.join(root, `${pkg.name}-${pkg.version}.vsix`);
  if (existsSync(vsix)) ok('打过包了,而且不是空的', readFileSync(vsix).length > 10000);
  else skip('还没打过包(`npm run package`)');
}

console.log(`\n${pass} 通过,${fail} 失败`);
process.exit(fail ? 1 : 0);
