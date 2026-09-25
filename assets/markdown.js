/* SECTION: markdown —— 轻量 Markdown 渲染器。
   安全策略：所有源文本先整体 HTML 转义再解析，链接/图片走协议白名单，
   不产出 script、iframe、on* 事件属性，也不还原任何实体。 */
(function () {
  'use strict';

  var ITEM_RE = /^(\s*)([-+*]|\d{1,9}[.)])(\s+)(.*)$/;
  var FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
  var FENCE_END_RE = /^(\s{0,3})(`{3,}|~{3,})\s*$/;
  var HEAD_RE = /^(\s{0,3})(#{1,6})\s+(.*?)\s*#*\s*$/;
  var HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  var QUOTE_RE = /^(\s{0,3})>\s?(.*)$/;
  var TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* 只放行 http/https/mailto 与站内相对地址；data: 仅放行常见位图 */
  function sanitizeUrl(raw) {
    var url = String(raw == null ? '' : raw).trim();
    if (!url) return '';
    if (/[\u0000-\u001f]/.test(url)) return '';
    if (/^(?:javascript|vbscript|file|blob):/i.test(url)) return '';
    if (/^data:/i.test(url)) {
      return /^data:image\/(?:png|jpe?g|gif|webp);/i.test(url) ? url : '';
    }
    return url;
  }

  /* ---------- inline ---------- */
  function inline(raw) {
    var codes = [];
    var text = String(raw == null ? '' : raw);

    text = text.replace(/(`+)([\s\S]*?)\1/g, function (m, ticks, code) {
      var i = codes.length;
      codes.push(escapeHtml(code.replace(/^ ([\s\S]*) $/, '$1')));
      return '\u0001C' + i + '\u0001';
    });

    text = escapeHtml(text);

    /* 图片 */
    text = text.replace(/!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
      function (m, alt, url, title) {
        var safe = sanitizeUrl(url);
        if (!safe) return alt;
        return '<img src="' + safe + '" alt="' + alt + '"' +
          (title ? ' title="' + title + '"' : '') + ' loading="lazy">';
      });

    /* 链接 */
    text = text.replace(/\[([^\]]+)\]\(\s*([^\s)]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
      function (m, label, url, title) {
        var safe = sanitizeUrl(url);
        var ext = /^https?:/i.test(safe) ? ' target="_blank" rel="noopener noreferrer"' : '';
        return '<a href="' + (safe || '#') + '"' + ext +
          (title ? ' title="' + title + '"' : '') + '>' + label + '</a>';
      });

    /* 裸链接 <https://...> */
    text = text.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/g, function (m, url) {
      var safe = sanitizeUrl(url);
      return safe
        ? '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + url + '</a>'
        : m;
    });

    /* 强调 */
    text = text.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>');
    text = text.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1<em>$2</em>');
    text = text.replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>');
    text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    text = text.replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>');

    /* 还原行内代码（内容已转义，不再参与任何替换） */
    text = text.replace(/\u0001C(\d+)\u0001/g, function (m, i) {
      return '<code>' + codes[+i] + '</code>';
    });
    return text;
  }

  /* ---------- table ---------- */
  function splitRow(line) {
    var s = String(line).trim().replace(/^\|/, '').replace(/\|$/, '');
    var cells = [], cur = '', esc = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (esc) { cur += ch; esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '|') { cells.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur);
    return cells.map(function (c) { return c.trim(); });
  }

  function parseTable(lines, i) {
    var header = splitRow(lines[i]);
    var aligns = splitRow(lines[i + 1]).map(function (c) {
      var l = /^:/.test(c), r = /:$/.test(c);
      return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
    });
    var html = '<table><thead><tr>';
    header.forEach(function (c, idx) {
      html += '<th' + (aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : '') + '>' + inline(c) + '</th>';
    });
    html += '</tr></thead><tbody>';
    var j = i + 2;
    while (j < lines.length && !/^\s*$/.test(lines[j]) && lines[j].indexOf('|') >= 0) {
      var cells = splitRow(lines[j]);
      html += '<tr>';
      for (var k = 0; k < header.length; k++) {
        html += '<td' + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + inline(cells[k] || '') + '</td>';
      }
      html += '</tr>';
      j++;
    }
    return { html: html + '</tbody></table>', next: j };
  }

  /* ---------- list ---------- */
  function dedentLine(line, n) {
    var lead = /^\s*/.exec(line)[0].length;
    return lead >= n ? line.slice(n) : line.replace(/^\s+/, '');
  }

  function collectList(lines, i) {
    var baseIndent = /^\s*/.exec(lines[i])[0].length;
    var out = [];
    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*$/.test(line)) {
        var j = i + 1;
        while (j < lines.length && /^\s*$/.test(lines[j])) j++;
        if (j >= lines.length) break;
        var nm = ITEM_RE.exec(lines[j]);
        var nind = /^\s*/.exec(lines[j])[0].length;
        if ((nm && nind >= baseIndent) || nind > baseIndent) {
          for (var k = i; k < j; k++) out.push(lines[k]);
          i = j; continue;
        }
        break;
      }
      var m = ITEM_RE.exec(line);
      if (m) {
        if (/^\s*/.exec(line)[0].length < baseIndent) break;
        out.push(line); i++; continue;
      }
      if (/^\s*/.exec(line)[0].length >= baseIndent && out.length) { out.push(line); i++; continue; }
      break;
    }
    return { lines: out, next: i };
  }

  /* tight 列表：短项直接内联，不包 <p>；loose 列表（项内/项间有空行）：段落用 <p> */
  function renderItemBody(lines, loose) {
    var i = 0, lead = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
      lead.push(lines[i]); i++;
    }
    var rest = lines.slice(i);
    var html = '';
    if (lead.length) {
      var inlineHtml = lead.map(function (l) { return inline(l); }).join('\n')
        .replace(/ {2,}\n/g, '<br>\n').replace(/\\\n/g, '<br>\n');
      html += loose ? '<p>' + inlineHtml + '</p>' : inlineHtml;
    }
    if (rest.length) html += blocks(rest);
    return html;
  }

  function detectLoose(items) {
    var loose = false;
    items.forEach(function (it, idx) {
      var lines = it.lines, start = 0, end = lines.length;
      while (start < end && /^\s*$/.test(lines[start])) start++;
      while (end > start && /^\s*$/.test(lines[end - 1])) end--;
      for (var i = start; i < end - 1; i++) {
        if (/^\s*$/.test(lines[i])) loose = true;   // 项内空行
      }
      if (idx < items.length - 1) {
        for (var j = end; j < lines.length; j++) {
          if (/^\s*$/.test(lines[j])) loose = true; // 项间空行
        }
      }
    });
    return loose;
  }

  function buildList(lines) {
    var first = ITEM_RE.exec(lines[0]);
    var baseIndent = first[1].length;
    var ordered = /\d/.test(first[2]);
    var start = ordered ? parseInt(first[2], 10) : 1;
    var items = [], cur = null;

    for (var i = 0; i < lines.length; i++) {
      var m = ITEM_RE.exec(lines[i]);
      var ind = /^\s*/.exec(lines[i])[0].length;
      if (m && ind <= baseIndent) {
        if (cur) items.push(cur);
        baseIndent = ind;
        var contentStart = m[1].length + m[2].length + m[3].length;
        cur = { lines: [], task: null, dedent: contentStart };
        var rest = lines[i].slice(contentStart);
        var cb = /^\[([ xX])\]\s+([\s\S]*)$/.exec(rest);
        if (cb) { cur.task = cb[1].toLowerCase() === 'x'; rest = cb[2]; }
        cur.lines.push(rest);
      } else if (cur) {
        cur.lines.push(dedentLine(lines[i], cur.dedent));
      }
    }
    if (cur) items.push(cur);

    var loose = detectLoose(items);
    var tag = ordered ? 'ol' : 'ul';
    var html = '<' + tag + (ordered && start !== 1 ? ' start="' + start + '"' : '') + '>';
    items.forEach(function (it) {
      var body = renderItemBody(it.lines, loose);
      if (it.task !== null) {
        html += '<li class="task-item"><span class="task-box' + (it.task ? ' on' : '') + '">' +
          (it.task ? '&#10003;' : '') + '</span><span>' + body + '</span></li>';
      } else {
        html += '<li>' + body + '</li>';
      }
    });
    return html + '</' + tag + '>';
  }

  /* ---------- block ---------- */
  function isBlockStart(line) {
    return FENCE_RE.test(line) || HEAD_RE.test(line) || HR_RE.test(line) ||
      QUOTE_RE.test(line) || ITEM_RE.test(line);
  }

  function blocks(lines) {
    var html = '', i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }

      var fence = FENCE_RE.exec(line);
      if (fence) {
        var marker = fence[2].charAt(0), minLen = fence[2].length, lang = fence[3] || '';
        var buf = [];
        i++;
        while (i < lines.length) {
          var cm = FENCE_END_RE.exec(lines[i]);
          if (cm && cm[2].charAt(0) === marker && cm[2].length >= minLen) { i++; break; }
          buf.push(lines[i]); i++;
        }
        html += '<pre><code' + (lang ? ' class="language-' + escapeHtml(lang) + '"' : '') + '>' +
          escapeHtml(buf.join('\n')) + '</code></pre>';
        continue;
      }

      var head = HEAD_RE.exec(line);
      if (head) {
        var lvl = head[2].length;
        html += '<h' + lvl + '>' + inline(head[3]) + '</h' + lvl + '>';
        i++; continue;
      }

      if (HR_RE.test(line)) { html += '<hr>'; i++; continue; }

      if (QUOTE_RE.test(line)) {
        var qb = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) {
          qb.push(QUOTE_RE.exec(lines[i])[2]); i++;
        }
        html += '<blockquote>' + blocks(qb) + '</blockquote>';
        continue;
      }

      if (ITEM_RE.test(line)) {
        var lb = collectList(lines, i);
        if (!lb.lines.length) { i++; continue; }
        html += buildList(lb.lines);
        i = lb.next;
        continue;
      }

      if (line.indexOf('|') >= 0 && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
        var tb = parseTable(lines, i);
        html += tb.html; i = tb.next;
        continue;
      }

      var para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
        para.push(lines[i]); i++;
      }
      if (!para.length) { para.push(line); i++; }
      var paraHtml = para.map(function (l) { return inline(l); }).join('\n');
      paraHtml = paraHtml.replace(/ {2,}\n/g, '<br>\n').replace(/\\\n/g, '<br>\n');
      html += '<p>' + paraHtml + '</p>';
    }
    return html;
  }

  function render(src) {
    var text = String(src == null ? '' : src);
    if (!text.trim()) {
      return '<p class="md-empty">这篇文章还没有内容。点「编辑」开始写。</p>';
    }
    return blocks(text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
  }

  /* 取纯文本摘要，用于列表副标题 */
  function excerpt(src, max) {
    var s = String(src == null ? '' : src)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*([-*_]\s?){3,}$/gm, ' ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_~`>#|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    var n = max || 60;
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function countWords(src) {
    var s = String(src == null ? '' : src);
    var cjk = (s.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    var latin = (s.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ')
      .match(/[A-Za-z0-9_'-]+/g) || []).length;
    return cjk + latin;
  }

  window.Markdown = {
    render: render,
    escape: escapeHtml,
    sanitizeUrl: sanitizeUrl,
    excerpt: excerpt,
    countWords: countWords
  };
})();
