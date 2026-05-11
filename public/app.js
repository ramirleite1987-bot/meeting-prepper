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
      button.innerHTML = '<span class="spinner"></span> Loading\u2026';
    } else {
      button.disabled = false;
      button.textContent = button.dataset.originalText || 'Submit';
    }
  }

  // ──────────────────────────────────────────────
  // Notifications
  // ──────────────────────────────────────────────

  var notifications = [];
  var eventSource = null;

  function fetchNotifications() {
    fetch('/api/notifications')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        notifications = data;
        renderNotifications();
      })
      .catch(function () { /* ignore */ });
  }

  function connectSSE() {
    if (typeof EventSource === 'undefined') return;
    eventSource = new EventSource('/api/notifications/stream');
    eventSource.addEventListener('message', function (e) {
      try {
        var notification = JSON.parse(e.data);
        notifications.unshift(notification);
        if (notifications.length > 20) notifications = notifications.slice(0, 20);
        renderNotifications();
      } catch (err) { /* ignore */ }
    });
    eventSource.addEventListener('error', function () {
      // Reconnect will happen automatically
    });
  }

  function renderNotifications() {
    var badge = document.getElementById('notification-badge');
    var list = document.getElementById('notification-list');

    if (!badge || !list) return;

    if (notifications.length > 0) {
      badge.classList.remove('hidden');
      badge.textContent = String(notifications.length);
    } else {
      badge.classList.add('hidden');
    }

    if (notifications.length === 0) {
      list.innerHTML = '<p class="p-3 text-sm text-gray-500">No notifications yet.</p>';
      return;
    }

    var html = '';
    for (var i = 0; i < notifications.length; i++) {
      var n = notifications[i];
      var typeClass = n.type === 'briefing_generated' ? 'text-indigo-700 bg-indigo-50' :
                      n.type === 'extraction_completed' ? 'text-green-700 bg-green-50' :
                      n.type === 'action_item_synced' ? 'text-blue-700 bg-blue-50' :
                      n.type === 'sync_error' ? 'text-red-700 bg-red-50' :
                      'text-gray-700 bg-gray-50';
      html += '<div class="p-3 border-b border-gray-100 ' + typeClass + ' rounded-lg m-1">';
      html += '<p class="text-sm font-medium">' + escapeHtml(n.title || n.type) + '</p>';
      html += '<p class="text-xs mt-1 opacity-75">' + escapeHtml(n.message || '') + '</p>';
      html += '</div>';
    }
    list.innerHTML = html;
  }

  window.toggleNotifications = function () {
    var dropdown = document.getElementById('notification-dropdown');
    if (dropdown) {
      dropdown.classList.toggle('hidden');
    }
  };

  // Close dropdown when clicking outside
  document.addEventListener('click', function (e) {
    var container = document.getElementById('notification-bell');
    var dropdown = document.getElementById('notification-dropdown');
    if (container && dropdown && !container.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });

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
    if (!str) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(String(str)));
    return div.innerHTML;
  }

  function renderBriefingSection(title, content) {
    if (!content) return '';
    var body;
    if (content.items && Array.isArray(content.items)) {
      body = renderList(content.items);
    } else if (Array.isArray(content)) {
      body = renderList(content);
    } else {
      body = '<p class="text-gray-700 leading-relaxed">' + escapeHtml(content) + '</p>';
    }
    return '<section class="bg-white shadow rounded-lg p-6 fade-in">' +
      '<h2 class="text-lg font-semibold text-gray-800 mb-3">' + escapeHtml(title) + '</h2>' +
      body +
      '</section>';
  }

  function renderBriefing(briefing) {
    if (!briefing) return '';
    var html = '';
    // Handle sections-based format from BriefingService
    if (briefing.sections) {
      var s = briefing.sections;
      html += renderBriefingSection('Last Deliveries', s.lastDeliveries);
      html += renderBriefingSection('Open Items & Risks', s.openItemsAndRisks);
      html += renderBriefingSection('Recent Agreements', s.recentAgreements);
      html += renderBriefingSection('Suggested Next Steps', s.suggestedNextSteps);
      html += renderBriefingSection('Recommended Questions', s.recommendedQuestions);
    } else {
      // Handle flat format
      html += renderBriefingSection('Executive Summary', briefing.executiveSummary);
      html += renderBriefingSection('Key Topics', briefing.keyTopics);
      html += renderBriefingSection('Client Background', briefing.clientBackground);
      html += renderBriefingSection('Talking Points', briefing.talkingPoints);
      html += renderBriefingSection('Action Items', briefing.actionItems);
      html += renderBriefingSection('Risks & Concerns', briefing.risks);
    }
    return html;
  }

  // ──────────────────────────────────────────────
  // Add Client form
  // ──────────────────────────────────────────────

  function initAddClientForm() {
    var form = document.getElementById('add-client-form');
    if (!form) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var name = form.querySelector('input[name="name"]').value.trim();
      var project = form.querySelector('input[name="project"]').value.trim();
      var kind = form.querySelector('select[name="kind"]').value;
      if (!name) return;

      var btn = form.querySelector('button[type="submit"]');
      setLoading(btn, true);

      fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name,
          project: project || undefined,
          kind: kind,
          aliases: {
            domains: csvInput(form, 'domains'),
            emails: csvInput(form, 'emails'),
            keywords: csvInput(form, 'keywords')
          }
        })
      })
        .then(function (res) {
          if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed to create client'); });
          return res.json();
        })
        .then(function () {
          document.getElementById('add-client-modal').classList.add('hidden');
          showToast('Client created successfully', 'success');
          setTimeout(function () { window.location.reload(); }, 500);
        })
        .catch(function (err) {
          showToast(err.message, 'error');
        })
        .finally(function () {
          setLoading(btn, false);
        });
    });
  }

  // ──────────────────────────────────────────────
  // Add Meeting form
  // ──────────────────────────────────────────────

  function initAddMeetingForm() {
    var form = document.getElementById('add-meeting-form');
    if (!form) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var clientId = form.querySelector('select[name="clientId"]').value;
      var title = form.querySelector('input[name="title"]').value.trim();
      var scheduledAt = form.querySelector('input[name="scheduledAt"]').value;
      if (!clientId || !title) return;

      var btn = form.querySelector('button[type="submit"]');
      setLoading(btn, true);

      fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: clientId,
          title: title,
          scheduledAt: scheduledAt || undefined
        })
      })
        .then(function (res) {
          if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed to create meeting'); });
          return res.json();
        })
        .then(function () {
          document.getElementById('add-meeting-modal').classList.add('hidden');
          showToast('Meeting created successfully', 'success');
          setTimeout(function () { window.location.reload(); }, 500);
        })
        .catch(function (err) {
          showToast(err.message, 'error');
        })
        .finally(function () {
          setLoading(btn, false);
        });
    });
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

      Promise.resolve(window.attachSelectedContext ? window.attachSelectedContext(meetingId) : undefined)
        .then(function () {
          return fetch('/api/meetings/' + encodeURIComponent(meetingId) + '/prepare', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
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

  function csvInput(form, name) {
    var input = form.querySelector('input[name="' + name + '"]');
    if (!input || !input.value) return [];
    return input.value.split(',').map(function (value) {
      return value.trim();
    }).filter(Boolean);
  }

  // ──────────────────────────────────────────────
  // Linear project selector
  // ──────────────────────────────────────────────

  function initLinearProjectSelectors() {
    var selects = document.querySelectorAll('[data-linear-project-select]');
    if (!selects.length) return;

    fetch('/api/linear/projects')
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Failed to load Linear projects'); });
        return res.json();
      })
      .then(function (projects) {
        selects.forEach(function (select) {
          projects.forEach(function (project) {
            var option = document.createElement('option');
            option.value = project.id;
            option.textContent = project.name;
            select.appendChild(option);
          });
        });
      })
      .catch(function (err) {
        showToast(err.message, 'error');
      });
  }

  function selectedLinearProject(meetingId) {
    var select = document.getElementById('linear-project-select-' + meetingId);
    return select && select.value ? select.value : undefined;
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
  // Post-call extract action
  // ──────────────────────────────────────────────

  window.extractMeeting = function (meetingId) {
    if (!meetingId) return;

    fetch('/api/meetings/' + encodeURIComponent(meetingId) + '/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Extraction failed'); });
        return res.json();
      })
      .then(function () {
        showToast('Post-call data extracted successfully', 'success');
        setTimeout(function () { window.location.reload(); }, 1000);
      })
      .catch(function (err) {
        showToast(err.message, 'error');
      });
  };

  // ──────────────────────────────────────────────
  // Linear sync actions
  // ──────────────────────────────────────────────

  window.syncAll = function (meetingId) {
    if (!meetingId) return;
    var projectId = selectedLinearProject(meetingId);

    fetch('/api/meetings/' + encodeURIComponent(meetingId) + '/sync-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: projectId }),
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Sync failed'); });
        return res.json();
      })
      .then(function () {
        showToast('Action items synced to Linear', 'success');
      })
      .catch(function (err) {
        showToast(err.message, 'error');
      });
  };

  window.syncItem = function (meetingId, itemId) {
    if (!meetingId || !itemId) return;
    var projectId = selectedLinearProject(meetingId);

    fetch('/api/meetings/' + encodeURIComponent(meetingId) + '/action-items/' + encodeURIComponent(itemId) + '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: projectId }),
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Sync failed'); });
        return res.json();
      })
      .then(function () {
        showToast('Action item synced to Linear', 'success');
      })
      .catch(function (err) {
        showToast(err.message, 'error');
      });
  };

  window.importLinearProject = function (clientId, meetingId) {
    if (!clientId || !meetingId) return;
    var projectId = selectedLinearProject(meetingId);
    if (!projectId) {
      showToast('Select a Linear project first', 'error');
      return;
    }

    fetch('/api/clients/' + encodeURIComponent(clientId) + '/linear-project/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: projectId }),
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Import failed'); });
        return res.json();
      })
      .then(function (result) {
        showToast('Imported ' + result.imported + ' Linear context items', 'success');
      })
      .catch(function (err) {
        showToast(err.message, 'error');
      });
  };

  // ──────────────────────────────────────────────
  // Init
  // ──────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    initPrepareModal();
    initInlineGenerateButtons();
    initBriefingPageGenerate();
    initAddClientForm();
    initAddMeetingForm();
    initLinearProjectSelectors();
    fetchNotifications();
    connectSSE();
  });
})();
