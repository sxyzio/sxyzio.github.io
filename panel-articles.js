/* SECTION: panel-articles —— 文件夹内「文章」区。
   列表 + 搜索 + 新建/继续编辑/删除；摘要按 sha 缓存，限并发懒加载。 */
(function () {
  'use strict';

  var esc = UI.esc, icon = UI.icon;
  var excerptCache = {};   // path + '@' + sha -> 摘要文本
  var loadedFor = '';      // 上一次懒加载所属文件夹

  function titleOf(name) {
    return String(name || '').replace(/\.(md|markdown)$/i, '');
  }

  function rowHtml(a) {
    return '<div class="row" data-path="' + esc(a.path) + '">' +
      '<span class="row-ico row-ico-doc">' + icon('doc') + '</span>' +
      '<button class="row-main" type="button" data-act="open" title="打开阅读">' +
        '<p class="row-title">' + esc(titleOf(a.name)) + '</p>' +
        '<p class="row-sub">' +
          '<span data-role="excerpt">读取中…</span>' +
          (a.size ? '<span class="dot"></span><span>' + UI.size(a.size) + '</span>' : '') +
        '</p>' +
      '</button>' +
      '<div class="row-actions">' +
        '<button class="btn btn-icon" type="button" data-act="edit" title="继续编辑">' + icon('pencil') + '</button>' +
        '<button class="btn btn-icon btn-danger" type="button" data-act="del" title="删除文章">' + icon('trash') + '</button>' +
      '</div>' +
    '</div>';
  }

  function applyFilter(host, keyword) {
    var rows = host.querySelectorAll('.row[data-path]');
    var k = keyword.trim().toLowerCase();
    var shown = 0;
    rows.forEach(function (r) {
      var name = (r.querySelector('.row-title').textContent || '').toLowerCase();
      var hit = !k || name.indexOf(k) >= 0;
      r.style.display = hit ? '' : 'none';
      if (hit) shown++;
    });
    var none = host.querySelector('[data-role="no-match"]');
    if (none) none.style.display = shown ? 'none' : '';
  }

  /* 并发上限 3 地取正文摘要 */
  function fillExcerpts(host, folder) {
    var rows = [].slice.call(host.querySelectorAll('.row[data-path]'));
    var byPath = {};
    folder.articles.forEach(function (a) { byPath[a.path] = a; });

    rows.forEach(function (r) {
      var p = r.dataset.path;
      var a = byPath[p];
      var slot = r.querySelector('[data-role="excerpt"]');
      if (!a || !slot) return;
      var key = p + '@' + (a.sha || '');
      if (excerptCache[key]) { slot.textContent = excerptCache[key]; return; }
      slot.textContent = a.size ? UI.size(a.size) : '';
    });

    var pending = rows.filter(function (r) {
      var a = byPath[r.dataset.path];
      return a && !excerptCache[r.dataset.path + '@' + (a.sha || '')];
    });
    if (!pending.length) return;

    var idx = 0;
    function worker() {
      if (idx >= pending.length) return Promise.resolve();
      var r = pending[idx++];
      var a = byPath[r.dataset.path];
      return Store.readText(a.path).then(function (text) {
        var key = a.path + '@' + (a.sha || '');
        var ex = Markdown.excerpt(text, 56) || '（空白文章）';
        excerptCache[key] = ex;
        // 视图可能已经切走，节点不在文档里就跳过
        if (r.isConnected) {
          var slot = r.querySelector('[data-role="excerpt"]');
          if (slot) slot.textContent = ex;
        }
      }).catch(function () {
        if (r.isConnected) {
          var slot = r.querySelector('[data-role="excerpt"]');
          if (slot) slot.textContent = '摘要读取失败';
        }
      }).then(worker);
    }
    var n = Math.min(3, pending.length);
    for (var i = 0; i < n; i++) worker();
  }

  /* ctx: { canWrite, onNew, onOpen(article), onEdit(article), onDelete(article) } */
  function render(host, folder, ctx) {
    ctx = ctx || {};
    var articles = folder.articles || [];

    var bar =
      '<div class="panel-bar">' +
        '<div class="panel-bar-left">' +
          '<div class="search">' + icon('search') +
            '<input class="input" type="search" data-role="filter" placeholder="搜索文章标题" spellcheck="false">' +
          '</div>' +
        '</div>' +
        (ctx.canWrite
          ? '<button class="btn btn-primary btn-sm" type="button" data-act="new" data-primary-action="new-article">' + icon('plus') + '<span>新建文章</span></button>'
          : '<span class="badge badge-read">' + icon('lock') + '只读令牌</span>') +
      '</div>';

    var body;
    if (!articles.length) {
      body = UI.empty({
        icon: 'doc',
        title: '这个文件夹还没有文章',
        text: ctx.canWrite ? '点「新建文章」写下第一篇，内容会以 Markdown 文件存进仓库。' : '当前令牌是只读权限，换成可写令牌后可以新建文章。',
        actionHtml: ctx.canWrite ? '<button class="btn btn-primary btn-sm" type="button" data-act="new">' + icon('plus') + '<span>新建文章</span></button>' : ''
      });
    } else {
      body = '<div class="list">' + articles.map(rowHtml).join('') + '</div>' +
        '<div class="empty" data-role="no-match" style="display:none;padding:34px 20px">' +
          '<h3>没有匹配的文章</h3><p>换个关键词试试。</p></div>';
    }

    host.innerHTML = bar + body;

    var filterInput = host.querySelector('[data-role="filter"]');
    if (filterInput) filterInput.addEventListener('input', function () { applyFilter(host, filterInput.value); });

    host.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.dataset.act;
      if (act === 'new') { ctx.onNew && ctx.onNew(); return; }
      var row = btn.closest('.row[data-path]');
      if (!row) return;
      var item = (folder.articles || []).filter(function (a) { return a.path === row.dataset.path; })[0];
      if (!item) return;
      if (act === 'open') ctx.onOpen && ctx.onOpen(item);
      else if (act === 'edit') ctx.onEdit && ctx.onEdit(item);
      else if (act === 'del') ctx.onDelete && ctx.onDelete(item, btn);
    });

    var key = folder.name;
    if (loadedFor !== key) { excerptCache = {}; loadedFor = key; }
    if (articles.length) fillExcerpts(host, folder);
  }

  window.ArticlesPanel = { render: render, titleOf: titleOf };
})();
