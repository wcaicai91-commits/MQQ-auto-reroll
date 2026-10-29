/**
 * 自动重 roll 插件版
 * 安装位置：SillyTavern/public/scripts/extensions/third-party/nana-auto-reroll/index.js
 * 同目录需要 manifest.json
 */
(function () {
  'use strict';

  var ROOT_ID = 'nana-auto-reroll-root';
  var KEY_SETTINGS = 'nana_auto_reroll_settings';
  var KEY_POS = 'nana_auto_reroll_pos';

  var settings = loadSettings();
  var state = {
    attempts: 0,
    failures: 0,
    lastErrorCode: '',
    lastErrorText: '',
    lastErrorLines: [],
    successCount: 0,
    baselineMessageId: -1,
    status: 'idle',
  };

  var timer = null;
  var dom = null;
  var listeners = [];
  var pos = loadPos();
  var expanded = false;

  // ------------------------------------------------------------ 设置读写

  function loadSettings() {
    try {
      var raw = localStorage.getItem(KEY_SETTINGS);
      if (raw) {
        var p = JSON.parse(raw);
        return {
          // 开关状态不持久化：每次加载一律关闭，避免上次开启后被自动带进新对话
          enabled: false,
          maxAttempts: typeof p.maxAttempts === 'number' ? p.maxAttempts : 5,
          intervalSec: typeof p.intervalSec === 'number' ? p.intervalSec : 2,
          intervalMinSec: typeof p.intervalMinSec === 'number' ? p.intervalMinSec : 2,
          intervalMaxSec: typeof p.intervalMaxSec === 'number' ? p.intervalMaxSec : 5,
          mode: p.mode === 'regen' ? 'regen' : 'send',
        };
      }
    } catch (e) {
      console.warn('[自动重roll] 读取设置失败', e);
    }
    return { enabled: false, maxAttempts: 5, intervalSec: 2, intervalMinSec: 2, intervalMaxSec: 5, mode: 'send' };
  }

  function saveSettings() {
    try {
      localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings));
    } catch (e) {
      /* 存储不可用不影响主流程 */
    }
  }

  function loadPos() {
    try {
      var raw = localStorage.getItem(KEY_POS);
      if (raw) {
        var p = JSON.parse(raw);
        if (typeof p.x === 'number' && typeof p.y === 'number') {
          return { x: p.x, y: p.y };
        }
      }
    } catch (e) {
      /* 位置读取失败使用默认位置 */
    }
    return null;
  }

  function savePos() {
    if (!pos) return;
    try {
      localStorage.setItem(KEY_POS, JSON.stringify(pos));
    } catch (e) {
      /* 位置保存失败不影响功能 */
    }
  }

  /** 在 [min, max] 之间取一个随机毫秒数，用于防封 */
  function intervalMs() {
    var lo = Math.max(0, settings.intervalMinSec);
    var hi = Math.max(0, settings.intervalMaxSec);
    if (hi < lo) {
      var t = lo;
      lo = hi;
      hi = t;
    }
    var sec = lo + Math.random() * (hi - lo);
    return Math.round(sec * 1000);
  }

  // ------------------------------------------------------------ 状态判断

  function isVisible(el) {
    if (!el) return false;
    var s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    return el.offsetParent !== null;
  }

  function isGenerating() {
    if (isVisible(document.querySelector('#mes_stop'))) return true;
    var icons = document.querySelectorAll('.fa-circle-stop');
    for (var i = 0; i < icons.length; i++) {
      if (isVisible(icons[i]) && isVisible(icons[i].parentElement)) return true;
    }
    return false;
  }

  function getChat() {
    try {
      return SillyTavern.getContext().chat || [];
    } catch (e) {
      return [];
    }
  }

  function lastId() {
    var c = getChat();
    return Array.isArray(c) ? c.length - 1 : -1;
  }

  function lastText() {
    var c = getChat();
    if (!Array.isArray(c) || c.length === 0) return '';
    var m = c[c.length - 1];
    return m && typeof m.mes === 'string' ? m.mes : '';
  }

  function hasNewMessage() {
    return lastId() > state.baselineMessageId;
  }

  function classifyFailure(text) {
    var v = (text || '').toLowerCase();
    if (!v) return 'EMPTY_RESPONSE';
    // 配额耗尽 / 限流：Gemini 与 OpenAI 都用 exhausted、quota、rate 这类词
    if (
      v.indexOf('exhausted') >= 0 ||
      v.indexOf('quota') >= 0 ||
      v.indexOf('rate') >= 0 ||
      v.indexOf('429') >= 0 ||
      v.indexOf('too many') >= 0
    ) {
      return 'RATE_LIMIT';
    }
    if (
      v.indexOf('context') >= 0 ||
      v.indexOf('token') >= 0 ||
      v.indexOf('length') >= 0 ||
      v.indexOf('maximum') >= 0
    ) {
      return 'CONTEXT_OVERFLOW';
    }
    if (v.indexOf('network') >= 0 || v.indexOf('fetch') >= 0 || v.indexOf('timeout') >= 0 || v.indexOf('超时') >= 0) {
      return 'NETWORK';
    }
    if (
      v.indexOf('401') >= 0 ||
      v.indexOf('403') >= 0 ||
      v.indexOf('auth') >= 0 ||
      v.indexOf('api key') >= 0 ||
      v.indexOf('unauthorized') >= 0
    ) {
      return 'AUTH';
    }
    if (
      v.indexOf('500') >= 0 ||
      v.indexOf('502') >= 0 ||
      v.indexOf('503') >= 0 ||
      v.indexOf('504') >= 0 ||
      v.indexOf('not found') >= 0 ||
      v.indexOf('404') >= 0
    ) {
      return 'SERVER';
    }
    if (v.indexOf('block') >= 0 || v.indexOf('filter') >= 0 || v.indexOf('refus') >= 0) return 'BLOCKED';
    return 'UNKNOWN';
  }

  // ------------------------------------------------------------ 图标

  var ICON_MOUSE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2" width="10" height="17" rx="5"/><line x1="12" y1="2" x2="12" y2="9"/><line x1="7" y1="9" x2="17" y2="9"/></svg>';

  var ICON_CHEVRON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

  // ------------------------------------------------------------ 样式

  var STYLE_TEXT = [
    '#nana-auto-reroll-root{position:fixed;z-index:99999;font-family:inherit;font-size:13px;line-height:1.5;color:#e4e4e7;user-select:none;touch-action:none}',
    '#nana-auto-reroll-root .nar-fab{position:relative;width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:grab;background:rgba(28,28,31,.97);border:1px solid rgba(255,255,255,.10);box-shadow:0 3px 14px rgba(0,0,0,.45);transition:border-color .16s,background .16s}',
    '#nana-auto-reroll-root .nar-fab:hover{background:rgba(40,40,44,.98)}',
    '#nana-auto-reroll-root .nar-fab svg{width:20px;height:20px;color:rgba(200,200,206,.9)}',
    '#nana-auto-reroll-root .nar-fab.on{border-color:rgba(111,191,139,.55)}',
    '#nana-auto-reroll-root .nar-fab.on svg{color:#6fbf8b}',
    '#nana-auto-reroll-root.dragging .nar-fab{cursor:grabbing}',
    '#nana-auto-reroll-root .nar-dot{position:absolute;top:1px;right:1px;width:8px;height:8px;border-radius:50%;display:none}',
    '#nana-auto-reroll-root .nar-dot.busy{display:block;background:#d8a74a}',
    '#nana-auto-reroll-root .nar-dot.bad{display:block;background:#c25050}',
    '#nana-auto-reroll-root .nar-panel{position:absolute;bottom:56px;right:0;width:240px;padding:14px;border-radius:12px;background:rgba(28,28,31,.97);border:1px solid rgba(255,255,255,.10);box-shadow:0 8px 28px rgba(0,0,0,.5)}',
    '#nana-auto-reroll-root .nar-panel[hidden]{display:none}',
    '#nana-auto-reroll-root .nar-switch{position:relative;display:inline-flex;align-items:center;padding:2px;border-radius:7px;background:rgba(0,0,0,.34);border:1px solid rgba(255,255,255,.10);cursor:pointer;font-family:inherit;font-size:12px}',
    '#nana-auto-reroll-root .nar-knob{position:absolute;top:2px;left:2px;width:calc(50% - 2px);height:calc(100% - 4px);border-radius:5px;background:rgba(255,255,255,.10);transition:transform .18s,background .18s}',
    '#nana-auto-reroll-root .nar-switch.on .nar-knob{transform:translateX(100%);background:rgba(111,191,139,.20);box-shadow:inset 0 0 0 1px rgba(111,191,139,.55)}',
    '#nana-auto-reroll-root .nar-opt{position:relative;width:30px;text-align:center;padding:1px 0;color:rgba(220,220,226,.45);transition:color .18s;z-index:1}',
    '#nana-auto-reroll-root .nar-switch.on .opt-on{color:#6fbf8b}',
    '#nana-auto-reroll-root .nar-switch:not(.on) .opt-off{color:rgba(230,230,235,.95)}',
    '#nana-auto-reroll-root .nar-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px}',
    '#nana-auto-reroll-root .nar-label{opacity:.62;font-size:12px}',
    '#nana-auto-reroll-root input{width:64px;background:rgba(0,0,0,.32);border:1px solid rgba(255,255,255,.10);color:inherit;border-radius:6px;padding:3px 7px;font-size:12px;font-family:inherit;text-align:right}',
    '#nana-auto-reroll-root input:focus{outline:none;border-color:rgba(111,191,139,.45)}',
    '#nana-auto-reroll-root .nar-counters{display:flex;gap:16px;font-size:12px;opacity:.72;margin-bottom:10px}',
    '#nana-auto-reroll-root .nar-mode{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px}',
    '#nana-auto-reroll-root .nar-seg{display:inline-flex;padding:2px;border-radius:7px;background:rgba(0,0,0,.34);border:1px solid rgba(255,255,255,.10)}',
    '#nana-auto-reroll-root .nar-mode-btn{background:none;border:none;color:rgba(220,220,226,.5);font-family:inherit;font-size:12px;padding:2px 8px;border-radius:5px;cursor:pointer;transition:color .16s,background .16s}',
    '#nana-auto-reroll-root .nar-mode-btn.on{color:#6fbf8b;background:rgba(111,191,139,.18);box-shadow:inset 0 0 0 1px rgba(111,191,139,.5)}',
    '#nana-auto-reroll-root .nar-dhead{display:flex;align-items:center;justify-content:space-between;font-size:12px;opacity:.62;margin-bottom:5px}',
    '#nana-auto-reroll-root .nar-tools{display:flex;align-items:center;gap:8px}',
    '#nana-auto-reroll-root .nar-ibtn{background:none;border:none;padding:0;color:inherit;cursor:pointer;display:flex;align-items:center;font-family:inherit;font-size:12px;opacity:.8}',
    '#nana-auto-reroll-root .nar-ibtn:hover{opacity:1}',
    '#nana-auto-reroll-root .nar-ibtn svg{width:13px;height:13px;transition:transform .16s}',
    '#nana-auto-reroll-root .nar-ibtn.open svg{transform:rotate(180deg)}',
    '#nana-auto-reroll-root .nar-detail{height:50px;overflow-y:auto;overflow-x:hidden;padding:7px 9px;border-radius:7px;background:rgba(0,0,0,.30);border:1px solid rgba(255,255,255,.10);font-size:12px;line-height:1.65;transition:height .18s}',
    '#nana-auto-reroll-root .nar-detail.open{height:164px}',
    '#nana-auto-reroll-root .nar-drow{display:flex;gap:7px}',
    '#nana-auto-reroll-root .nar-k{opacity:.5;flex:none}',
    '#nana-auto-reroll-root .nar-v{word-break:break-word;white-space:pre-line}',
    '#nana-auto-reroll-root .nar-line{padding:1px 0;line-height:1.6}',
    '#nana-auto-reroll-root .nar-line-err{color:#e0796f}',
    '#nana-auto-reroll-root .nar-line-ok{color:#6fbf8b}',
    '#nana-auto-reroll-root .nar-range{display:inline-flex;align-items:center;gap:4px}',
    '#nana-auto-reroll-root .nar-range-sep{opacity:.5;font-size:12px}',
    '#nana-auto-reroll-root .nar-range input{width:46px}',
    '#nana-auto-reroll-root .nar-confirm{margin-top:9px;padding:8px 9px;border-radius:7px;background:rgba(194,80,80,.10);border:1px solid rgba(194,80,80,.32);font-size:12px}',
    '#nana-auto-reroll-root .nar-confirm[hidden]{display:none}',
    '#nana-auto-reroll-root .nar-ctext{opacity:.9;margin-bottom:7px}',
    '#nana-auto-reroll-root .nar-cactions{display:flex;gap:7px;justify-content:flex-end}',
    '#nana-auto-reroll-root .nar-btn{padding:2px 10px;border-radius:5px;font-size:12px;font-family:inherit;cursor:pointer;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.06);color:inherit}',
    '#nana-auto-reroll-root .nar-btn:hover{background:rgba(255,255,255,.11)}',
    '#nana-auto-reroll-root .nar-btn.danger{border-color:rgba(194,80,80,.45);background:rgba(194,80,80,.16);color:#e8a0a0}',
  ].join('\n');

  function injectStyle() {
    if (document.getElementById(ROOT_ID + '-style')) return;
    var el = document.createElement('style');
    el.id = ROOT_ID + '-style';
    el.textContent = STYLE_TEXT;
    document.head.appendChild(el);
  }

  // ------------------------------------------------------------ 界面构建

  var PANEL_HTML =
    '<div class="nar-panel" hidden>' +
    '<div class="nar-row">' +
    '<span class="nar-label">自动重 roll</span>' +
    '<button class="nar-switch" type="button" role="switch" aria-checked="false">' +
    '<span class="nar-knob"></span>' +
    '<span class="nar-opt opt-off">关</span>' +
    '<span class="nar-opt opt-on">开</span>' +
    '</button>' +
    '</div>' +
    '<div class="nar-row"><span class="nar-label">重试次数</span>' +
    '<input class="nar-attempts" type="number" min="-1" step="1"></div>' +
    '<div class="nar-row"><span class="nar-label">间隔（秒）</span>' +
    '<span class="nar-range">' +
    '<input class="nar-int-min" type="number" min="0" step="0.5">' +
    '<span class="nar-range-sep">~</span>' +
    '<input class="nar-int-max" type="number" min="0" step="0.5">' +
    '</span></div>' +
    '<div class="nar-mode">' +
    '<span class="nar-label">失败后</span>' +
    '<span class="nar-seg" role="radiogroup">' +
    '<button class="nar-mode-btn" type="button" data-mode="send">重新发送</button>' +
    '<button class="nar-mode-btn" type="button" data-mode="regen">重新生成</button>' +
    '</span>' +
    '</div>' +
    '<div class="nar-counters">' +
    '<span>已重试 <span class="nar-ac">0</span></span>' +
    '<span>失败 <span class="nar-fc">0</span></span>' +
    '</div>' +
    '<div class="nar-dhead"><span>失败详情</span><span class="nar-tools">' +
'<button class="nar-ibtn nar-copy" type="button" title="复制记录">复制</button>' +
    '<button class="nar-ibtn nar-clear" type="button" title="清空">清空</button>' +
    '<button class="nar-ibtn nar-expand" type="button" title="展开">' + ICON_CHEVRON + '</button>' +
    '</span></div>' +
    '<div class="nar-detail">' +
    '<div class="nar-drow"><span class="nar-k">错误代码</span><span class="nar-v nar-ec">—</span></div>' +
    '<div class="nar-drow"><span class="nar-k">记录</span><span class="nar-v nar-et">暂无记录</span></div>' +
    '</div>' +
    '<div class="nar-confirm" hidden>' +
    '<div class="nar-ctext">清空失败记录？</div>' +
    '<div class="nar-cactions">' +
    '<button class="nar-btn nar-cancel" type="button">取消</button>' +
    '<button class="nar-btn danger nar-ok" type="button">清空</button>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '<div class="nar-fab" title="自动重 roll">' + ICON_MOUSE + '<span class="nar-dot"></span></div>';

  function build() {
    injectStyle();

    var root = document.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = PANEL_HTML;
    document.body.appendChild(root);

    var q = function (sel) {
      return root.querySelector(sel);
    };

    var panel = q('.nar-panel');
    var fab = q('.nar-fab');
    var sw = q('.nar-switch');
    var inputAttempts = q('.nar-attempts');
    var inputIntMin = q('.nar-int-min');
    var inputIntMax = q('.nar-int-max');
    var detail = q('.nar-detail');
    var btnExpand = q('.nar-expand');
    var btnClear = q('.nar-clear');
    var btnCopy = q('.nar-copy');
    btnCopy.addEventListener('click', function () {
      var text = state.lastErrorLines.join('\n');
      if (!text) { toastr.info('暂无记录'); return; }
      navigator.clipboard.writeText(text).then(function () {
        btnCopy.textContent = '已复制';
        setTimeout(function () { btnCopy.textContent = '复制'; }, 1200);
      }).catch(function () {
        toastr.error('复制失败');
      });
    });
    var confirmBox = q('.nar-confirm');

    inputAttempts.value = String(settings.maxAttempts);
    inputIntMin.value = String(settings.intervalMinSec);
    inputIntMax.value = String(settings.intervalMaxSec);

    dom = {
      root: root,
      panel: panel,
      fab: fab,
      switchEl: sw,
      modeBtns: root.querySelectorAll('.nar-mode-btn'),
      ac: q('.nar-ac'),
      fc: q('.nar-fc'),
      ec: q('.nar-ec'),
      et: q('.nar-et'),
      el: q('.nar-et'),
      detailEl: detail,
      dot: q('.nar-dot'),
    };

    // ---- 圆形按钮：拖动与点击 ----
    var dragState = null;
    var moved = false;

    fab.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      var rect = root.getBoundingClientRect();
      dragState = { startX: e.clientX, startY: e.clientY, left: rect.left, top: rect.top };
      moved = false;
      try {
        fab.setPointerCapture(e.pointerId);
      } catch (err) {
        /* 不支持指针捕获时退化为普通拖动 */
      }
    });

    fab.addEventListener('pointermove', function (e) {
      if (!dragState) return;
      var dx = e.clientX - dragState.startX;
      var dy = e.clientY - dragState.startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 3) {
        moved = true;
        root.classList.add('dragging');
      }
      if (!moved) return;
      var x = Math.min(Math.max(0, dragState.left + dx), window.innerWidth - 48);
      var y = Math.min(Math.max(0, dragState.top + dy), window.innerHeight - 48);
      root.style.left = x + 'px';
      root.style.top = y + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
      pos = { x: x, y: y };
    });

    fab.addEventListener('pointerup', function (e) {
      if (!dragState) return;
      dragState = null;
      root.classList.remove('dragging');
      try {
        fab.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* 指针已释放 */
      }
      if (moved) {
        savePos();
      } else {
        togglePanel(panel.hidden);
      }
    });

    // ---- 开关 ----
    sw.addEventListener('click', function () {
      settings.enabled = !settings.enabled;
      saveSettings();
      if (settings.enabled) {
        state.attempts = 0;
        state.failures = 0;
        state.status = 'idle';
        state.lastErrorLines = [];
        seenNodes = [];
        state.lastErrorCode = '';
        state.lastErrorText = '';
        state.baselineMessageId = lastId();
        // 开启后立即开始连续触发，不等任何失败事件
        scheduleReroll();
      } else {
        clearTimer();
        state.status = 'idle';
      }
      render();
    });

    // ---- 数字输入 ----
    inputAttempts.addEventListener('change', function () {
      var v = Number(inputAttempts.value);
      settings.maxAttempts = isFinite(v) ? Math.trunc(v) : 5;
      if (settings.maxAttempts < -1) settings.maxAttempts = -1;
      inputAttempts.value = String(settings.maxAttempts);
      saveSettings();
    });

    inputIntMin.addEventListener('change', function () {
      var v = Number(inputIntMin.value);
      settings.intervalMinSec = isFinite(v) && v >= 0 ? v : 2;
      inputIntMin.value = String(settings.intervalMinSec);
      saveSettings();
    });

    inputIntMax.addEventListener('change', function () {
      var v = Number(inputIntMax.value);
      settings.intervalMaxSec = isFinite(v) && v >= 0 ? v : 5;
      inputIntMax.value = String(settings.intervalMaxSec);
      saveSettings();
    });

    // ---- 模式切换：重新发送 / 重新生成 ----
    Array.prototype.forEach.call(dom.modeBtns, function (btn) {
      btn.addEventListener('click', function () {
        settings.mode = btn.getAttribute('data-mode') === 'regen' ? 'regen' : 'send';
        saveSettings();
        render();
      });
    });

    // ---- 展开 / 收起详情 ----
    btnExpand.addEventListener('click', function () {
      expanded = !expanded;
      detail.classList.toggle('open', expanded);
      btnExpand.classList.toggle('open', expanded);
      btnExpand.title = expanded ? '收起' : '展开';
    });

    // ---- 清空（带确认） ----
    btnClear.addEventListener('click', function () {
      confirmBox.hidden = false;
      detail.style.display = 'none';
      btnExpand.style.display = 'none';
    });

    q('.nar-cancel').addEventListener('click', function () {
      confirmBox.hidden = true;
      detail.style.display = '';
      btnExpand.style.display = '';
    });

    q('.nar-ok').addEventListener('click', function () {
      state.failures = 0;
      state.lastErrorCode = '';
      state.lastErrorText = '';
      state.lastErrorLines = [];
      seenNodes = [];
      confirmBox.hidden = true;
      detail.style.display = '';
      btnExpand.style.display = '';
      render();
    });

    applyPos();
    render();
  }

  function togglePanel(open) {
    if (!dom) return;
    dom.panel.hidden = !open;
    if (open) {
      var rect = dom.root.getBoundingClientRect();
      if (rect.left + 240 > window.innerWidth) {
        dom.panel.style.right = 'auto';
        dom.panel.style.left = '0';
      } else {
        dom.panel.style.right = '0';
        dom.panel.style.left = 'auto';
      }
    }
    render();
  }

  function applyPos() {
    if (!dom) return;
    if (pos) {
      dom.root.style.left = pos.x + 'px';
      dom.root.style.top = pos.y + 'px';
      dom.root.style.right = 'auto';
      dom.root.style.bottom = 'auto';
    } else {
      dom.root.style.right = '20px';
      dom.root.style.bottom = '110px';
    }
  }

  function render() {
    if (!dom) return;

    dom.switchEl.classList.toggle('on', settings.enabled);
    dom.switchEl.setAttribute('aria-checked', String(settings.enabled));

    dom.ac.textContent = String(state.attempts);
    dom.fc.textContent = String(state.failures);
    dom.ec.textContent = state.lastErrorCode || '—';

    // 记录逐行渲染：报错红色，成功绿色
    if (dom.el) {
      if (!state.lastErrorLines.length) {
        dom.el.textContent = '暂无记录';
      } else {
        var frag = document.createDocumentFragment();
        for (var i = 0; i < state.lastErrorLines.length; i++) {
          var lineText = state.lastErrorLines[i];
          var row = document.createElement('div');
          row.className = lineText.indexOf('生成成功') >= 0 ? 'nar-line nar-line-ok' : 'nar-line nar-line-err';
          row.textContent = lineText.replace(/^绿字/, '');
          frag.appendChild(row);
        }
        dom.el.textContent = '';
        dom.el.appendChild(frag);
      }
    }

    Array.prototype.forEach.call(dom.modeBtns, function (btn) {
      btn.classList.toggle('on', btn.getAttribute('data-mode') === settings.mode);
    });

    dom.fab.classList.toggle('on', settings.enabled);

    var dot = '';
    if (state.failures > 0) dot = 'bad';
    else if (state.status === 'waiting' || state.status === 'retrying') dot = 'busy';
    dom.dot.className = 'nar-dot' + (dot ? ' ' + dot : '');
  }

  // ------------------------------------------------------------ 运行逻辑

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function stop(status) {
    clearTimer();
    settings.enabled = false;
    saveSettings();
    state.status = status;
    render();
  }

  function tryReroll() {
    if (!settings.enabled) return;

    // 只保留这一条保护：正在生成时不点，避免打断当前回复。
    // 其余"是否失败""是否成功"的判断全部去掉，开关开启即按间隔连续触发。
    if (isGenerating()) {
      state.status = 'waiting';
      render();
      timer = setTimeout(tryReroll, Math.max(200, intervalMs()));
      return;
    }

    if (settings.maxAttempts >= 0 && state.attempts >= settings.maxAttempts) {
      stop('given_up');
      return;
    }

    fireAttempt();

    state.attempts += 1;
    state.status = 'retrying';
    render();

    timer = setTimeout(tryReroll, intervalMs());
    markPendingSuccess();
  }

  /** 记录一次失败，编号按失败次数递增，便于对账 */
  function logError(code, detail) {
    state.lastErrorCode = code;
    var time = new Date();
    var hh = ('0' + time.getHours()).slice(-2);
    var mm = ('0' + time.getMinutes()).slice(-2);
    var ss = ('0' + time.getSeconds()).slice(-2);
    var line =
      '失败 ' + state.failures + '  ' + hh + ':' + mm + ':' + ss + '  ' + code + (detail ? '  ' + detail : '');
    state.lastErrorLines.push(line);
    // 只保留最近 30 条，避免无限增长
    if (state.lastErrorLines.length > 30) {
      state.lastErrorLines.shift();
    }
    render();
    scrollDetailToBottom();
  }

  /** 让详情框自动滚到最底部，最新记录始终可见 */
  function scrollDetailToBottom() {
    if (!dom || !dom.detailEl) return;
    dom.detailEl.scrollTop = dom.detailEl.scrollHeight;
  }

  /**
   * 按当前模式发起一次重试。
   * - send：点发送按钮，走酒馆原生输入流程，发新请求。
   * - regen：调用斜杠命令 /trigger，重新生成上一条回复。
   */
  function fireAttempt() {
    if (settings.mode === 'regen') {
      try {
        var result = SillyTavern.getContext().executeSlashCommandsWithOptions('/trigger');
        if (result && typeof result.catch === 'function') {
          result.catch(function (err) {
            console.warn('[自动重roll] 重新生成失败', err);
          });
        }
      } catch (err) {
        console.warn('[自动重roll] 重新生成失败', err);
      }
      return;
    }

    var btn = document.querySelector('#send_but');
    if (!btn) {
      state.lastErrorCode = 'NO_SEND_BUTTON';
      state.lastErrorText = '找不到发送按钮，界面结构可能已变化';
      return;
    }

    btn.click();
  }

  function scheduleReroll() {
    clearTimer();
    if (!settings.enabled) return;
    state.status = 'waiting';
    render();
    timer = setTimeout(tryReroll, intervalMs());
  }

  // ------------------------------------------------------------ 事件绑定

  function bind() {
    var ctx;
    try {
      ctx = SillyTavern.getContext();
    } catch (e) {
      console.error('[自动重roll] 无法获取酒馆上下文', e);
      return;
    }

    var src = ctx.eventSource;
    var types = ctx.eventTypes;
    if (!src || !types) {
      console.error('[自动重roll] 事件接口不可用');
      return;
    }

    function on(name, fn) {
      src.on(name, fn);
      listeners.push({ name: name, fn: fn });
    }

    on(types.GENERATION_STARTED, function () {
      state.status = 'waiting';
      render();
    });

    // 生成结束：正文为空即视为一次失败，带上序号记录
    on(types.GENERATION_ENDED, function () {
      var text = lastText();
      if (text.trim().length === 0) {
        state.failures += 1;
        logError(classifyFailure(text), '返回内容为空');
      }
    });

    on(types.GENERATION_STOPPED, function () {
      if (settings.enabled) stop('stopped');
    });

    // 酒馆在 API 报错时不一定触发 GENERATION_ENDED，因此改为监视错误提示框。
    // 出现新的错误红框即记为一次失败，并把框里的文字抓下来作为错误信息。
    startErrorWatch();
  }

  /** 已经记录过的错误框元素，用元素本身做标识，避免同一框重复计数 */
  var seenNodes = [];
  /** 已记录条数上限，防止数组无限增长 */
  var SEEN_LIMIT = 200;

  /** 酒馆报错时会连带弹出一条"检查服务器连接"的提示，它本身不是一次独立失败 */
  function isDerivedNotice(text) {
    return (
      text.indexOf('检查服务器连接') >= 0 ||
      text.indexOf('刷新页面') >= 0 ||
      text.indexOf('reload the page') >= 0 ||
      text.indexOf('check server') >= 0
    );
  }

  /** 收集当前可见的错误提示，返回 {node, text} 列表 */
  function collectErrors() {
    var list = [];
    // 酒馆用 toastr 弹出错误提示，容器为 #toast-container
    var nodes = document.querySelectorAll('#toast-container .toast-error, #toast-container .toast');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.classList.contains('toast-success') || node.classList.contains('toast-info')) continue;
      var msgEl = node.querySelector('.toast-message');
      var raw = (msgEl ? msgEl.textContent : node.textContent) || '';
      var text = raw.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (isDerivedNotice(text)) continue;
      var isError =
        node.classList.contains('toast-error') ||
        /error|failed|错误|失败|exhausted|quota|not found|timeout|超时/i.test(text);
      if (isError) list.push({ node: node, text: text });
    }
    return list;
  }

  function scanErrors() {
    var list = collectErrors();
    if (!list.length) return;

    var recorded = 0;
    for (var i = 0; i < list.length; i++) {
      var node = list[i].node;
      var text = list[i].text;

      // 用元素本身判断是否已记录过：同一个框只算一次
      if (seenNodes.indexOf(node) >= 0) continue;
      seenNodes.push(node);
      if (seenNodes.length > SEEN_LIMIT) {
        seenNodes.shift();
      }

      state.failures += 1;
      // 出现错误框说明本轮没成功，清掉成功待判定标记
      pendingSuccess = false;
      logError(classifyFailure(text), text.slice(0, 120));
      recorded += 1;
    }

    // 没有记录到新错误时，顺带清理已从页面消失的元素引用
    if (!recorded && seenNodes.length) {
      seenNodes = seenNodes.filter(function (el) {
        return document.body.contains(el);
      });
    }
  }

  /**
   * 成功判定：点完之后等待一小段时间，期间没有出现错误红框、
   * 并且楼层内容发生了变化，就判为成功。
   */
  var pendingSuccess = false;
  var successTimer = null;

  function markPendingSuccess() {
    pendingSuccess = true;
    if (successTimer !== null) clearTimeout(successTimer);
    var baselineId = state.baselineMessageId;
    successTimer = setTimeout(function () {
      if (!pendingSuccess) return;
      if (!settings.enabled) return;
      // 楼层出现了新的正文，且没有报错，视为成功
      if (lastId() > baselineId && lastText().trim().length > 0) {
        state.baselineMessageId = lastId();
        logSuccess();
        stop('success');
      }
    }, Math.max(1500, intervalMs() + 1200));
  }

  function logSuccess() {
    state.lastErrorLines.push('绿字第 ' + (state.successCount + 1) + ' 条  生成成功');
    state.successCount += 1;
    if (state.lastErrorLines.length > 30) {
      state.lastErrorLines.shift();
    }
    render();
    scrollDetailToBottom();
  }

  var errorWatchTimer = null;

  function startErrorWatch() {
    if (errorWatchTimer !== null) return;
    errorWatchTimer = setInterval(scanErrors, 800);
  }

  function stopErrorWatch() {
    if (errorWatchTimer !== null) {
      clearInterval(errorWatchTimer);
      errorWatchTimer = null;
    }
  }

  function unbind() {
    var src;
    try {
      src = SillyTavern.getContext().eventSource;
    } catch (e) {
      return;
    }
    if (!src) return;
    listeners.forEach(function (item) {
      try {
        src.removeListener(item.name, item.fn);
      } catch (e) {
        /* 清理失败不影响退出 */
      }
    });
    listeners = [];
  }

  // ------------------------------------------------------------ 启动与卸载

  function init() {
    document.querySelectorAll('#' + ROOT_ID).forEach(function (el) {
      el.remove();
    });

    state.baselineMessageId = lastId();
    build();
    bind();

    window.addEventListener('resize', function () {
      if (!pos || !dom) return;
      var mx = window.innerWidth - 48;
      var my = window.innerHeight - 48;
      if (pos.x > mx || pos.y > my) {
        pos = { x: Math.min(pos.x, mx), y: Math.min(pos.y, my) };
        applyPos();
        savePos();
      }
    });

    window.addEventListener('pagehide', destroy, { once: true });
    console.log('[自动重roll] 插件已加载');
  }

  function destroy() {
    clearTimer();
    stopErrorWatch();
    unbind();
    if (dom && dom.root) dom.root.remove();
    dom = null;
    var styleEl = document.getElementById(ROOT_ID + '-style');
    if (styleEl) styleEl.remove();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
