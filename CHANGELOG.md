# 更新记录

## 1.0.4

- **修**:预览里全是红框 —— 渲染核心用 `new Function` 编译表达式,而 VSCode 预览的
  CSP 禁止 `unsafe-eval`。核心新增 `compileToClosures`(把 AST 编成嵌套闭包,
  完全不碰动态求值),载入时探测一次、自动切换。两条路的结果逐表达式一致。

## 1.0.3

- **修**:`extendMarkdownIt` 一次都不被调用 —— 缺 `markdown.markdownItPlugins: true`。
  VSCode 只对这个声明过的扩展调用该钩子;少了它扩展照样激活、样式照常注入,
  但预览里一直是代码块原文,而且没有任何报错。
- 加:`tools/test.mjs` 里一条测试专门守这个声明。

## 1.0.2

- 加:右下角状态栏 `plot` 图标(一眼看出扩展有没有激活,点它看诊断)。
- 加:`plot-preview: 诊断` 命令 + 「函数图像预览」输出面板,记录激活、
  `extendMarkdownIt` 调用次数、每个围栏的转换结果。
- 修:让扩展在纯 Node 环境下也能被 require(测试用),不再依赖 `vscode` 模块存在。

## 1.0.1

- 加:`activationEvents` 加上 `*`,启动即激活,不再依赖激活时机。
- 修:两处重构残留引用(`data.source` → `source`、`return whole` → `return null`),
  导致凡是有问题的代码块都会抛 `ReferenceError`,真正的错误信息被吃掉。

## 1.0.0

- 第一版:在 VSCode 自带的 Markdown 预览里渲染 `plot2d` / `plot3d`。
  解析规则与博客构建期插件共用同一份代码(靠 `tools/sync-from-blog.mjs` 同步)。
