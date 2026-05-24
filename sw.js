// Service Worker — Web Push 알림 처리
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {}
  const title = data.title || '당근 발주 알림';
  const opts = {
    body: data.body || '발주 마감이 가까웠습니다.',
    icon: 'data:image/svg+xml;utf8,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 viewBox%3D%220 0 192 192%22%3E%3Crect width%3D%22192%22 height%3D%22192%22 rx%3D%2240%22 fill%3D%22%23ff6f0f%22%2F%3E%3Ctext x%3D%2296%22 y%3D%22130%22 font-size%3D%22110%22 text-anchor%3D%22middle%22 fill%3D%22%23fff%22%3E%F0%9F%A5%95%3C%2Ftext%3E%3C%2Fsvg%3E',
    badge: 'data:image/svg+xml;utf8,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 viewBox%3D%220 0 72 72%22%3E%3Ccircle cx%3D%2236%22 cy%3D%2236%22 r%3D%2236%22 fill%3D%22%23ff6f0f%22%2F%3E%3C%2Fsvg%3E',
    tag: data.tag || 'deadline',
    requireInteraction: true,
    data: { url: data.url || '/' }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      try { return await c.focus(); } catch {}
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
  })());
});
