(function () {
  'use strict';

  var selections = [];

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, text) {
    var el = byId(id);
    if (el) el.textContent = text;
  }

  function selectedMeetingId() {
    var select = byId('prepare-meeting-select');
    return select && select.value ? select.value : '';
  }

  function escapeHtml(value) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(String(value || '')));
    return div.innerHTML;
  }

  function checkGoogleStatus() {
    if (!byId('google-sync-status')) return;
    fetch('/api/google/status')
      .then(function (res) { return res.json(); })
      .then(function (status) {
        var message = status.available
          ? 'gog is available' + (status.accountConfigured ? ' with account configured.' : '.')
          : 'gog is not available.';
        setText('google-sync-status', message);
      })
      .catch(function () {
        setText('google-sync-status', 'Could not check gog status.');
      });
  }

  function syncGoogle() {
    var meetingId = selectedMeetingId();
    if (!meetingId) return;
    setText('google-sync-status', 'Syncing Google context...');
    fetch('/api/google/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (data) { throw new Error(data.error || 'Google sync failed'); });
        return res.json();
      })
      .then(function (result) {
        setText('google-sync-status', 'Imported ' + result.imported + ' Google context item(s).');
      })
      .catch(function (error) {
        setText('google-sync-status', error.message);
      });
  }

  function searchSources() {
    var meetingId = selectedMeetingId();
    var source = byId('source-select').value;
    var query = byId('source-query').value;
    var tags = byId('krisp-tags').value;
    var results = byId('source-results');
    if (!meetingId || !results) return;

    results.innerHTML = '<p class="text-xs text-gray-500">Searching...</p>';
    var params = new URLSearchParams({ source: source, query: query, limit: '8' });
    if (tags) params.set('tags', tags);

    fetch('/api/meetings/' + encodeURIComponent(meetingId) + '/context-candidates?' + params.toString())
      .then(function (res) {
        if (!res.ok) return res.json().then(function (data) { throw new Error(data.error || 'Search failed'); });
        return res.json();
      })
      .then(renderResults)
      .catch(function (error) {
        results.innerHTML = '<p class="text-xs text-red-600">' + escapeHtml(error.message) + '</p>';
      });
  }

  function renderResults(items) {
    var results = byId('source-results');
    if (!results) return;
    if (!items.length) {
      results.innerHTML = '<p class="text-xs text-gray-500">No matching context found.</p>';
      return;
    }

    results.innerHTML = items.map(function (item) {
      var id = item.source + ':' + item.meetingId;
      return '<label class="flex items-start gap-2 border border-gray-100 rounded p-2">' +
        '<input type="checkbox" class="mt-1" data-context-choice="' + escapeHtml(id) + '">' +
        '<span><span class="block font-medium">' + escapeHtml(item.title) + '</span>' +
        '<span class="block text-xs text-gray-500">' + escapeHtml(item.source) + ' · ' + escapeHtml(item.date) + '</span></span>' +
        '</label>';
    }).join('');

    results.querySelectorAll('[data-context-choice]').forEach(function (checkbox) {
      checkbox.addEventListener('change', function () {
        updateSelection(checkbox);
      });
    });
  }

  function updateSelection(checkbox) {
    var parts = checkbox.dataset.contextChoice.split(':');
    var selection = { source: parts[0], externalId: parts.slice(1).join(':') };
    selections = selections.filter(function (item) {
      return item.source !== selection.source || item.externalId !== selection.externalId;
    });
    if (checkbox.checked) {
      selections.push(selection);
    }
  }

  window.attachSelectedContext = function (meetingId) {
    if (!selections.length) return Promise.resolve();
    return fetch('/api/meetings/' + encodeURIComponent(meetingId) + '/context-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selections: selections })
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (data) { throw new Error(data.error || 'Could not attach context'); });
      return res.json();
    });
  };

  document.addEventListener('DOMContentLoaded', function () {
    var syncButton = byId('google-sync-button');
    var searchButton = byId('source-search-button');
    if (syncButton) syncButton.addEventListener('click', syncGoogle);
    if (searchButton) searchButton.addEventListener('click', searchSources);
    checkGoogleStatus();
  });
})();
