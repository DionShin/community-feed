const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { ObjectId } = require('mongodb')
const { startTestApp, form, signup } = require('./helpers')

let app
let alice
let bob
let aliceId
let bobId

before(async () => {
  app = await startTestApp()
  alice = await signup(app.baseUrl, 'alice01', '앨리스')
  bob = await signup(app.baseUrl, 'bob0001', '바비')
  const users = app.db.getDb().collection('users')
  aliceId = (await users.findOne({ username: 'alice01' }))._id
  bobId = (await users.findOne({ username: 'bob0001' }))._id
})

after(async () => {
  await app.close()
})

beforeEach(async () => {
  await events().deleteMany({})
})

const events = () => app.db.getDb().collection('events')

async function createPost(cookie) {
  const body = new FormData()
  body.append('board', 'free')
  body.append('title', '글')
  body.append('content', '내용')
  const res = await fetch(`${app.baseUrl}/posts`, { method: 'POST', redirect: 'manual', headers: { cookie }, body })
  return new ObjectId(res.headers.get('location').split('/').pop())
}

function sendEvents(payload, cookie) {
  return fetch(`${app.baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload),
  })
}

const impression = (postId, extra = {}) => ({
  type: 'impression',
  postId: String(postId),
  surface: 'feed_latest',
  position: 0,
  occurredAt: new Date().toISOString(),
  ...extra,
})

test('상세 화면을 열면 view 이벤트가 출발 화면과 함께 기록됨', async () => {
  const postId = await createPost(alice)
  await fetch(`${app.baseUrl}/posts/${postId}?from=feed_board`, { headers: { cookie: bob } })

  const [e] = await events().find({ type: 'view' }).toArray()
  assert.equal(e.source, 'server')
  assert.ok(e.userId.equals(bobId))
  assert.ok(e.postId.equals(postId))
  assert.equal(e.surface, 'feed_board')
  assert.deepEqual(e.occurredAt, e.receivedAt)
})

test('비로그인 조회는 userId 없이 기록되고, 모르는 출발 화면은 null이 됨', async () => {
  const postId = await createPost(alice)
  await fetch(`${app.baseUrl}/posts/${postId}?from=hacker`)

  const [e] = await events().find({ type: 'view' }).toArray()
  assert.equal(e.userId, null)
  assert.equal(e.surface, null)
})

test('공감은 상태가 실제로 바뀐 경우에만 이벤트가 남음', async () => {
  const postId = await createPost(alice)
  const like = (method) =>
    fetch(`${app.baseUrl}/posts/${postId}/like`, { method, headers: { cookie: bob, Accept: 'application/json' } })

  await like('PUT')
  await like('PUT')
  await like('PUT')
  await like('DELETE')
  await like('DELETE')

  const types = (await events().find({ postId }).sort({ _id: 1 }).toArray()).map((e) => e.type)
  assert.deepEqual(types, ['like', 'unlike'])
})

test('공감 API 응답에는 내부용 changed 값이 섞이지 않음', async () => {
  const postId = await createPost(alice)
  const res = await fetch(`${app.baseUrl}/posts/${postId}/like`, { method: 'PUT', headers: { cookie: bob, Accept: 'application/json' } })
  assert.deepEqual(await res.json(), { liked: true, likeCount: 1 })
})

test('댓글을 쓰면 comment 이벤트가 남음', async () => {
  const postId = await createPost(alice)
  await fetch(`${app.baseUrl}/posts/${postId}/comments`, form({ content: '댓글' }, bob))

  const e = await events().findOne({ type: 'comment' })
  assert.ok(e.postId.equals(postId))
  assert.ok(e.userId.equals(bobId))
})

test('브라우저가 보낸 노출 이벤트는 한 번에 저장되고 202를 돌려줌', async () => {
  const p1 = await createPost(alice)
  const p2 = await createPost(alice)
  const res = await sendEvents({ events: [impression(p1, { position: 0 }), impression(p2, { position: 1 })] }, bob)

  assert.equal(res.status, 202)
  assert.deepEqual(await res.json(), { accepted: 2, rejected: 0 })

  const saved = await events().find({ type: 'impression' }).sort({ position: 1 }).toArray()
  assert.equal(saved.length, 2)
  assert.equal(saved[0].source, 'client')
  assert.ok(saved[0].userId.equals(bobId))
  assert.ok(saved[1].postId.equals(p2))
  assert.ok(saved[0].receivedAt instanceof Date)
})

test('비로그인 노출도 받음', async () => {
  const postId = await createPost(alice)
  const res = await sendEvents({ events: [impression(postId)] })
  assert.equal(res.status, 202)
  assert.equal((await events().findOne({ type: 'impression' })).userId, null)
})

test('브라우저는 조회나 공감 이벤트를 보낼 수 없고, 이상한 값은 그 이벤트만 버림', async () => {
  const postId = await createPost(alice)
  const now = Date.now()
  const res = await sendEvents({
    events: [
      impression(postId),
      impression(postId, { type: 'like' }),
      impression(postId, { type: 'view' }),
      impression('not-an-id'),
      impression(postId, { surface: 'detail' }),
      impression(postId, { position: -1 }),
      impression(postId, { position: 1.5 }),
      impression(postId, { occurredAt: 'yesterday' }),
      impression(postId, { occurredAt: new Date(now - 2 * 24 * 3600 * 1000).toISOString() }),
      impression(postId, { occurredAt: new Date(now + 60 * 60 * 1000).toISOString() }),
      null,
    ],
  })

  assert.deepEqual(await res.json(), { accepted: 1, rejected: 10 })
  assert.equal(await events().countDocuments({}), 1)
})

test('배열이 아니거나 너무 많이 보내면 400을 돌려줌', async () => {
  const postId = await createPost(alice)
  assert.equal((await sendEvents({ events: 'x' })).status, 400)
  assert.equal((await sendEvents({ events: [] })).status, 400)
  assert.equal((await sendEvents({ events: Array.from({ length: 51 }, () => impression(postId)) })).status, 400)
})

test('이벤트 저장이 실패해도 상세 화면과 공감은 정상 동작함', async () => {
  const postId = await createPost(alice)
  const db = app.db.getDb()

  // 모든 문서를 거부하는 검증 규칙으로 저장 실패 상황을 만듦
  await db.command({
    collMod: 'events',
    validator: { $jsonSchema: { required: ['thisFieldNeverExists'] } },
    validationAction: 'error',
  })
  const originalError = console.error
  console.error = () => {}

  try {
    const detail = await fetch(`${app.baseUrl}/posts/${postId}`, { headers: { cookie: bob } })
    assert.equal(detail.status, 200)

    const like = await fetch(`${app.baseUrl}/posts/${postId}/like`, { method: 'PUT', headers: { cookie: bob, Accept: 'application/json' } })
    assert.deepEqual(await like.json(), { liked: true, likeCount: 1 })

    assert.equal(await events().countDocuments({}), 0)
  } finally {
    console.error = originalError
    await db.command({ collMod: 'events', validator: {}, validationLevel: 'off' })
  }
})

test('피드 화면은 노출 추적에 필요한 정보를 담고, 글 링크에 출발 화면을 붙임', async () => {
  const postId = await createPost(alice)
  const html = await (await fetch(`${app.baseUrl}/`)).text()

  assert.match(html, /data-surface="feed_latest"/)
  assert.match(html, new RegExp(`data-post-id="${postId}" data-position="0"`))
  assert.match(html, new RegExp(`href="/posts/${postId}\\?from=feed_latest"`))
  assert.match(html, /\/js\/impressions\.js/)
})
