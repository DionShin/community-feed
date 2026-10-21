const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { ObjectId } = require('mongodb')
const { io: connect } = require('socket.io-client')
const { startTestApp, signup } = require('./helpers')

let app
let author
let asker
let stranger
let postId

before(async () => {
  app = await startTestApp()
  author = await signup(app.baseUrl, 'author01', '작성자')
  asker = await signup(app.baseUrl, 'asker001', '문의자')
  stranger = await signup(app.baseUrl, 'other001', '제삼자')

  const body = new FormData()
  body.append('board', 'free')
  body.append('title', '자전거 팝니다')
  body.append('content', '거의 새것')
  const res = await fetch(`${app.baseUrl}/posts`, { method: 'POST', redirect: 'manual', headers: { cookie: author }, body })
  postId = res.headers.get('location').split('/').pop()
})

after(async () => {
  await app.close()
})

const db = () => app.db.getDb()

function requestChat(cookie, id = postId) {
  return fetch(`${app.baseUrl}/posts/${id}/chat`, { method: 'POST', redirect: 'manual', headers: { cookie } })
}

async function openRoomId(cookie) {
  const res = await requestChat(cookie)
  assert.equal(res.status, 302)
  return res.headers.get('location').split('/').pop()
}

function connectSocket(cookie) {
  return new Promise((resolve, reject) => {
    const socket = connect(app.baseUrl, {
      extraHeaders: cookie ? { cookie } : {},
      reconnection: false,
      forceNew: true,
    })
    socket.once('connect', () => resolve(socket))
    socket.once('connect_error', (err) => {
      socket.close()
      reject(err)
    })
  })
}

const emit = (socket, event, data) => new Promise((resolve) => socket.emit(event, data, resolve))

function nextMessage(socket, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('메시지를 받지 못함')), timeoutMs)
    socket.once('message', (m) => {
      clearTimeout(timer)
      resolve(m)
    })
  })
}

test('내 글에는 문의할 수 없음', async () => {
  const res = await requestChat(author)
  assert.equal(res.status, 400)
})

test('같은 글에 여러 번, 동시에 문의해도 채팅방은 하나이고 이벤트도 한 번만 남음', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => requestChat(asker)))
  const locations = new Set(results.map((r) => r.headers.get('location')))
  assert.equal(locations.size, 1)

  const again = await requestChat(asker)
  assert.equal(again.headers.get('location'), [...locations][0])

  assert.equal(await db().collection('chatRooms').countDocuments({ postId: new ObjectId(postId) }), 1)
  assert.equal(await db().collection('events').countDocuments({ type: 'chat_request', postId: new ObjectId(postId) }), 1)
})

test('참여자는 방 목록과 방을 볼 수 있고, 다른 사람은 볼 수 없음', async () => {
  const roomId = await openRoomId(asker)

  for (const cookie of [author, asker]) {
    const list = await (await fetch(`${app.baseUrl}/chats`, { headers: { cookie } })).text()
    assert.match(list, /자전거 팝니다/)
    assert.equal((await fetch(`${app.baseUrl}/chats/${roomId}`, { headers: { cookie } })).status, 200)
  }

  assert.equal((await fetch(`${app.baseUrl}/chats/${roomId}`, { headers: { cookie: stranger } })).status, 403)
  assert.doesNotMatch(await (await fetch(`${app.baseUrl}/chats`, { headers: { cookie: stranger } })).text(), /자전거 팝니다/)
})

test('로그인하지 않으면 채팅 소켓에 연결할 수 없음', async () => {
  await assert.rejects(connectSocket(null))
})

test('참여자가 아니면 방에 들어갈 수 없고, 들어가지 않은 방에는 메시지를 보낼 수 없음', async () => {
  const roomId = await openRoomId(asker)
  const socket = await connectSocket(stranger)
  try {
    assert.equal((await emit(socket, 'join', { roomId })).ok, false)
    assert.equal((await emit(socket, 'join', { roomId: 'not-an-id' })).ok, false)
    assert.equal((await emit(socket, 'message', { roomId, content: '몰래 보내기' })).ok, false)
  } finally {
    socket.close()
  }
  assert.equal(await db().collection('chatMessages').countDocuments({ content: '몰래 보내기' }), 0)
})

test('메시지는 저장된 뒤 상대에게 전달되고, 방 목록의 마지막 메시지가 갱신됨', async () => {
  const roomId = await openRoomId(asker)
  const a = await connectSocket(asker)
  const b = await connectSocket(author)
  try {
    assert.equal((await emit(a, 'join', { roomId })).ok, true)
    assert.equal((await emit(b, 'join', { roomId })).ok, true)

    const received = nextMessage(b)
    const ack = await emit(a, 'message', { roomId, content: '  아직 판매 중인가요?  ' })
    assert.equal(ack.ok, true)

    const m = await received
    assert.equal(m.content, '아직 판매 중인가요?')
    assert.equal(m.senderNickname, '문의자')

    const saved = await db().collection('chatMessages').findOne({ _id: new ObjectId(m.id) })
    assert.equal(saved.content, '아직 판매 중인가요?')
    const room = await db().collection('chatRooms').findOne({ _id: new ObjectId(roomId) })
    assert.equal(room.lastMessage, '아직 판매 중인가요?')
  } finally {
    a.close()
    b.close()
  }
})

test('빈 메시지는 거절함', async () => {
  const roomId = await openRoomId(asker)
  const socket = await connectSocket(asker)
  try {
    await emit(socket, 'join', { roomId })
    const ack = await emit(socket, 'message', { roomId, content: '   ' })
    assert.equal(ack.ok, false)
  } finally {
    socket.close()
  }
})

test('새로고침해도 지난 메시지가 보이고, 태그는 글자로만 보임', async () => {
  const roomId = await openRoomId(asker)
  const socket = await connectSocket(author)
  try {
    await emit(socket, 'join', { roomId })
    await emit(socket, 'message', { roomId, content: '<b>네 판매 중이에요</b>' })
  } finally {
    socket.close()
  }

  const html = await (await fetch(`${app.baseUrl}/chats/${roomId}`, { headers: { cookie: asker } })).text()
  assert.match(html, /&lt;b&gt;네 판매 중이에요&lt;\/b&gt;/)
  assert.doesNotMatch(html, /<b>네 판매 중이에요<\/b>/)
})

test('채팅 요청 이벤트는 인기 점수에 영향을 주지 않음', () => {
  const { SCORED_TYPES } = require('../src/services/scoring')
  assert.equal(SCORED_TYPES.includes('chat_request'), false)
})
