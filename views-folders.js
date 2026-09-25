/* SECTION: views-folders —— 文件夹列表视图、文件夹详情视图（文章/文件双标签）、文章阅读视图 */
(function () {
  'use strict';

  var esc = UI.esc, icon = UI.icon;

  /* ================= 文件夹列表 ================= */
  function folderCardHtml(f) {
    var total = f.articles.length + f.files.length;
    return '<div class="folder-card" role="button" tabindex="0" data-folder="' + esc(f.name) + '" data-act="open" aria-label="打开文件夹 ' + esc(f.name) + '">' +
      '<span class="folder-card-actions">' +
        '<button class="btn btn-icon btn-danger btn-sm" type="button" data-act="del" title="删除文件夹" aria-label="删除文件夹 ' + esc(f.name) + '">' + icon('trash') + '</button>' +
      '</span>' +
      '<span class="folder-card-head">' +
        '<span class="folder-ico">' + icon('folder') + '</span>' +
        '<span class="folder-name">' + esc(f.name) + '</span>' +
      '</span>' +
      '<span class="folder-stats">' +
        '<span class="stat">' + icon('doc') + f.articles.length + ' 篇文章</span>' +
        '<span class="stat">' + icon('file') + f.files.length + ' 个文件</span>' +
      '</span>' +
      (total === 0 ? '<span style="font-size:12.5px;color:var(--ink-3)">空文件夹</span>' : '') +
    '</div>';
  }

  /* opts: { canWrite, onNew, onOpen(name), onDelete(name), truncated } */
  function renderFolders(host, snapshot, opts) {
    opts = opts || {};
    var folders = snapshot.folders || [];

    var head =
      '<div class="page-head">' +
        '<div>' +
          '<h1 class="page-title">' + icon('folder') + '文件夹</h1>' +
          '<p class="page-sub">' + esc(snapshot.repoLabel || '') + ' · 分支 ' + esc(snapshot.branch) +
            (snapshot.baseLabel ? ' · 目录 ' + esc(snapshot.baseLabel) : ' · 仓库根目录') + '</p>' +
        '</div>' +
        '<div class="head-actions">' +
          (opts.canWrite
            ? '<button class="btn btn-primary" type="button" data-act="new" data-primary-action="new-folder">' + icon('folder-plus') + '<span>新建文件夹</span></button>'
            : '<span class="badge badge-read">' + icon('lock') + '只读令牌 · 仅浏览</span>') +
        '</div>' +
      '</div>';

    var body;
    if (!folders.length) {
      body = UI.empty({
        icon: 'folder-plus',
        title: '还没有任何文件夹',
        text: opts.canWrite
          ? '新建一个文件夹，就能在里面分「文章」和「文件」两块存放内容。'
          : '当前令牌是只读权限，换成可写令牌后即可新建文件夹。',
        actionHtml: opts.canWrite ? '<button class="btn btn-primary btn-sm" type="button" data-act="new">' + icon('folder-plus') + '<span>新建文件夹</span></button>' : ''
      });
    } else {
      body = '<div class="folder-grid">' + folders.map(folderCardHtml).join('') + '</div>';
    }

    host.innerHTML = '<div class="view">' + head + body +
      (snapshot.truncated ? '<div class="notice notice-warn" style="margin-top:18px">' + icon('alert') +
        '<div>仓库条目较多，GitHub 只返回了部分目录树，这里可能没列全。建议在仓库里把文档集中到一个子目录。</div></div>' : '') +
      '</div>';

    // 监听器挂在每次新建的 .view 上，避免反复渲染时在同一容器上累积
    var view = host.querySelector('.view');

    view.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'new') { e.stopPropagation(); opts.onNew && opts.onNew(act); return; }
      var card = act.closest('[data-folder]');
      if (!card) return;
      if (act.dataset.act === 'del') {
        e.preventDefault();
        e.stopPropagation();
        opts.onDelete && opts.onDelete(card.dataset.folder, act);
        return;
      }
      opts.onOpen && opts.onOpen(card.dataset.folder);
    });

    view.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var card = e.target.closest('[data-folder][data-act="open"]');
      if (!card) return;
      e.preventDefault();
      opts.onOpen && opts.onOpen(card.dataset.folder);
    });
  }

  /* ================= 文件夹详情 ================= */
  function crumbHtml(folderName, onHome) {
    return '<button type="button" data-act="home">' + esc(onHome || '全部文件夹') + '</button>' +
      '<span class="sep">' + icon('back') + '</span>' +
      '<span class="current">' + esc(folderName) + '</span>';
  }

  /* opts: { canWrite, tab, onTab(tab), onBack, onHome } */
  function renderFolderShell(host, folder, opts) {
    opts = opts || {};
    var tab = opts.tab || 'articles';

    host.innerHTML =
      '<div class="view">' +
        '<nav class="crumb">' + crumbHtml(folder.name) + '</nav>' +
        '<div class="page-head">' +
          '<div>' +
            '<h1 class="page-title">' + icon('folder') + esc(folder.name) + '</h1>' +
            '<p class="page-sub">' + folder.articles.length + ' 篇文章 · ' + folder.files.length + ' 个文件</p>' +
          '</div>' +
        '</div>' +
        '<div class="tabs">' +
          '<button class="tab' + (tab === 'articles' ? ' active' : '') + '" type="button" data-tab="articles">' +
            icon('doc') + '文章<span class="tab-count">' + folder.articles.length + '</span></button>' +
          '<button class="tab' + (tab === 'files' ? ' active' : '') + '" type="button" data-tab="files">' +
            icon('file') + '文件<span class="tab-count">' + folder.files.length + '</span></button>' +
        '</div>' +
        '<div id="panel-host"></div>' +
      '</div>';

    host.querySelector('.crumb [data-act="home"]').addEventListener('click', function () {
      opts.onHome && opts.onHome();
    });
    host.querySelector('.tabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-tab]');
      if (b && b.dataset.tab !== tab) opts.onTab && opts.onTab(b.dataset.tab);
    });
    return host.querySelector('#panel-host');
  }

  /* ================= 文章阅读 ================= */
  /* opts: { canWrite, onBack, onEdit } */
  function renderReader(host, article, text, folderName, opts) {
    opts = opts || {};
    var words = Markdown.countWords(text);

    host.innerHTML =
      '<div class="view narrow">' +
        '<nav class="crumb">' +
          '<button type="button" data-act="home">全部文件夹</button>' +
          '<span class="sep">' + icon('back') + '</span>' +
          '<button type="button" data-act="folder">' + esc(folderName) + '</button>' +
          '<span class="sep">' + icon('back') + '</span>' +
          '<span class="current">文章</span>' +
        '</nav>' +
        '<article class="card reader">' +
          '<header class="reader-head">' +
            '<h1 class="reader-title">' + esc(article.title) + '</h1>' +
            '<div class="reader-meta">' +
              '<span>' + words + ' 字</span><span class="dot" style="width:3px;height:3px;border-radius:50%;background:#c9ced8;display:inline-block"></span>' +
              '<span>' + UI.size(article.size) + '</span>' +
              '<span class="dot" style="width:3px;height:3px;border-radius:50%;background:#c9ced8;display:inline-block"></span>' +
              '<span>路径 ' + esc(article.path) + '</span>' +
            '</div>' +
          '</header>' +
          '<div class="markdown">' + Markdown.render(text) + '</div>' +
        '</article>' +
        (opts.canWrite
          ? '<div style="margin-top:16px;display:flex;gap:9px;justify-content:flex-end">' +
              '<button class="btn btn-danger btn-sm" type="button" data-act="del">' + icon('trash') + '<span>删除文章</span></button>' +
              '<button class="btn btn-primary btn-sm" type="button" data-act="edit" data-primary-action="continue-edit">' + icon('pencil') + '<span>继续编辑</span></button>' +
            '</div>'
          : '') +
      '</div>';

    host.querySelector('.crumb [data-act="home"]').addEventListener('click', function () { opts.onHome && opts.onHome(); });
    host.querySelector('.crumb [data-act="folder"]').addEventListener('click', function () { opts.onBack && opts.onBack(); });
    var editBtn = host.querySelector('[data-act="edit"]');
    if (editBtn) editBtn.addEventListener('click', function () { opts.onEdit && opts.onEdit(); });
    var delBtn = host.querySelector('[data-act="del"]');
    if (delBtn) delBtn.addEventListener('click', function () { opts.onDelete && opts.onDelete(delBtn); });

    window.scrollTo(0, 0);
  }

  window.FolderViews = {
    renderFolders: renderFolders,
    renderFolderShell: renderFolderShell,
    renderReader: renderReader
  };
})();
