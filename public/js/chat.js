// 서버가 저장 후 보내준 메시지만 화면에 그림
;(() => {
  const screen = document.querySelector('[data-chat-screen]')
  const form = document.querySelector('[data-chat-form]')
  const input = form.querySelector('input')
  const errorBox = document.querySelector('[data-chat-error]')
  const roomId = screen.dataset.roomId
  const myId = screen.dataset.myId

  const socket = io()

  function showError(message) {
    errorBox.textContent = message
    errorBox.hidden = !message
  }

  function append(message) {
    const box = document.createElement('div')
    box.className = message.senderId === myId ? 'chat-box mine' : 'chat-box'

    const name = document.createElement('span')
    name.className = 'meta'
    name.textContent = message.senderNickname

    const text = document.createElement('span')
    text.className = 'chat-text'
    // XSS 방지를 위해 textContent 사용
    text.textContent = message.content

    box.append(name, text)
    screen.appendChild(box)
    screen.scrollTop = screen.scrollHeight
  }

  // 재연결 시에도 다시 입장
  socket.on('connect', () => {
    socket.emit('join', { roomId }, (res) => showError(res.ok ? '' : res.error))
  })
  socket.on('connect_error', () => showError('채팅 서버에 연결하지 못했습니다.'))
  socket.on('message', append)

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const content = input.value.trim()
    if (!content) return
    socket.emit('message', { roomId, content }, (res) => {
      if (!res.ok) return showError(res.error)
      showError('')
      input.value = ''
    })
  })

  screen.scrollTop = screen.scrollHeight
})()
