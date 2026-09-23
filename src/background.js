chrome.action.onClicked.addListener((tab) => {
	if (tab && tab.id && tab.url && tab.url.startsWith('https://claude.ai')) {
		chrome.tabs.sendMessage(tab.id, { action: 'play_tiding_sound' }).catch((err) => {
			console.log('Failed to send play_tiding_sound message:', err);
		});
	}
});

chrome.runtime.onMessage.addListener((message) => {
	if (message && message.action === 'send_notification') {
		const { title, body } = message;
		if (chrome.notifications) {
			chrome.notifications.create({
				type: 'basic',
				iconUrl: 'icons/icon128.png',
				title: title || 'Claude Counter',
				message: body || '',
				priority: 2
			});
		}
	}
});

