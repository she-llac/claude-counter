chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'cc:notify') return;
    chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon48.png'),
        title: msg.title,
        message: msg.body,
        priority: 2,
    });
});