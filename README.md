# 函数图像预览(`plot2d` / `plot3d`)

在 **VSCode 自带的 Markdown 预览**里直接渲染 `plot2d` / `plot3d` 代码块 —— 滚轮缩放、拖动旋转、双击重置,零依赖、可交互。

````markdown
```plot2d x=[-7,7] y=[-2,2]
sin(x)
cos(x)
```

```plot3d x=[-2,2] y=[-2,2] z=[-2,2] grid=34
sphere(0, 0, 0, 1) where z >= 0
```
````

**装一次,所有项目里的 `.md` 都能用** —— 不限于某一个仓库,也不需要任何构建步骤。

## 装法

```bash
npm install          # 只是为了跑测试;扩展本身零运行时依赖
npm run package      # 生成 plot-preview-1.0.4.vsix
```

然后:

- **VSCode 里装**:扩展面板右上角「…」→「从 VSIX 安装…」,选那个 `.vsix`;
- **命令行装**:`code --install-extension plot-preview-1.0.4.vsix`

装完**必须重载窗口**(`Ctrl+Shift+P → Developer: Reload Window`),然后打开任意 `.md` 按 `Ctrl+Shift+V`。

### 改这个扩展本身

用 VSCode 打开本仓库,按 <kbd>F5</kbd> 会弹出扩展开发宿主;仓库里已经放好 `.vscode/launch.json`。

## 支持的写法

- `plot2d` / `plot3d`,选项写在围栏那一行:`x= y= z= grid= alpha= ratio= equal= n=`;
- 表达式一行一个,`#` 开头当注释;
- `y = sin(x)`、`sin(x)`、`x^2 + y^2 = 1`(隐式)、`f(x,y,z)=0`(等值面);
- `point(1, 2) A`、`segment(A, B)`、`polygon(A, B, C)`、`sphere(A, 1)`;
- `centers`、`links(2)`(画晶格骨架);
- `where x > 0`,以及独立成行的全局约束。

## 在别的项目里用

**只想在编辑器里看**:装一次扩展就够了 —— 它对**所有** `.md` 生效,不管在哪个仓库,
也不需要 `npm install`、不需要构建。

**还想把带图的笔记发布成别的站点**(比如另一个 Hexo 博客):把两份文件放过去就行,
不需要重新实现任何东西:

| 从这里复制 | 放到那边 |
| --- | --- |
| `vendor/plot-build.cjs` | `scripts/plot.js`(Hexo 会自动加载 `scripts/*.js`) |
| `preview/plot.js` | `<你的主题>/source/js/plot.js` |
| `preview/plot.css` 里 `.plot` 那几段 | 主题的样式表(或者单独引一个 CSS) |

构建期插件会**优先用当前主题的** `source/js/plot.js`,所以不依赖主题叫什么名字。
然后和这边一样:`npm run build` / `hexo generate` 就能把 `plot2d` / `plot3d` 代码块
换成可交互的图。

> 注:那个插件只认 Hexo 的 `scripts/`。用别的静态站点生成器(比如 Hugo / VitePress),
> 得自己把 `plot-build.cjs` 的 `buildPlotBlock()` 接到对方的 Markdown 渲染钩子上 ——
> 它是个纯函数,输入(类型、选项、代码)输出 HTML 字符串,没有别的依赖。

## 代码从哪来

**绘图代码不在这个仓库里维护。** 源头是博客仓库(那边有完整的单测和渲染测试),
这个仓库只做"消费",靠 `tools/` 里的脚本把三份文件拉进来并提交:

| 这个仓库里的 | 来自博客仓库的 |
| --- | --- |
| `preview/plot.js` | `themes/cos-cross/source/js/plot.js` |
| `vendor/plot-build.cjs` | `scripts/plot.js` |
| `preview/plot.css` | `themes/cos-cross/source/css/style.css` 的变量 + 绘图段 |

```bash
node tools/sync-from-blog.mjs <博客仓库路径>          # 同步
node tools/sync-from-blog.mjs <博客仓库路径> --check  # 只检查
node tools/test.mjs <博客仓库路径>                    # 跑测试,顺带核对一致性
```

**为什么这么分**:画图的解析规则只能有一份。预览里看到的必须和网站上看到的完全一样,
否则迟早出现"编辑器里好好的、网站上不对"这种最难查的问题。

同步过来的文件是**提交进仓库**的,所以这个仓库自包含 —— 别人 clone 下来不需要博客仓库也能打包。

## 实现上的几个坑(都踩过)

| 坑 | 说明 |
| --- | --- |
| **必须声明 `markdown.markdownItPlugins: true`** | VSCode 只对声明了它的扩展调用 `extendMarkdownIt`。少了它,扩展照样激活、样式照常注入,但那个钩子**一次都不会被调用** —— 预览里一直是代码块原文,一句报错都没有。`tools/test.mjs` 里有一条测试守着它。 |
| **预览的 CSP 禁止 `unsafe-eval`** | 渲染核心为了性能用 `new Function` 编译表达式,在预览里会直接抛 CSP 错误(红框里写着 `unsafe-eval`)。所以核心里有 `compileToClosures` 兜底:把 AST 编成嵌套闭包,载入时探一次、自动切换。 |
| **正文里的内联 `<script>` 也会被 CSP 挡掉** | 渲染器只能通过 `markdown.previewScripts` 注入,不能塞在 markdown-it 的输出里。 |
| **预览编辑时只替换 body,不重载脚本** | 第一次能画,改一个字之后新生成的容器就没人挂载了。`preview/bootstrap.js` 用 MutationObserver 盯着 DOM 补挂。 |
| **围栏里的选项没法从 HTML 里捞回来** | markdown-it 只把语言名写进 `class="language-plot2d"`,`x=[-7,7] grid=48` 全丢。所以"在 webview 里自己解析代码块"这条兜底路走不通(会静默用默认参数画错图),`extendMarkdownIt` 是唯一正确的接入点。 |

## 出问题怎么查

`Ctrl+Shift+P → plot-preview: 诊断`,或者在「输出 → 函数图像预览」里看日志:

```
[激活] plot-preview 1.0.4,VSCode 1.9x.x
[激活] 渲染核心 已加载
[钩子] extendMarkdownIt 第 1 次被调用
[围栏] 3d /path/note.md → 容器 826 字节
```

| 日志里看到 | 说明 |
| --- | --- |
| 什么都没有 | 扩展没激活(没重载窗口 / 被禁用 / 版本不满足) |
| 有「激活」没有「钩子」 | 缺 `markdown.markdownItPlugins`,或者用的不是自带预览 |
| 有「钩子」没有「围栏」 | 围栏那行写错了(反引号后面要**紧跟** `plot2d`) |
| 「围栏 → 容器」但画面空 | 解析没问题,是浏览器端的事:「帮助 → 切换开发人员工具」看 Console |
| 「围栏 ❌ 画不出来」 | 表达式有问题,红框和日志里都写了原因 |

## 已知限制

- 只在 VSCode **自带的**预览里生效。Markdown Preview Enhanced 之类自带预览的扩展不走
  `extendMarkdownIt`,接不上;
- 不渲染 KaTeX 公式(VSCode 自己会处理数学);
- 预览里用的是闭包求值器(因为 CSP),比网站上慢几倍 —— 球很多、`grid` 很高时预览会有点卡;
- 这套 `plot2d` / `plot3d` 语法只在**这个扩展**和**博客的构建期插件**里通用。
  想让别的静态站点生成器也认,得另外接 `vendor/plot-build.cjs`。

## 许可

MIT
