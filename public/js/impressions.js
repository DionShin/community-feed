// 글이 실제로 화면에 보였는지는 브라우저만 알 수 있어 노출은 브라우저에서 기록
;(() => {
  const container = document.querySelector('[data-surface]')
  if (!container || !('IntersectionObserver' in window)) return

  const surface = container.dataset.surface
  const queue = []
  const seen = new Set()

  const FLUSH_SIZE = 20
  const FLUSH_INTERVAL_MS = 5000

  // 모아서 전송. 실패해도 재전송하지 않음(중복 대신 일부 유실을 감수하는 최대 한 번 전달)
  function flush(pageIsClosing) {
    if (queue.length === 0) return
    const body = JSON.stringify({ events: queue.splice(0, 50) })

    // 페이지를 떠날 때는 fetch가 취소될 수 있어 sendBeacon 사용
    if (pageIsClosing && navigator.sendBeacon) {
      navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }))
      return
    }
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {})
  }

  // 50% 이상 보이면 노출. 같은 글은 페이지당 한 번만
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const el = entry.target
        const postId = el.dataset.postId
        observer.unobserve(el)
        if (seen.has(postId)) continue
        seen.add(postId)

        queue.push({
          type: 'impression',
          postId,
          surface,
          position: Number(el.dataset.position),
          occurredAt: new Date().toISOString(),
        })
      }
      if (queue.length >= FLUSH_SIZE) flush(false)
    },
    { threshold: 0.5 },
  )

  container.querySelectorAll('[data-impression]').forEach((el) => observer.observe(el))

  setInterval(() => flush(false), FLUSH_INTERVAL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true)
  })
  window.addEventListener('pagehide', () => flush(true))
})()
