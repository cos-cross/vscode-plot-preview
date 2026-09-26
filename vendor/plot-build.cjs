/**
 * 文章里的函数图像:2D 曲线与 3D 曲面,可在网页上用鼠标缩放 / 旋转。
 *
 * 写法:用一个带 plot2d / plot3d 标记的围栏代码块
 *
 *   ```plot2d x=[-7,7] y=[-2,2]
 *   sin(x)
 *   cos(x)
 *   ```
 *
 *   ```plot3d x=[-5,5] y=[-5,5] grid=48
 *   sin(sqrt(x^2+y^2))
 *   ```
 *
 * 这里只做两件事:把代码块换成 <div class="plot"> 容器,把表达式和选项以 JSON 塞进去。
 * 真正的解析与绘制在 themes/cos-cross/source/js/plot.js(按需加载)。
 *
 * 关键点:
 *   1. 必须挂 after_post_render —— before_post_render 阶段代码块已经被换成
 *      <hexoPostRenderCodeBlock> 占位符,拿不到内容也不认识 figure;
 *   2. 构建期顺手把表达式编译一遍,语法错/未知符号当场在日志里报出来,
 *      不用等打开网页才发现是一张空图;
 *   3. 表达式是**纯文本**高亮(highlight.js 没有 plot2d 这个词法),所以从 HTML 里
 *      还原代码是可靠的,唯一要注意的是把 HTML 实体解回来。
 */
const path = require('node:path');
const fs = require('node:fs');

/**
 * 解析器 / 渲染核心(themes/cos-cross/source/js/plot.js)。
 *
 * 这里**不能**在顶层直接 `require(hexo.theme_dir ...)`:同一个文件还要被
 * VSCode 预览插件(见 vscode-plot-preview/)当普通模块 require,
 * 那边没有 hexo。所以改成懒加载 + 可注入。
 */
let Kit = null;
function kit() {
  if (!Kit) {
    Kit = require(path.join(__dirname, '..', 'themes', 'cos-cross', 'source', 'js', 'plot.js'));
  }
  return Kit;
}
function setKit(k) { Kit = k; }

const FIGURE_RE = /<figure class="highlight [^"]*">([\s\S]*?)<\/figure>/g;
/** 围栏代码块:匹配"同长度的闭合围栏" */
const FENCE_RE = /^(`{3,})([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gm;

let rendered = 0;
let problems = [];

/** 取走并清空攒下的问题(VSCode 预览插件按块调用时用) */
function takeProblems() {
  const out = problems.slice();
  problems = [];
  return out;
}

/* ---------- 工具 ---------- */

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** 从渲染好的 figure 里还原代码(plot 块是纯文本高亮,所以能原样还原) */
function extractCode(inner) {
  const m = inner.match(/<td class="code">([\s\S]*?)<\/td>/);
  const html = m ? m[1] : inner;
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''));
}

/** 规范化代码,用来做"源文件 ↔ 渲染结果"的配对 */
function normCode(s) {
  return String(s)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 把选项串解析成对象:x=[-5,5] y=[-1,1] grid=48 */
function parseOptions(str) {
  const out = {};
  if (!str) return out;
  const re = /([A-Za-z_]\w*)\s*=\s*(\[[^\]]*\]|[^\s]+)/g;
  let m;
  while ((m = re.exec(str))) {
    const key = m[1].toLowerCase();
    const raw = m[2];
    if (raw.startsWith('[')) {
      const nums = raw.slice(1, -1).split(',').map((v) => Number(v.trim()));
      if (nums.length === 2 && nums.every(Number.isFinite)) out[key] = nums;
    } else if (Number.isFinite(Number(raw))) {
      out[key] = Number(raw);
    } else {
      out[key] = raw;
    }
  }
  return out;
}

/** 保证区间是 [小, 大],并且有点宽度 */
function normalizeRange(v, fallback) {
  if (!Array.isArray(v) || v.length !== 2) return fallback.slice();
  let [a, b] = v;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return fallback.slice();
  if (a > b) [a, b] = [b, a];
  if (b - a < 1e-6) { a -= 0.5; b += 0.5; }
  return [a, b];
}

/* ---------- 从源文件里找出所有 plot 代码块 ---------- */

/**
 * 从一段 Markdown 文本里找出所有 plot 代码块。
 *
 * 为什么 Hexo 侧要读源文件、而不是靠渲染结果里的类名:
 * Hexo 的高亮对"没见过的语言"会统一降级成 plaintext,`plot2d` 这个类名根本留不下来;
 * 而给 highlight.js 注册自定义语言又会踩到 hexo-util 在项目里存在两份实现、
 * 行为不一致的坑。所以直接读原始 Markdown,再用**代码内容**去和渲染出来的
 * figure 配对 —— 顺序、缩进代码块、类名降级都不影响。
 */
function readPlotBlocksOf(markdown) {
  const body = String(markdown || '').replace(/^\uFEFF/, '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '');

  const blocks = [];
  for (const m of body.matchAll(FENCE_RE)) {
    const info = m[2].trim();
    const tokens = info.split(/\s+/);
    const kind = (tokens[0] || '').toLowerCase();
    if (kind !== 'plot2d' && kind !== 'plot3d') continue;
    blocks.push({
      kind: kind === 'plot3d' ? '3d' : '2d',
      optsRaw: parseOptions(tokens.slice(1).join(' ')),
      code: m[3].replace(/\s+$/, ''),
      norm: normCode(m[3]),
    });
  }
  return blocks;
}

/** Hexo 侧:按 source 路径读源文件 */
function readPlotBlocks(sourcePath) {
  if (!sourcePath) return [];
  const full = path.join(hexo.source_dir, sourcePath);
  if (!fs.existsSync(full)) return [];
  return readPlotBlocksOf(fs.readFileSync(full, 'utf8'));
}

/* ---------- 生成容器 ---------- */

function buildBlock(kind, payload, opts, rawSource, label, ratio) {
  // JSON 直接嵌在 <script> 里,把 < 转义掉才不会被当成结束标签
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');

  const hint = kind === '3d'
    ? '拖动旋转 · 滚轮缩放 · 双击重置'
    : '滚轮缩放 · 拖动平移 · 双击重置';

  // "半透明"按钮只给 3D —— 2D 曲线没有互相遮挡的问题
  const actions = [
    '    <span class="plot-actions">',
    '      <button type="button" data-plot-action="reset">重置</button>',
  ];
  if (kind === '3d') {
    actions.push('      <button type="button" data-plot-action="alpha" aria-pressed="false">半透明</button>');
  }
  actions.push('      <button type="button" data-plot-action="save">存为 PNG</button>', '    </span>');

  return [
    `<div class="plot" data-kind="${kind}" data-mount${ratio ? ` data-ratio="${ratio}"` : ''}>`,
    '  <div class="plot-bar">',
    `    <span class="plot-kind">${escapeHtml(label)}</span>`,
    `    <span class="plot-hint">${hint}</span>`,
    ...actions,
    '  </div>',
    '  <div class="plot-stage"><canvas></canvas></div>',
    `  <script type="application/json">${json}</script>`,
    `  <details class="plot-src"><summary>表达式</summary><pre>${escapeHtml(rawSource)}</pre></details>`,
    '</div>',
  ].join('\n');
}

/**
 * 把 2D 图形实际占的范围量出来。
 *
 * 作者一个范围都没写时用它来自动定窗口 —— 不然默认的 [-10,10]² 会让一个小图形
 * 只占画面一小角。显式曲线直接采样,隐式曲线用 marching squares 取线段端点,
 * 点 / 线段 / 多边形顶点照抄,约束也照常生效(被裁掉的部分不算进范围)。
 */
function contentBox2D(kept, shapes, globalConds, regionOnly, xr, yr) {
  const Kit = kit();
  const win = {
    x: xr.slice(),
    y: Array.isArray(yr) ? yr.slice() : [-10, 10],
  };
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  const add = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };

  kept.forEach((it) => {
    const mask = it.constraints.length
      ? Kit.makeMask(it.constraints.map((c) => Kit.compileConstraint(c, ['x', 'y'])))
      : null;
    try {
      if (it.type === 'explicit') {
        const series = Kit.compute2D([it.expr], { x: win.x, samples: 400, mask }).series[0];
        series.forEach((p) => add(p.x, p.y));
      } else {
        const segs = Kit.marchingSquares(Kit.compileImplicit(it.expr, ['x', 'y']),
          { x: win.x, y: win.y, nx: 60, ny: 60, mask });
        segs.forEach((sg) => { add(sg[0].x, sg[0].y); add(sg[1].x, sg[1].y); });
      }
    } catch { /* 单条算不出来不影响整体范围 */ }
  });

  if (regionOnly) {
    const mask = Kit.makeMask(globalConds.map((c) => Kit.compileConstraint(c, ['x', 'y'])));
    Kit.regionCells(mask, { x: win.x, y: win.y, nx: 60, ny: 60 })
      .forEach((c) => { add(c[0], c[1]); add(c[0] + c[2], c[1] + c[3]); });
  }

  shapes.points.forEach((p) => add(p.x, p.y));
  shapes.segments.forEach((s) => { add(s.a.x, s.a.y); add(s.b.x, s.b.y); });
  shapes.polygons.forEach((pg) => pg.points.forEach((p) => add(p.x, p.y)));

  if (!Number.isFinite(x0)) return null;
  return { x0, x1, y0, y1 };
}

/** 代码围栏信息串里认得的选项名(用来给"选项写错地方了"这种错误加提示) */
const OPTION_NAMES = new Set(['grid', 'n', 'alpha', 'opacity', 'ratio', 'equal', 'samples']);

/**
 * 有人把 `equal=1` 这类**选项**写成了代码块正文里的一行。
 * 那句话会被当成表达式解析,报出来的"未知符号"完全看不出问题在哪,所以补一句提示。
 */
function optionHint(base) {
  const m = /^([A-Za-z_]\w*)\s*=\s*\S+$/.exec(base.trim());
  if (!m || !OPTION_NAMES.has(m[1].toLowerCase())) return '';
  return `\n      ↑「${m[1]}」是选项,要写在代码围栏的**信息串**里,`
    + `比如 \`\`\`plot2d x=[-4,4] y=[-1.5,1.5] ${m[1]}=1\`,而不是写成正文的一行`;
}

/* ---------- 单个代码块 → 容器 HTML ---------- */

/**
 * 把一个 plot 代码块变成 `<div class="plot">` 容器(表达式和选项以 JSON 塞进去)。
 *
 * 返回 HTML 字符串;**返回 null 表示这块画不出来**(表达式的错会进 problems),
 * 调用方自己决定是原样留着代码块还是显示错误。
 *
 * Hexo 的过滤器和 VSCode 预览插件(VSCode 那边直接扔 markdown-it 的 fence token 进来)
 * 共用这一个函数 —— 这样"编辑器里看到的"和"网站上看到的"是同一套解析规则。
 */
function buildPlotBlock(kind, optsRaw, code, source) {
  const Kit = kit();
  {
    const all = code.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    if (!all.length) {
      problems.push(`${source}:一个 plot${kind} 代码块里没有表达式`);
      return null;
    }

    const o = optsRaw;
    const vars = kind === '3d' ? ['x', 'y', 'z'] : ['x', 'y'];

    // 按行分类。判断顺序很重要:点的写法最特殊先认,
    // 然后是比较(<=/>= 里也含 "=",必须排在等号前面),最后才是等号和显式函数。
    const items = [];        // 曲线 / 方程 / 点,各自带自己的约束
    const globalConds = [];  // 独立成行、不带 where 的约束 = 全图生效
    const shapes = [];       // 线段 / 多边形(先把引用存下来,整块扫完再解析)
    const spheres = [];      // 球面:球心引用也要等点都读完才能解析
    const wantCenters = [];  // `centers`:在每个球心/点位置打一个点
    const linkSpecs = [];    // `links(d)`:把相距 d 的两两格点连起来

    // segment(A, B) / line(A, B) / polygon(A, B, C) / face(...) / triangle(...)
    const SHAPE_RE = /^(segment|line|polygon|face|triangle)\s*\(/i;
    // centers / links(d) —— 画晶格骨架用的两个词
    const CENTERS_RE = /^centers?$/i;
    const LINKS_RE = /^(links?|bonds?)\s*\(/i;

    /**
     * `y = f(x)` / `z = f(x,y)` 这种"左边只有一个因变量"的等式,按显式函数处理。
     * 效果一样,但显式走的是逐点采样,比 marching squares / surface nets 快得多,
     * 而且不会因为"看起来像隐式"而把画布强行改成正方形。
     */
    function asExplicit(line, dep) {
      const eq = Kit.parseEquation(line);
      if (!eq.implicit) return null;
      if (eq.lhs !== dep) return null;
      let names;
      try {
        names = Kit.collectNames(Kit.parse(eq.rhs));
      } catch {
        return null;
      }
      if (names.vars[dep]) return null; // 右边又出现因变量,那就是真隐式
      return eq.rhs;
    }

    all.forEach((line) => {
      const { base, conds } = Kit.splitWhere(line);
      if (!base) return;
      conds.forEach((c) => {
        try {
          Kit.compileConstraint(c, vars);
        } catch (e) {
          problems.push(`${source}:"${c}" —— ${e.message}`);
        }
      });

      if (/^point\s*\(/i.test(base)) {
        try {
          Kit.parsePoints(base, []).forEach((p) => {
            items.push({
              type: 'point', x: p.x, y: p.y, z: p.z, label: p.label, constraints: conds,
            });
          });
        } catch (e) {
          problems.push(`${source}:"${line}" —— ${e.message}`);
        }
      } else if (CENTERS_RE.test(base)) {
        // `centers`:在每个球心(以及已定义的点)位置打一个点
        wantCenters.push({ conds, source: line.trim() });
      } else if (LINKS_RE.test(base)) {
        // `links(2)`:把相距 2 的两两格点连起来 —— 一条线画出整个相切网络
        const keyword = /^([A-Za-z_]\w*)/.exec(base)[1].toLowerCase();
        try {
          const call = Kit.parseCallArgs(base, keyword);
          if (!call) throw new Error(`没找到 ${keyword}(...)`);
          if (call.args.length !== 1) {
            throw new Error(`${keyword} 只要一个参数,写成 ${keyword}(距离),现在给了 ${call.args.length} 个`);
          }
          const d = Kit.evalConst(call.args[0], '距离');
          if (!(d > 0)) throw new Error('距离要大于 0,现在是 ' + d);
          linkSpecs.push({ d, conds, source: line.trim() });
        } catch (e) {
          problems.push(`${source}:"${line}" —— ${e.message}`);
        }
      } else if (SHAPE_RE.test(base)) {
        // 线段 / 多边形。顶点可以引用同一块里定义的点(靠标签),
        // 也可以直接写坐标。这里先原样存下引用,等整块扫完再解析 ——
        // 否则 `segment(A, B)` 写在 `point(...) A` 前面就会找不到 A。
        const keyword = /^([A-Za-z_]\w*)/.exec(base)[1].toLowerCase();
        const isSegment = keyword === 'segment' || keyword === 'line';
        try {
          const call = Kit.parseCallArgs(base, keyword);
          if (!call) throw new Error(`没找到 ${keyword}(...)`);
          const refs = call.args.map((a) => Kit.parseCoordRef(a));
          if (isSegment && refs.length !== 2) {
            throw new Error(`线段要正好两个端点,现在写了 ${refs.length} 个`);
          }
          if (!isSegment && refs.length < 3) {
            throw new Error(`多边形至少要三个顶点,现在写了 ${refs.length} 个`);
          }
          shapes.push({ kind: isSegment ? 'segment' : 'polygon', refs, conds, source: line.trim() });
        } catch (e) {
          problems.push(`${source}:"${line}" —— ${e.message}`);
        }
      } else if (/^sphere\s*\(/i.test(base)) {
        // 球面:sphere(球心, 半径) 或 sphere(x, y, z, r)
        if (kind !== '3d') {
          problems.push(`${source}:"${line}" —— 球面是 3D 的;plot2d 里请写成 x^2 + y^2 = r^2 这种方程`);
        } else {
          try {
            const call = Kit.parseCallArgs(base, 'sphere');
            if (!call) throw new Error('没找到 sphere(...)');
            const args = call.args;
            let center = null;
            let centerRef = null;
            let centerText = null;
            let radius;
            let radiusRaw;
            if (args.length === 4) {
              center = {
                x: Kit.evalConst(args[0]), y: Kit.evalConst(args[1]), z: Kit.evalConst(args[2]),
              };
              centerText = `(${args[0]}, ${args[1]}, ${args[2]})`;
              radius = Kit.evalConst(args[3], '半径');
              radiusRaw = args[3];
            } else if (args.length === 2) {
              const ref = Kit.parseCoordRef(args[0]);
              if (ref.coords) center = ref.coords; else centerRef = ref.label;
              centerText = args[0];
              radius = Kit.evalConst(args[1], '半径');
              radiusRaw = args[1];
            } else {
              throw new Error(`sphere 要么写 4 个数 sphere(x, y, z, r),`
                + `要么写 2 个 sphere(球心, r),现在给了 ${args.length} 个`);
            }
            spheres.push({ center, centerRef, centerText, radius, radiusRaw, conds, source: line.trim() });
          } catch (e) {
            problems.push(`${source}:"${line}" —— ${e.message}`);
          }
        }
      } else if (!conds.length && /<=|>=|<|>/.test(base)) {
        // 独立成行、不带 where 的约束:全图生效
        try {
          Kit.compileConstraint(base, vars);
          globalConds.push(base);
        } catch (e) {
          problems.push(`${source}:"${line}" —— ${e.message}`);
        }
      } else if (/<=|>=|<|>/.test(base)) {
        problems.push(`${source}:"${line}" —— 约束条件本身不能再跟 where`);
      } else if (base.includes('=')) {
        const dep = kind === '3d' ? 'z' : 'y';
        const asFn = asExplicit(base, dep);
        if (asFn !== null) {
          try {
            Kit.compile(asFn, kind === '3d' ? ['x', 'y'] : ['x']);
            items.push({ type: 'explicit', expr: asFn, constraints: conds });
          } catch (e) {
            problems.push(`${source}:"${line}" —— ${e.message}`);
          }
        } else {
          try {
            Kit.compileImplicit(base, kind === '3d' ? vars : ['x', 'y']);
            items.push({ type: 'implicit', expr: base, constraints: conds });
          } catch (e) {
            problems.push(`${source}:"${line}" —— ${e.message}${optionHint(base)}`);
          }
        }
      } else {
        try {
          Kit.compile(base, kind === '3d' ? ['x', 'y'] : ['x']);
          items.push({ type: 'explicit', expr: base, constraints: conds });
        } catch (e) {
          problems.push(`${source}:"${line}" —— ${e.message}`);
        }
      }
    });

    // 先把点按标签建成表,再解析线段/多边形的引用 ——
    // 这样"先写图形后写点"也能正常工作。
    const byLabel = new Map();
    items.forEach((it) => {
      if (it.type !== 'point' || !it.label) return;
      if (byLabel.has(it.label)) {
        problems.push(`${source}:点的标签「${it.label}」重复定义了,引用它时用最先出现的那个`);
        return;
      }
      byLabel.set(it.label, it);
    });

    const resolve = (ref) => {
      if (ref.coords) return ref.coords;
      const p = byLabel.get(ref.label);
      if (!p) {
        const known = [...byLabel.keys()].join('、') || '(这个块里没有带标签的点)';
        throw new Error(`找不到名为「${ref.label}」的点;已定义的标签:${known}`);
      }
      return { x: p.x, y: p.y, z: p.z };
    };

    shapes.forEach((sh) => {
      try {
        const pts = sh.refs.map(resolve);
        if (sh.kind === 'segment') {
          const [a, b] = pts;
          if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-12) {
            throw new Error('线段两个端点重合了');
          }
          items.push({ type: 'segment', a, b, constraints: sh.conds });
        } else {
          items.push({ type: 'polygon', points: pts, constraints: sh.conds });
        }
      } catch (e) {
        problems.push(`${source}:"${sh.source}" —— ${e.message}`);
      }
    });

    // 球面:展开成等值面方程,归到普通的 implicit 条目里。
    // 放在这里(而不是扫描时立刻展开)是因为球心可以引用点的标签。
    const sphereCenters = [];
    spheres.forEach((sp) => {
      try {
        const c = sp.center || resolve({ label: sp.centerRef });
        const expr = Kit.sphereEquation(c, sp.radius);
        sphereCenters.push(c);
        items.push({
          type: 'implicit',
          expr,
          // 标签里写人话,而不是展开后那一长串方程。
          // 球心和半径都直接用作者写的原文 —— `r = sqrt(3)/2` 比 `r = 0.866025403784` 好读太多。
          display: `球 · 球心 ${sp.centerText} · r = ${sp.radiusRaw}`,
          constraints: sp.conds,
        });
      } catch (e) {
        problems.push(`${source}:"${sp.source}" —— ${e.message}`);
      }
    });

    /* ---------- 晶格骨架:centers / links(d) ---------- */

    // "格点" = 球心 + 显式写的点。同一个位置只算一次 ——
    // 球心常常和作者标的点重合(`point(0,0,0) O` + `sphere(O, 1)`)。
    const keyOf = (p) => `${p.x.toFixed(9)},${p.y.toFixed(9)},${p.z.toFixed(9)}`;
    const lattice = [];
    const seenLattice = new Set();
    const addLattice = (p) => {
      const k = keyOf(p);
      if (seenLattice.has(k)) return;
      seenLattice.add(k);
      lattice.push(p);
    };
    sphereCenters.forEach(addLattice);
    items.filter((it) => it.type === 'point').forEach(addLattice);

    if ((wantCenters.length || linkSpecs.length) && !lattice.length) {
      problems.push(`${source}:centers / links 需要先有球面或者点,这一块里一个都没有`);
    }

    if (wantCenters.length) {
      // 已经有标签的点不用再打一遍,免得同一个位置画两层
      const labeled = new Set(items.filter((it) => it.type === 'point' && it.label).map(keyOf));
      wantCenters.forEach((spec) => {
        lattice.forEach((p) => {
          if (labeled.has(keyOf(p))) return;
          items.push({ type: 'point', x: p.x, y: p.y, z: p.z, label: '', constraints: spec.conds });
        });
      });
    }

    if (linkSpecs.length) {
      let made = 0;
      linkSpecs.forEach((spec) => {
        Kit.linkPairs(lattice, spec.d).forEach(([i, j]) => {
          items.push({ type: 'segment', a: lattice[i], b: lattice[j], constraints: spec.conds });
          made += 1;
        });
      });
      if (made > 200) {
        problems.push(`${source}:links 生成了 ${made} 条线段,太多了拖动会卡;`
          + '限制一下范围或者把距离写准一点');
      }
    }

    // 全局约束并进每一条:语义是"先按整张图的限制裁,再按各自 where 裁"
    items.forEach((it) => { it.constraints = globalConds.concat(it.constraints); });

    const notShape = (it) => it.type === 'explicit' || it.type === 'implicit';
    const curves = items.filter(notShape);
    const points = items.filter((it) => it.type === 'point');
    const segments = items.filter((it) => it.type === 'segment');
    const polygons = items.filter((it) => it.type === 'polygon');
    const hasShape = segments.length > 0 || polygons.length > 0;

    // 整块只有独立的点/线段/多边形(既没有曲线,也不是区域模式)时,纵轴自动定范围。
    // 区域模式下不能这么做 —— 否则画布会被几个点挤成一条窄带,区域就看不出来了。
    if (kind === '2d' && (points.length || hasShape) && !curves.length && !globalConds.length
      && !Array.isArray(o.y)) {
      const ys = [
        ...points.map((p) => p.y),
        ...segments.flatMap((s) => [s.a.y, s.b.y]),
        ...polygons.flatMap((p) => p.points.map((v) => v.y)),
      ];
      if (ys.length) {
        const lo = Math.min(...ys);
        const hi = Math.max(...ys);
        const pad = Math.max((hi - lo) * 0.2, 0.5);
        o.y = [lo - pad, hi + pad];
      }
    }

    let payload;
    let label;
    let ratio = null;

    // 画布高宽比。默认 3D 是 0.78、2D 是 0.58;
    // 作者写了 ratio= 就用他的(限制在 0.4~1.4,不然布局会很难看)。
    const askedRatio = Number.isFinite(o.ratio) ? Math.max(0.4, Math.min(1.4, o.ratio)) : null;
    if (askedRatio !== null) ratio = askedRatio;

    // equal=1:强制 x、y 两个轴等长(圆不会被压成椭圆、半径长度在两个方向一致)。
    // 隐式和区域图本来就必须等比例,写了 equal=0 可以关掉。
    let askedEqual = null;
    if (Number.isFinite(o.equal)) askedEqual = o.equal !== 0;

    if (kind === '3d') {
      if (!curves.length && !points.length && !hasShape) {
        problems.push(`${source}:一个 plot3d 代码块里没有可画的式子`);
        return null;
      }
      // 一个图里可以叠多个曲面/等值面(比如正四面体堆积的四个相切球、
      // 六方最密堆积晶胞的 17 个球),上限纯粹是防手滑:再多就该拆成几张图了。
      // 32 够放下一个晶胞(六方 17 球 / 面心立方 14 球)还留了余量。
      const MAX_SURFACES = 32;
      const surfaces = curves.slice(0, MAX_SURFACES);
      if (curves.length > MAX_SURFACES) {
        problems.push(`${source}:3D 最多叠 ${MAX_SURFACES} 个曲面,超出的被忽略了`);
      }
      // 隐式方程(f(x,y,z)=0)和显式曲面(z=...)的默认范围、网格数、归一化方式都不同,
      // 混在同一个代码块里会互相打架,所以拆开判断并给个提醒。
      const anyImplicit = surfaces.some((it) => it.type === 'implicit');
      const anyExplicit = surfaces.some((it) => it.type !== 'implicit');
      if (anyImplicit && anyExplicit) {
        problems.push(`${source}:同一个 plot3d 里混了隐式方程和 z=... 曲面,建议拆成两个代码块`);
      }
      // 网格密度的上下限和渲染器共用一份(Kit.GRID_LIMITS)—— 两边各写一套
      // 就会出现"插件说最多 80、渲染器偷偷夹到 64",作者写了 80 却拿到 64 的图
      // 还完全看不出来。这里如果真要夹,就直接报出来。
      const gridKind = anyImplicit ? 'implicit' : 'explicit';
      const gridLimit = Kit.GRID_LIMITS[gridKind];
      const grid = Kit.clampGrid(o.grid, gridKind);
      if (Number.isFinite(o.grid) && Math.round(o.grid) !== grid) {
        problems.push(`${source}:grid=${o.grid} 超出${anyImplicit ? '隐式' : '显式'} 3D 允许的 `
          + `${gridLimit.min}~${gridLimit.max},按 ${grid} 处理`);
      }
      const o2 = anyImplicit
        ? {
          x: normalizeRange(o.x, [-2, 2]),
          y: normalizeRange(o.y, [-2, 2]),
          z: normalizeRange(o.z, [-2, 2]),
          grid,
        }
        : {
          x: normalizeRange(o.x, [-5, 5]),
          y: normalizeRange(o.y, [-5, 5]),
          z: Array.isArray(o.z) ? normalizeRange(o.z, [-1, 1]) : null,
          grid,
        };

      // 作者的 x/y/z 是**采样盒子**:隐式曲面的零等值面一旦伸出盒子,
      // 那一部分就被静默切掉了 —— 表现得就像"周围那几个球只剩一点点边的碎片"。
      // 这里在盒子 6 个面上探测符号变化,一旦发现被切就把盒子撑到装得下,
      // 并把建议的范围报给作者(自己写对能省下不少网格精度)。
      if (anyImplicit) {
        const fns = surfaces
          .filter((it) => it.type === 'implicit')
          .map((it) => Kit.compileImplicit(it.expr, ['x', 'y', 'z']));
        const fitBox = Kit.fitImplicitBox(fns, { x: o2.x, y: o2.y, z: o2.z });
        if (fitBox.expanded) {
          const show = (r) => `[${Number(r[0].toFixed(3))}, ${Number(r[1].toFixed(3))}]`;
          problems.push(`${source}:曲面伸出了 x/y/z 范围,有一角被切掉了。建议把范围写成 `
            + `x=${show(fitBox.x)} y=${show(fitBox.y)} z=${show(fitBox.z)}`
            + `(这次先自动撑到这么大)`);
          o2.x = fitBox.x;
          o2.y = fitBox.y;
          o2.z = fitBox.z;
        }
      }

      // 曲面透明度。作者写了 alpha= / opacity= 就用他的;
      // 没写时"多个曲面"默认半透明 —— 否则前面的曲面会把后面的全挡住,
      // 叠四个球看起来还是一个球。单个曲面保持不透明(实心的更好看)。
      const asked = Number.isFinite(o.alpha) ? o.alpha : o.opacity;
      let alpha = Number.isFinite(asked) ? Math.max(0.05, Math.min(1, asked)) : 1;
      // 默认半透明的前提是"有东西会互相遮挡":多个曲面,或者曲面/面片加起来不止一块
      const fillCount = surfaces.length + polygons.length;
      if (!Number.isFinite(asked) && fillCount > 1) alpha = 0.62;
      o2.alpha = alpha;

      payload = { items: surfaces.concat(polygons, segments, points), opts: o2 };
      const nameOf = (it) => it.display || it.expr;
      label = surfaces.length === 1
        ? (anyImplicit ? `3D 等值面 · ${nameOf(surfaces[0])}` : `3D 曲面 · z = ${nameOf(surfaces[0])}`)
        : surfaces.length
          ? `3D · ${surfaces.length} 个曲面`
          : '3D · 线段与面';
      if (alpha < 1) label += ` · 半透明 ${Math.round(alpha * 100)}%`;
      const globalCount = globalConds.length;
      if (globalCount) label += ` · ${globalCount} 个全局约束`;
      if (surfaces.some((it) => it.constraints.length > globalCount)) label += ' · 带 where';
      if (polygons.length) label += ` · ${polygons.length} 个面`;
      if (segments.length) label += ` · ${segments.length} 条线段`;
      if (points.length) label += ` · ${points.length} 个点`;
    } else {
      const hasCurves = curves.length > 0;
      // 有线段/面片时就不是"只写约束画区域"了,别再顺手把区域填上
      const regionOnly = !hasCurves && !hasShape && globalConds.length > 0;
      if (!hasCurves && !globalConds.length && !points.length && !hasShape) {
        problems.push(`${source}:一个 plot2d 代码块里没有可画的式子`);
        return null;
      }
      if (curves.length > 6) {
        problems.push(`${source}:2D 最多 6 条曲线/方程,超出的被忽略了`);
      }
      const kept = curves.slice(0, 6);
      const hasImplicit = kept.some((it) => it.type === 'implicit');

      const autoX = !Array.isArray(o.x);
      const autoY = !Array.isArray(o.y);
      const xr = normalizeRange(o.x, [-10, 10]);
      let yr = Array.isArray(o.y) ? normalizeRange(o.y, [-1, 1]) : null;
      const mustBeSquare = hasImplicit || regionOnly;

      if (autoX && autoY) {
        // 两个范围都没写:按图形实际占的地方自动取景。
        // 不这么做的话窗口是默认的 [-10,10]²,一个小图形只占画面 1/20 宽 ——
        // 就是"初始状态看着特别小"的原因。
        const box = contentBox2D(kept, { polygons, segments, points }, globalConds, regionOnly, xr, yr);
        if (box) {
          const pad = 0.08;
          const w = Math.max(box.x1 - box.x0, 1e-6);
          const h = Math.max(box.y1 - box.y0, 1e-6);
          const cx = (box.x0 + box.x1) / 2;
          const cy = (box.y0 + box.y1) / 2;
          if (mustBeSquare) {
            // 圆和区域必须横纵等比例,所以取两个方向的较大值当边长
            const span = Math.max(w, h) * (1 + 2 * pad);
            xr[0] = cx - span / 2;
            xr[1] = cx + span / 2;
            yr = [cy - span / 2, cy + span / 2];
          } else {
            xr[0] = box.x0 - w * pad;
            xr[1] = box.x1 + w * pad;
            yr = [box.y0 - h * pad, box.y1 + h * pad];
          }
        }
      } else if (mustBeSquare && !yr) {
        // 老规矩:x 写了、y 没写 → y 取和 x 一样的跨度,中心跟着 x 的中心。
        // 这样圆不会被压成椭圆。
        const cxr = (xr[0] + xr[1]) / 2;
        const half = (xr[1] - xr[0]) / 2;
        yr = [cxr - half, cxr + half];
      }

      // equal=1:强制 x、y 两个轴等长(圆在任何比例下都不会被压扁、半径在两个方向一样长)。
      if (askedEqual === true && yr) {
        const span = Math.max(xr[1] - xr[0], yr[1] - yr[0]);
        const cx = (xr[0] + xr[1]) / 2;
        const cy = (yr[0] + yr[1]) / 2;
        xr[0] = cx - span / 2;
        xr[1] = cx + span / 2;
        yr = [cy - span / 2, cy + span / 2];
        if (askedRatio === null) ratio = 1;
      }

      // 隐式曲线和区域(圆、椭圆…)必须横纵等比例,否则会被压扁。
      // 作者显式写了 ratio= 的话就尊重他(他自己知道会变形)。
      if (mustBeSquare && askedRatio === null) ratio = 1;

      payload = {
        items: kept.concat(polygons, segments, points),
        region: regionOnly ? globalConds : [],
        opts: { x: xr, y: yr, samples: Math.max(100, Math.min(2000, o.n || 900)) },
      };
      const parts = [];
      if (regionOnly) parts.push('区域');
      const nExplicit = kept.filter((it) => it.type === 'explicit').length;
      const nImplicit = kept.filter((it) => it.type === 'implicit').length;
      if (nExplicit) parts.push(`${nExplicit} 条曲线`);
      if (nImplicit) parts.push(`${nImplicit} 个方程`);
      if (globalConds.length && !regionOnly) parts.push(`${globalConds.length} 个全局约束`);
      const withWhere = kept.filter((it) => it.constraints.length > globalConds.length).length;
      if (withWhere) parts.push(`${withWhere} 条带 where`);
      if (polygons.length) parts.push(`${polygons.length} 个面`);
      if (segments.length) parts.push(`${segments.length} 条线段`);
      if (points.length) parts.push(`${points.length} 个点`);
      label = `2D · ${parts.join(' + ')}`;
    }

    rendered += 1;
    return buildBlock(kind, payload, null, code, label, ratio);
  }
}

/* ---------- Hexo 侧注册 ---------- */

// 这个文件同时被 VSCode 预览插件 require(vscode-plot-preview/)。
// 那边没有 hexo,所以注册必须在"确实在 Hexo 里"时才做 ——
// type of 一个不存在的变量是安全的,不会抛。
if (typeof hexo !== 'undefined' && hexo && hexo.extend && hexo.extend.filter) {
  hexo.extend.filter.register('after_post_render', function (data) {
    if (!data.content || data.content.indexOf('highlight') === -1) return data;

    const blocks = readPlotBlocks(data.source);
    if (!blocks.length) return data;

    // 按代码内容建索引;内容相同的块按出现顺序依次消费
    const queue = new Map();
    blocks.forEach((b) => {
      if (!queue.has(b.norm)) queue.set(b.norm, []);
      queue.get(b.norm).push(b);
    });

    data.content = data.content.replace(FIGURE_RE, (whole, inner) => {
      const code = extractCode(inner);
      const list = queue.get(normCode(code));
      if (!list || !list.length) return whole;
      const block = list.shift();
      const html = buildPlotBlock(block.kind, block.optsRaw, code, data.source);
      return html === null ? whole : html;
    });

    // 有源块但没配上 figure,说明配对失败,要说出来而不是静默失败
    queue.forEach((list) => {
      list.forEach((b) => {
        problems.push(`${data.source}:一个 plot${b.kind} 代码块没能和渲染结果配对(表达式:${b.norm.split('\n')[0]})`);
      });
    });

    return data;
  });

  hexo.extend.filter.register('after_generate', function () {
    if (rendered) hexo.log.info('plot: 生成了 %d 个函数图像', rendered);
    if (problems.length) {
      hexo.log.warn('plot: %d 个问题:', problems.length);
      problems.forEach((p) => hexo.log.warn('  - %s', p));
    }
  });

  hexo.log.info('plot: 已启用(代码围栏用 plot2d / plot3d 标记即可插入函数图像)');
}

/* ---------- 导出:Hexo 过滤器与 VSCode 预览插件共用 ---------- */

module.exports = {
  buildPlotBlock,
  buildBlock,
  parseOptions,
  normalizeRange,
  readPlotBlocksOf,
  optionHint,
  takeProblems,
  setKit,
  getProblems: () => problems,
};

