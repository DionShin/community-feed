const button = document.querySelector('[data-like-button]')

function render({ liked, likeCount }) {
  button.dataset.liked = String(liked)
  button.textContent = `${liked ? '♥' : '♡'} 공감 ${likeCount}`
}

if (button) {
  button.addEventListener('click', async () => {
    if (button.dataset.loggedIn !== 'true') {
      location.href = '/login'
      return
    }

    const liked = button.dataset.liked === 'true'
    // 응답 전 연타 방지(중복은 서버에서도 막음)
    button.disabled = true
    try {
      const res = await fetch(`/posts/${button.dataset.postId}/like`, {
        method: liked ? 'DELETE' : 'PUT',
        headers: { Accept: 'application/json' },
      })
      if (res.status === 401) {
        location.href = '/login'
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      render(await res.json())
    } catch (err) {
      alert('잠시 후 다시 시도해 주세요.')
    } finally {
      button.disabled = false
    }
  })
}
