/* SECTION: app —— 主控制器。登录校验、hash 路由、快照缓存，
   以及文件夹 / 文章 / 文件三类操作的串联。 */
(function () {
  'use strict';

  var esc = UI.esc, icon = UI.icon;
  var CFG = window.VAULT_CONFIG || {};
  var SESSION_KEY = 'vault.session';

  var app = {
    authed: false,
    canWrite: false,
    login: '',
    snapshot: null,       // 最近一次 list 结果
    inflight: null,       // 正在进行的 list 请求，用于并发去重
    currentFolder: null,  // 当前打开的文件夹对象
    detached: []          // 视图卸载时需要清理的监听器
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ================= 路由 ================= */
  function route() {
    var h = location.hash.replace(/^#/, '') || '/';
    var qs = '';
    var qIdx = h.indexOf('?');
    if (qIdx >= 0) { qs = h.slice(qIdx + 1); h = h.slice(0, qIdx); }
    var params = {};
    qs.split('&').forEach(function (kv) {
      if (!kv) return;
      var p = kv.split('=');
      params[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
    });
    var segs = h.split('/').filter(function (s) { return s !== ''; });
    return {
      segs: segs,                 // 保持编码态，由 render 按需解码一次
      params: params,
      raw: h
    };
  }

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  function folderHash(name, tab) {
    return '#/folder/' + encodeURIComponent(name) + (tab ? '?tab=' + tab : '');
  }
  function readHash(name, path) {
    return '#/folder/' + encodeURIComponent(name) + '/read?path=' + encodeURIComponent(path);
  }
  function editHash(name, path) {
    return '#/folder/' + encodeURIComponent(name) + '/edit?path=' + encodeURIComponent(path);
  }
  function writeHash(name) {
    return '#/folder/' + encodeURIComponent(name) + '/write';
  }

  /* ================= 快照 ================= */
  function loadSnapshot(force) {
    if (app.snapshot && !force) return Promise.resolve(app.snapshot);
    // 已有一次 list 在途且非强制刷新时，复用它，避免并发重复请求
    if (app.inflight && !force) return app.inflight;
    app.inflight = Store.list().then(function (snap) {
      snap.repoLabel = Store.state.owner + '/' + Store.state.repo;
      snap.baseLabel = Store.state.basePath || '';
      app.snapshot = snap;
      app.inflight = null;
      return snap;
    }).catch(function (err) {
      app.inflight = null;
      throw err;
    });
    return app.inflight;
  }

  function findFolder(name) {
    if (!app.snapshot) return null;
    return app.snapshot.folders.filter(function (f) { return f.name === name; })[0] || null;
  }

  function findArticle(folder, path) {
    if (!folder) return null;
    return folder.articles.filter(function (a) { return a.path === path; })[0] || null;
  }

  /* 每次写操作后刷新快照，保证列表与服务端一致 */
  function refresh() {
    app.snapshot = null;
    return loadSnapshot(true);
  }

  function mainHost() { return $('main'); }

  function cleanup() {
    app.detached.forEach(function (fn) { try { fn(); } catch (e) {} });
    app.detached = [];
  }

  /* ================= 顶栏 ================= */
  function paintChrome() {
    $('repo-chip').textContent = Store.state.owner + '/' + Store.state.repo + ' · ' + Store.state.branch;
    var badge = $('perm-badge');
    badge.innerHTML = app.canWrite
      ? '<span class="badge badge-write">' + icon('check') + '可读写</span>'
      : '<span class="badge badge-read">' + icon('lock') + '只读</span>';
    if (app.login) badge.title = '当前身份：' + app.login;
  }

  /* ================= 视图分发 ================= */
  function render() {
    if (!app.authed) return;
    cleanup();
    var r = route();
    var host = mainHost();
    var segs = r.segs;

    if (!segs.length) { renderFolderList(host); return; }

    if (segs[0] === 'folder' && segs[1]) {
      var name = decodeURIComponent(segs[1]);
      var p = r.params.path || '';
      if (segs[2] === 'write') { renderEditor(host, name, null); return; }
      if (segs[2] === 'edit' && p) { renderEditor(host, name, p); return; }
      if (segs[2] === 'read' && p) { renderReader(host, name, p); return; }
      renderFolderDetail(host, name, r.params.tab === 'files' ? 'files' : 'articles');
      return;
    }
    renderFolderList(host);
  }

  /* ---------- 文件夹列表 ---------- */
  function renderFolderList(host) {
    host.innerHTML = '<div class="view">' + UI.skeletons(4) + '</div>';
    loadSnapshot().then(function (snap) {
      FolderViews.renderFolders(host, snap, {
        canWrite: app.canWrite,
        onNew: function (trigger) { promptNewFolder(trigger); },
        onOpen: function (name) { go(folderHash(name)); },
        onDelete: function (name, trigger) { promptDeleteFolder(name, trigger); }
      });
    }).catch(function (err) {
      if (err && err.status === 401) return forceLogout(err.message);
      host.innerHTML = '<div class="view">' +
        '<div class="notice notice-error">' + icon('alert') + '<div>' + esc(err.message) + '</div></div>' +
        '<button class="btn btn-sm" type="button" id="retry-list">' + icon('refresh') + '<span>重试</span></button>' +
        '</div>';
      $('retry-list').addEventListener('click', function () { app.snapshot = null; render(); });
    });
  }

  function promptNewFolder(trigger) {
    UI.input({
      title: '新建文件夹',
      label: '文件夹名称',
      placeholder: '例如：读书笔记',
      hint: '会在这个文件夹下自动建好「文章」和「文件」两个子目录。',
      validate: function (v) {
        var clean = Store.safeName(v);
        if (!clean) return '名称不能为空，且不能包含 / \\ : * ? " < > | 等字符。';
        if (findFolder(clean)) return '已经有一个同名文件夹了。';
        return '';
      }
    }).then(function (name) {
      if (!name) return;
      var clean = Store.safeName(name);
      var btn = trigger || document.querySelector('[data-primary-action="new-folder"]');
      UI.setBusy(btn, true, '创建中…');
      Store.createFolder(clean).then(refresh).then(function () {
        UI.setBusy(btn, false);
        UI.toast('文件夹「' + clean + '」已创建。', { type: 'ok' });
        go(folderHash(clean));
      }).catch(function (err) {
        UI.setBusy(btn, false);
        if (err && err.status === 401) return forceLogout(err.message);
        UI.reportError(err);
      });
    });
  }

  function promptDeleteFolder(name, trigger) {
    var f = findFolder(name);
    var count = f ? (f.articles.length + f.files.length) : 0;
    UI.confirm({
      title: '删除文件夹「' + name + '」？',
      danger: true,
      okText: '删除文件夹',
      body: '<p>这会删除该文件夹下<b>全部内容</b>' + (count ? '（' + count + ' 项）' : '') + '，操作不可撤销。</p>' +
        '<p style="font-size:13px;color:var(--ink-3)">删除会以一次提交记录在仓库里，必要时可以到 GitHub 的提交历史找回。</p>'
    }).then(function (ok) {
      if (!ok) return;
      var btn = trigger || null;
      UI.setBusy(btn, true, '删除中…');
      Store.deleteFolder(name).then(refresh).then(function () {
        UI.setBusy(btn, false);
        UI.toast('文件夹「' + name + '」已删除。', { type: 'ok' });
        render();
      }).catch(function (err) {
        UI.setBusy(btn, false);
        if (err && err.status === 401) return forceLogout(err.message);
        UI.reportError(err);
      });
    });
  }

  /* ---------- 文件夹详情 ---------- */
  function renderFolderDetail(host, name, tab) {
    host.innerHTML = '<div class="view">' + UI.skeletons(3) + '</div>';
    loadSnapshot().then(function () {
      var folder = findFolder(name);
      if (!folder) {
        host.innerHTML = '<div class="view"><div class="notice notice-error">' + icon('alert') +
          '<div>找不到文件夹「' + esc(name) + '」，它可能已被删除。</div></div>' +
          '<button class="btn btn-sm" type="button" id="back-home">返回文件夹列表</button></div>';
        $('back-home').addEventListener('click', function () { go('#/'); });
        return;
      }
      app.currentFolder = folder;
      var panel = FolderViews.renderFolderShell(host, folder, {
        canWrite: app.canWrite,
        tab: tab,
        onTab: function (t) { go(folderHash(name, t)); },
        onHome: function () { go('#/'); }
      });
      if (tab === 'files') renderFilesPanel(panel, folder);
      else renderArticlesPanel(panel, folder);
    }).catch(function (err) {
      if (err && err.status === 401) return forceLogout(err.message);
      UI.reportError(err);
      host.innerHTML = '<div class="view"><div class="notice notice-error">' + icon('alert') +
        '<div>' + esc(err.message) + '</div></div></div>';
    });
  }

  function renderArticlesPanel(panel, folder) {
    ArticlesPanel.render(panel, folder, {
      canWrite: app.canWrite,
      onNew: function () { go(writeHash(folder.name)); },
      onOpen: function (a) { go(readHash(folder.name, a.path)); },
      onEdit: function (a) { go(editHash(folder.name, a.path)); },
      onDelete: function (a, trigger) { promptDeleteArticle(folder, a, trigger); }
    });
  }

  function promptDeleteArticle(folder, a, trigger, afterDelete) {
    var title = ArticlesPanel.titleOf(a.name);
    UI.confirm({
      title: '删除文章「' + title + '」？',
      danger: true,
      okText: '删除文章',
      body: '<p>文章文件将从仓库中移除，操作不可撤销。</p>' +
        '<p style="font-size:13px;color:var(--ink-3)">历史版本仍可在 GitHub 的提交记录中找到。</p>'
    }).then(function (ok) {
      if (!ok) return;
      var btn = trigger || null;
      UI.setBusy(btn, true, '删除中…');
      Store.deleteArticle(a.path).then(refresh).then(function () {
        UI.setBusy(btn, false);
        UI.toast('文章已删除。', { type: 'ok' });
        if (afterDelete) afterDelete(); else render();
      }).catch(function (err) {
        UI.setBusy(btn, false);
        if (err && err.status === 401) return forceLogout(err.message);
        UI.reportError(err);
      });
    });
  }

  /* ---------- 文件面板 ---------- */
  function renderFilesPanel(panel, folder) {
    FilesPanel.render(panel, folder, {
      canWrite: app.canWrite,
      maxUploadMb: CFG.maxUploadMb || 25,
      onUpload: function (list) { doUpload(panel, folder, list); },
      onDownload: function (f, row) { doDownload(f, row); },
      onDelete: function (f, trigger) { promptDeleteFile(folder, f, trigger); }
    });
  }

  function doUpload(panel, folder, list) {
    var total = list.length;
    FilesPanel.showUploadBar(panel, '准备上传 ' + total + ' 个文件…', 0);
    Store.uploadFiles(folder.name, list, function (done, all, name) {
      FilesPanel.showUploadBar(panel, name, Math.round(done / all * 100));
    }).then(function () {
      return refresh();
    }).then(function () {
      FilesPanel.hideUploadBar(panel);
      UI.toast(total + ' 个文件已上传到「' + folder.name + '」。', { type: 'ok' });
      render();
    }).catch(function (err) {
      FilesPanel.hideUploadBar(panel);
      if (err && err.status === 401) return forceLogout(err.message);
      UI.reportError(err);
    });
  }

  function doDownload(f, row) {
    var slot = row ? row.querySelector('[data-role="dl-state"]') : null;
    var original = slot ? slot.textContent : '';
    if (slot) slot.textContent = '下载中…';
    Store.download(f.path, f.name).then(function () {
      if (slot) slot.textContent = '已下载';
      setTimeout(function () { if (slot && slot.isConnected) slot.textContent = original || '点击下载'; }, 2600);
    }).catch(function (err) {
      if (slot) slot.textContent = original || '点击下载';
      if (err && err.status === 401) return forceLogout(err.message);
      UI.reportError(err);
    });
  }

  function promptDeleteFile(folder, f, trigger) {
    UI.confirm({
      title: '删除「' + f.name + '」？',
      danger: true,
      okText: '删除文件',
      body: '<p>这个文件将从仓库中移除，操作不可撤销。</p>' +
        '<p style="font-size:13px;color:var(--ink-3)">历史版本仍可在 GitHub 的提交记录中找到。</p>'
    }).then(function (ok) {
      if (!ok) return;
      var btn = trigger || null;
      UI.setBusy(btn, true, '删除中…');
      Store.deleteFile(f.path).then(refresh).then(function () {
        UI.setBusy(btn, false);
        UI.toast('文件已删除。', { type: 'ok' });
        render();
      }).catch(function (err) {
        UI.setBusy(btn, false);
        if (err && err.status === 401) return forceLogout(err.message);
        UI.reportError(err);
      });
    });
  }

  /* ---------- 阅读视图 ---------- */
  function renderReader(host, folderName, path) {
    host.innerHTML = '<div class="view narrow">' + UI.loading('正在读取文章…') + '</div>';
    loadSnapshot().then(function () {
      var folder = findFolder(folderName);
      var article = findArticle(folder, path);
      if (!article) {
        host.innerHTML = '<div class="view narrow"><div class="notice notice-error">' + icon('alert') +
          '<div>找不到这篇文章，它可能已被删除或移动。</div></div>' +
          '<button class="btn btn-sm" type="button" id="back-folder">返回文件夹</button></div>';
        $('back-folder').addEventListener('click', function () { go(folderHash(folderName)); });
        return;
      }
      return Store.readText(article.path).then(function (text) {
        article.title = ArticlesPanel.titleOf(article.name);
        FolderViews.renderReader(host, article, text, folderName, {
          canWrite: app.canWrite,
          onHome: function () { go('#/'); },
          onBack: function () { go(folderHash(folderName)); },
          onEdit: function () { go(editHash(folderName, article.path)); },
          onDelete: function (trigger) {
            promptDeleteArticle(folder, article, trigger, function () { go(folderHash(folderName)); });
          }
        });
      });
    }).catch(function (err) {
      if (err && err.status === 401) return forceLogout(err.message);
      host.innerHTML = '<div class="view narrow"><div class="notice notice-error">' + icon('alert') +
        '<div>' + esc(err.message) + '</div></div></div>';
    });
  }

  /* ---------- 编辑器视图 ---------- */
  function renderEditor(host, folderName, path) {
    host.innerHTML = '<div class="view">' + UI.loading('正在准备编辑器…') + '</div>';

    loadSnapshot().then(function () {
      var folder = findFolder(folderName);
      if (!folder) { go('#/'); return null; }
      if (!app.canWrite) {
        host.innerHTML = '<div class="view"><div class="notice notice-warn">' + icon('lock') +
          '<div>当前令牌是只读权限，不能新建或编辑文章。请换成 Contents 可写的令牌。</div></div></div>';
        return null;
      }

      var crumb =
        '<button type="button" data-act="home">全部文件夹</button>' +
        '<span class="sep">' + icon('back') + '</span>' +
        '<button type="button" data-act="folder">' + esc(folderName) + '</button>' +
        '<span class="sep">' + icon('back') + '</span>' +
        '<span class="current">' + (path ? '编辑文章' : '新建文章') + '</span>';

      function mount(article, text) {
        Editor.open({
          crumb: crumb,
          isNew: !article,
          title: article ? article.title : '',
          content: text || '',
          onDetach: function (fn) { app.detached.push(fn); },
          onBack: function () { go(folderHash(folderName)); },
          onAuthFail: forceLogout,
          onSave: function (title, body) {
            return Store.writeArticle(
              folderName, title, body,
              null,                       // 目标路径由标题推导，同名自动避让
              article ? article.path : null
            ).then(function (res) {
              var newPath = (res && res.path) || (article && article.path);
              return refresh().then(function () {
                UI.toast(article ? '已保存。' : '文章已创建。', { type: 'ok' });
                go(newPath ? readHash(folderName, newPath) : folderHash(folderName));
              });
            });
          }
        });
        // 编辑器内面包屑需要自己绑定
        var c = document.getElementById('ed-crumb');
        if (c) {
          var homeBtn = c.querySelector('[data-act="home"]');
          var fBtn = c.querySelector('[data-act="folder"]');
          if (homeBtn) homeBtn.addEventListener('click', function () { go('#/'); });
          if (fBtn) fBtn.addEventListener('click', function () { go(folderHash(folderName)); });
        }
      }

      if (!path) { mount(null, ''); return null; }

      var article = findArticle(folder, path);
      if (!article) { go(folderHash(folderName)); return null; }
      article.title = ArticlesPanel.titleOf(article.name);
      return Store.readText(article.path).then(function (text) { mount(article, text); });
    }).catch(function (err) {
      if (err && err.status === 401) return forceLogout(err.message);
      host.innerHTML = '<div class="view"><div class="notice notice-error">' + icon('alert') +
        '<div>' + esc(err.message) + '</div></div></div>';
    });
  }

  /* ================= 登录 / 登出 ================= */
  function saveSession(cfg) {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(cfg));
    } catch (e) {}
  }
  function readSession() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  function notice(html, type) {
    return '<div class="notice notice-' + (type || 'error') + '">' + icon(type === 'warn' ? 'alert' : 'alert') +
      '<div>' + html + '</div></div>';
  }

  function showLogin(errHtml, preset) {
    app.authed = false;
    $('shell').hidden = true;
    var v = $('view-login');
    v.hidden = false;
    var n = $('login-notice');
    n.innerHTML = errHtml || '';
    var p = preset || {};
    $('f-owner').value = p.owner != null ? p.owner : (CFG.owner || '');
    $('f-repo').value = p.repo != null ? p.repo : (CFG.repo || '');
    $('f-branch').value = p.branch != null ? p.branch : (CFG.branch || '');
    $('f-base').value = p.basePath != null ? p.basePath : (CFG.basePath || '');
    $('f-token').value = p.token || '';
    setTimeout(function () { (p.token ? $('f-owner') : $('f-token')).focus(); }, 60);
  }

  function enterApp(info) {
    app.authed = true;
    app.canWrite = !!info.hasWrite;
    app.login = info.login || '';
    $('view-login').hidden = true;
    $('shell').hidden = false;
    $('brand-text').textContent = CFG.siteTitle || 'GitHub 文档库';
    paintChrome();
    if (!location.hash) location.hash = '#/';
    render();
  }

  function forceLogout(message) {
    clearSession();
    app.snapshot = null;
    Store.reset();
    showLogin(notice(esc(message || '令牌已失效，请重新验证。')));
    UI.toast(message || '令牌已失效，请重新验证。', { type: 'err' });
  }

  function doLogin(values) {
    var btn = $('btn-login');
    var $n = $('login-notice');
    $n.innerHTML = '';
    UI.setBusy(btn, true, '正在向 GitHub 验证…');

    Store.verify(values).then(function (info) {
      var allow = CFG.allowUsers || [];
      if (allow.length) {
        var ok = allow.some(function (u) { return String(u).toLowerCase() === String(info.login).toLowerCase(); }) ||
          String(info.login).toLowerCase() === String(values.owner).toLowerCase();
        if (!ok) {
          UI.setBusy(btn, false);
          $n.innerHTML = notice('身份已确认为 <b>' + esc(info.login) + '</b>，但这个账号不在允许进入的名单里。请联系站点管理员把该用户名加入配置。');
          Store.reset();
          return;
        }
      }
      if (!info.hasWrite) {
        // 只读令牌可以进入，但提前告知能力边界
        $n.innerHTML = '';
      }
      saveSession(values);
      UI.setBusy(btn, false);
      app.snapshot = null;
      enterApp(info);
      UI.toast(info.hasWrite ? '已进入，当前令牌可读写。' : '已进入，当前令牌为只读，仅可浏览与下载。',
        { type: 'ok' });
      if (!info.hasWrite) {
        setTimeout(function () {
          UI.toast('只读令牌不能新建、上传或删除，需要时请重新生成一个 Contents 可写的令牌。', { type: 'info', duration: 6000 });
        }, 900);
      }
    }).catch(function (err) {
      UI.setBusy(btn, false);
      var msg = (err && err.message) || '验证失败，请重试。';
      var html = esc(msg);
      if (err && err.code === 'forbidden') {
        html += '<br>请确认令牌的 <b>Contents</b> 权限设置为 Read and write。';
      } else if (err && err.code === 'notfound') {
        html += '<br>也请确认生成令牌时勾选了这个仓库。';
      }
      $n.innerHTML = notice(html);
      Store.reset();
    });
  }

  function bindLogin() {
    $('login-title').textContent = CFG.siteTitle || 'GitHub 文档库';
    document.title = CFG.siteTitle || 'GitHub 文档库';
    $('login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      doLogin({
        token: $('f-token').value.trim(),
        owner: $('f-owner').value.trim(),
        repo: $('f-repo').value.trim(),
        branch: $('f-branch').value.trim(),
        basePath: $('f-base').value.trim()
      });
    });
    // 站点配置里已写死仓库时，隐藏这两项的手填必要，但仍允许覆盖
    if (CFG.owner) $('f-owner').placeholder = CFG.owner;
    if (CFG.repo) $('f-repo').placeholder = CFG.repo;
  }

  function bindChrome() {
    $('btn-home').addEventListener('click', function () { go('#/'); });
    $('btn-logout').addEventListener('click', function () {
      UI.confirm({
        title: '退出登录？',
        okText: '退出',
        body: '<p>令牌会从当前标签页清除，仓库里的内容不受影响。下次进入需要重新填写令牌。</p>'
      }).then(function (ok) { if (ok) forceLogout('已退出登录。'); });
    });
    $('btn-reload').addEventListener('click', function () {
      var btn = $('btn-reload');
      UI.setBusy(btn, true, '');
      app.snapshot = null;
      loadSnapshot(true).then(function () {
        UI.setBusy(btn, false);
        UI.toast('已重新拉取仓库内容。', { type: 'ok' });
        render();
      }).catch(function (err) {
        UI.setBusy(btn, false);
        if (err && err.status === 401) return forceLogout(err.message);
        UI.reportError(err);
      });
    });
    window.addEventListener('hashchange', render);
  }

  /* ================= 启动 ================= */
  function boot() {
    bindLogin();
    bindChrome();

    var session = readSession();
    if (session && session.token) {
      // 用会话里的令牌静默复登，失败就回到登录页
      showLogin('', session);
      Store.verify(session).then(function (info) {
        enterApp(info);
      }).catch(function () {
        Store.reset();
        showLogin(notice('上次的令牌已失效，请重新填写。'), session);
      });
    } else {
      showLogin();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
