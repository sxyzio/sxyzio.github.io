/* SECTION: ui-common —— 弹窗、提示条、图标与格式化工具 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function icon(name, cls) {
    return '<svg class="ic' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }

  /* ---------- toast ---------- */
  var TOAST_ICON = { ok: 'check', err: 'alert', info: 'info' };
  function toast(message, opts) {
    opts = opts || {};
    var type = opts.type || 'info';
    var root = document.getElementById('toast-root');
    if (!root) return;
    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.setAttribute('role', type === 'err' ? 'alert' : 'status');
    el.innerHTML = icon(TOAST_ICON[type] || 'info') +
      '<div>' + (opts.title ? '<b>' + esc(opts.title) + '</b>' : '') + esc(message) + '</div>';
    root.appendChild(el);
    var life = opts.duration || (type === 'err' ? 5200 : 2800);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }, life);
  }

  /* ---------- modal ---------- */
  var openCount = 0;
  function setBodyLock(on) {
    openCount = Math.max(0, openCount + (on ? 1 : -1));
    document.body.style.overflow = openCount > 0 ? 'hidden' : '';
  }

  function modal(opts) {
    opts = opts || {};
    var root = document.getElementById('modal-root');
    var wrap = document.createElement('div');
    wrap.className = 'modal-root';
    wrap.innerHTML =
      '<div class="modal-mask"></div>' +
      '<div class="modal' + (opts.wide ? ' modal-wide' : '') + '" role="dialog" aria-modal="true">' +
        '<div class="modal-head"><h2 class="modal-title">' + esc(opts.title || '') + '</h2></div>' +
        '<div class="modal-body">' + (opts.body || '') + '</div>' +
        '<div class="modal-foot">' + (opts.foot || '') + '</div>' +
      '</div>';
    root.appendChild(wrap);
    setBodyLock(true);

    var panel = wrap.querySelector('.modal');
    var closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      setBodyLock(false);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      if (opts.onClose) opts.onClose(result);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    }
    document.addEventListener('keydown', onKey, true);
    wrap.querySelector('.modal-mask').addEventListener('click', function () {
      if (opts.dismissable !== false) close(null);
    });

    if (opts.onMount) opts.onMount(panel, close);
    var focusTarget = panel.querySelector('[data-autofocus]') || panel.querySelector('input,textarea,button');
    if (focusTarget) setTimeout(function () { try { focusTarget.focus(); } catch (e) {} }, 30);
    return close;
  }

  /* 通用确认框：resolve(true/false) */
  function confirmDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var answered = false;
      var foot =
        '<button class="btn" type="button" data-act="cancel">' + esc(opts.cancelText || '取消') + '</button>' +
        '<button class="btn ' + (opts.danger ? 'btn-solid-danger' : 'btn-primary') + '" type="button" data-act="ok" data-autofocus>' +
          esc(opts.okText || '确定') + '</button>';
      var close = modal({
        title: opts.title || '请确认',
        body: opts.body || '',
        foot: foot,
        dismissable: true,
        onClose: function () { if (!answered) { answered = true; resolve(false); } },
        onMount: function (panel, closeFn) {
          panel.querySelector('[data-act="cancel"]').addEventListener('click', function () {
            answered = true; closeFn(); resolve(false);
          });
          panel.querySelector('[data-act="ok"]').addEventListener('click', function () {
            answered = true; closeFn(); resolve(true);
          });
        }
      });
      void close;
    });
  }

  /* 单行输入框：resolve(字符串/null) */
  function inputDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var answered = false;
      var body =
        (opts.notice ? '<div class="notice notice-info">' + icon('info') + '<div>' + opts.notice + '</div></div>' : '') +
        '<label class="field"><span class="field-label">' + esc(opts.label || '名称') + '</span>' +
        '<input class="input" type="text" data-role="value" value="' + esc(opts.value || '') + '" ' +
        'placeholder="' + esc(opts.placeholder || '') + '" data-autofocus spellcheck="false" maxlength="' + (opts.maxlength || 120) + '">' +
        (opts.hint ? '<p class="field-hint">' + esc(opts.hint) + '</p>' : '') +
        '<p class="field-hint" data-role="error" style="color:var(--danger);display:none"></p></label>';
      var foot =
        '<button class="btn" type="button" data-act="cancel">取消</button>' +
        '<button class="btn btn-primary" type="button" data-act="ok">' + esc(opts.okText || '确定') + '</button>';

      modal({
        title: opts.title || '请输入',
        body: body,
        foot: foot,
        onClose: function () { if (!answered) { answered = true; resolve(null); } },
        onMount: function (panel, closeFn) {
          var input = panel.querySelector('[data-role="value"]');
          var errEl = panel.querySelector('[data-role="error"]');
          var okBtn = panel.querySelector('[data-act="ok"]');
          function submit() {
            var val = input.value;
            var err = opts.validate ? opts.validate(val) : '';
            if (err) {
              errEl.textContent = err;
              errEl.style.display = '';
              input.focus();
              return;
            }
            answered = true;
            closeFn();
            resolve(val.trim());
          }
          okBtn.addEventListener('click', submit);
          input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
          });
          input.addEventListener('input', function () { errEl.style.display = 'none'; });
          panel.querySelector('[data-act="cancel"]').addEventListener('click', function () {
            answered = true; closeFn(); resolve(null);
          });
          if (opts.value) { input.select(); }
        }
      });
    });
  }

  /* ---------- format ---------- */
  function size(n) {
    if (n == null || n === '') return '';
    n = Number(n);
    if (!isFinite(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function setBusy(btn, busy, busyLabel) {
    if (!btn) return;
    if (busy) {
      if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span><span>' + esc(busyLabel || '处理中…') + '</span>';
    } else {
      btn.disabled = false;
      if (btn.dataset.origHtml) { btn.innerHTML = btn.dataset.origHtml; delete btn.dataset.origHtml; }
    }
  }

  function kindIcon(kind) {
    var map = { doc: 'doc', img: 'image', zip: 'zip', code: 'code', audio: 'file', video: 'file', office: 'file', file: 'file' };
    return map[kind] || 'file';
  }

  function kindClass(kind) {
    return kind && kind !== 'file' ? ' row-ico-' + kind : '';
  }

  /* 空状态 */
  function empty(opts) {
    return '<div class="empty">' +
      '<div class="empty-ico">' + icon(opts.icon || 'folder') + '</div>' +
      '<h3>' + esc(opts.title || '这里还是空的') + '</h3>' +
      '<p>' + esc(opts.text || '') + '</p>' +
      (opts.actionHtml || '') +
      '</div>';
  }

  function loading(text) {
    return '<div class="loading-line"><span class="spinner spinner-dark"></span><span>' + esc(text || '正在读取…') + '</span></div>';
  }

  function skeletons(n) {
    var s = '';
    for (var i = 0; i < (n || 3); i++) s += '<div class="skeleton"></div>';
    return s;
  }

  /* 统一的错误提示：区分令牌失效与其他错误 */
  function reportError(err, onAuthFail) {
    var msg = (err && err.message) ? err.message : '操作失败，请重试。';
    if (err && err.status === 401 && onAuthFail) onAuthFail(msg);
    else toast(msg, { type: 'err' });
    return msg;
  }

  window.UI = {
    esc: esc,
    icon: icon,
    toast: toast,
    modal: modal,
    confirm: confirmDialog,
    input: inputDialog,
    size: size,
    setBusy: setBusy,
    kindIcon: kindIcon,
    kindClass: kindClass,
    empty: empty,
    loading: loading,
    skeletons: skeletons,
    reportError: reportError
  };
})();
