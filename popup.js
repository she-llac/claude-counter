document.addEventListener('DOMContentLoaded', async () => {
  const showSessionBar = document.getElementById('showSessionBar');
  const showWeeklyBar = document.getElementById('showWeeklyBar');
  const sessionColor = document.getElementById('sessionColor');
  const weeklyColor = document.getElementById('weeklyColor');
  const resetDefaultsBtn = document.getElementById('resetDefaultsBtn');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const historyTableBody = document.querySelector('#historyTable tbody');

  const defaultSettings = {
    showSessionBar: true,
    showWeeklyBar: true,
    sessionColor: '#ce2029',
    weeklyColor: '#ce2029'
  };

  // Load state
  const data = await chrome.storage.local.get(['cc_settings', 'cc_daily_usage']);
  const settings = { ...defaultSettings, ...(data.cc_settings || {}) };
  const dailyUsage = data.cc_daily_usage || {};

  // Initialize UI
  showSessionBar.checked = settings.showSessionBar;
  showWeeklyBar.checked = settings.showWeeklyBar;
  sessionColor.value = settings.sessionColor;
  weeklyColor.value = settings.weeklyColor;

  renderHistory(dailyUsage);

  // Save changes
  const saveSettings = () => {
    const newSettings = {
      showSessionBar: showSessionBar.checked,
      showWeeklyBar: showWeeklyBar.checked,
      sessionColor: sessionColor.value,
      weeklyColor: weeklyColor.value
    };
    chrome.storage.local.set({ cc_settings: newSettings });
  };

  showSessionBar.addEventListener('change', saveSettings);
  showWeeklyBar.addEventListener('change', saveSettings);
  sessionColor.addEventListener('input', saveSettings);
  weeklyColor.addEventListener('input', saveSettings);

  resetDefaultsBtn.addEventListener('click', () => {
    showSessionBar.checked = defaultSettings.showSessionBar;
    showWeeklyBar.checked = defaultSettings.showWeeklyBar;
    sessionColor.value = defaultSettings.sessionColor;
    weeklyColor.value = defaultSettings.weeklyColor;
    saveSettings();
  });

  clearHistoryBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear your local token history?')) {
      chrome.storage.local.set({ cc_daily_usage: {} }, () => {
        renderHistory({});
      });
    }
  });

  function renderHistory(usageObj) {
    historyTableBody.innerHTML = '';
    const entries = Object.entries(usageObj);
    
    if (entries.length === 0) {
      historyTableBody.innerHTML = '<tr><td colspan="2" class="empty-history">No data yet</td></tr>';
      return;
    }

    // Sort descending by date, keep last 7
    const sorted = entries.sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7);

    for (const [dateStr, record] of sorted) {
      const tr = document.createElement('tr');
      const tdDate = document.createElement('td');
      tdDate.textContent = dateStr;
      
      const tdTokens = document.createElement('td');
      tdTokens.textContent = (record.total_tokens || 0).toLocaleString();

      tr.appendChild(tdDate);
      tr.appendChild(tdTokens);
      historyTableBody.appendChild(tr);
    }
  }
});
