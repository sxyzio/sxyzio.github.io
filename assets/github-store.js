/* SECTION: store —— GitHub 数据层。全部读写走 api.github.com 的 Git Data API，
   每次操作合并成一次 commit，权限由 GitHub 服务器判定。 */
(function () {
  'use strict';

  var API = 'https://api.github.com';
  var MAX_BLOB_MB = 100; // GitHub 单个 blob 上限 100MB

  function StoreError(message, opts) {
    var e = new Error(message);
    e.name = 'StoreError';
    e.status = (opts && opts.status) || 0;
    e.code = (opts && opts.code) || '';
    e.retryable = !!(opts && opts.retryable);
    return e;
  }

  var state = {
    token: '',
    owner: '',
    repo: '',
    branch: '',
    defaultBranch: '',
    basePath: '',
    login: '',
    hasWrite: false,
    repoPrivate: false,
    lastHeadSha: ''
  };

  /* ---------- utils ---------- */
  function joinPath() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var p = String(arguments[i] == null ? '' : arguments[i]);
      p = p.replace(/^\/+|\/+$/g, '');
      if (p) parts.push(p);
    }
    return parts.join('/');
  }

  function encodePath(p) {
    return String(p).split('/').filter(function (s) { return s !== ''; })
      .map(encodeURIComponent).join('/');
  }

  function bytesToBase64(bytes) {
    var CH = 0x8000, out = '';
    for (var i = 0; i < bytes.length; i += CH) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(out);
  }

  function base64ToBytes(b64) {
    var bin = atob(b64.replace(/\s/g, ''));
    var len = bin.length, bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function utf8Bytes(str) {
    return new TextEncoder().encode(str);
  }

  function bytesToText(buf) {
    try { return new TextDecoder('utf-8', { fatal: false }).decode(buf); }
    catch (e) {
      var s = '', bytes = new Uint8Array(buf);
      for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function stamp() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* ---------- fetch core ---------- */
  function request(path, opts) {
    opts = opts || {};
    var headers = {
      'Authorization': 'Bearer ' + state.token,
      'Accept': opts.accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (opts.method && opts.method !== 'GET') headers['Content-Type'] = 'application/json';

    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      var remaining = res.headers.get('x-ratelimit-remaining');
      if (res.status === 401) {
        throw StoreError('令牌无效或已被撤销，请重新生成后再试。', { status: 401, code: 'unauthorized' });
      }
      if (res.status === 403 && remaining === '0') {
        throw StoreError('GitHub 接口访问频率已达上限，请一小时后再试，或减少刷新次数。', { status: 403, code: 'ratelimited' });
      }
      if (res.status === 403) {
        throw StoreError('GitHub 拒绝了这次写入：当前令牌没有该仓库的 Contents 写权限。', { status: 403, code: 'forbidden' });
      }
      if (res.status === 404) {
        throw StoreError('找不到这个仓库或这个分支。检查所有者、仓库名、分支是否填对，以及令牌是否授权了该仓库。', { status: 404, code: 'notfound' });
      }
      if (res.status === 422) {
        return res.json().then(function (j) {
          var detail = '';
          if (j.errors && j.errors[0] && j.errors[0].message) detail = '（' + j.errors[0].message + '）';
          throw StoreError('GitHub 拒绝了这次操作' + detail, { status: 422, code: 'invalid' });
        });
      }
      if (!res.ok && res.status !== 204 && res.status !== 304) {
        throw StoreError('GitHub 返回了异常状态 ' + res.status + '，请稍后重试。', { status: res.status, code: 'http' });
      }
      if (opts.raw) return res.arrayBuffer();
      if (res.status === 204) return null;
      return res.json();
    }).catch(function (err) {
      if (err && err.name === 'StoreError') throw err;
      throw StoreError('连不上 GitHub，请检查网络后重试。', { code: 'network', retryable: true });
    });
  }

  /* ---------- auth ---------- */
  function verifyToken(cfg) {
    state.token = (cfg.token || '').trim();
    state.owner = (cfg.owner || '').trim().replace(/^\/+|\/+$/g, '');
    state.repo = (cfg.repo || '').trim().replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    state.branch = (cfg.branch || '').trim();
    state.basePath = (cfg.basePath || '').trim().replace(/^\/+|\/+$/g, '').replace(/\/+$/g, '');

    if (!state.token) throw StoreError('请先填写 GitHub 令牌。', { code: 'badinput' });
    if (!state.owner || !state.repo) throw StoreError('请填写仓库所有者和仓库名。', { code: 'badinput' });

    var repoPath = '/repos/' + encodePath(state.owner) + '/' + encodePath(state.repo);
    return request(repoPath).then(function (repo) {
      if (!repo.permissions || !repo.permissions.pull) {
        throw StoreError('这个令牌读不了该仓库。请确认生成令牌时勾选了这个仓库，并授予 Contents 权限。', { code: 'noperm' });
      }
      state.repoPrivate = !!repo.private;
      state.defaultBranch = repo.default_branch || 'main';
      state.hasWrite = !!(repo.permissions.push || repo.permissions.admin || repo.permissions.maintain);
      if (!state.branch) state.branch = state.defaultBranch;

      return request('/user').then(function (me) {
        state.login = me.login || '';
        return {
          login: state.login,
          hasWrite: state.hasWrite,
          repo: state.owner + '/' + state.repo,
          branch: state.branch,
          basePath: state.basePath,
          isPrivate: state.repoPrivate
        };
      }).catch(function () {
        // 经典令牌缺少 user:read 权限时，仍可用仓库权限判定身份
        var name = (state.token.indexOf('github_pat_') === 0) ? '' : '';
        return {
          login: name || '(未读取到用户名)',
          hasWrite: state.hasWrite,
          repo: state.owner + '/' + state.repo,
          branch: state.branch,
          basePath: state.basePath,
          isPrivate: state.repoPrivate
        };
      });
    });
  }

  /* ---------- tree read ---------- */
  function getHeadSha() {
    return request('/repos/' + encodePath(state.owner) + '/' + encodePath(state.repo) +
      '/git/ref/heads/' + encodePath(state.branch))
      .then(function (r) {
        var sha = r && r.object && r.object.sha;
        if (!sha) throw StoreError('分支 ' + state.branch + ' 不存在或还没有任何提交。', { code: 'nobranch' });
        state.lastHeadSha = sha;
        return sha;
      });
  }

  function kindOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || '');
    var ext = m ? m[1].toLowerCase() : '';
    if (ext === 'md' || ext === 'markdown') return 'doc';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'].indexOf(ext) >= 0) return 'img';
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].indexOf(ext) >= 0) return 'zip';
    if (['js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'css', 'html', 'json', 'yml', 'yaml', 'sh', 'sql'].indexOf(ext) >= 0) return 'code';
    if (['mp3', 'wav', 'm4a', 'flac', 'ogg'].indexOf(ext) >= 0) return 'audio';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].indexOf(ext) >= 0) return 'video';
    if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].indexOf(ext) >= 0) return 'office';
    return 'file';
  }

  function relOf(full) {
    if (!state.basePath) return full;
    return full.indexOf(state.basePath + '/') === 0 ? full.slice(state.basePath.length + 1) : null;
  }

  /* 一次 recursive tree 请求拿到全部结构 */
  function listAll() {
    var repoRoot = '/' + encodePath(state.owner) + '/' + encodePath(state.repo);
    return getHeadSha().then(function (sha) {
      return request(repoRoot + '/git/trees/' + sha + '?recursive=1');
    }).then(function (data) {
      var tree = data.tree || [];
      var folders = {};   // name -> {name, articleCount, fileCount, articles:[], files:[]}
      var loose = [];     // basePath 根下的散落文件
      var A = (window.VAULT_CONFIG.articlesDir || '文章');
      var F = (window.VAULT_CONFIG.filesDir || '文件');

      function ensure(name) {
        if (!folders[name]) {
          folders[name] = {
            name: name,
            path: joinPath(state.basePath, name),
            articles: [], files: [], others: []
          };
        }
        return folders[name];
      }

      tree.forEach(function (node) {
        if (node.type !== 'blob') {
          // 目录节点：登记顶层文件夹，保证空文件夹也能显示出来
          var rel0 = relOf(node.path);
          if (rel0 !== null && node.type === 'tree') {
            var top = rel0.split('/')[0];
            if (top) ensure(top);
          }
          return;
        }
        var rel = relOf(node.path);
        if (rel === null) return;
        var segs = rel.split('/');
        var fname = segs[segs.length - 1];
        if (fname === '.gitkeep') return;   // 占位文件不计入任何列表

        if (segs.length === 1) { loose.push(node); return; }

        var folder = ensure(segs[0]);
        var sub = segs.length > 2 ? segs[1] : '';
        var m = /\.([a-z0-9]+)$/i.exec(fname);
        var item = {
          name: fname,
          path: node.path,
          size: (typeof node.size === 'number' ? node.size : 0),
          sha: node.sha,
          kind: kindOf(fname),
          ext: m ? m[1].toLowerCase() : ''
        };

        if (sub === A) folder.articles.push(item);
        else if (sub === F) folder.files.push(item);
        else if (!sub && item.kind === 'doc') folder.articles.push(item);  // 直接放在文件夹根的 md
        else if (!sub) folder.files.push(item);                            // 直接放在文件夹根的其他文件
        else folder.others.push(item);                                     // 自建子目录里的内容
      });

      var list = Object.keys(folders).map(function (k) {
        var f = folders[k];
        // 文章目录内即使不是 .md 也按文章展示，避免内容丢失
        f.articles.forEach(function (it) {
          if (it.kind !== 'doc') it.kind = 'doc';
          it.title = it.name.replace(/\.(md|markdown)$/i, '');
        });
        // 自建子目录里的文件并入文件区，md 并入文章区
        f.others.forEach(function (it) {
          if (it.kind === 'doc') { it.kind = 'doc'; it.title = it.name.replace(/\.(md|markdown)$/i, ''); f.articles.push(it); }
          else f.files.push(it);
        });
        f.others = [];
        f.articles.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN'); });
        f.files.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN'); });
        return f;
      }).sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN'); });

      return {
        folders: list,
        truncated: !!data.truncated,
        branch: state.branch,
        rootFiles: loose.map(function (n) { return n.path; })
      };
    });
  }

  /* ---------- read a single blob ---------- */
  /* 直接取原始字节：单次请求，支持到 100MB，二进制不乱码 */
  function readBlob(path) {
    var repoRoot = '/' + encodePath(state.owner) + '/' + encodePath(state.repo);
    return request(repoRoot + '/contents/' + encodePath(path) + '?ref=' + encodeURIComponent(state.branch), {
      accept: 'application/vnd.github.raw',
      raw: true
    }).then(function (buf) {
      return new Uint8Array(buf);
    });
  }

  function readText(path) {
    return readBlob(path).then(function (bytes) { return bytesToText(bytes.buffer || bytes); });
  }

  /* 下载用：拿到 Blob 触发浏览器保存 */
  function download(path, name) {
    return readBlob(path).then(function (bytes) {
      var blob = new Blob([bytes], { type: 'application/octet-stream' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name || path.split('/').pop();
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 4000);
    });
  }

  function fileToBytes(file) {
    return file.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  /* ---------- commit builder ---------- */
  /* ops: [{ path, text } | { path, file } | { delete: path }] */
  function applyOps(ops, message) {
    var repoRoot = '/' + encodePath(state.owner) + '/' + encodePath(state.repo);
    var maxMb = window.VAULT_CONFIG.maxUploadMb || 25;

    var oversized = ops.filter(function (o) {
      return o.file && o.file.size > Math.min(maxMb, MAX_BLOB_MB) * 1024 * 1024;
    });
    if (oversized.length) {
      return Promise.reject(StoreError(
        '文件「' + oversized[0].file.name + '」超过网页上传上限（' + maxMb + ' MB），请到 GitHub 仓库页面手动上传。',
        { code: 'toobig' }
      ));
    }

    function attempt(triesLeft) {
      return getHeadSha().then(function (headSha) {
        return request(repoRoot + '/git/commits/' + headSha).then(function (commit) {
          var baseTree = commit.tree.sha;

          var blobJobs = ops.map(function (op) {
            if (op.delete) return Promise.resolve(null);
            return Promise.resolve(op.file ? fileToBytes(op.file) : utf8Bytes(op.text || '')).then(function (bytes) {
              return request(repoRoot + '/git/blobs', {
                method: 'POST',
                body: { content: bytesToBase64(bytes), encoding: 'base64' }
              }).then(function (b) { return { sha: b.sha, size: bytes.length }; });
            });
          });

          return Promise.all(blobJobs).then(function (shas) {
            var entries = ops.map(function (op, i) {
              if (op.delete) {
                return { path: op.delete, mode: '100644', type: 'blob', sha: null };
              }
              return {
                path: op.path,
                mode: op.exec ? '100755' : '100644',
                type: 'blob',
                sha: shas[i].sha
              };
            });

            return request(repoRoot + '/git/trees', {
              method: 'POST',
              body: { base_tree: baseTree, tree: entries }
            }).then(function (tree) {
              return request(repoRoot + '/git/commits', {
                method: 'POST',
                body: { message: message, tree: tree.sha, parents: [headSha] }
              });
            });
          });
        }).then(function (newCommit) {
          return request(repoRoot + '/git/refs/heads/' + encodePath(state.branch), {
            method: 'PATCH',
            body: { sha: newCommit.sha, force: false }
          }).then(function () {
            return { sha: newCommit.sha, message: message, time: stamp() };
          });
        });
      }).catch(function (err) {
        if (err && err.status === 409 && triesLeft > 0) {
          return attempt(triesLeft - 1); // 仓库刚被别人改动，基于最新提交重试一次
        }
        throw err;
      });
    }

    return attempt(1);
  }

  /* ---------- high level ---------- */
  function safeName(raw) {
    var s = String(raw || '').trim()
      .replace(/[\\/:*?"<>|#%\u0000-\u001f]/g, '')
      .replace(/^\.+/, '')
      .replace(/\s+/g, ' ');
    if (!s) return '';
    return s.slice(0, 80);
  }

  function safeFileBase(raw) {
    var s = String(raw || '').trim()
      .replace(/[\\/:*?"<>|#%\u0000-\u001f]/g, '')
      .replace(/^\.+/, '');
    if (!s) s = '未命名';
    return s.slice(0, 90);
  }

  function uniquePath(existing, dir, base, ext) {
    var taken = {};
    existing.forEach(function (p) { taken[p.toLowerCase()] = 1; });
    var path = joinPath(dir, ext ? base + '.' + ext : base);
    var i = 2;
    while (taken[path.toLowerCase()]) {
      path = joinPath(dir, ext ? base + '_' + i + '.' + ext : base + '_' + i);
      i++;
    }
    return path;
  }

  function A_DIR() { return window.VAULT_CONFIG.articlesDir || '文章'; }
  function F_DIR() { return window.VAULT_CONFIG.filesDir || '文件'; }

  function createFolder(name) {
    var clean = safeName(name);
    if (!clean) return Promise.reject(StoreError('文件夹名称不能为空，也不要包含 / \\ : * ? " < > | 等字符。', { code: 'badname' }));
    return listAll().then(function (snap) {
      var exists = snap.folders.some(function (f) { return f.name === clean; });
      if (exists) throw StoreError('已经有一个同名文件夹「' + clean + '」。', { code: 'dup' });
      var base = joinPath(state.basePath, clean);
      return applyOps([
        { path: joinPath(base, A_DIR(), '.gitkeep'), text: '' },
        { path: joinPath(base, F_DIR(), '.gitkeep'), text: '' }
      ], 'create folder: ' + clean);
    }).then(function () { return clean; });
  }

  function deleteFolder(name) {
    var found = null;
    return listAll().then(function (snap) {
      found = snap.folders.filter(function (f) { return f.name === name; })[0];
      if (!found) throw StoreError('这个文件夹已经不在了。', { code: 'gone' });
      var prefix = found.path + '/';
      return listAllFullPaths(prefix).then(function (all) {
        var ops = all.map(function (p) { return { delete: p }; });
        if (!ops.length) throw StoreError('这个文件夹是空的，没有可删除的内容。', { code: 'empty' });
        return applyOps(ops, 'delete folder: ' + name);
      });
    });
  }

  function listAllFullPaths(prefix) {
    var repoRoot = '/' + encodePath(state.owner) + '/' + encodePath(state.repo);
    return getHeadSha().then(function (sha) {
      return request(repoRoot + '/git/trees/' + sha + '?recursive=1');
    }).then(function (data) {
      return (data.tree || []).filter(function (n) {
        return n.type === 'blob' && n.path.indexOf(prefix) === 0;
      }).map(function (n) { return n.path; });
    });
  }

  function writeArticle(folderName, title, markdownText, articlePath, deletePath) {
    var base = safeFileBase(title);
    var dir = joinPath(state.basePath, folderName, A_DIR());
    return listAll().then(function (snap) {
      var f = snap.folders.filter(function (x) { return x.name === folderName; })[0];
      var existing = f ? f.articles.map(function (a) { return a.path; }) : [];
      var path = articlePath;
      if (!path) {
        // 改名或新建时，把旧路径从占用表里剔除，避免自己跟自己撞名
        var pool = deletePath ? existing.filter(function (p) { return p !== deletePath; }) : existing;
        path = uniquePath(pool, dir, base, 'md');
      }
      var ops = [{ path: path, text: markdownText }];
      if (deletePath && deletePath !== path) ops.push({ delete: deletePath });
      return applyOps(ops, 'save article: ' + base).then(function (r) {
        r.path = path;
        return r;
      });
    });
  }

  function deleteArticle(path) {
    return applyOps([{ delete: path }], 'delete article: ' + path.split('/').pop());
  }

  function uploadFiles(folderName, files, onProgress) {
    var dir = joinPath(state.basePath, folderName, F_DIR());
    var queue = [].slice.call(files);
    return listAll().then(function (snap) {
      var f = snap.folders.filter(function (x) { return x.name === folderName; })[0];
      var existing = f ? f.files.map(function (a) { return a.path; }) : [];
      var done = 0;
      var chain = Promise.resolve();
      queue.forEach(function (file) {
        chain = chain.then(function () {
          var name = safeFileBase(file.name), ext = '';
          var m = /\.([a-z0-9]+)$/i.exec(file.name);
          if (m) { name = file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 90); ext = m[1].toLowerCase(); }
          var path = uniquePath(existing, dir, name, ext);
          existing.push(path);
          return applyOps([{ path: path, file: file }], 'upload: ' + path.split('/').pop())
            .then(function () {
              done++;
              if (onProgress) onProgress(done, queue.length, file.name);
            });
        });
      });
      return chain.then(function () { return done; });
    });
  }

  function deleteFile(path) {
    return applyOps([{ delete: path }], 'delete file: ' + path.split('/').pop());
  }

  function reset() {
    Object.keys(state).forEach(function (k) {
      state[k] = (typeof state[k] === 'boolean') ? false : '';
    });
  }

  window.Store = {
    state: state,
    verify: verifyToken,
    list: listAll,
    readText: readText,
    download: download,
    createFolder: createFolder,
    deleteFolder: deleteFolder,
    writeArticle: writeArticle,
    deleteArticle: deleteArticle,
    uploadFiles: uploadFiles,
    deleteFile: deleteFile,
    reset: reset,
    safeName: safeName,
    stamp: stamp,
    paths: function (folderName, which) {
      return joinPath(state.basePath, folderName, which === 'articles' ? A_DIR() : F_DIR());
    }
  };
})();
