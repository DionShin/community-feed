const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { startTestApp, form, signup } = require('./helpers')

let app
let alice
let bob
let newPosts

before(async () => {
  app = await startTestApp({ replSet: true })
  alice = await signup(app.baseUrl, 'alice01', '앨리스')
  bob = await signup(app.baseUrl, 'bob0001', '바비')
  newPosts = require('../src/realtime/newPosts')
  await newPosts.start()
})

after(async () => {
  await newPosts.stop()
  await app.close()
})

async function createPost(cookie, board = 'free') {
  const body = new FormData()
  body.append('board', board)
  body.append('title', '새 글')
  body.append('content', '내용')
  const res = await fetch(`${app.baseUrl}/posts`, { method: 'POST', redirect: 'manual', headers: { cookie }, body })
  return res.headers.get('location').split('/').pop()
}

// SSE 연결을 열고 받은 new-post 이벤트를 모음
async function openStream(path, cookie) {
  const controller = new AbortController()
  const res = await fetch(`${app.baseUrl}${path}`, { headers: cookie ? { cookie } : {}, signal: controller.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const received = []
  let buffer = ''

  ;(async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const data = block.split('\n').find((l) => l.startsWith('data: '))
          if (block.includes('event: new-post') && data) received.push(JSON.parse(data.slice(6)))
        }
      }
    } catch {
      // 연결을 닫으면 읽기가 중단됨
    }
  })()

  return { res, received, close: () => controller.abort() }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 테스트 파일이 동시에 돌면 느려질 수 있어 넉넉히 대기
async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await wait(20)
  }
  return false
}

test('SSE 연결은 이벤트 스트림 형식으로 응답함', async () => {
  const s = await openStream('/stream/posts')
  assert.equal(s.res.status, 200)
  assert.match(s.res.headers.get('content-type'), /text\/event-stream/)
  s.close()
})

test('새 글을 쓰면 연결된 브라우저에 알림이 감', async () => {
  const s = await openStream('/stream/posts')
  await waitFor(() => newPosts.clientCount() > 0)
  const id = await createPost(alice)

  assert.ok(await waitFor(() => s.received.some((e) => e.postId === id)), '알림을 받아야 한다')
  assert.deepEqual(s.received.find((e) => e.postId === id), { postId: id, board: 'free' })
  s.close()
})

test('게시판 피드 연결은 그 게시판 글만 받음', async () => {
  const hobby = await openStream('/stream/posts?board=hobby')
  await waitFor(() => newPosts.clientCount() > 0)

  const freeId = await createPost(alice, 'free')
  const hobbyId = await createPost(alice, 'hobby')

  assert.ok(await waitFor(() => hobby.received.some((e) => e.postId === hobbyId)))
  assert.equal(hobby.received.some((e) => e.postId === freeId), false)
  hobby.close()
})

test('내가 쓴 글은 나에게 알리지 않음', async () => {
  const mine = await openStream('/stream/posts', alice)
  const other = await openStream('/stream/posts', bob)
  await waitFor(() => newPosts.clientCount() >= 2)

  const id = await createPost(alice)
  assert.ok(await waitFor(() => other.received.some((e) => e.postId === id)))
  await wait(200)
  assert.equal(mine.received.some((e) => e.postId === id), false)
  mine.close()
  other.close()
})

test('글 수정과 삭제는 알리지 않음', async () => {
  const s = await openStream('/stream/posts')
  await waitFor(() => newPosts.clientCount() > 0)

  // 늦게 도착한 생성 알림을 수정 알림으로 세지 않도록 생성 알림을 먼저 받고 비움
  const id = await createPost(alice)
  assert.ok(await waitFor(() => s.received.some((e) => e.postId === id)))
  s.received.length = 0

  await fetch(`${app.baseUrl}/posts/${id}?_method=PATCH`, form({ board: 'free', title: '수정', content: '수정' }, alice))
  await fetch(`${app.baseUrl}/posts/${id}?_method=DELETE`, { method: 'POST', redirect: 'manual', headers: { cookie: alice } })
  await wait(500)
  assert.equal(s.received.length, 0)
  s.close()
})

test('연결을 끊으면 연결 목록에서 빠짐', async () => {
  // 앞 테스트의 연결이 정리 중일 수 있어 절대값 대신 증감으로 확인
  await wait(300)
  const before = newPosts.clientCount()
  const s = await openStream('/stream/posts')
  assert.ok(await waitFor(() => newPosts.clientCount() === before + 1))
  s.close()
  assert.ok(await waitFor(() => newPosts.clientCount() === before), '끊긴 연결이 남아 있으면 안 된다')
})

test('스트림이 끊긴 동안 올라온 글도 다시 연결하면 이어받음', async () => {
  const s = await openStream('/stream/posts')
  await waitFor(() => newPosts.clientCount() > 0)

  // 이어받을 위치를 만들기 위해 글 하나를 먼저 받음
  const first = await createPost(alice)
  assert.ok(await waitFor(() => s.received.some((e) => e.postId === first)))

  // DB 연결이 끊긴 사이에 글이 올라온 상황
  await newPosts.closeStream()
  const missed = await createPost(alice)
  await wait(200)
  assert.equal(s.received.some((e) => e.postId === missed), false)

  // 다시 열면 마지막 위치부터 이어받아 놓친 글도 전달됨
  await newPosts.openStream()
  assert.ok(await waitFor(() => s.received.some((e) => e.postId === missed)), '놓친 글을 이어받아야 한다')
  s.close()
})
