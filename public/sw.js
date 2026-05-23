self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    Promise.all([
      // Show the OS notification
      self.registration.showNotification(data.title || '📳 BUZZ!', {
        body: data.body || 'The organiser is calling you!',
        requireInteraction: true,
        vibrate: [300, 100, 300, 100, 500],
        data: { url: data.url || '/join' },
      }),
      // Wake every open client (PWA window, browser tab) so the page can buzz
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        list.forEach(client => client.postMessage({
          type: 'push-buzz',
          title: data.title,
          body: data.body,
        }));
      }),
    ])
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/join';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes('/join'));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});
