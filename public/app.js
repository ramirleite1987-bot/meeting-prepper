(function () {
  'use strict';

  // ──────────────────────────────────────────────
  // Utilities
  // ──────────────────────────────────────────────

  function showToast(message, type) {
    var existing = document.querySelector('.toast');
    if (existing) existing.remove();

    var el = document.createElement('div');
    el.className = 'toast toast--' + type;
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 3000);
  }

  function setLoading(button, loading) {
    if (loading) {
      button.disabled = true;
      button.dataset.originalText = button.textContent;
      button.innerHTML = '<span class="spinner"></span> Generating\u2026';
    } else {
      button.disabled = false;
      button.textContent = button.dataset.originalText || 'Generate Briefing';
    }
  }

  // ──────────────────────────────────────────────
  // Briefing display helpers
  // ──────────────────────────────────────────────

  function renderList(items) {
    if (!items || items.length === 0) return '';
    return '<ul class="list-disc list-inside space-y-1 text-gray-700">' +
      items.map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join('') +
      '</ul>';
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function renderBriefingSection(title, content) {
    if (!content) return '';
    var body = Array.isArray(content) ? renderList(content) : '<p class="text-gray-700 leading-relaxed">' + escapeHtml(content) + '</p>';
    return '<section class="bg-white shadow rounded-lg p-6 fade-in">' +
      '<h2 class="text-lg font-semibold text-gray-800 mb-3">' + escapeHtml(title) + '</h2>' +
      body +
      '</section>';
  }

  function renderBriefing(briefing) {
    var html = '';
    html += renderBriefingSection('Executive Summary', briefing.executiveSummary);
    html += renderBriefingSection('Key Topics', briefing.keyTopics);
    html += renderBriefingSection('Client Background', briefing.clientBackground);
    html += renderBriefingSection('Talking Points', briefing.talkingPoints);
    html += renderBriefingSection('Action Items', briefing.actionItems);
    html += renderBriefingSection('Risks & Concerns', briefing.risks);
    return html;
  }

  // ──────────────────────────────────────────────
  // Prepare Meeting (modal form)
  // ──────────────────────────────────────────────

  function initPrepareModal() {
    var modal = document.getElementById('prepare-modal');
    if (!modal) return;

    var form = modal.querySelector('form');
    if (!form) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var select = form.querySelector('select[name="meetingId"]');
      if (!select || !select.value) return;

      var meetingId = select.value;
      var submitBtn = form.querySelector('button[type="submit"]');
      setLoading(submitBtn, true);

      fetch('/api/meetings/' + encodeURIComponent(meetingId) + '/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
        .then(function (res) {
          if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed to generate briefing'); });
          return res.json();
        })
        .then(function () {
          modal.classList.add('hidden');
          showToast('Briefing generated successfully', 'success');
          window.location.href = '/briefing/' + encodeURIComponent(meetingId);
        })
        .catch(function (err) {
          showToast(err.message, 'error');
        })
        .finally(function () {
          setLoading(submitBtn, false);
        });
    });
  }

  // ──────────────────────────────────────────────
  // Inline "Generate Briefing" buttons on dashboard
  // ──────────────────────────────────────────────

  function initInlineGenerateButtons() {
    document.querySelectorAll('form[action$="/prepare"]').forEach(function (form) {
      // Skip the modal form
      if (form.closest('#prepare-modal')) return;

      form.addEventListener('submit', function (e) {
        e.preventDefault();

        var action = form.getAttribute('action');
        var match = action.match(/\/briefing\/([^/]+)\/prepare/);
        if (!match) return;

        var meetingId = match[1];
        var btn = form.querySelector('button[type="submit"]');
        setLoading(btn, true);

        fetch('/api/meetings/' + encodeURIComponent(meetingId) + '/prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
          .then(function (res) {
            if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed to generate briefing'); });
            return res.json();
          })
          .then(function () {
            showToast('Briefing generated', 'success');
            window.location.href = '/briefing/' + encodeURIComponent(meetingId);
          })
          .catch(function (err) {
            showToast(err.message, 'error');
            setLoading(btn, false);
          });
      });
    });
  }

  // ──────────────────────────────────────────────
  // Briefing page: generate button
  // ──────────────────────────────────────────────

  function initBriefingPageGenerate() {
    var container = document.querySelector('[data-briefing-container]');
    if (!container) return;

    var form = container.querySelector('form[action$="/prepare"]');
    if (!form) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var action = form.getAttribute('action');
      var match = action.match(/\/briefing\/([^/]+)\/prepare/);
      if (!match) return;

      var meetingId = match[1];
      var btn = form.querySelector('button[type="submit"]');
      setLoading(btn, true);

      fetch('/api/meetings/' + encodeURIComponent(meetingId) + '/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
        .then(function (res) {
          if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed to generate briefing'); });
          return res.json();
        })
        .then(function (briefing) {
          container.innerHTML = renderBriefing(briefing);
          showToast('Briefing generated', 'success');
        })
        .catch(function (err) {
          showToast(err.message, 'error');
          setLoading(btn, false);
        });
    });
  }

  // ──────────────────────────────────────────────
  // Init
  // ──────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    initPrepareModal();
    initInlineGenerateButtons();
    initBriefingPageGenerate();
  });
})();
