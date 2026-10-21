// 받은 내용을 화면에 넣지 않고 개수만 셈. 누르면 새로고침
;(() => {
  const banner = document.querySelector('[data-new-posts-banner]')
  if (!banner || !('EventSource' in window)) return

  const board = banner.dataset.board
  const source = new EventSource(board ? `/stream/posts?board=${encodeURIComponent(board)}` : '/stream/posts')
  const seen = new Set()

  source.addEventListener('new-post', (e) => {
    const { postId } = JSON.parse(e.data)
    // 재연결로 같은 소식을 다시 받아도 한 번만 셈
    if (seen.has(postId)) return
    seen.add(postId)

    banner.textContent = `새 글 ${seen.size}개 보기`
    banner.hidden = false
  })

  window.addEventListener('pagehide', () => source.close())
})()
