chrome.action.onClicked.addListener((tab) => {
	if (tab && tab.id && tab.url && tab.url.startsWith('https://claude.ai')) {
		chrome.tabs.sendMessage(tab.id, { action: 'play_tiding_sound' }).catch((err) => {
			console.log('Failed to send play_tiding_sound message:', err);
		});
	}
});
