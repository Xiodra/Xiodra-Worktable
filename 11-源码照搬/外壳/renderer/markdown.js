/**
 * markdown.js —— 自包含 GFM 解析器 + 代码高亮（2026-11-25）
 *
 * 为什么自己写：
 *   · 参考项目（leoshone/markdown-viewer）靠 CDN 载入 marked / highlight.js / DOMPurify；
 *   · 本壳的 CSP 是 `script-src 'self'` ⇒ **不能用 CDN**，也**不想引第三方包**（离线可用优先）；
 *   · 我们只需要「读本地 .md 看得清」，不需要完美兼容全部 CommonMark 边界。
 *
 * ⛔ 安全：**一律转义 HTML**，不直通内联 HTML（参考项目用 DOMPurify，我们用更保守的"全转义"）。
 *
 * 支持：
 *   块级：ATX 标题(#)、Setext 标题(===/---)、段落、无序/有序列表（可嵌套一层）、
 *         任务列表(- [ ] / - [x])、引用(>，可嵌套)、围栏代码块(``` / ~~~，带语言)，
 *         GFM 表格(含对齐)、分隔线(--- &#47; *** &#47; ___)、缩进代码块(4 空格)
 *   行内：行内代码(`x`)、粗体(**)、斜体(* _)、删除线(~~)、链接[](url)、图片![]()、
 *         自动链接(http://…)、反斜杠转义、换行
 *   高亮：通用 tokenizer（注释 / 字符串 / 数字 / 关键字 / 函数调用），不区分语言也够用
 *
 * 用法：
 *   window.__dshMarkdown.render(mdText)  → { html, toc: [{level,text,id}] }
 */
(function () {
  'use strict';

  // ---------- 基础工具 ----------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 生成 slug（给标题锚点用；中文保留，空格变 -） */
  function slugify(text) {
    return String(text || '')
      .replace(/<[^>]*>/g, '')
      .trim()
      .toLowerCase()
      .replace(/[\s]+/g, '-')
      .replace(/[^\w\u4e00-\u9fa5\-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'section';
  }

  // ---------- 代码高亮（通用 tokenizer） ----------

  // 各语言常见关键字并集（够"看起来像高亮"，不求精确）
  var KW = ('abstract as async await base break case catch class const continue def default defer del delete do ' +
    'elif else end enum except export extends false final finally fn for foreach from func function global go ' +
    'if implements import in instanceof int interface is lambda let local module namespace new nil none not null ' +
    'of or package pass private protected public raise return self static struct super switch this throw throws ' +
    'true try type typeof unless until use var void when where while with yield ' +
    'echo function param filter begin process try trap finally')
    .split(/\s+/).filter(Boolean);
  var KW_SET = {};
  KW.forEach(function (k) { KW_SET[k] = 1; });

  /**
   * 把一段代码高亮成 HTML（先整体转义，再按 token 包 span —— 所以不会注入）。
   * 规则顺序：注释 → 字符串 → 数字 → 标识符（关键字/函数调用）→ 其它
   */
  function highlight(code, lang) {
    var src = String(code == null ? '' : code);
    var out = '';
    var i = 0;
    var n = src.length;
    var isHash = /^(py|python|sh|bash|shell|ps1|powershell|yml|yaml|toml|r|rb|ruby|perl|conf|ini|dockerfile|makefile)$/i.test(lang || '');

    while (i < n) {
      var c = src[i];
      var two = src.substr(i, 2);

      // 行注释：// 或 #（按语言）
      if (two === '//' || (c === '#' && isHash)) {
        var endL = src.indexOf('\n', i);
        if (endL < 0) endL = n;
        out += '<span class="md-tok-com">' + esc(src.slice(i, endL)) + '</span>';
        i = endL;
        continue;
      }
      // 块注释 /* ... */
      if (two === '/*') {
        var endB = src.indexOf('*/', i + 2);
        endB = endB < 0 ? n : endB + 2;
        out += '<span class="md-tok-com">' + esc(src.slice(i, endB)) + '</span>';
        i = endB;
        continue;
      }
      // HTML 注释 <!-- -->
      if (src.substr(i, 4) === '<!--') {
        var endH = src.indexOf('-->', i + 4);
        endH = endH < 0 ? n : endH + 3;
        out += '<span class="md-tok-com">' + esc(src.slice(i, endH)) + '</span>';
        i = endH;
        continue;
      }
      // 字符串 ' " `
      if (c === '"' || c === "'" || c === '`') {
        var q = c, j = i + 1, esc2 = false;
        while (j < n) {
          var ch = src[j];
          if (esc2) { esc2 = false; j++; continue; }
          if (ch === '\\') { esc2 = true; j++; continue; }
          if (ch === q) { j++; break; }
          // 单引号/双引号不跨行
          if (ch === '\n' && q !== '`') break;
          j++;
        }
        out += '<span class="md-tok-str">' + esc(src.slice(i, j)) + '</span>';
        i = j;
        continue;
      }
      // 数字
      if (/[0-9]/.test(c) && !/[\w]/.test(src[i - 1] || '')) {
        var m = /^[0-9][0-9_]*(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
        if (m) {
          out += '<span class="md-tok-num">' + esc(m[0]) + '</span>';
          i += m[0].length;
          continue;
        }
      }
      // 标识符：关键字 / 函数调用
      if (/[A-Za-z_$]/.test(c)) {
        var mm = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
        var word = mm[0];
        var after = src[i + word.length];
        if (KW_SET[word.toLowerCase()]) {
          out += '<span class="md-tok-kw">' + esc(word) + '</span>';
        } else if (after === '(') {
          out += '<span class="md-tok-fn">' + esc(word) + '</span>';
        } else {
          out += esc(word);
        }
        i += word.length;
        continue;
      }
      // 其它单字符
      out += esc(c);
      i++;
    }
    return out;
  }

  // ---------- 行内解析 ----------

  /**
   * 行内：代码 → 图片 → 链接 → 粗体 → 斜体 → 删除线 → 自动链接 → 转义
   * ⚠ 顺序很重要：先把反引号里的内容"占位"，避免里面的 * _ 被当成格式。
   */
  function inline(text) {
    var codes = [];
    var s = String(text == null ? '' : text);

    // ① 行内代码先挖出来占位（\u0000 不会被用户输入）
    s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, function (m, ticks, body) {
      codes.push('<code class="md-code-inline">' + esc(body.trim()) + '</code>');
      return '\u0000' + (codes.length - 1) + '\u0000';
    });

    // ② 反斜杠转义（\* \_ \` 等）
    var escapes = [];
    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, function (m, ch) {
      escapes.push(ch);
      return '\u0001' + (escapes.length - 1) + '\u0001';
    });

    // ③ 整体转义 HTML（之后插入的标签是我们自己的，安全）
    s = esc(s);

    // ④ 图片 ![alt](url "title")
    s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g, function (m, alt, url, title) {
      return '<img class="md-img" src="' + url + '" alt="' + alt + '"' + (title ? ' title="' + title + '"' : '') + '>';
    });

    // ⑤ 链接 [text](url "title")
    s = s.replace(/\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g, function (m, txt, url, title) {
      var ext = /^https?:/i.test(url);
      return '<a class="md-a"' + (ext ? ' target="_blank" rel="noreferrer"' : '') +
        ' href="' + url + '"' + (title ? ' title="' + title + '"' : '') + '>' + txt + '</a>';
    });

    // ⑥ 自动链接 http(s)://（跳过已在 href 里的）
    s = s.replace(/(^|[^"'>=])(https?:\/\/[^\s<"]+)/g, function (m, pre, url) {
      return pre + '<a class="md-a" target="_blank" rel="noreferrer" href="' + url + '">' + url + '</a>';
    });

    // ⑦ 粗体 **x** / __x__
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    // ⑧ 斜体 *x* / _x_（避免吃掉 ** 的残留）
    s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*])/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?![_])/g, '$1<em>$2</em>');
    // ⑨ 删除线 ~~x~~
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // ⑩ 还原占位（转义 → 行内代码）
    s = s.replace(/\u0001(\d+)\u0001/g, function (m, k) { return esc(escapes[Number(k)] || ''); });
    s = s.replace(/\u0000(\d+)\u0000/g, function (m, k) { return codes[Number(k)] || ''; });

    // ⑪ 硬换行：行尾两个空格 + 换行 → <br>
    s = s.replace(/ {2,}\n/g, '<br>\n');
    return s;
  }

  // ---------- 块级解析 ----------

  var RE_ATX = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  var RE_FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
  var RE_HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
  var RE_UL = /^(\s*)([-*+])\s+(.*)$/;
  var RE_OL = /^(\s*)(\d+)[.)]\s+(.*)$/;
  var RE_QUOTE = /^\s*>\s?(.*)$/;
  var RE_TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  function splitRow(line) {
    var s = String(line || '').trim();
    if (s[0] === '|') s = s.slice(1);
    if (s[s.length - 1] === '|') s = s.slice(0, -1);
    // 支持 \| 转义
    var cells = [];
    var cur = '';
    for (var i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
      if (s[i] === '|') { cells.push(cur); cur = ''; continue; }
      cur += s[i];
    }
    cells.push(cur);
    return cells.map(function (c) { return c.trim(); });
  }

  function render(text) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    var html = [];
    var toc = [];
    var usedSlug = {};
    var i = 0;

    function pushToc(level, txt) {
      var base = slugify(txt);
      var id = base;
      var k = 1;
      while (usedSlug[id]) { id = base + '-' + (k++); }
      usedSlug[id] = 1;
      toc.push({ level: level, text: txt.replace(/<[^>]*>/g, ''), id: id });
      return id;
    }

    while (i < lines.length) {
      var line = lines[i];

      // 空行
      if (!line.trim()) { i++; continue; }

      // ① 围栏代码块
      var mf = RE_FENCE.exec(line);
      if (mf) {
        var fence = mf[2];
        var lang = mf[3] || '';
        var buf = [];
        i++;
        while (i < lines.length) {
          var closeRe = new RegExp('^\\s*' + fence[0] + '{' + fence.length + ',}\\s*$');
          if (closeRe.test(lines[i])) { i++; break; }
          buf.push(lines[i]); i++;
        }
        html.push(
          '<div class="md-codewrap">' +
          (lang ? '<span class="md-codelang">' + esc(lang) + '</span>' : '') +
          '<pre class="md-pre"><code class="md-code">' + highlight(buf.join('\n'), lang) + '</code></pre>' +
          '</div>'
        );
        continue;
      }

      // ② ATX 标题
      var mh = RE_ATX.exec(line);
      if (mh) {
        var lv = mh[1].length;
        var htxt = inline(mh[2]);
        var hid = pushToc(lv, mh[2]);
        html.push('<h' + lv + ' class="md-h md-h' + lv + '" id="' + hid + '">' + htxt + '</h' + lv + '>');
        i++; continue;
      }

      // ③ Setext 标题（=== / ---），只在"下一行"且当前行不像别的东西时
      if (i + 1 < lines.length && line.trim() && !/^\s*[-*+]\s/.test(line)) {
        var next = lines[i + 1];
        if (/^\s*={2,}\s*$/.test(next)) {
          var hid1 = pushToc(1, line);
          html.push('<h1 class="md-h md-h1" id="' + hid1 + '">' + inline(line) + '</h1>');
          i += 2; continue;
        }
        if (/^\s*-{2,}\s*$/.test(next) && !RE_HR.test(line)) {
          var hid2 = pushToc(2, line);
          html.push('<h2 class="md-h md-h2" id="' + hid2 + '">' + inline(line) + '</h2>');
          i += 2; continue;
        }
      }

      // ④ 分隔线
      if (RE_HR.test(line)) { html.push('<hr class="md-hr">'); i++; continue; }

      // ⑤ 表格：当前行含 | 且下一行是分隔行
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
        var head = splitRow(line);
        var seps = splitRow(lines[i + 1]);
        var aligns = seps.map(function (c) {
          var l = /^:/.test(c), r = /:$/.test(c);
          return l && r ? 'center' : (r ? 'right' : (l ? 'left' : ''));
        });
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) {
          rows.push(splitRow(lines[i])); i++;
        }
        var th = head.map(function (c, k2) {
          var a = aligns[k2] ? ' style="text-align:' + aligns[k2] + '"' : '';
          return '<th' + a + '>' + inline(c) + '</th>';
        }).join('');
        var tb = rows.map(function (r) {
          var tds = [];
          for (var k3 = 0; k3 < head.length; k3++) {
            var a2 = aligns[k3] ? ' style="text-align:' + aligns[k3] + '"' : '';
            tds.push('<td' + a2 + '>' + inline(r[k3] == null ? '' : r[k3]) + '</td>');
          }
          return '<tr>' + tds.join('') + '</tr>';
        }).join('');
        html.push('<div class="md-tablewrap"><table class="md-table"><thead><tr>' + th + '</tr></thead><tbody>' + tb + '</tbody></table></div>');
        continue;
      }

      // ⑥ 引用（可嵌套）
      if (RE_QUOTE.test(line)) {
        var qbuf = [];
        while (i < lines.length && RE_QUOTE.test(lines[i])) {
          qbuf.push(RE_QUOTE.exec(lines[i])[1]);
          i++;
        }
        html.push('<blockquote class="md-quote">' + render(qbuf.join('\n')).html + '</blockquote>');
        continue;
      }

      // ⑦ 列表（无序 / 有序 / 任务）
      var mu = RE_UL.exec(line), mo = RE_OL.exec(line);
      if (mu || mo) {
        var ordered = !!mo;
        var items = [];
        var indent0 = (mu ? mu[1] : mo[1]).length;
        while (i < lines.length) {
          var lu = RE_UL.exec(lines[i]), lo = RE_OL.exec(lines[i]);
          var cur = ordered ? lo : lu;
          if (!cur) break;
          if (cur[1].length < indent0) break;
          var body = cur[3];
          // 任务列表
          var task = null;
          var mt = /^\[([ xX])\]\s+([\s\S]*)$/.exec(body);
          if (mt) { task = mt[1].toLowerCase() === 'x'; body = mt[2]; }
          // 续行（缩进更深的普通行）
          i++;
          var cont = [];
          while (i < lines.length && lines[i].trim() && !RE_UL.test(lines[i]) && !RE_OL.test(lines[i]) &&
                 !RE_FENCE.test(lines[i]) && !RE_ATX.test(lines[i]) && !RE_HR.test(lines[i])) {
            cont.push(lines[i].trim());
            i++;
          }
          var inner = inline(body + (cont.length ? '\n' + cont.join(' ') : ''));
          if (task === null) {
            items.push('<li class="md-li">' + inner + '</li>');
          } else {
            items.push('<li class="md-li md-task"><input type="checkbox" disabled' + (task ? ' checked' : '') + '> <span>' + inner + '</span></li>');
          }
        }
        html.push('<' + (ordered ? 'ol' : 'ul') + ' class="md-list' + (ordered ? ' md-ol' : '') + '">' + items.join('') + '</' + (ordered ? 'ol' : 'ul') + '>');
        continue;
      }

      // ⑧ 缩进代码块（4 空格 / Tab）
      if (/^(    |\t)/.test(line)) {
        var cbuf = [];
        while (i < lines.length && (/^(    |\t)/.test(lines[i]) || !lines[i].trim())) {
          if (!lines[i].trim()) { cbuf.push(''); i++; continue; }
          cbuf.push(lines[i].replace(/^(    |\t)/, ''));
          i++;
        }
        while (cbuf.length && !cbuf[cbuf.length - 1].trim()) cbuf.pop();
        html.push('<div class="md-codewrap"><pre class="md-pre"><code class="md-code">' + highlight(cbuf.join('\n'), '') + '</code></pre></div>');
        continue;
      }

      // ⑨ 段落（吃到空行或下一个块起始）
      var pbuf = [line];
      i++;
      while (i < lines.length && lines[i].trim() &&
             !RE_FENCE.test(lines[i]) && !RE_ATX.test(lines[i]) && !RE_HR.test(lines[i]) &&
             !RE_QUOTE.test(lines[i]) && !RE_UL.test(lines[i]) && !RE_OL.test(lines[i]) &&
             !(lines[i].indexOf('|') >= 0 && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]))) {
        pbuf.push(lines[i]);
        i++;
      }
      html.push('<p class="md-p">' + inline(pbuf.join('\n')) + '</p>');
    }

    return { html: html.join('\n'), toc: toc };
  }

  window.__dshMarkdown = {
    render: render,
    inline: inline,
    highlight: highlight,
    esc: esc
  };
})();
