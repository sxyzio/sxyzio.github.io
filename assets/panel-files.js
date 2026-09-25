/* SECTION: panel-files —— 文件夹内「文件」区。
   上传（含拖拽与串行队列）、下载、删除、搜索过滤。 */
(function () {
  'use strict';

  var esc = UI.esc, icon = UI.icon;

  function rowHtml(f) {
    return '<div class="row" data-path="' + esc(f.path) + '">' +
      '<span class="row-ico' + UI.kindClass(f.kind) + '">' + icon(UI.kindIcon(f.kind)) + '</span>' +
      '<button class="row-main" type="button" data-act="download" title="下载这个文件">' +
        '<p class="row-title">' + esc(f.name) + '</p>' +
        '<p class="row-sub">' +
          (f.size ? '<span>' + UI.size(f.size) + '</span>' : '') +
          (f.ext ? '<span class="dot"></span><span>' + esc(f.ext.toUpperCase()) + '</span>' : '') +
          '<span class="dot"></span><span data-role="dl-state">点击下载</span>' +
        '</p>' +
      '</button>' +
      '<div class="row-actions">' +
        '<button class="btn btn-icon" type="button" data-act="download" title="下载">' + icon('download') + '</button>' +
        '<button class="btn btn-icon btn-danger" type="button" data-act="del" title="删除文件">' + icon('trash') + '</button>' +
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

  function uploadBarHtml(label, pct) {
    return '<div class="uploading" data-role="upload-bar">' +
      '<span class="spinner spinner-dark"></span>' +
      '<span style="flex:none;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(label) + '</span>' +
      '<span class="progress"><i style="width:' + (pct || 0) + '%"></i></span>' +
      '<span style="flex:none;color:var(--ink-3)">' + (pct || 0) + '%</span>' +
    '</div>';
  }

  function showUploadBar(host, label, pct) {
    var mount = host.querySelector('[data-role="upload-mount"]');
    if (!mount) return;
    mount.innerHTML = uploadBarHtml(label, pct);
  }
  function hideUploadBar(host) {
    var mount = host.querySelector('[data-role="upload-mount"]');
    if (mount) mount.innerHTML = '';
  }

  /* ctx: { canWrite, onUpload(files), onDownload(file), onDelete(file), maxUploadMb } */
  function render(host, folder, ctx) {
    ctx = ctx || {};
    var files = folder.files || [];
    var maxMb = ctx.maxUploadMb || 25;

    var dropzone = ctx.canWrite
      ? '<div class="dropzone" data-role="dropzone" tabindex="0" role="button">' +
          icon('upload') +
          '<div>把文件拖到这里，或<b>点击选择文件</b>上传</div>' +
          '<div style="font-size:12px;color:var(--ink-3);margin-top:4px">单个文件最大 ' + maxMb + ' MB，多个文件会自动排队上传</div>' +
        '</div>'
      : '<div class="notice notice-warn">' + icon('lock') +
          '<div>当前令牌是只读权限，可以下载但不能上传或删除文件。换成 Contents 可写的令牌即可解锁。</div></div>';

    var bar =
      '<div class="panel-bar">' +
        '<div class="panel-bar-left">' +
          '<div class="search">' + icon('search') +
            '<input class="input" type="search" data-role="filter" placeholder="搜索文件名" spellcheck="false">' +
          '</div>' +
          (files.length ? '<span style="font-size:12.5px;color:var(--ink-3)">' + files.length + ' 个文件 · 共 ' +
            UI.size(files.reduce(function (s, f) { return s + (f.size || 0); }, 0)) + '</span>' : '') +
        '</div>' +
        (ctx.canWrite && files.length
          ? '<button class="btn btn-sm" type="button" data-act="pick">' + icon('upload') + '<span>上传文件</span></button>'
          : '') +
      '</div>';

    var body;
    if (!files.length) {
      body = UI.empty({
        icon: 'file',
        title: '这个文件夹还没有文件',
        text: ctx.canWrite ? '把图片、压缩包、PDF 等任意文件放进这个文件夹，之后可以在线下载。' : '当前令牌是只读权限，换成可写令牌后可以上传文件。',
        actionHtml: ''
      });
    } else {
      body = '<div class="list">' + files.map(rowHtml).join('') + '</div>' +
        '<div class="empty" data-role="no-match" style="display:none;padding:34px 20px">' +
          '<h3>没有匹配的文件</h3><p>换个关键词试试。</p></div>';
    }

    host.innerHTML = dropzone + bar + '<div data-role="upload-mount"></div>' + body;

    /* --- 搜索 --- */
    var filterInput = host.querySelector('[data-role="filter"]');
    if (filterInput) filterInput.addEventListener('input', function () { applyFilter(host, filterInput.value); });

    /* --- 上传入口 --- */
    var fileInput = document.getElementById('hidden-file-input');

    function pickFiles() {
      if (!ctx.canWrite) return;
      if (!fileInput) return;
      fileInput.value = '';
      fileInput.onchange = function () {
        var list = fileInput.files;
        if (list && list.length) startUpload([].slice.call(list));
      };
      fileInput.click();
    }

    var dz = host.querySelector('[data-role="dropzone"]');
    if (dz) {
      dz.addEventListener('click', pickFiles);
      dz.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFiles(); }
      });
      ['dragenter', 'dragover'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); });
      });
      dz.addEventListener('drop', function (e) {
        var dt = e.dataTransfer;
        if (!dt || !dt.files || !dt.files.length) return;
        startUpload([].slice.call(dt.files));
      });
    }

    function startUpload(list) {
      // 先按大小筛掉超限的，避免整批失败
      var limit = maxMb * 1024 * 1024;
      var ok = [], tooBig = [];
      list.forEach(function (f) { (f.size > limit ? tooBig : ok).push(f); });
      if (tooBig.length) {
        UI.toast('「' + tooBig[0].name + '」超过 ' + maxMb + ' MB，请到 GitHub 仓库页面手动上传。', { type: 'err' });
      }
      if (!ok.length) return;
      if (ctx.onUpload) ctx.onUpload(ok);
    }

    host.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.dataset.act;
      if (act === 'pick') { pickFiles(); return; }
      var row = btn.closest('.row[data-path]');
      if (!row) return;
      var item = (folder.files || []).filter(function (f) { return f.path === row.dataset.path; })[0];
      if (!item) return;
      if (act === 'download') ctx.onDownload && ctx.onDownload(item, row);
      else if (act === 'del') ctx.onDelete && ctx.onDelete(item, btn);
    });
  }

  window.FilesPanel = {
    render: render,
    showUploadBar: showUploadBar,
    hideUploadBar: hideUploadBar
  };
})();
