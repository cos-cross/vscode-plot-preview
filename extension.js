/**
 * VSCode 扩展入口:把 plot2d / plot3d 代码块接进自带的 Markdown 预览。
 *
 * 预览用的是 markdown-it,扩展通过 `extendMarkdownIt` 拿到它的实例。
 * 我们只覆盖 `fence` 规则:认出 plot2d / plot3d 就把它换成
 * 和博客上完全一样的 `<div class="plot">` 容器。
 *
 * 三条关键约束:
 *   1. 容器的 JSON 由 scripts/plot.js 生成(经 tools/sync-vscode-ext.mjs 同步到
 *      vendor/plot-build.cjs)—— 解析规则只有一份,"编辑器里看到的"就是"网站上看到的";
 *   2. 预览的 CSP 不允许正文里的内联 <script>,所以渲染器是靠 package.json 的
 *      `markdown.previewScripts` 注入的,那边 VSCode 会带上正确的 nonce;
 *   3. **出问题时必须能看出来卡在哪一步。** 预览里的表现只有"没画出来"一种,
 *      分不清是"扩展没激活""extendMarkdownIt 没被调用"还是"围栏没被认出来",
 *      所以这里把每一步都记到「输出 → 函数图像预览」里,并提供一个诊断命令。
 */
const path = require('node:path');

// 测试里(纯 Node)没有 vscode 模块,这里要能优雅降级
let vscode = null;
try { vscode = require('vscode'); } catch { vscode = null; }

const build = require('./vendor/plot-build.cjs');
const PLOTKIT = require('./preview/plot.js');
build.setKit(PLOTKIT);

/* ---------- 日志 ---------- */

let channel = null;
let activated = false;
let extendCalls = 0;
let fencesSeen = 0;
let fencesConverted = 0;
let fencesFailed = 0;
const recent = [];

function log(line) {
  if (channel) channel.appendLine(line);
  if (recent.length < 60) recent.push(line);
  if (!channel) console.log('[plot-preview]', line);
}

function ensureChannel() {
  if (channel || !vscode) return;
  channel = vscode.window.createOutputChannel('函数图像预览');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 画不出来时给个能看懂的红框,而不是静默留个代码块 */
function errorBox(problems, code) {
  const detail = problems.length ? escapeHtml(problems.join('\n')) : '没有解析出任何可画的式子';
  return [
    '<div class="plot-preview-error">',
    '<div class="plot-preview-error-title">这张图画不出来</div>',
    `<pre class="plot-preview-error-msg">${detail}</pre>`,
    '<div class="plot-preview-error-hint">这段代码块的内容:</div>',
    `<pre class="plot-preview-error-src">${escapeHtml(code)}</pre>`,
    '</div>',
  ].join('\n');
}

/* ---------- 激活 ---------- */

function activate(context) {
  ensureChannel();
  activated = true;

  const env = (vscode && vscode.version) || '未知';
  log(`[激活] plot-preview ${require('./package.json').version},VSCode ${env}`);
  log(`[激活] 渲染核心 ${PLOTKIT && PLOTKIT.mount ? '已加载' : '❌ 没加载到 mount'}`);
  log(`[激活] 代码块构建器 ${typeof build.buildPlotBlock === 'function' ? '已加载' : '❌ 缺失'}`);
  log(`[激活] 扩展类型 ${(vscode && vscode.env && vscode.env.remoteName) ? '远程(' + vscode.env.remoteName + ')' : '本地'}`);
  log('');

  if (context && context.subscriptions && vscode) {
    // 右下角状态栏放一个小图标:一眼就能看出扩展到底激活了没有。
    // "预览里没画出图"有一半的可能压根不是渲染问题,而是扩展没被加载 ——
    // 但预览里的表现完全一样,所以给一个不依赖翻日志的判据。
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 60);
    status.text = '$(graph) plot';
    status.tooltip = `函数图像预览已激活(v${require('./package.json').version})· 点这里看诊断`;
    status.command = 'plot-preview.diagnose';
    status.show();
    context.subscriptions.push(status);

    context.subscriptions.push(vscode.commands.registerCommand('plot-preview.diagnose', () => {
      ensureChannel();
      log('');
      log('========== 诊断 ==========');
      log(`已激活:${activated}`);
      log(`extendMarkdownIt 被调用次数:${extendCalls}`);
      log(`见过的 plot 围栏:${fencesSeen}(成功 ${fencesConverted},失败 ${fencesFailed})`);
      if (!extendCalls) {
        log('');
        log('❌ VSCode 从来没调用过 extendMarkdownIt —— 说明扩展没被 VSCode 当成');
        log('   Markdown 扩展加载。常见原因:');
        log('   1. 装完扩展没有重载窗口(VSCode 要重建 markdown-it 实例);');
        log('   2. 扩展被禁用了 / VSCode 版本低于 engines.vscode 要求;');
        log('   3. 打开的是「Markdown Preview Enhanced」之类自带预览的扩展,');
        log('      它们不走 VSCode 的 extendMarkdownIt;');
        log('   4. 用的其实是别的编辑器(Cursor / VSCodium / Trae 之类),');
        log('      扩展目录和自带预览的实现都不一样。');
      } else if (!fencesSeen) {
        log('');
        log('❌ 钩子装上了,但一次都没收到 plot 围栏。');
        log('   检查代码块围栏那一行是不是写成了 ```plot2d / ```plot3d');
        log('   (三个反引号后面紧跟语言名,不能有空格)。');
      } else {
        log('');
        log('✅ 钩子在正常工作。如果预览里还是看不到图,那就是浏览器端的问题:');
        log('   打开「帮助 → 切换开发人员工具」看 Console 有没有 [plot-preview] 报错。');
      }
      if (recent.length) {
        log('');
        log('---------- 最近的日志 ----------');
        recent.forEach((l) => log('  ' + l));
      }
      channel.show(true);
    }));
    context.subscriptions.push(channel);
  }

  return {
    extendMarkdownIt(md) {
      extendCalls += 1;
      log(`[钩子] extendMarkdownIt 第 ${extendCalls} 次被调用(markdown-it ${(md && md.version) || '?'})`);

      const defaultFence = md.renderer.rules.fence
        || ((tokens, idx, options, env2, self) => self.renderToken(tokens, idx, options));

      md.renderer.rules.fence = (tokens, idx, options, env2, self) => {
        const token = tokens[idx];
        const info = (token.info || '').trim();
        const m = /^(plot2d|plot3d)(?=\s|$)/i.exec(info);
        if (!m) return defaultFence(tokens, idx, options, env2, self);

        fencesSeen += 1;
        const kind = m[1].toLowerCase() === 'plot3d' ? '3d' : '2d';
        const optsRaw = build.parseOptions(info.slice(m[1].length).trim());
        const code = token.content.replace(/\s+$/, '');
        const where = (env2 && (env2.path || env2.fsPath)) || 'markdown';

        let html = null;
        let problems = [];
        try {
          build.takeProblems(); // 清掉上一次的
          html = build.buildPlotBlock(kind, optsRaw, code, where);
          problems = build.takeProblems();
        } catch (e) {
          problems = [`解析时抛错:${(e && e.message) || e}`];
        }

        if (html) {
          fencesConverted += 1;
          if (fencesSeen <= 20) log(`[围栏] ${kind} ${where} → 容器 ${html.length} 字节`);
          return html;
        }
        fencesFailed += 1;
        log(`[围栏] ${kind} ${where} ❌ 画不出来:${problems.join(' / ') || '没有可画的式子'}`);
        return errorBox(problems, code);
      };
      return md;
    },
  };
}

/** 给测试用:不经过 VSCode 也能拿到插件本体 */
function createMarkdownItHook() {
  return activate(null).extendMarkdownIt;
}

module.exports = { activate, createMarkdownItHook, errorBox, escapeHtml };
