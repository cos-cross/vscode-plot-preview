/**
 * 预览里的"挂载探针"。
 *
 * 为什么需要它:VSCode 的 Markdown 预览在编辑时**只替换 body 的 HTML**,
 * 不会重新加载 previewScripts。也就是说第一次渲染时挂上的图能画,
 * 你改一个字之后新生成的 <div class="plot"> 就没人管了 —— 屏幕上是一片空白。
 *
 * 所以这里盯着 DOM 变化,发现新的 `.plot[data-mount]:not([data-mounted])`
 * 就再喂给 PlotKit.boot()。boot() 本身就只挑没挂载过的,重复调用是安全的。
 */
(function () {
  function boot() {
    var kit = window.PlotKit;
    if (!kit || typeof kit.boot !== 'function') return;
    try {
      kit.boot();
    } catch (e) {
      // 一张图挂掉不该影响整页预览
      if (window.console) console.error('[plot-preview] 挂载失败', e);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  window.addEventListener('load', boot);

  if (window.MutationObserver) {
    var pending = false;
    var run = function () { pending = false; boot(); };
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      // 攒到下一帧再跑,编辑时不会每一处小改动都触发一次完整挂载
      if (window.requestAnimationFrame) window.requestAnimationFrame(run);
      else setTimeout(run, 16);
    }).observe(document.body, { childList: true, subtree: true });
  }
}());
