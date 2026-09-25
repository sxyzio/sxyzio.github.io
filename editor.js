/* SECTION: editor —— 文章编辑器视图。
   左右分栏实时预览；小屏切换「写 / 看」单栏；支持工具栏插入与 Ctrl/Cmd+S 保存。 */
(function () {
  'use strict';

  var esc = UI.esc, icon = UI.icon;

  function buildShell() {
    var host = document.getElementById('main');
    host.innerHTML =
      '<div class="view editor-view">' +
        '<nav class="crumb" id="ed-crumb"></nav>' +
        '<section class="editor" id="editor">' +
          '<header class="editor-head">' +
            '<button class="btn btn-icon" type="button" id="ed-back" title="返回">' + icon('back', 'ic-lg') + '</button>' +
            '<input class="editor-title" id="ed-title" type="text" placeholder="文章标题" maxlength="90" spellcheck="false">' +
            '<div class="toolrow hide-sm" id="ed-mode">' +
              '<button class="tool" type="button" data-mode="split" title="分栏">' + icon('split') + '</button>' +
              '<button class="tool" type="button" data-mode="write" title="只写">' + icon('pencil') + '</button>' +
              '<button class="tool" type="button" data-mode="read" title="只看">' + icon('eye') + '</button>' +
            '</div>' +
            '<button class="btn btn-primary btn-sm" type="button" id="ed-save" data-primary-action="save-article">' + icon('save') + '<span>保存</span></button>' +
          '</header>' +
          '<div class="editor-body">' +
            '<div class="pane pane-edit">' +
              '<div class="pane-head"><span>编辑 · Markdown</span>' +
                '<div class="toolrow" id="ed-tools">' +
                  '<button class="tool" type="button" data-ins="bold" title="加粗">' + icon('bold') + '</button>' +
                  '<button class="tool" type="button" data-ins="italic" title="斜体">' + icon('italic') + '</button>' +
                  '<button class="tool" type="button" data-ins="h2" title="二级标题">' + icon('doc') + '</button>' +
                  '<button class="tool" type="button" data-ins="list" title="无序列表">' + icon('list') + '</button>' +
                  '<button class="tool" type="button" data-ins="quote" title="引用">' + icon('quote') + '</button>' +
                  '<button class="tool" type="button" data-ins="link" title="链接">' + icon('link') + '</button>' +
                  '<button class="tool" type="button" data-ins="code" title="代码块">' + icon('code') + '</button>' +
                '</div>' +
              '</div>' +
              '<textarea class="md-input" id="ed-input" spellcheck="false" placeholder="用 Markdown 写点什么…&#10;&#10;# 一级标题&#10;**加粗** *斜体* `代码`&#10;- 列表项&#10;> 引用&#10;[链接](https://example.com)"></textarea>' +
            '</div>' +
            '<div class="pane pane-preview">' +
              '<div class="pane-head"><span>预览</span></div>' +
              '<div class="markdown" id="ed-preview"></div>' +
            '</div>' +
          '</div>' +
          '<footer class="editor-foot">' +
            '<div class="editor-stat" id="ed-stat"></div>' +
            '<div class="editor-stat"><span id="ed-hint">Ctrl/⌘ + S 保存</span></div>' +
          '</footer>' +
        '</section>' +
      '</div>';
    return host;
  }

  var INSERTS = {
    bold: { before: '**', after: '**', placeholder: '加粗文字' },
    italic: { before: '*', after: '*', placeholder: '斜体文字' },
    h2: { before: '## ', after: '', placeholder: '小标题', line: true },
    list: { before: '- ', after: '', placeholder: '列表项', line: true },
    quote: { before: '> ', after: '', placeholder: '引用', line: true },
    link: { before: '[', after: '](https://)', placeholder: '链接文字' },
    code: { before: '```\n', after: '\n```', placeholder: '代码', line: true }
  };

  function applyInsert(textarea, key) {
    var ins = INSERTS[key];
    if (!ins) return;
    var s = textarea.selectionStart, e = textarea.selectionEnd;
    var val = textarea.value;
    var selected = val.slice(s, e) || ins.placeholder;

    var prefix = '';
    if (ins.line && s > 0 && val.charAt(s - 1) !== '\n') prefix = '\n';

    var inserted = prefix + ins.before + selected + ins.after;
    textarea.setRangeText(inserted, s, e, 'end');

    // 选中占位或用户刚选中的文字，方便继续输入
    var selStart = s + prefix.length + ins.before.length;
    textarea.setSelectionRange(selStart, selStart + selected.length);
    textarea.focus();
    textarea.dispatchEvent(new Event('input'));
  }

  function updateStat(input, titleEl) {
    var text = input.value;
    var words = Markdown.countWords(text);
    var lines = text ? text.split('\n').length : 0;
    var stat = document.getElementById('ed-stat');
    if (stat) stat.innerHTML = '<span>' + words + ' 字</span><span class="dot" style="width:3px;height:3px;border-radius:50%;background:#c9ced8;display:inline-block"></span><span>' + lines + ' 行</span>';
  }

  function setMode(mode) {
    var editor = document.getElementById('editor');
    if (!editor) return;
    editor.classList.remove('mode-split', 'mode-write', 'mode-read');
    editor.classList.add('mode-' + mode);
    var tools = editor.querySelectorAll('#ed-mode .tool');
    tools.forEach(function (b) {
      b.style.background = (b.dataset.mode === mode) ? '#eef0f4' : '';
      b.style.color = (b.dataset.mode === mode) ? 'var(--ink)' : '';
    });
    try { localStorage.setItem('vault.editorMode', mode); } catch (e) {}
  }

  function currentMode() {
    try { return localStorage.getItem('vault.editorMode') || 'split'; } catch (e) { return 'split'; }
  }

  /* opts: { crumb, title, content, saving, onSave(text,title)->Promise, onBack, isNew } */
  function open(opts) {
    opts = opts || {};
    buildShell();

    var crumb = document.getElementById('ed-crumb');
    if (opts.crumb) crumb.innerHTML = opts.crumb;
    else crumb.style.display = 'none';

    var titleEl = document.getElementById('ed-title');
    var input = document.getElementById('ed-input');
    var preview = document.getElementById('ed-preview');
    var saveBtn = document.getElementById('ed-save');
    var backBtn = document.getElementById('ed-back');

    titleEl.value = opts.title || '';
    input.value = opts.content || '';

    var dirty = false;
    function render() {
      preview.innerHTML = Markdown.render(input.value);
      updateStat(input, titleEl);
    }
    render();

    var rafId = 0;
    input.addEventListener('input', function () {
      dirty = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(function () { render(); rafId = 0; });
    });
    titleEl.addEventListener('input', function () { dirty = true; });

    // Tab 键在编辑区插入两个空格，而不是跳走焦点
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        var s = input.selectionStart, en = input.selectionEnd;
        input.setRangeText('  ', s, en, 'end');
        input.dispatchEvent(new Event('input'));
      }
    });

    // 工具栏
    var toolRow = document.getElementById('ed-tools');
    if (toolRow) {
      toolRow.addEventListener('click', function (e) {
        var b = e.target.closest('[data-ins]');
        if (b) applyInsert(input, b.dataset.ins);
      });
    }

    // 视图模式
    var modeRow = document.getElementById('ed-mode');
    if (modeRow) {
      modeRow.addEventListener('click', function (e) {
        var b = e.target.closest('[data-mode]');
        if (b) setMode(b.dataset.mode);
      });
    }
    setMode(currentMode());

    function doSave() {
      var title = titleEl.value.trim();
      if (!title) {
        UI.toast('请先给文章起个标题。', { type: 'err' });
        titleEl.focus();
        return;
      }
      if (opts.saving) return;
      UI.setBusy(saveBtn, true, '保存中…');
      dirty = false;
      Promise.resolve(opts.onSave(title, input.value)).then(function () {
        UI.setBusy(saveBtn, false);
      }).catch(function (err) {
        UI.setBusy(saveBtn, false);
        dirty = true;
        UI.reportError(err, opts.onAuthFail);
      });
    }

    saveBtn.addEventListener('click', doSave);
    backBtn.addEventListener('click', function () {
      if (dirty) {
        UI.confirm({
          title: '放弃未保存的修改？',
          body: '这篇文章有改动还没保存，返回后这些修改会丢失。',
          okText: '放弃修改', danger: true
        }).then(function (ok) { if (ok && opts.onBack) opts.onBack(); });
      } else if (opts.onBack) {
        opts.onBack();
      }
    });

    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        doSave();
      }
    }
    document.addEventListener('keydown', onKey);

    // 离开编辑器视图时移除快捷键监听
    if (opts.onDetach) opts.onDetach(function () { document.removeEventListener('keydown', onKey); });

    setTimeout(function () { (opts.isNew ? titleEl : input).focus(); }, 40);
  }

  window.Editor = { open: open };
})();
