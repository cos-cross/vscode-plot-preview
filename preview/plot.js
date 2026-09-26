/**
 * 函数图像渲染:2D 曲线 + 3D 曲面,支持鼠标缩放 / 旋转 / 平移。
 *
 * 设计取舍:没有用 plotly / three.js,而是自己实现。
 *   - 零依赖:不用往仓库里塞 1~3 MB 的库,也不用担心 CDN 在国内的速度;
 *   - 体积小:整个文件就是全部,按需加载(只有含图像的页面才引入);
 *   - 可验证:表达式解析、网格生成、投影排序这些数学核心都能在 Node 里跑单元测试,
 *     引库的话就只能"看起来对"了。
 *
 * 3D 用的是 Canvas 2D + 画家算法(按深度排序后从远到近画四边形),
 * 不是 WebGL —— 对 z = f(x,y) 这种单值高度场完全够用,而且没有 WebGL 上下文丢失
 * 、移动端兼容性这些麻烦。代价是网格密度不能太高(默认 44×44)。
 *
 * 文件末尾同时导出到 window 和 module.exports,所以同一份代码既能给浏览器用,
 * 也能在 Node 里 require 出来做测试。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PlotKit = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ============================================================
     一、表达式解析
     词法分析 → 递归下降 → 编译成 JS 函数
     ============================================================ */

  var CONSTANTS = {
    pi: Math.PI, PI: Math.PI, e: Math.E, E: Math.E, tau: Math.PI * 2,
    inf: Infinity, Infinity: Infinity,
  };

  var FUNCTIONS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
    exp: Math.exp, log: Math.log, ln: Math.log, log2: Math.log2, log10: Math.log10,
    sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, sign: Math.sign,
    floor: Math.floor, ceil: Math.ceil, round: Math.round, trunc: Math.trunc,
    min: Math.min, max: Math.max, pow: Math.pow, hypot: Math.hypot,
    mod: function (a, b) { return ((a % b) + b) % b; },
    clamp: function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); },
    // 常用数学记号
    sinc: function (x) { return x === 0 ? 1 : Math.sin(x) / x; },
    gauss: function (x, s) { s = s || 1; return Math.exp(-(x * x) / (2 * s * s)); },
  };

  var TOKEN_RE = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_]\w*)|([+\-*/^%(),])|(.))/y;

  function tokenize(src) {
    var tokens = [];
    var re = new RegExp(TOKEN_RE.source, 'y');
    var pos = 0;
    while (pos < src.length) {
      re.lastIndex = pos;
      var m = re.exec(src);
      if (!m) throw new Error('无法解析的位置:' + src.slice(pos, pos + 12));
      pos = re.lastIndex;
      if (m[1] !== undefined) tokens.push({ t: 'num', v: parseFloat(m[1]) });
      else if (m[2] !== undefined) tokens.push({ t: 'id', v: m[2] });
      else if (m[3] !== undefined) tokens.push({ t: 'op', v: m[3] });
      else throw new Error('不认识的字符:' + m[4]);
    }
    tokens.push({ t: 'eof' });
    return tokens;
  }

  function parse(src) {
    if (!src || !src.trim()) throw new Error('表达式是空的');
    var tokens = tokenize(src);
    var i = 0;

    var peek = function () { return tokens[i]; };
    var isOp = function (v) { var t = tokens[i]; return t.t === 'op' && t.v === v; };
    var eat = function (v) { if (!isOp(v)) throw new Error('缺少 "' + v + '"'); i++; };
    var isNumLike = function (t) { return t.t === 'num' || t.t === 'id' || (t.t === 'op' && t.v === '('); };

    function parseExpr() {
      var node = parseTerm();
      for (;;) {
        if (isOp('+')) { i++; node = { t: 'bin', op: '+', a: node, b: parseTerm() }; }
        else if (isOp('-')) { i++; node = { t: 'bin', op: '-', a: node, b: parseTerm() }; }
        else return node;
      }
    }

    function parseTerm() {
      var node = parseUnary();
      for (;;) {
        if (isOp('*')) { i++; node = { t: 'bin', op: '*', a: node, b: parseUnary() }; }
        else if (isOp('/')) { i++; node = { t: 'bin', op: '/', a: node, b: parseUnary() }; }
        else if (isOp('%')) { i++; node = { t: 'bin', op: '%', a: node, b: parseUnary() }; }
        // 隐式乘法:2x、3sin(x)、2(x+1)、(x+1)(x-1) 都支持
        else if (isNumLike(peek())) node = { t: 'bin', op: '*', a: node, b: parseUnary() };
        else return node;
      }
    }

    function parseUnary() {
      if (isOp('-')) { i++; return { t: 'neg', a: parseUnary() }; }
      if (isOp('+')) { i++; return parseUnary(); }
      return parsePower();
    }

    function parsePower() {
      var base = parsePrimary();
      if (isOp('^')) { i++; return { t: 'bin', op: '^', a: base, b: parseUnary() }; } // 右结合
      return base;
    }

    function parsePrimary() {
      var t = peek();
      if (t.t === 'num') { i++; return { t: 'num', v: t.v }; }
      if (t.t === 'op' && t.v === '(') {
        i++;
        var node = parseExpr();
        if (!isOp(')')) throw new Error('括号没有闭合');
        i++;
        return node;
      }
      if (t.t === 'id') {
        i++;
        var name = t.v;
        if (isOp('(')) {
          i++;
          var args = [];
          if (!isOp(')')) {
            args.push(parseExpr());
            while (isOp(',')) { i++; args.push(parseExpr()); }
          }
          if (!isOp(')')) throw new Error('函数调用缺少 ")"');
          i++;
          return { t: 'call', name: name, args: args };
        }
        return { t: 'var', name: name };
      }
      throw new Error('表达式不完整,位置:' + i);
    }

    var ast = parseExpr();
    if (peek().t !== 'eof') throw new Error('表达式后面有多余内容');
    return ast;
  }

  /** 收集表达式里用到的变量名 */
  function collectVars(node, out) {
    out = out || {};
    if (!node) return out;
    if (node.t === 'var') out[node.name] = true;
    else if (node.t === 'neg') collectVars(node.a, out);
    else if (node.t === 'bin') { collectVars(node.a, out); collectVars(node.b, out); }
    else if (node.t === 'call') node.args.forEach(function (a) { collectVars(a, out); });
    return out;
  }

  function toJS(node) {
    switch (node.t) {
      case 'num': return '(' + node.v + ')';
      case 'var': return 's.' + node.name;
      case 'neg': return '(-' + toJS(node.a) + ')';
      case 'bin':
        // 注意:数学的 ^ 是乘方,不能直接拼成 JS 的 ^(那是按位异或!)
        if (node.op === '^') {
          return 'Math.pow(' + toJS(node.a) + ',' + toJS(node.b) + ')';
        }
        return '(' + toJS(node.a) + ' ' + node.op + ' ' + toJS(node.b) + ')';
      case 'call':
        return 's.' + node.name + '(' + node.args.map(toJS).join(',') + ')';
      default: throw new Error('未知节点:' + node.t);
    }
  }

  /** 表达式里引用到的所有标识符:变量 + 函数名 */
  function collectNames(node, out) {
    out = out || { vars: {}, calls: {} };
    if (!node) return out;
    if (node.t === 'var') out.vars[node.name] = true;
    else if (node.t === 'neg') collectNames(node.a, out);
    else if (node.t === 'bin') { collectNames(node.a, out); collectNames(node.b, out); }
    else if (node.t === 'call') {
      out.calls[node.name] = true;
      node.args.forEach(function (a) { collectNames(a, out); });
    }
    return out;
  }

  /**
   * 编译隐式方程 f(x,y)=0 / f(x,y,z)=0。
   * 把 "左边 = 右边" 变成 "左边 - 右边",于是求等值线/等值面就是在求 f=0。
   */
  function parseEquation(src) {
    const parts = String(src).split('=');
    if (parts.length === 1) return { implicit: false, expr: src.trim() };
    if (parts.length !== 2) throw new Error('一个式子里只能有一个等号');
    return { implicit: true, lhs: parts[0].trim(), rhs: parts[1].trim() };
  }

  /**
   * 把 AST 编译成**嵌套闭包** —— 完全不碰 eval / new Function。
   *
   * 为什么必须有这条路:**VSCode 的 Markdown 预览 webview 禁止 unsafe-eval**
   * (CSP 里只有 `script-src 'nonce-…'`),`new Function` 会当场抛
   * "Evaluating a string as JavaScript violates the following Content Security Policy directive"。
   * 普通浏览器页面是允许的,所以网站走下面编译版(快),受限环境自动退到这一版。
   *
   * 求值顺序、NaN 传播、`^` 是乘方(不是异或)这些必须和编译版逐位一致 ——
   * tools/test-plot.mjs 里有一条逐表达式的对照测试。
   */
  function compileToClosures(node) {
    switch (node.t) {
      case 'num': { const v = node.v; return function () { return v; }; }
      case 'var': { const n = node.name; return function (s) { return s[n]; }; }
      case 'neg': { const a = compileToClosures(node.a); return function (s) { return -a(s); }; }
      case 'bin': {
        const a = compileToClosures(node.a);
        const b = compileToClosures(node.b);
        switch (node.op) {
          case '+': return function (s) { return a(s) + b(s); };
          case '-': return function (s) { return a(s) - b(s); };
          case '*': return function (s) { return a(s) * b(s); };
          case '/': return function (s) { return a(s) / b(s); };
          case '%': return function (s) { return a(s) % b(s); };
          case '^': return function (s) { return Math.pow(a(s), b(s)); };
          default: throw new Error('未知运算符:' + node.op);
        }
      }
      case 'call': {
        const name = node.name;
        const args = node.args.map(compileToClosures);
        const n = args.length;
        return function (s) {
          const f = s[name];
          if (typeof f !== 'function') return NaN;
          const xs = new Array(n);
          for (let i = 0; i < n; i++) xs[i] = args[i](s);
          return f.apply(null, xs);
        };
      }
      default: throw new Error('未知节点:' + node.t);
    }
  }

  /**
   * `new Function` 能不能用?普通页面能,限制 CSP 的 webview 里不能。
   * 载入时试一次就够了 —— 这也正是"预览里全是红框"那条报错的来源。
   */
  let NATIVE_COMPILE = (function () {
    try { return new Function('return 1')() === 1; } catch (e) { return false; }
  })();

  function compileAst(ast, allowedVars) {
    const names = collectNames(ast);

    Object.keys(names.calls).forEach((name) => {
      if (!Object.prototype.hasOwnProperty.call(FUNCTIONS, name)) {
        throw new Error('未知函数:"' + name + '"');
      }
    });
    Object.keys(names.vars).forEach((name) => {
      if (allowedVars && allowedVars.indexOf(name) !== -1) return;
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return;
      if (Object.prototype.hasOwnProperty.call(FUNCTIONS, name)) return;
      throw new Error('未知符号:"' + name + '"(可用变量:' + (allowedVars || []).join(', ') + ')');
    });

    let fn;
    if (NATIVE_COMPILE) {
      const body = 'return ' + toJS(ast) + ';';
      try {
        fn = new Function('s', body); // 代码串完全由 AST 拼出来,不含用户原始输入
      } catch (e) {
        throw new Error('表达式无法编译:' + e.message);
      }
    } else {
      // CSP 不让动态求值(VSCode 预览就是这样):退到闭包版,结果一样、只是慢些
      fn = compileToClosures(ast);
    }
    return function (scope) {
      const v = fn(scope);
      return typeof v === 'number' ? v : NaN;
    };
  }

  function compile(src, allowedVars) {
    return compileAst(parse(src), allowedVars);
  }

  function compileImplicit(src, allowedVars) {
    const eq = parseEquation(src);
    if (!eq.implicit) throw new Error('不是等式:' + src);
    return compileAst({ t: 'bin', op: '-', a: parse(eq.lhs), b: parse(eq.rhs) }, allowedVars);
  }

  /**
   * 约束条件(x < y、x+y <= z 这种)。
   *
   * 统一归一化成 "g > 0" 或 "g >= 0":
   *   a <  b   →  b - a > 0
   *   a >  b   →  a - b > 0
   *   a <= b   →  b - a >= 0
   * 这样判断就只剩一个符号问题,不用为四种写法各写一遍分支。
   *
   * 注意比较符号的匹配顺序:必须先看 <= / >=,否则会被当成 "<" 或 ">" 加个等号。
   */
  function parseConstraint(src) {
    const m = String(src).match(/<=|>=|<|>/);
    if (!m) return null;
    const lhs = src.slice(0, m.index).trim();
    const rhs = src.slice(m.index + m[0].length).trim();
    if (!lhs || !rhs) throw new Error('比较符号两边都要有式子:' + src);
    return { op: m[0], lhs, rhs };
  }

  function compileConstraint(src, allowedVars) {
    const c = parseConstraint(src);
    if (!c) throw new Error('不是约束条件:' + src);
    const leftFirst = c.op === '>' || c.op === '>=';
    const ast = {
      t: 'bin',
      op: '-',
      a: parse(leftFirst ? c.lhs : c.rhs),
      b: parse(leftFirst ? c.rhs : c.lhs),
    };
    const fn = compileAst(ast, allowedVars);
    const inclusive = c.op.length === 2;
    const test = function (scope) {
      const v = fn(scope);
      if (!Number.isFinite(v)) return false;
      return inclusive ? v >= 0 : v > 0;
    };
    test.source = src;
    return test;
  }

  /** 全部约束都满足才算通过 */
  function makeMask(tests) {
    if (!tests || !tests.length) return null;
    return function (scope) {
      for (let i = 0; i < tests.length; i++) {
        if (!tests[i](scope)) return false;
      }
      return true;
    };
  }

  /**
   * 把一行里的 "where" 子句拆出来:
   *   y = sin(x) where x > 0 and y < 1
   * → { base: "y = sin(x)", conds: ["x > 0", "y < 1"] }
   * `and` 和 `&&` 都认;没有 where 时 conds 为空数组。
   *
   * 用 \b 做词边界,免得把 `wherever` 之类的标识符也当成关键字。
   */
  function splitWhere(line) {
    const parts = String(line).split(/\s+\bwhere\b\s+/i);
    if (parts.length === 1) return { base: String(line).trim(), conds: [] };
    const conds = parts.slice(1)
      .flatMap((s) => s.split(/\s+(?:and|&&)\s+/i))
      .map((s) => s.trim())
      .filter(Boolean);
    return { base: parts[0].trim(), conds };
  }

  /**
   * 单独的点,坐标在**构建期**就求好(写成字符串带过来,浏览器端不重复解析)。
   * 支持 point(1, 2) / point(1, 2, 3),后面可以跟一个标签:point(1,2) A
   */
  /**
   * 从 `point(` 之后找出配对的那个右括号。
   * 不能拿正则 `[^,()]+` 硬凑 —— 坐标里完全可以出现括号(比如 sqrt(3)/2),
   * 那样整个 point 都会被判成"写错了"。所以老老实实数括号层数。
   */
  function matchParen(s, open) {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /** 按顶层逗号切分(括号里的逗号不算分隔符,支持 point(min(1,2), 3)) */
  function splitTopLevel(s) {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of s) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map((v) => v.trim()).filter((v) => v !== '');
  }

  /**
   * 取出 text 里第一个 `name(...)` 调用,返回括号内按顶层逗号切开的参数。
   * `segment(A, B)` / `polygon(A, B, C)` 这类写法都靠它。
   */
  function parseCallArgs(text, name) {
    const re = new RegExp('(?:^|[^A-Za-z0-9_])' + name + '\\s*\\(', 'i');
    const m = re.exec(text);
    if (!m) return null;
    const open = m.index + m[0].length - 1;
    const close = matchParen(text, open);
    if (close < 0) throw new Error(name + ' 的括号没有闭合:' + text.trim());
    return { args: splitTopLevel(text.slice(open + 1, close)) };
  }

  /** 把一段文本当常量表达式算出来(球心坐标、半径这些都用它) */
  function evalConst(src, what) {
    const label = what || '坐标';
    let v;
    try {
      v = compileAst(parse(String(src).trim()), [])(makeScope([]));
    } catch (e) {
      // 加上下文,不然「未知符号:x」看不出是哪个参数出的问题。
      // 这里的变量表永远是空的,编译器那句「(可用变量:)」读起来莫名其妙,顺手换掉。
      const msg = String(e.message).replace('(可用变量:)', '(这里只能写常量,不能用变量)');
      throw new Error(label + '不对:' + msg);
    }
    if (!Number.isFinite(v)) throw new Error(label + '算不出有限值:' + src);
    return v;
  }

  /**
   * 打印一个数,顺手把浮点噪声抹掉。
   * `sqrt(2)^2` 在双精度里是 2.0000000000000004,直接写进方程里很难看;
   * 1e-12 以内的偏差没有任何几何意义,按整数显示。
   */
  function fmtNum(v) {
    if (Number.isInteger(v)) return String(v);
    const r = Math.round(v);
    if (Math.abs(v - r) < 1e-12) return String(r);
    const p = Number(v.toPrecision(12));
    return String(p);
  }

  /**
   * 球面:给定球心和半径,展开成隐式方程
   *   (x-a)² + (y-b)² + (z-c)² = r²
   *
   * 为什么要展开成方程、而不是另开一种图元:
   * 展开之后走的就是现成的等值面那条路 —— surface nets 提取、`where` 裁剪、
   * 多曲面深度排序、半透明……全都不用改一行。少一条代码路径就少一类 bug。
   */
  function sphereEquation(center, radius) {
    if (!(radius > 0)) throw new Error('球的半径要大于 0,现在是 ' + radius);
    const axis = (name, c) => {
      if (c === 0) return name;
      return c < 0 ? `(${name}+${fmtNum(-c)})` : `(${name}-${fmtNum(c)})`;
    };
    return `${axis('x', center.x)}^2+${axis('y', center.y)}^2+${axis('z', center.z)}^2=${fmtNum(radius * radius)}`;
  }

  /**
   * 线段/多边形的顶点有两种写法:
   *   A           —— 引用同一块里 `point(...) A` 定义的标签
   *   (1, 2, 3)   —— 直接写常量坐标
   * 光写 `1, 2` 是不行的:分不清那到底是标签还是坐标,索性要求坐标必须带括号。
   */
  function parseCoordRef(arg) {
    const s = String(arg).trim();
    if (s.startsWith('(') && s.endsWith(')')) {
      const vals = splitTopLevel(s.slice(1, -1)).map((c) => evalConst(c));
      if (vals.length < 2 || vals.length > 3) throw new Error('坐标要写两个或三个:' + s);
      return { coords: { x: vals[0], y: vals[1], z: vals.length > 2 ? vals[2] : 0 } };
    }
    if (!/^[A-Za-z_]\w*$/.test(s)) {
      throw new Error(`不认识的顶点「${s}」:要么引用点的标签(如 A),要么直接写坐标(如 (1, 2, 0))`);
    }
    return { label: s };
  }

  function parsePoints(src, allowedVars) {
    const out = [];
    const text = String(src);
    const finder = /point\s*\(/gi;
    let m;
    while ((m = finder.exec(text))) {
      const open = m.index + m[0].length - 1;
      const close = matchParen(text, open);
      if (close < 0) break;
      const inner = text.slice(open + 1, close);
      // 标签是右括号后面紧跟的那一串非空白字符
      const tail = /^\s*([^\s(<]*)/.exec(text.slice(close + 1));
      const label = (tail && tail[1] ? tail[1] : '').trim();

      const scope = makeScope([]);
      const coords = splitTopLevel(inner);
      const vals = coords.map((c) => evalConst(c, '点的坐标'));
      if (vals.length < 2) throw new Error('点至少需要两个坐标:' + m[0] + inner + ')');
      if (vals.length > 3) throw new Error('点最多只能有三个坐标:' + m[0] + inner + ')');
      out.push({ x: vals[0], y: vals[1], z: vals.length > 2 ? vals[2] : 0, label });

      finder.lastIndex = close + 1;
    }
    // 写了 point( 但一个都没解析出来 —— 比如 point(1) 少了个坐标 ——
    // 这时候静默返回空列表最糟:作者以为画上了,结果什么都没有。
    const written = (String(src).match(/point\s*\(/gi) || []).length;
    if (written > out.length) {
      throw new Error('点的坐标没写对,应该形如 point(1, 2) 或 point(1, 2, 3):' + src.trim());
    }
    return out;
  }

  /**
   * 只给约束条件时,把满足条件的格子收集起来画成"区域"。
   * 一次性塞进同一条路径再 fill,叠加处不会出现两次半透明的接缝。
   */
  function regionCells(mask, opts) {
    const nx = Math.max(20, Math.min(300, opts.nx || 150));
    const ny = Math.max(20, Math.min(300, opts.ny || 150));
    const x0 = opts.x[0], x1 = opts.x[1], y0 = opts.y[0], y1 = opts.y[1];
    const dx = (x1 - x0) / nx;
    const dy = (y1 - y0) / ny;
    const scope = makeScope(['x', 'y']);
    const cells = [];
    for (let i = 0; i < nx; i++) {
      scope.x = x0 + dx * (i + 0.5);
      for (let j = 0; j < ny; j++) {
        scope.y = y0 + dy * (j + 0.5);
        if (!mask(scope)) continue;
        cells.push([x0 + dx * i, y0 + dy * j, dx, dy]);
      }
    }
    return cells;
  }

  /** 建一个带常量/函数原型的求值作用域(每次求值只改 x/y,避免反复建对象) */
  function makeScope(vars) {
    var scope = Object.create(FUNCTIONS);
    Object.keys(CONSTANTS).forEach(function (k) { scope[k] = CONSTANTS[k]; });
    (vars || []).forEach(function (v) { scope[v] = 0; });
    return scope;
  }

  /* ============================================================
     二、2D:采样
     ============================================================ */

  function compute2D(exprs, opts) {
    opts = opts || {};
    var fns = exprs.map(function (e) { return compile(e, ['x']); });
    var scope = makeScope(['x', 'y']);
    var n = opts.samples || 720;
    var x0 = opts.x[0];
    var x1 = opts.x[1];
    var mask = opts.mask || null;
    var series = fns.map(function (fn) {
      var pts = [];
      for (var i = 0; i <= n; i++) {
        var x = x0 + (x1 - x0) * (i / n);
        scope.x = x;
        var y = fn(scope);
        scope.y = y;
        // 约束条件不满足的地方直接断开,曲线就不会画到区域外面去
        var ok = Number.isFinite(y) && (!mask || mask(scope));
        pts.push(ok ? { x: x, y: y } : { x: x, y: null });
      }
      return pts;
    });
    return { exprs: exprs, series: series };
  }

  /* ============================================================
     三、3D:高度场网格
     ============================================================ */

  /**
   * 网格密度的上下限 —— **渲染器和构建期插件共用这一份**。
   *
   * 以前两边各写一套(插件说隐式最多 80、渲染器偷偷夹到 64),
   * 于是 `grid=80` 静默地给出 64 的结果,作者完全看不出来。
   * 现在只有一个真值来源,构建期还会在"你要的比上限高"时直接报警告。
   *
   * 上限不是拍脑袋定的:
   *   - 隐式(surface nets)要采样 (n+1)³ 个点,内存和时间都随 n³ 涨;
   *     n=96 时单个曲面约 90 万次求值 / 7 MB 临时数组,4 个曲面 ~0.4 秒,还是能忍的;
   *   - 显式(高度场)只要 (n+1)² 次求值,但四边形数正好是 n²,
   *     而每帧都要排序 + 逐个 fill,所以真正的瓶颈是**拖动时的帧率**而不是求值。
   */
  var GRID_LIMITS = {
    implicit: { min: 8, max: 96, def: 32 },
    explicit: { min: 4, max: 120, def: 46 },
  };

  /** 把作者写的 grid 夹进合法区间 */
  function clampGrid(asked, kind) {
    var L = GRID_LIMITS[kind];
    var want = Number.isFinite(asked) ? Math.round(asked) : L.def;
    return Math.max(L.min, Math.min(L.max, want));
  }

  function buildSurface(expr, opts) {
    opts = opts || {};
    var fn = compile(expr, ['x', 'y']);
    var scope = makeScope(['x', 'y', 'z']);
    var n = clampGrid(opts.grid, 'explicit');
    var x0 = opts.x[0], x1 = opts.x[1], y0 = opts.y[0], y1 = opts.y[1];
    var mask = opts.mask || null;

    var verts = [];
    var zmin = Infinity, zmax = -Infinity;

    for (var j = 0; j <= n; j++) {
      var row = [];
      for (var i = 0; i <= n; i++) {
        scope.x = x0 + (x1 - x0) * (i / n);
        scope.y = y0 + (y1 - y0) * (j / n);
        var z = fn(scope);
        scope.z = z;
        // 被约束排除的地方直接标成 NaN,引用到它的四边形会自动被丢掉
        if (!Number.isFinite(z) || (mask && !mask(scope))) z = NaN;
        if (Number.isFinite(z)) { if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
        row.push({ x: scope.x, y: scope.y, z: z });
      }
      verts.push(row);
    }

    if (!Number.isFinite(zmin)) { zmin = 0; zmax = 1; }
    if (zmax - zmin < 1e-9) { zmax = zmin + 1; }

    // 作者指定了 z 范围就用指定的(颜色映射更稳定)
    if (opts.z) { zmin = opts.z[0]; zmax = opts.z[1]; }

    // 归一化到 [-1,1] 的立方体里,便于统一投影和缩放
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    var cxr = (x1 - x0) / 2 || 1, cyr = (y1 - y0) / 2 || 1;

    function unitZ(z) {
      return ((z - zmin) / (zmax - zmin)) * 2 - 1;
    }

    var grid = verts.map(function (row) {
      return row.map(function (p) {
        return {
          ux: (p.x - cx) / cxr,
          uy: (p.y - cy) / cyr,
          uz: Number.isFinite(p.z) ? unitZ(p.z) : NaN,
          z: p.z,
        };
      });
    });

    return {
      expr: expr, grid: grid, n: n,
      zmin: zmin, zmax: zmax,
      range: { x: [x0, x1], y: [y0, y1] },
    };
  }

  /* ============================================================
     三之二、隐式方程:marching squares(2D 等值线)
     ============================================================ */

  /**
   * 求 f(x,y)=0 的等值线,返回线段数组。
   *
   * 做法:在网格上采样,每个小格看四个角的正负号 —— 有正有负就说明零线穿过这个格,
   * 在符号变化的边上线性插值出交点,再把交点按规则连起来。这就是 marching squares。
   *
   * 每个格子的交点个数只能是 2 或 4:
   *   - 2 个:直接连;
   *   - 4 个:是鞍点(比如 f = x·y 在原点附近),必须看格子中心值的正负才能决定
   *     该"上下连"还是"左右连"。这一步不能省 —— 省了圆锥曲线会在某些角度出现
   *     错误的交叉连线。
   */
  function marchingSquares(fn, opts) {
    const nx = Math.max(20, Math.min(400, opts.nx || 170));
    const ny = Math.max(20, Math.min(400, opts.ny || 170));
    const x0 = opts.x[0], x1 = opts.x[1], y0 = opts.y[0], y1 = opts.y[1];
    const scope = makeScope(['x', 'y']);
    const mask = opts.mask || null;

    const sample = (x, y) => {
      scope.x = x;
      scope.y = y;
      const v = fn(scope);
      return Number.isFinite(v) ? v : NaN;
    };

    // 网格采样
    const vals = [];
    for (let i = 0; i <= nx; i++) {
      const col = [];
      const xi = x0 + (x1 - x0) * (i / nx);
      for (let j = 0; j <= ny; j++) {
        col.push(sample(xi, y0 + (y1 - y0) * (j / ny)));
      }
      vals.push(col);
    }

    const px = (i) => x0 + (x1 - x0) * (i / nx);
    const py = (j) => y0 + (y1 - y0) * (j / ny);
    // 在两值之间找零点:v0 + t(v1-v0) = 0
    const cross = (ax, ay, av, bx, by, bv) => {
      const d = av - bv;
      const t = Math.abs(d) < 1e-15 ? 0.5 : av / d;
      return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t };
    };

    const segs = [];
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        // 四角:0 左下,1 右下,2 右上,3 左上
        const v0 = vals[i][j];
        const v1 = vals[i + 1][j];
        const v2 = vals[i + 1][j + 1];
        const v3 = vals[i][j + 1];
        if (!Number.isFinite(v0) || !Number.isFinite(v1)
          || !Number.isFinite(v2) || !Number.isFinite(v3)) continue;
        if ((v0 > 0) === (v1 > 0) && (v0 > 0) === (v2 > 0) && (v0 > 0) === (v3 > 0)) continue;

        const X = [px(i), px(i + 1), px(i + 1), px(i)];
        const Y = [py(j), py(j), py(j + 1), py(j + 1)];
        const V = [v0, v1, v2, v3];

        // 按边界顺序(边 0,1,2,3)收集交点,天然是环形的
        const hits = [];
        for (let e = 0; e < 4; e++) {
          const a = e, b = (e + 1) % 4;
          if ((V[a] > 0) === (V[b] > 0)) continue;
          hits.push(cross(X[a], Y[a], V[a], X[b], Y[b], V[b]));
        }

        if (hits.length === 2) {
          segs.push([hits[0], hits[1]]);
        } else if (hits.length === 4) {
          // 鞍点:用格子中心的正负号决定怎么连
          const vc = sample((px(i) + px(i + 1)) / 2, (py(j) + py(j + 1)) / 2);
          const centerInside = Number.isFinite(vc) ? vc > 0 : (v0 > 0);
          if (centerInside === (v0 > 0)) {
            segs.push([hits[0], hits[1]]);
            segs.push([hits[2], hits[3]]);
          } else {
            segs.push([hits[0], hits[3]]);
            segs.push([hits[1], hits[2]]);
          }
        }
      }
    }
    return segs.filter(function (s) {
      if (!mask) return true;
      // 两端都在允许区域里的线段才保留 —— 曲线会被约束条件干净地截断
      const a = s[0], b = s[1];
      scope.x = a.x; scope.y = a.y;
      if (!mask(scope)) return false;
      scope.x = b.x; scope.y = b.y;
      return mask(scope);
    });
  }

  /* ============================================================
     三之三、隐式方程:surface nets(3D 等值面)
     ============================================================ */

  /**
   * 求 f(x,y,z)=0 的曲面,返回 {verts, quads}。
   *
   * 用的是 naive surface nets,而不是经典的 marching cubes:
   *   - marching cubes 需要一张 256 项、每项最多 16 个索引的查找表,手抄容易错;
   *   - surface nets 每个"有符号变化的格子"只生成一个顶点(取 12 条棱上交点的平均),
   *     再对每条有符号变化的网格棱拼一个四边形。代码短得多,而且产出的正好是四边形,
   *     能直接喂给现有的画家算法渲染器。
   *
   * 法线取 f 的梯度(中心差分),比用邻接面算更准也更省事。
   *
   * 已知边界行为:如果曲面正好贴到包围盒的面上,那一圈会缺少量四边形。
   * 把范围开大一点就能避免。
   */
  function surfaceNets(fn, opts) {
    const n = clampGrid(opts.grid, 'implicit');
    const x0 = opts.x[0], x1 = opts.x[1];
    const y0 = opts.y[0], y1 = opts.y[1];
    const z0 = opts.z[0], z1 = opts.z[1];
    const dx = (x1 - x0) / n, dy = (y1 - y0) / n, dz = (z1 - z0) / n;
    const m = n + 1;

    const scope = makeScope(['x', 'y', 'z']);
    const mask = opts.mask || null;
    const at = (i, j, k) => ({ x: x0 + dx * i, y: y0 + dy * j, z: z0 + dz * k });
    const evalAt = (p) => {
      scope.x = p.x; scope.y = p.y; scope.z = p.z;
      const v = fn(scope);
      return Number.isFinite(v) ? v : NaN;
    };

    // 采样 (n+1)³
    const F = new Float64Array(m * m * m);
    const idx = (i, j, k) => (i * m + j) * m + k;
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        for (let k = 0; k < m; k++) {
          F[idx(i, j, k)] = evalAt(at(i, j, k));
        }
      }
    }

    const CORNER = [
      [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
      [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
    ];
    const EDGE = [
      [0, 1], [1, 3], [3, 2], [2, 0],
      [4, 5], [5, 7], [7, 6], [6, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];

    const cellOf = new Int32Array(n * n * n).fill(-1);
    const cidx = (i, j, k) => (i * n + j) * n + k;
    const verts = [];

    // 归一化到 [-1,1]³,渲染器只认这个立方体。
    // 三个轴共用同一个 half(取最大的那个)—— 如果各轴各归一化,
    // 非正方体的包围盒会把球拉成椭球,形状就不是原样了。
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    const half = Math.max(x1 - x0, y1 - y0, z1 - z0) / 2 || 1;
    // 渲染空间的三个半宽(x←数学 x,y←数学 z,z←数学 y),坐标轴盒子要用它画
    const ext = [(x1 - x0) / 2 / half, (z1 - z0) / 2 / half, (y1 - y0) / 2 / half];

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        for (let k = 0; k < n; k++) {
          const v = [];
          let anyNaN = false;
          let pos = 0;
          for (let c = 0; c < 8; c++) {
            const val = F[idx(i + CORNER[c][0], j + CORNER[c][1], k + CORNER[c][2])];
            if (!Number.isFinite(val)) { anyNaN = true; break; }
            v.push(val);
            if (val > 0) pos++;
          }
          if (anyNaN || pos === 0 || pos === 8) continue;

          // 12 条棱上的交点求平均 → 这个格子的顶点
          let sx = 0, sy = 0, sz = 0, cnt = 0;
          for (let e = 0; e < 12; e++) {
            const a = EDGE[e][0], b = EDGE[e][1];
            if ((v[a] > 0) === (v[b] > 0)) continue;
            const t = v[a] / (v[a] - v[b]);
            const pa = CORNER[a], pb = CORNER[b];
            sx += (pa[0] + (pb[0] - pa[0]) * t);
            sy += (pa[1] + (pb[1] - pa[1]) * t);
            sz += (pa[2] + (pb[2] - pa[2]) * t);
            cnt++;
          }
          if (!cnt) continue;

          const wx = x0 + dx * (i + sx / cnt);
          const wy = y0 + dy * (j + sy / cnt);
          const wz = z0 + dz * (k + sz / cnt);

          // 约束条件在顶点处判断:不满足就不生成这个顶点,
          // 引用它的四边形自然消失 —— 曲面被切掉一块(切口是格子级的锯齿)
          if (mask) {
            scope.x = wx; scope.y = wy; scope.z = wz;
            if (!mask(scope)) continue;
          }

          // 梯度当法线(中心差分)
          const h = Math.min(dx, dy, dz) * 0.35;
          const gx = evalAt({ x: wx + h, y: wy, z: wz }) - evalAt({ x: wx - h, y: wy, z: wz });
          const gy = evalAt({ x: wx, y: wy + h, z: wz }) - evalAt({ x: wx, y: wy - h, z: wz });
          const gz = evalAt({ x: wx, y: wy, z: wz + h }) - evalAt({ x: wx, y: wy, z: wz - h });
          const gl = Math.hypot(gx, gy, gz) || 1;

          cellOf[cidx(i, j, k)] = verts.length;
          verts.push({
            x: (wx - cx) / half,
            y: (wz - cz) / half, // 数学的 z 映射到渲染空间的"上"
            z: (wy - cy) / half, // 数学的 y 映射到渲染空间的深度
            // 颜色参数用数学 z(高度)归一化,球面这种按高度上色好看
            t: (wz - z0) / (z1 - z0 || 1),
            nx: gx / gl, ny: gz / gl, nz: gy / gl,
          });
        }
      }
    }

    // 每条网格棱生成一个四边形,连接共享它的 4 个格子
    const quads = [];
    const pushQuad = (a, b, c, d) => {
      const ia = cellOf[cidx(a[0], a[1], a[2])];
      const ib = cellOf[cidx(b[0], b[1], b[2])];
      const ic = cellOf[cidx(c[0], c[1], c[2])];
      const id = cellOf[cidx(d[0], d[1], d[2])];
      if (ia < 0 || ib < 0 || ic < 0 || id < 0) return;
      quads.push([ia, ib, ic, id]);
    };

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        for (let k = 0; k < n; k++) {
          const here = F[idx(i, j, k)];
          // x 方向的棱
          if (i + 1 < m && (here > 0) !== (F[idx(i + 1, j, k)] > 0) && j >= 1 && k >= 1) {
            pushQuad([i, j - 1, k - 1], [i, j, k - 1], [i, j, k], [i, j - 1, k]);
          }
          // y 方向的棱
          if (j + 1 < m && (here > 0) !== (F[idx(i, j + 1, k)] > 0) && i >= 1 && k >= 1) {
            pushQuad([i - 1, j, k - 1], [i, j, k - 1], [i, j, k], [i - 1, j, k]);
          }
          // z 方向的棱
          if (k + 1 < m && (here > 0) !== (F[idx(i, j, k + 1)] > 0) && i >= 1 && j >= 1) {
            pushQuad([i - 1, j - 1, k], [i, j - 1, k], [i, j, k], [i - 1, j, k]);
          }
        }
      }
    }

    return { verts, quads, grid: n, ext };
  }

  /* ============================================================
     四、3D:投影
     ============================================================ */

  function rotatePoint(p, cam) {
    // 渲染空间约定:x 向右,y 向上,z 指向观察者。
    // 方位角绕"向上"的 y 轴转,仰角再绕水平轴转 ——
    // 顺序不能反,也不要把 y 混进方位角里(那等于让画面原地打滚)。
    var ca = Math.cos(cam.az), sa = Math.sin(cam.az);
    var x1 = p.x * ca + p.z * sa;
    var z1 = -p.x * sa + p.z * ca;

    var ce = Math.cos(cam.el), se = Math.sin(cam.el);
    var y2 = p.y * ce - z1 * se;
    var z2 = p.y * se + z1 * ce;

    return { x: x1, y: y2, z: z2 };
  }

  function project(p, cam, w, h) {
    var r = rotatePoint(p, cam);
    // 相机在 +z 方向距离 cam.dist 处朝 -z 看,r.z 越大离相机越近
    var d = cam.dist - r.z;
    var k = cam.focal / Math.max(d, 0.01);
    var s = Math.min(w, h) * 0.42 * cam.zoom;
    return { x: w / 2 + r.x * k * s, y: h / 2 - r.y * k * s, z: r.z, depth: d };
  }

  /** 生成待排序的四边形(带法线和平均深度) */
  function buildQuads(surface, cam, w, h, opts) {
    opts = opts || {};
    var g = surface.grid;
    var n = surface.n;
    var cx = opts.panX || 0;
    var cy = opts.panY || 0;
    var quads = [];

    var proj = function (p) {
      var q = project({ x: p.ux, y: p.uz, z: p.uy }, cam, w, h);
      // 注意:数学上的 z 映射到屏幕的"上",所以在投影时把 uz 当 y、uy 当 z
      q.x += cx;
      q.y += cy;
      return q;
    };

    for (var j = 0; j < n; j++) {
      for (var i = 0; i < n; i++) {
        var a = g[j][i], b = g[j][i + 1], c = g[j + 1][i + 1], d = g[j + 1][i];
        if (!Number.isFinite(a.uz) || !Number.isFinite(b.uz)
          || !Number.isFinite(c.uz) || !Number.isFinite(d.uz)) continue;

        var pa = proj(a), pb = proj(b), pc = proj(c), pd = proj(d);
        if (pa.depth <= 0.05 || pb.depth <= 0.05 || pc.depth <= 0.05 || pd.depth <= 0.05) continue;

        // 用平行四边形两条边做叉积求法线,给着色用
        var e1 = { x: b.ux - a.ux, y: b.uz - a.uz, z: b.uy - a.uy };
        var e2 = { x: d.ux - a.ux, y: d.uz - a.uz, z: d.uy - a.uy };
        var nx = e1.y * e2.z - e1.z * e2.y;
        var ny = e1.z * e2.x - e1.x * e2.z;
        var nz = e1.x * e2.y - e1.y * e2.x;
        var len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; } // 统一朝上

        var zAvg = (a.uz + b.uz + c.uz + d.uz) / 4;
        quads.push({
          pts: [pa, pb, pc, pd],
          depth: (pa.depth + pb.depth + pc.depth + pd.depth) / 4,
          light: Math.max(0.18, 0.55 * nx - 0.32 * ny + 0.78 * nz),
          t: (zAvg + 1) / 2,
          z: (a.z + b.z + c.z + d.z) / 4,
        });
      }
    }

    // 画家算法:远的先画
    quads.sort(function (p, q) { return q.depth - p.depth; });
    return quads;
  }

  /** 相机空间里的一束平行光(右上、略偏观察者),用来给曲面打光 */
  const LIGHT_DIR = (function () {
    const l = [0.45, 0.72, 0.53];
    const n = Math.hypot(l[0], l[1], l[2]);
    return [l[0] / n, l[1] / n, l[2] / n];
  }());

  /**
   * 把隐式曲面的四边形网格投影 + 排序。
   *
   * 和高度场那条路(buildQuads)分开写,是为了不动已经验证过的代码。
   * 光照的差别:这里把法线转到**相机空间**再和光照方向点乘,等于光跟着视角走,
   * 转动球面时明暗会在表面上正确流动,而不是像贴在物体上一样跟着转。
   */
  function projectMeshQuads(mesh, cam, w, h, opts) {
    const panX = (opts && opts.panX) || 0;
    const panY = (opts && opts.panY) || 0;
    const out = [];

    for (let qi = 0; qi < mesh.quads.length; qi++) {
      const q = mesh.quads[qi];
      const pts = [];
      let depth = 0;
      let tSum = 0;
      let light = 0;
      let ok = true;

      for (let e = 0; e < 4; e++) {
        const v = mesh.verts[q[e]];
        const sp = project({ x: v.x, y: v.y, z: v.z }, cam, w, h);
        if (sp.depth <= 0.05) { ok = false; break; }
        sp.x += panX;
        sp.y += panY;
        pts.push(sp);
        depth += sp.depth;
        tSum += v.t;
        const nCam = rotatePoint({ x: v.nx, y: v.ny, z: v.nz }, cam);
        light += nCam.x * LIGHT_DIR[0] + nCam.y * LIGHT_DIR[1] + nCam.z * LIGHT_DIR[2];
      }
      if (!ok) continue;

      out.push({
        pts,
        depth: depth / 4,
        light: Math.max(0.18, light / 4),
        t: Math.max(0, Math.min(1, tSum / 4)),
      });
    }

    out.sort((p, q) => q.depth - p.depth);
    return out;
  }

  /**
   * 拖拽 → 相机角度。抽成纯函数是为了能单测 ——
   * "拖右时物体该往哪边转"这种事只有写成可验证的规则才不会被改错。
   *
   * 手感约定:**物体跟着鼠标走**(抓住正面拖动的那种感觉),而不是相机反向绕行。
   * 投影里 x_screen = w/2 + r.x·k·s,而 az 增大时正面的点 (0,0,1) 的 r.x = sin(az) 增大,
   * 所以"拖右 → az 增大"。竖直方向同理:往下拖 → 正面往下翻、露出顶部 → el 增大。
   */
  var ORBIT_SENS = 0.008;

  function applyOrbit(cam, dx, dy) {
    return {
      az: cam.az + dx * ORBIT_SENS,
      el: Math.max(-1.5, Math.min(1.5, cam.el + dy * ORBIT_SENS)),
    };
  }

  /* ============================================================
     五、配色
     ============================================================ */

  var STOPS = [
    [0.00, [46, 230, 255]],   // cyan
    [0.50, [155, 123, 255]],  // violet
    [1.00, [255, 95, 208]],   // pink
  ];

  function colormap(t, alpha) {    t = Math.max(0, Math.min(1, t));
    for (var i = 0; i < STOPS.length - 1; i++) {
      var a = STOPS[i], b = STOPS[i + 1];
      if (t <= b[0]) {
        var k = (t - a[0]) / (b[0] - a[0] || 1);
        var r = Math.round(a[1][0] + (b[1][0] - a[1][0]) * k);
        var g = Math.round(a[1][1] + (b[1][1] - a[1][1]) * k);
        var bl = Math.round(a[1][2] + (b[1][2] - a[1][2]) * k);
        return alpha === undefined ? 'rgb(' + r + ',' + g + ',' + bl + ')'
          : 'rgba(' + r + ',' + g + ',' + bl + ',' + alpha + ')';
      }
    }
    return 'rgb(255,95,208)';
  }

  /** 把 #rrggbb 拆成 [r,g,b],给按曲面上色用 */
  function hexToRgb(hex) {
    const v = parseInt(String(hex).slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  /* ============================================================
     六、绘制
     ============================================================ */

  function niceStep(range, target) {
    var raw = range / Math.max(1, target);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
    return step * mag;
  }

  function tickLabel(v) {
    if (v === 0) return '0';
    var a = Math.abs(v);
    if (a >= 1e5 || a < 1e-4) return v.toExponential(1).replace('e+', 'e');
    var s = String(Math.round(v * 1e6) / 1e6);
    return s;
  }

  function drawAxes2D(ctx, view, w, h, theme) {
    var x2p = function (x) { return (x - view.x0) / (view.x1 - view.x0) * w; };
    var y2p = function (y) { return h - (y - view.y0) / (view.y1 - view.y0) * h; };

    var stepX = niceStep(view.x1 - view.x0, 8);
    var stepY = niceStep(view.y1 - view.y0, 5);

    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.grid;
    ctx.beginPath();
    for (var x = Math.ceil(view.x0 / stepX) * stepX; x <= view.x1; x += stepX) {
      var px = Math.round(x2p(x)) + 0.5;
      ctx.moveTo(px, 0); ctx.lineTo(px, h);
    }
    for (var y = Math.ceil(view.y0 / stepY) * stepY; y <= view.y1; y += stepY) {
      var py = Math.round(y2p(y)) + 0.5;
      ctx.moveTo(0, py); ctx.lineTo(w, py);
    }
    ctx.stroke();

    // 坐标轴
    ctx.strokeStyle = theme.axis;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    var y0p = y2p(0), x0p = x2p(0);
    if (y0p >= 0 && y0p <= h) { ctx.moveTo(0, y0p); ctx.lineTo(w, y0p); }
    if (x0p >= 0 && x0p <= w) { ctx.moveTo(x0p, 0); ctx.lineTo(x0p, h); }
    ctx.stroke();

    // 刻度数字
    ctx.fillStyle = theme.text;
    ctx.font = '11px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var labelY = Math.min(Math.max(y0p, 0), h - 14);
    for (var x2 = Math.ceil(view.x0 / stepX) * stepX; x2 <= view.x1; x2 += stepX) {
      if (Math.abs(x2) < stepX * 1e-6) continue;
      ctx.fillText(tickLabel(x2), x2p(x2), labelY + 4);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    var labelX = Math.min(Math.max(x0p, 26), w - 4);
    for (var y2 = Math.ceil(view.y0 / stepY) * stepY; y2 <= view.y1; y2 += stepY) {
      if (Math.abs(y2) < stepY * 1e-6) continue;
      ctx.fillText(tickLabel(y2), labelX - 6, y2p(y2));
    }
  }

  function render2D(ctx, canvas, state, theme) {
    var w = canvas.width / theme.dpr;
    var h = canvas.height / theme.dpr;
    ctx.setTransform(theme.dpr, 0, 0, theme.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var view = state.view;
    drawAxes2D(ctx, view, w, h, theme);

    var x2p = function (x) { return (x - view.x0) / (view.x1 - view.x0) * w; };
    var y2p = function (y) { return h - (y - view.y0) / (view.y1 - view.y0) * h; };

    // 1) 只有约束条件时,先把满足条件的区域铺一层底色。
    //    所有格子塞进同一条路径再 fill,叠加处不会出现两层半透明的接缝。
    if (state.regionCells && state.regionCells.length) {
      var sx = w / (view.x1 - view.x0);
      var sy = h / (view.y1 - view.y0);
      ctx.beginPath();
      for (var ci = 0; ci < state.regionCells.length; ci++) {
        var c = state.regionCells[ci];
        ctx.rect(x2p(c[0]), y2p(c[1] + c[3]), c[2] * sx, c[3] * sy);
      }
      ctx.fillStyle = 'rgba(46, 230, 255, .13)';
      ctx.fill();
      // 区域边界再描一遍,比格子边缘干净
      (state.regionBoundary || []).forEach(function (segs) {
        ctx.beginPath();
        for (var s = 0; s < segs.length; s++) {
          ctx.moveTo(x2p(segs[s][0].x), y2p(segs[s][0].y));
          ctx.lineTo(x2p(segs[s][1].x), y2p(segs[s][1].y));
        }
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#2ee6ff';
        ctx.shadowColor = '#2ee6ff';
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.shadowBlur = 0;
      });
    }

    // 1.5) 多边形面片垫在曲线下面(几何图里"先铺面、再画线")
    (state.polygons || []).forEach(function (face, fi) {
      var color = state.colors[fi % state.colors.length];
      ctx.beginPath();
      face.points.forEach(function (p, i) {
        var px = x2p(p.x), py = y2p(p.y);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = color;
      ctx.stroke();
    });

    // 每条曲线按自己的约束算好了,依次画(颜色按顺序分配)
    (state.renderedSeries || []).forEach(function (item, si) {
      var color = state.colors[si % state.colors.length];
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();

      if (item.kind === 'explicit') {
        var started = false;
        for (var i = 0; i < item.series.length; i++) {
          var p = item.series[i];
          if (p.y === null) { started = false; continue; }
          var px = x2p(p.x), py = y2p(p.y);
          // 纵向出界时截断,避免曲线飞出画布还拖着长线
          if (py < -h * 4 || py > h * 5) { started = false; continue; }
          if (!started) { ctx.moveTo(px, py); started = true; }
          else ctx.lineTo(px, py);
        }
      } else {
        // 隐式等值线:线段很密(每格一小段),一次性塞进同一条路径描边
        for (var s = 0; s < item.segs.length; s++) {
          var a = item.segs[s][0];
          var b = item.segs[s][1];
          ctx.moveTo(x2p(a.x), y2p(a.y));
          ctx.lineTo(x2p(b.x), y2p(b.y));
        }
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    });

    // 2.5) 线段盖在曲线之上(它是"作图辅助线",不该被函数线压住)
    var segScope2d = makeScope(['x', 'y']);
    (state.segments || []).forEach(function (seg) {
      // 约束按中点判定:整条留或整条不留。
      // 想只要一半就把它拆成两条,或者用 where 分开写。
      if (seg.mask) {
        segScope2d.x = (seg.a.x + seg.b.x) / 2;
        segScope2d.y = (seg.a.y + seg.b.y) / 2;
        if (!seg.mask(segScope2d)) return;
      }
      ctx.beginPath();
      ctx.moveTo(x2p(seg.a.x), y2p(seg.a.y));
      ctx.lineTo(x2p(seg.b.x), y2p(seg.b.y));
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffd166';
      ctx.shadowColor = '#ffd166';
      ctx.shadowBlur = 8;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.shadowBlur = 0;
    });

    // 3) 单独的点画在最上层(2D 没有遮挡问题)
    drawPoints2D(ctx, state.points || [], x2p, y2p);
  }

  function drawPoints2D(ctx, points, x2p, y2p) {
    points.forEach(function (p) {
      var px = x2p(p.x);
      var py = y2p(p.y);
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd166';
      ctx.shadowColor = '#ffd166';
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = 'rgba(7, 7, 15, .85)';
      ctx.stroke();

      if (p.label) {
        ctx.font = '600 12.5px ui-monospace, Consolas, monospace';
        ctx.fillStyle = '#ffd166';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(p.label, px + 9, py - 6);
      }
    });
  }

  /**
   * 把一个四边形从重心往外撑开 px 像素。
   *
   * 半透明填充时不能用"同色描边"去压相邻四边形之间的缝 ——
   * 描边会沿着每条棱再叠一层 alpha,整张网格线就浮出来了。
   * 改成把每个面稍微放大一点点让相邻面互相咬住,接缝就藏住了。
   */
  function inflateQuad(pts, px) {
    var cx = 0, cy = 0;
    for (var i = 0; i < 4; i++) { cx += pts[i].x; cy += pts[i].y; }
    cx /= 4; cy /= 4;
    return pts.map(function (p) {
      var dx = p.x - cx, dy = p.y - cy;
      var len = Math.hypot(dx, dy);
      if (len < 1e-6) return p;
      return { x: p.x + (dx / len) * px, y: p.y + (dy / len) * px, depth: p.depth };
    });
  }

  /** 线段按比例取点(渲染空间坐标就是普通的三维向量) */
  function lerpPoint(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  }

  /* ---------- 采样盒子装不装得下 ---------- */

  /**
   * 在某个面上采样,看函数的符号有没有变化 —— 有就说明零等值面穿过了这个面,
   * 也就是"这个面把图形切了"。
   *
   * axis 指定这个面垂直于哪个轴:0=x、1=y、2=z,value 是面的位置。
   */
  function faceCrossed(fn, axis, value, rx, ry, rz, n) {
    const scope = makeScope(['x', 'y', 'z']);
    const u = axis === 0 ? ry : rx;
    const v = axis === 2 ? ry : rz;
    const sign = (us, vs) => {
      if (axis === 0) { scope.x = value; scope.y = us; scope.z = vs; } else if (axis === 1) {
        scope.x = us; scope.y = value; scope.z = vs;
      } else { scope.x = us; scope.y = vs; scope.z = value; }
      const r = fn(scope);
      return Number.isFinite(r) ? (r > 0 ? 1 : -1) : 0;
    };
    const rowPrev = [];
    for (let i = 0; i <= n; i++) {
      const us = u[0] + (u[1] - u[0]) * (i / n);
      let leftPrev = 0;
      for (let j = 0; j <= n; j++) {
        const vs = v[0] + (v[1] - v[0]) * (j / n);
        const s = sign(us, vs);
        if (s !== 0) {
          if (leftPrev !== 0 && s !== leftPrev) return true;
          if (rowPrev[j] !== undefined && rowPrev[j] !== 0 && s !== rowPrev[j]) return true;
        }
        leftPrev = s;
        rowPrev[j] = s;
      }
    }
    return false;
  }

  var BOX_GROW = 1.2;       // 每轮撑大的倍数
  var BOX_MAX_STEPS = 10;   // 最多撑几轮(病态表达式保护)
  var BOX_FACE_RES = 14;    // 每个面的采样密度

  /**
   * 把"相距正好是 d"的两两格点配成对,返回下标对。
   *
   * 容差放宽到 d×1e-6:格点坐标常常是 `sqrt(2)`、`sqrt(8/3)` 这类算出来的,
   * 双精度下 `hypot` 出来的值可能是 2.0000000000000004,写死等号就配不上了。
   */
  function linkPairs(points, d) {
    const tol = Math.max(1e-6, Math.abs(d) * 1e-6);
    const out = [];
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i];
        const b = points[j];
        if (Math.abs(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) - d) <= tol) out.push([i, j]);
      }
    }
    return out;
  }

  /**
   * 求"刚好装得下这些隐式曲面"的采样盒子。
   *
   * 作者的 `x=` `y=` `z=` 是**采样盒子**:零等值面一旦伸到盒子外面,
   * 那一部分就直接没了 —— 表现出来就是"周围那几个球只剩一点点边的碎片",
   * 而且一声不响。这里在盒子 6 个面上采样,看每个曲面的符号有没有变化,
   * 有就把那个轴往外撑,直到装下为止。
   *
   * 每轮多给一格(`span/n`),保证曲面是**严格在内**而不是贴着面 ——
   * surface nets 在贴面的那一圈会缺面片。
   *
   * 返回 `{ x, y, z, expanded }`,ranges 的格式和 `opts.x` 一样是 `[a, b]`。
   */
  function fitImplicitBox(fns, range) {
    let x = range.x.slice();
    let y = range.y.slice();
    let z = range.z.slice();
    let expanded = false;

    const grow = (r) => {
      const c = (r[0] + r[1]) / 2;
      const half = (r[1] - r[0]) / 2;
      const nh = half * BOX_GROW + (r[1] - r[0]) / BOX_FACE_RES;
      return [c - nh, c + nh];
    };

    for (let step = 0; step < BOX_MAX_STEPS; step++) {
      let cutX = false;
      let cutY = false;
      let cutZ = false;
      for (let f = 0; f < fns.length; f++) {
        const fn = fns[f];
        if (!cutX && (faceCrossed(fn, 0, x[0], x, y, z, BOX_FACE_RES)
          || faceCrossed(fn, 0, x[1], x, y, z, BOX_FACE_RES))) cutX = true;
        if (!cutY && (faceCrossed(fn, 1, y[0], x, y, z, BOX_FACE_RES)
          || faceCrossed(fn, 1, y[1], x, y, z, BOX_FACE_RES))) cutY = true;
        if (!cutZ && (faceCrossed(fn, 2, z[0], x, y, z, BOX_FACE_RES)
          || faceCrossed(fn, 2, z[1], x, y, z, BOX_FACE_RES))) cutZ = true;
        if (cutX && cutY && cutZ) break;
      }
      if (!cutX && !cutY && !cutZ) break;

      expanded = true;
      if (cutX) x = grow(x);
      if (cutY) y = grow(y);
      if (cutZ) z = grow(z);
      if (x[1] - x[0] > 1e6 || y[1] - y[0] > 1e6 || z[1] - z[0] > 1e6) break;
    }
    return { x, y, z, expanded };
  }

  /**
   * 收集"算适配比例用的探针点"。
   *
   * 为什么不直接拿内容的包围盒 8 个角去算:盒子角上往往是空的
   * (球填在盒子里,角在外面),按盒角适配会把图形缩到画面一半大。
   * 但也不能全量收集 —— 一个晶胞动辄上万顶点 —— 所以抽稀到 1500 个,
   * 估外轮廓足够了。
   */
  function contentProbes(state, limit) {
    var cap = limit || 1500;
    var all = [];
    var push = function (x, y, z) {
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) all.push({ x: x, y: y, z: z });
    };

    (state.surfaces || []).forEach(function (s) {
      if (s.kind === 'mesh') {
        s.data.verts.forEach(function (v) { push(v.x, v.y, v.z); });
      } else {
        // 显式高度场:ux/uz/uy 就是渲染空间的三轴
        s.data.grid.forEach(function (row) {
          row.forEach(function (v) { if (Number.isFinite(v.uz)) push(v.ux, v.uz, v.uy); });
        });
      }
    });
    (state.points || []).forEach(function (p) { push(p.nx, p.ny, p.nz); });
    (state.segments || []).forEach(function (g) {
      push(g.a.x, g.a.y, g.a.z);
      push(g.b.x, g.b.y, g.b.z);
    });
    (state.polygons || []).forEach(function (f) {
      f.pts.forEach(function (p) { push(p.x, p.y, p.z); });
    });

    if (all.length <= cap) return all;
    // 等间隔抽稀:顶点是按网格顺序生成的,等间隔取就能均匀覆盖整个曲面
    var out = [];
    var step = all.length / cap;
    for (var i = 0; i < cap; i++) out.push(all[Math.floor(i * step)]);
    return out;
  }

  /** 适配比例要对这些角度都成立(见 fitZoom 的说明) */
  var FIT_AZ_STEPS = [0, 60, 120, 180, 240, 300];
  var FIT_EL_SPREAD = 0.35;

  /**
   * 算出让全部内容刚好装进画布的 zoom。
   *
   * 投影里 screen = 中心 + r·(focal/depth)·min(w,h)·0.42·zoom,
   * 对 zoom 是**线性**的 —— 所以按 zoom=1 投影一遍,量出超了多少,再一次除回去。
   *
   * 关键点:适配是挂载时算一次的,但用户接下来会拖动旋转。只按初始角度贴边适配的话,
   * 转一下就又被切掉了。所以方位角取 6 个、仰角取 3 个,取**最坏情况**。
   * 代价是比"只按初始角度贴边"小一圈,换来的是转起来不会掉东西。
   *
   * 上下限只做保护:上限防止内容只占画面一小角时放得过大,下限防止极端情况下缩成一个点。
   */
  function fitZoom(probes, cam, w, h, margin) {
    if (!probes || !probes.length) return 1;
    var pad = margin === undefined ? 0.9 : margin;
    var els = [cam.el, cam.el - FIT_EL_SPREAD, cam.el + FIT_EL_SPREAD];
    var need = 0;
    for (var ai = 0; ai < FIT_AZ_STEPS.length; ai++) {
      for (var ei = 0; ei < els.length; ei++) {
        var c = {
          az: cam.az + FIT_AZ_STEPS[ai] * Math.PI / 180,
          el: Math.max(-1.5, Math.min(1.5, els[ei])),
          dist: cam.dist, focal: cam.focal, zoom: 1,
        };
        for (var i = 0; i < probes.length; i++) {
          var q = project(probes[i], c, w, h);
          need = Math.max(need,
            Math.abs(q.x - w / 2) / (w / 2 * pad),
            Math.abs(q.y - h / 2) / (h / 2 * pad));
        }
      }
    }
    if (!(need > 0)) return 1;
    return Math.max(0.12, Math.min(3, 1 / need));
  }

  function render3D(ctx, canvas, state, theme) {
    var w = canvas.width / theme.dpr;
    var h = canvas.height / theme.dpr;
    ctx.setTransform(theme.dpr, 0, 0, theme.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 半透明:按深度从远到近、每个面各自带 alpha,后面的曲面就能透出来。
    // （如果整块曲面先画到离屏画布再整体压 alpha,球就只剩正面一层了 ——
    //   背面被同色的正面盖住,反而看不到"透明"的效果。）
    var alpha = (typeof state.alpha === 'number' && state.alpha > 0.05 && state.alpha < 1)
      ? state.alpha
      : 1;
    var translucent = alpha < 1;

    // 每个曲面各自算四边形,再合成一个列表统一排序 ——
    // 这样多个曲面之间也能正确互相遮挡。
    var items = [];
    (state.surfaces || []).forEach(function (s, si) {
      var qs = s.kind === 'mesh'
        ? projectMeshQuads(s.data, state.cam, w, h, state)
        : buildQuads(s.data, state.cam, w, h, state);
      for (var k = 0; k < qs.length; k++) {
        qs[k].surface = si;
        items.push(qs[k]);
      }
    });
    for (var qi = 0; qi < items.length; qi++) items[qi].kind = 'quad';

    // 面片:顶点投影后按平均深度参与排序,和曲面共享同一套画家算法。
    // 颜色编号接在曲面后面,这样一个图里"每个填充块一个颜色"。
    var surfaceCount = (state.surfaces || []).length;
    (state.polygons || []).forEach(function (face, fi) {
      var pts = [];
      var depth = 0;
      var ok = true;
      for (var k = 0; k < face.pts.length; k++) {
        var sp = project(face.pts[k], state.cam, w, h);
        if (sp.depth <= 0.05) { ok = false; break; }
        sp.x += state.panX || 0;
        sp.y += state.panY || 0;
        pts.push(sp);
        depth += sp.depth;
      }
      if (!ok) return;
      depth /= pts.length;

      // 平面法线用渲染空间的三点叉积求,再和光照方向点乘 ——
      // 取绝对值是因为面片是双面的(从背面看也得有明暗,而不是全黑)。
      var e1 = { x: face.pts[1].x - face.pts[0].x, y: face.pts[1].y - face.pts[0].y, z: face.pts[1].z - face.pts[0].z };
      var e2 = { x: face.pts[2].x - face.pts[0].x, y: face.pts[2].y - face.pts[0].y, z: face.pts[2].z - face.pts[0].z };
      var nx = e1.y * e2.z - e1.z * e2.y;
      var ny = e1.z * e2.x - e1.x * e2.z;
      var nz = e1.x * e2.y - e1.y * e2.x;
      var len = Math.hypot(nx, ny, nz) || 1;
      var nCam = rotatePoint({ x: nx / len, y: ny / len, z: nz / len }, state.cam);
      var light = Math.abs(nCam.x * LIGHT_DIR[0] + nCam.y * LIGHT_DIR[1] + nCam.z * LIGHT_DIR[2]);

      items.push({
        kind: 'face',
        pts: pts,
        depth: depth,
        light: Math.max(0.35, 0.35 + 0.65 * light),
        surface: surfaceCount + fi,
      });
    });

    // 线段:按深度**切成小段**再分别排序。
    // 整条线只按中点排序的话,一条从球前面穿到球后面的棱会整根被球挡住或者
    // 整根盖在球上面,两种都明显不对。切开之后遮挡关系就是逐段正确的。
    var SEG_PIECES = 14;
    var segScope = makeScope(['x', 'y', 'z']);
    (state.segments || []).forEach(function (seg) {
      for (var k = 0; k < SEG_PIECES; k++) {
        var t0 = k / SEG_PIECES, t1 = (k + 1) / SEG_PIECES;
        var p0 = lerpPoint(seg.a, seg.b, t0);
        var p1 = lerpPoint(seg.a, seg.b, t1);
        var s0 = project(p0, state.cam, w, h);
        var s1 = project(p1, state.cam, w, h);
        if (s0.depth <= 0.05 || s1.depth <= 0.05) continue;
        // 约束按每一小段的中点判定 —— 于是 `segment(A,B) where z > 0`
        // 能真的只留上半截,而不是整条去掉。
        if (seg.mask) {
          var mid = lerpPoint(seg.a, seg.b, (t0 + t1) / 2);
          segScope.x = mid.x; segScope.y = mid.y; segScope.z = mid.z;
          if (!seg.mask(segScope)) continue;
        }
        items.push({
          kind: 'seg',
          depth: (s0.depth + s1.depth) / 2,
          x0: s0.x + (state.panX || 0),
          y0: s0.y + (state.panY || 0),
          x1: s1.x + (state.panX || 0),
          y1: s1.y + (state.panY || 0),
        });
      }
    });

    // 把点也塞进同一个深度序列 —— 这样球背面的点会被球正确地挡住
    (state.points || []).forEach(function (p) {
      var sp = project({ x: p.nx, y: p.ny, z: p.nz }, state.cam, w, h);
      if (sp.depth <= 0.05) return;
      items.push({
        kind: 'point',
        depth: sp.depth,
        x: sp.x + (state.panX || 0),
        y: sp.y + (state.panY || 0),
        // 半径跟着透视缩放,靠近时自然变大
        r: 5 * (state.cam.focal / sp.depth) * state.cam.zoom,
        label: p.label,
      });
    });
    items.sort(function (a, b) { return b.depth - a.depth; });

    var quads = items;
    // 填充块(曲面 + 面片)不止一个时按序号轮流换色,一眼能区分是哪一块
    var multiFill = (state.surfaces || []).length + (state.polygons || []).length > 1;

    for (var i = 0; i < quads.length; i++) {
      var q = quads[i];
      if (q.kind === 'point') {
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(q.x, q.y, Math.max(2.5, Math.min(14, q.r)), 0, Math.PI * 2);
        ctx.fillStyle = '#ffd166';
        ctx.shadowColor = '#ffd166';
        ctx.shadowBlur = 12;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(7, 7, 15, .85)';
        ctx.stroke();
        if (q.label) {
          ctx.font = '600 12.5px ui-monospace, Consolas, monospace';
          ctx.fillStyle = '#ffd166';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(q.label, q.x + 9, q.y - 6);
        }
        continue;
      }

      if (q.kind === 'seg') {
        // 线段始终不透明、带一点辉光 —— 它读起来是"作图辅助线",
        // 跟着曲面一起变半透明的话会和面糊在一起看不清。
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.moveTo(q.x0, q.y0);
        ctx.lineTo(q.x1, q.y1);
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.strokeStyle = '#ffd166';
        ctx.shadowColor = '#ffd166';
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.shadowBlur = 0;
        continue;
      }

      if (q.kind === 'face') {
        // 多边形面片:平面法线定明暗,再乘上全局透明度
        var frgb = hexToRgb(COLORS[q.surface % COLORS.length]);
        var fm = q.light;
        if (translucent) fm = 0.55 + 0.45 * fm;
        var fcol = 'rgba('
          + Math.min(255, Math.round(frgb[0] * fm)) + ','
          + Math.min(255, Math.round(frgb[1] * fm)) + ','
          + Math.min(255, Math.round(frgb[2] * fm)) + ','
          + alpha + ')';
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.moveTo(q.pts[0].x, q.pts[0].y);
        for (var fi = 1; fi < q.pts.length; fi++) ctx.lineTo(q.pts[fi].x, q.pts[fi].y);
        ctx.closePath();
        ctx.fillStyle = fcol;
        ctx.fill();
        // 面片描边:实体几何图里棱线很重要,顺手描一圈同色边
        ctx.strokeStyle = fcol;
        ctx.lineWidth = 1.4;
        ctx.lineJoin = 'round';
        ctx.stroke();
        continue;
      }

      // 多个填充块时按编号上色(更容易分辨是哪一块);
      // 只有一个的时候保持原来的高度渐变色。
      var rgb = (multiFill
        ? hexToRgb(COLORS[q.surface % COLORS.length])
        : colormap(q.t).match(/\d+/g));
      var m = q.light;
      // 半透明时要少压暗一些 —— 深色背景下本来就暗,再乘个 0.2 就几乎看不见了
      if (translucent) m = 0.55 + 0.45 * m;
      // 用四边形法线算出的明暗系数调制颜色,曲面才有立体感
      var r = Math.min(255, Math.round(rgb[0] * m));
      var g = Math.min(255, Math.round(rgb[1] * m));
      var b = Math.min(255, Math.round(rgb[2] * m));

      var pts = translucent ? inflateQuad(q.pts, 0.6) : q.pts;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.lineTo(pts[2].x, pts[2].y);
      ctx.lineTo(pts[3].x, pts[3].y);
      ctx.closePath();
      var flat = 'rgb(' + r + ',' + g + ',' + b + ')';
      ctx.fillStyle = flat;
      if (translucent) {
        // 每个面单独设一次 alpha,画完立刻还原(后面的点必须是不透明的)
        ctx.globalAlpha = alpha;
        ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.fill();
        // 极细的同色边线能压掉相邻四边形之间的白缝
        ctx.strokeStyle = flat;
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
    }

    drawAxes3D(ctx, state, w, h, theme);
  }

  function drawAxes3D(ctx, state, w, h, theme) {
    var cam = state.cam;
    var P = function (x, y, z) {
      var q = project({ x: x, y: y, z: z }, cam, w, h);
      q.x += state.panX || 0;
      q.y += state.panY || 0;
      return q;
    };

    // 坐标轴盒子的半宽:隐式曲面按它自己的包围盒比例画,显式曲面就是单位立方体
    var ext = null;
    for (var si = 0; si < (state.surfaces || []).length; si++) {
      var d = state.surfaces[si].data;
      if (d && d.ext) { ext = d.ext; break; }
    }
    if (!ext) ext = [1, 1, 1];

    // 立方体左下后角的三条棱 → 坐标轴
    var axes = [
      { to: [ext[0], 0, 0], label: 'x' },
      { to: [0, 0, ext[2]], label: 'y' },
      { to: [0, ext[1], 0], label: 'z' },
    ];
    var origin = P(-ext[0], -ext[1], -ext[2]);

    ctx.lineWidth = 1.6;
    axes.forEach(function (ax) {
      var end = P(-ext[0] + ax.to[0] * 2, -ext[1] + ax.to[1] * 2, -ext[2] + ax.to[2] * 2);
      ctx.strokeStyle = theme.axis;
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();

      ctx.fillStyle = theme.text;
      ctx.font = '600 12px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ax.label, end.x + (end.x - origin.x) * 0.08, end.y + (end.y - origin.y) * 0.08);
    });

    // 立方体其余棱(淡一点),给点空间感
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    var corners = [];
    for (var sx = 0; sx <= 1; sx++) {
      for (var sy = 0; sy <= 1; sy++) {
        for (var sz = 0; sz <= 1; sz++) {
          corners.push(P((sx * 2 - 1) * ext[0], (sy * 2 - 1) * ext[1], (sz * 2 - 1) * ext[2]));
        }
      }
    }
    // 12 条棱
    var edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    edges.forEach(function (e) {
      ctx.moveTo(corners[e[0]].x, corners[e[0]].y);
      ctx.lineTo(corners[e[1]].x, corners[e[1]].y);
    });
    ctx.stroke();
  }

  /* ============================================================
     七、浏览器挂载 + 交互
     ============================================================ */

  var COLORS = ['#2ee6ff', '#ff5fd0', '#a6ff5c', '#ffd166', '#9b7bff'];

  function themeOf(el) {
    var cs = getComputedStyle(el);
    var pick = function (name, fallback) {
      var v = cs.getPropertyValue(name);
      return v && v.trim() ? v.trim() : fallback;
    };
    return {
      grid: pick('--plot-grid', 'rgba(140,150,255,.14)'),
      axis: pick('--plot-axis', 'rgba(160,170,255,.42)'),
      text: pick('--plot-text', 'rgba(169,173,207,.85)'),
      dpr: Math.min(window.devicePixelRatio || 1, 2),
    };
  }

  function setupCanvas(canvas, el) {
    var rect = canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(240, Math.round(rect.width));
    // 3D 的投影包围盒接近正方形,所以画布也偏方一点(0.78);
    // 早期用的 0.62 太扁,图形被高度卡住,左右白白空掉一大条。
    var h = Math.round(w * (el.dataset.ratio ? parseFloat(el.dataset.ratio) : (el.dataset.kind === '3d' ? 0.78 : 0.58)));
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    return { w: w, h: h, dpr: dpr };
  }

  function mount(el) {
    var canvas = el.querySelector('canvas');
    var payloadEl = el.querySelector('script[type="application/json"]');
    if (!canvas || !payloadEl) return;

    var payload;
    try {
      payload = JSON.parse(payloadEl.textContent);
    } catch (e) {
      showError(el, '图像参数读取失败:' + e.message);
      return;
    }

    var ctx = canvas.getContext('2d');
    var kind = el.dataset.kind;
    var state = { panX: 0, panY: 0 };
    // 注意:必须声明在 try 外面 —— resample() 定义在 try 之后,
    // 用 const 写在 try 块里会因为块级作用域而看不见它(区域模式就是这么挂掉的)。
    const varNames = kind === '3d' ? ['x', 'y', 'z'] : ['x', 'y'];

    function fail(msg) {
      showError(el, msg);
    }

    try {
      // 每条曲线 / 每个点都带自己的约束(构建期已经把全局约束并进去了),
      // 所以这里给每一条单独编译一个 mask。
      const compiled = (payload.items || []).map(function (it) {
        const tests = (it.constraints || []).map(function (c) {
          return compileConstraint(c, varNames);
        });
        return Object.assign({}, it, { mask: makeMask(tests) });
      });

      if (kind === '3d') {
        // 一个图里可以有多个曲面/等值面,各自带自己的约束
        const surfaceItems = compiled.filter(function (it) {
          return it.type === 'explicit' || it.type === 'implicit';
        });
        state.surfaces = surfaceItems.map(function (it) {
          const o = Object.assign({}, payload.opts, { mask: it.mask });
          if (it.type === 'implicit') {
            return { kind: 'mesh', data: surfaceNets(compileImplicit(it.expr, varNames), o) };
          }
          return { kind: 'surface', data: buildSurface(it.expr, o) };
        });
        state.cam = { az: -0.62, el: 0.52, dist: 3.4, focal: 3.4, zoom: 1 };
        // 曲面透明度由构建期定好(作者写了 alpha= 就用他的值,没写时
        // "多个曲面"默认半透明 —— 否则前面的球会把后面的全挡住)。
        // 客户端只负责读它,并且允许用工具条上的按钮临时切回不透明。
        state.alphaDefault = (typeof payload.opts.alpha === 'number'
          && payload.opts.alpha > 0.05 && payload.opts.alpha <= 1)
          ? payload.opts.alpha
          : 1;
        state.alpha = state.alphaDefault;

        // 点从数学坐标换算到和曲面同一套归一化立方体里。
        // 显式曲面的 opts.z 是"颜色映射范围"、允许为 null,这时用曲面实际的高度范围兜底。
        const [ax, bx] = payload.opts.x;
        const [ay, by] = payload.opts.y;
        let zr = payload.opts.z;
        if (!Array.isArray(zr)) {
          const zs = state.surfaces
            .filter(function (s) { return s.kind === 'surface'; })
            .map(function (s) { return [s.data.zmin, s.data.zmax]; });
          zr = zs.length
            ? [Math.min.apply(null, zs.map((v) => v[0])), Math.max.apply(null, zs.map((v) => v[1]))]
            : [-1, 1];
        }
        const cx = (ax + bx) / 2, cy = (ay + by) / 2, cz = (zr[0] + zr[1]) / 2;
        // 隐式曲面(surfaceNets)三个轴共用一个 half,点必须跟着用同一套比例,
        // 否则 x/y/z 范围不一样时点会飘到曲面外面去。
        const hasMesh = state.surfaces.some(function (s) { return s.kind === 'mesh'; });
        const half = hasMesh
          ? (Math.max(bx - ax, by - ay, zr[1] - zr[0]) / 2 || 1)
          : 0;
        const hx = hasMesh ? half : ((bx - ax) / 2 || 1);
        const hy = hasMesh ? half : ((by - ay) / 2 || 1);
        const hz = hasMesh ? half : ((zr[1] - zr[0]) / 2 || 1);
        const scope = makeScope(['x', 'y', 'z']);
        // 数学坐标 → 渲染立方体。点、线段、面片都用同一套比例,
        // 免得三者对不上(尤其是非正方体包围盒)。
        const toRender = function (p) {
          return { x: (p.x - cx) / hx, y: (p.z - cz) / hz, z: (p.y - cy) / hy };
        };
        state.points = compiled.filter(function (it) {
          if (it.type !== 'point') return false;
          if (!it.mask) return true;
          scope.x = it.x; scope.y = it.y; scope.z = it.z;
          return it.mask(scope);
        }).map(function (p) {
          const r = toRender(p);
          return { nx: r.x, ny: r.y, nz: r.z, label: p.label };
        });

        // 线段:保留原端点,渲染时再按深度切开(见 render3D)—— 一整条线只按
        // 中点排序的话,穿过球的那一段遮挡关系会明显不对。
        state.segments = compiled.filter(function (it) { return it.type === 'segment'; })
          .map(function (s) {
            return { a: toRender(s.a), b: toRender(s.b), mask: s.mask };
          });

        // 面片:顶点投影后按平均深度参与排序。约束按重心判定(整块留或整块不留)。
        state.polygons = compiled.filter(function (it) { return it.type === 'polygon'; })
          .filter(function (pg) {
            if (!pg.mask) return true;
            let sx = 0, sy = 0, sz = 0;
            pg.points.forEach(function (p) { sx += p.x; sy += p.y; sz += p.z; });
            const n = pg.points.length;
            scope.x = sx / n; scope.y = sy / n; scope.z = sz / n;
            return pg.mask(scope);
          })
          .map(function (pg) {
            return { pts: pg.points.map(toRender) };
          });
      } else {
        // 区域模式:整块只有约束条件
        state.regionMask = (payload.region && payload.region.length)
          ? makeMask(payload.region.map(function (c) { return compileConstraint(c, varNames); }))
          : null;
        state.regionOnly = Boolean(state.regionMask);
        state.regionCells = [];
        state.regionBoundary = [];

        const scope = makeScope(['x', 'y']);
        const curves = [];
        const dots = [];
        const segs = [];
        const faces = [];
        compiled.forEach(function (it) {
          if (it.type === 'point') {
            if (!it.mask) { dots.push(it); return; }
            scope.x = it.x; scope.y = it.y;
            if (it.mask(scope)) dots.push(it);
          } else if (it.type === 'segment') {
            segs.push({ a: it.a, b: it.b, mask: it.mask });
          } else if (it.type === 'polygon') {
            if (it.mask) {
              let sx = 0, sy = 0;
              it.points.forEach(function (p) { sx += p.x; sy += p.y; });
              const n = it.points.length;
              scope.x = sx / n; scope.y = sy / n;
              if (!it.mask(scope)) return;
            }
            faces.push({ points: it.points });
          } else if (it.type === 'implicit') {
            curves.push({ kind: 'implicit', fn: compileImplicit(it.expr, varNames), mask: it.mask });
          } else {
            curves.push({ kind: 'explicit', expr: it.expr, mask: it.mask });
          }
        });
        state.curves = curves;
        state.points = dots;
        state.segments = segs;
        state.polygons = faces;
        state.colors = COLORS;
        state.opts = payload.opts;
        state.renderedSeries = [];
        // 初值必须直接用作者给的 y 范围 —— 之前这里写死成 [-1,1],
        // 而 autoFitY 在"作者指定了 y"时会提前 return,于是 opts.y 从来没生效过:
        // 区域会被算成 4×2 的窗口(格子数翻倍)、图形被纵向压扁。
        state.view = {
          x0: payload.opts.x[0],
          x1: payload.opts.x[1],
          y0: payload.opts.y ? payload.opts.y[0] : -1,
          y1: payload.opts.y ? payload.opts.y[1] : 1,
        };
      }
    } catch (e) {
      fail(e.message);
      return;
    }

    var size = setupCanvas(canvas, el);

    // 3D:第一帧就把镜头拉到刚好装下全部内容。
    // 默认视角(dist 3.4 / focal 3.4 / zoom 1)是按"球在图中央"的小图调的,
    // 图形一旦铺满包围盒(晶胞那种),上下两条棱就会被画布切掉。
    if (kind === '3d') {
      state.probes = contentProbes(state);
      state.fit = fitZoom(state.probes, state.cam, size.w, size.h);
      state.cam.zoom = state.fit;
      state.userZoomed = false;
    }

    function resample() {
      if (kind === '3d') return;
      var range = { x: [state.view.x0, state.view.x1], y: [state.view.y0, state.view.y1] };

      // 每条曲线自己算自己那份 —— 约束不同,不能像以前那样一次算完
      state.renderedSeries = state.curves.map(function (c) {
        if (c.kind === 'explicit') {
          return {
            kind: 'explicit',
            series: compute2D([c.expr], { x: range.x, samples: 900, mask: c.mask }).series[0],
          };
        }
        return {
          kind: 'implicit',
          segs: marchingSquares(c.fn, {
            x: range.x, y: range.y, nx: 170, ny: 170, mask: c.mask,
          }),
        };
      });

      if (state.regionOnly) {
        state.regionCells = regionCells(state.regionMask, {
          x: range.x, y: range.y, nx: 150, ny: 150,
        });
        state.regionBoundary = (payload.region || []).map(function (c) {
          return marchingSquares(compileConstraint(c, varNames), { x: range.x, y: range.y, nx: 170, ny: 170 });
        });
      }
    }

    function autoFitY() {
      if (kind === '3d') return;
      if (state.opts && state.opts.y) return; // 作者指定了 y 范围,别自作主张
      var lo = Infinity, hi = -Infinity;
      (state.renderedSeries || []).forEach(function (item) {
        if (item.kind !== 'explicit') return;
        item.series.forEach(function (p) {
          if (p.y === null) return;
          if (p.y < lo) lo = p.y;
          if (p.y > hi) hi = p.y;
        });
      });
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = -1; hi = 1; }
      if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
      var pad = (hi - lo) * 0.12;
      state.view.y0 = lo - pad;
      state.view.y1 = hi + pad;
    }

    function draw() {
      var theme = themeOf(el);
      var s = setupCanvas(canvas, el);
      if (kind === '3d') render3D(ctx, canvas, state, theme);
      else render2D(ctx, canvas, state, theme);
      el.dataset.ready = '1';
    }

    // 采样/绘制也兜一层:出错就显示提示,而不是让异常冒到调用方变成白屏
    function safe(fn) {
      try {
        fn();
      } catch (e) {
        fail(e && e.message ? e.message : String(e));
      }
    }

    safe(resample);
    safe(autoFitY);
    safe(draw);

    // ---- 交互 ----
    var dragging = false;
    var lastX = 0, lastY = 0;
    var pointers = new Map();
    var pinchStart = 0, pinchZoom = 1;

    function localPos(e) {
      var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function zoomAt(px, py, factor) {
      if (kind === '3d') {
        state.cam.zoom = Math.max(0.25, Math.min(6, state.cam.zoom * factor));
        state.userZoomed = true; // 手动缩放过之后,窗口尺寸变化就别再自动适配了
        return;
      }
      var v = state.view;
      var fx = (px / size.w);
      var fy = (py / size.h);
      var xAnchor = v.x0 + (v.x1 - v.x0) * fx;
      var yAnchor = v.y1 - (v.y1 - v.y0) * fy;
      state.view = {
        x0: xAnchor + (v.x0 - xAnchor) / factor,
        x1: xAnchor + (v.x1 - xAnchor) / factor,
        y0: yAnchor + (v.y0 - yAnchor) / factor,
        y1: yAnchor + (v.y1 - yAnchor) / factor,
      };
      resample();
    }

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = localPos(e);
      zoomAt(p.x, p.y, e.deltaY < 0 ? 1.12 : 1 / 1.12);
      draw();
    }, { passive: false });

    canvas.addEventListener('pointerdown', function (e) {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, e);
      if (pointers.size === 1) {
        dragging = true;
        lastX = e.clientX; lastY = e.clientY;
      } else if (pointers.size === 2) {
        var pts = [...pointers.values()];
        pinchStart = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
        pinchZoom = kind === '3d' ? state.cam.zoom : 1;
      }
      canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', function (e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, e);

      if (pointers.size === 2) {
        var pts = [...pointers.values()];
        var d = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
        if (pinchStart > 0) {
          var factor = d / pinchStart;
          if (kind === '3d') {
            state.cam.zoom = Math.max(0.25, Math.min(6, pinchZoom * factor));
            state.userZoomed = true;
          } else {
            // 双指缩放:以画布中心为锚点
            state.view = scaleView(state.view, factor);
            resample();
          }
          draw();
        }
        return;
      }

      if (!dragging) return;
      var dx = e.clientX - lastX;
      var dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;

      if (kind === '3d') {
        var next = applyOrbit(state.cam, dx, dy);
        state.cam.az = next.az;
        state.cam.el = next.el;
      } else {
        var v = state.view;
        var sx = (v.x1 - v.x0) / size.w;
        var sy = (v.y1 - v.y0) / size.h;
        state.view = { x0: v.x0 - dx * sx, x1: v.x1 - dx * sx, y0: v.y0 + dy * sy, y1: v.y1 + dy * sy };
        resample();
      }
      draw();
    });

    function release(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = 0;
      if (pointers.size === 0) {
        dragging = false;
        canvas.style.cursor = 'grab';
      }
    }
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    function scaleView(v, factor) {
      var cx = (v.x0 + v.x1) / 2, cy = (v.y0 + v.y1) / 2;
      var hw = (v.x1 - v.x0) / 2 / factor, hh = (v.y1 - v.y0) / 2 / factor;
      return { x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh };
    }

    canvas.addEventListener('dblclick', function () {
      reset();
    });

    function reset() {
      state.panX = 0; state.panY = 0;
      if (kind === '3d') {
        state.cam.az = -0.62; state.cam.el = 0.52;
        // 回到"刚好装下全部内容"的那个比例,而不是写死的 1 ——
        // 不然双击重置之后图形又被切掉了。
        state.cam.zoom = state.fit || 1;
        state.userZoomed = false;
      } else {
        state.view.x0 = payload.opts.x[0];
        state.view.x1 = payload.opts.x[1];
        resample();
        autoFitY();
      }
      draw();
    }

    // 1) 半透明切换:直接改变"填充时用的 alpha",所以后面的曲面能透出来,
    //    不需要重新计算网格。0.62 是试出来的 —— 再低一片糊,再高看不见背面。
    function syncAlphaButton(btn) {
      var on = state.alpha < 1;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.title = on ? '当前半透明:能看见后面的曲面,点击改为不透明' : '点击改为半透明';
    }

    el.querySelectorAll('[data-plot-action]').forEach(function (btn) {
      if (btn.dataset.plotAction === 'alpha') syncAlphaButton(btn);
      btn.addEventListener('click', function () {
        var act = btn.dataset.plotAction;
        if (act === 'reset') reset();
        else if (act === 'alpha' && kind === '3d') {
          // 在三档之间切:默认值 → 不透明 → 半透明(0.62)
          state.alpha = state.alpha >= 1 ? (state.alphaDefault < 1 ? state.alphaDefault : 0.62) : 1;
          syncAlphaButton(btn);
          draw();
        } else if (act === 'save') {
          var a = document.createElement('a');
          a.download = (el.dataset.title || 'plot') + '.png';
          a.href = canvas.toDataURL('image/png');
          a.click();
        }
      });
    });

    var ro = window.ResizeObserver ? new ResizeObserver(function () {
      // 画布宽度变了(换窗口 / 收起侧栏)就得重新算一次适配比例,
      // 否则按旧宽度算出来的 zoom 会把图形切掉。用户手动缩放过就不动他了。
      if (kind === '3d') {
        var rect = canvas.getBoundingClientRect();
        if (Math.abs(rect.width - size.w) >= 1) {
          size = setupCanvas(canvas, el);
          state.fit = fitZoom(state.probes, state.cam, size.w, size.h);
          if (!state.userZoomed) state.cam.zoom = state.fit;
        }
      }
      draw();
    }) : null;
    if (ro) ro.observe(el);

    canvas.style.cursor = 'grab';
    el.dataset.mounted = '1';
  }

  function showError(el, msg) {
    el.dataset.error = '1';
    var box = el.querySelector('.plot-error');
    if (!box) {
      box = document.createElement('p');
      box.className = 'plot-error';
      el.appendChild(box);
    }
    box.textContent = '图像无法绘制:' + msg;
    var c = el.querySelector('canvas');
    if (c) c.style.display = 'none';
  }

  function boot() {
    document.querySelectorAll('.plot[data-mount]:not([data-mounted])').forEach(function (el) {
      try { mount(el); } catch (e) { showError(el, e.message); }
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
    window.addEventListener('load', boot);
  }

  return {
    // 供 Node 侧单测使用
    tokenize: tokenize,
    compileToClosures: compileToClosures,
    /** 测试用:强行关掉/打开编译版,验证两条路结果一致 */
    __setNativeCompile: function (on) { NATIVE_COMPILE = !!on; },
    __nativeCompile: function () { return NATIVE_COMPILE; },
    parse: parse,
    compile: compile,
    makeScope: makeScope,
    collectVars: collectVars,
    collectNames: collectNames,
    compute2D: compute2D,
    buildSurface: buildSurface,
    marchingSquares: marchingSquares,
    surfaceNets: surfaceNets,
    parseEquation: parseEquation,
    compileImplicit: compileImplicit,
    parseConstraint: parseConstraint,
    compileConstraint: compileConstraint,
    makeMask: makeMask,
    splitWhere: splitWhere,
    parsePoints: parsePoints,
    parseCallArgs: parseCallArgs,
    parseCoordRef: parseCoordRef,
    evalConst: evalConst,
    fmtNum: fmtNum,
    sphereEquation: sphereEquation,
    regionCells: regionCells,
    projectMeshQuads: projectMeshQuads,
    buildQuads: buildQuads,
    applyOrbit: applyOrbit,
    project: project,
    rotatePoint: rotatePoint,
    contentProbes: contentProbes,
    fitZoom: fitZoom,
    fitImplicitBox: fitImplicitBox,
    faceCrossed: faceCrossed,
    linkPairs: linkPairs,
    colormap: colormap,
    niceStep: niceStep,
    GRID_LIMITS: GRID_LIMITS,
    clampGrid: clampGrid,
    inflateQuad: inflateQuad,
    mount: mount,
    boot: boot,
  };
}));
