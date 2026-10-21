const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { ObjectId } = require('mongodb')
const { startTestApp, form, signup } = require('./helpers')

let app
let alice
let bob

before(async () => {
  app = await startTestApp()
  alice = await signup(app.baseUrl, 'alice01', '앨리스')
  bob = await signup(app.baseUrl, 'bob0001', '바비')
})

after(async () => {
  await app.close()
})

async function createPost(cookie) {
  const body = new FormData()
  body.append('board', 'free')
  body.append('title', '글')
  body.append('content', '내용')
  const res = await fetch(`${app.baseUrl}/posts`, { method: 'POST', redirect: 'manual', headers: { cookie }, body })
  return res.headers.get('location').split('/').pop()
}

const postDoc = (id) => app.db.getDb().collection('posts').findOne({ _id: new ObjectId(id) })

function likeRequest(postId, cookie, method) {
  return fetch(`${app.baseUrl}/posts/${postId}/like`, {
    method,
    headers: { cookie, Accept: 'application/json' },
  })
}

test('댓글을 쓰면 상세 화면에 보이고 글의 댓글 수가 오름', async () => {
  const id = await createPost(alice)
  const res = await fetch(`${app.baseUrl}/posts/${id}/comments`, form({ content: '첫 댓글' }, bob))
  assert.equal(res.status, 302)

  const html = await (await fetch(`${app.baseUrl}/posts/${id}`)).text()
  assert.match(html, /첫 댓글/)
  assert.match(html, /바비/)
  assert.equal((await postDoc(id)).commentCount, 1)
})

test('빈 댓글은 400, 없는 글에 단 댓글은 404를 돌려줌', async () => {
  const id = await createPost(alice)
  assert.equal((await fetch(`${app.baseUrl}/posts/${id}/comments`, form({ content: '   ' }, bob))).status, 400)
  assert.equal((await fetch(`${app.baseUrl}/posts/${new ObjectId()}/comments`, form({ content: 'x' }, bob))).status, 404)
})

test('내 댓글만 지울 수 있고, 지우면 댓글 수가 내려감', async () => {
  const id = await createPost(alice)
  await fetch(`${app.baseUrl}/posts/${id}/comments`, form({ content: '바비 댓글' }, bob))
  const comment = await app.db.getDb().collection('comments').findOne({ content: '바비 댓글' })

  const del = (cookie) =>
    fetch(`${app.baseUrl}/comments/${comment._id}?_method=DELETE`, { method: 'POST', redirect: 'manual', headers: { cookie } })

  assert.equal((await del(alice)).status, 403)
  assert.equal((await del(bob)).status, 302)
  assert.equal((await postDoc(id)).commentCount, 0)
  assert.doesNotMatch(await (await fetch(`${app.baseUrl}/posts/${id}`)).text(), /바비 댓글/)
})

test('같은 댓글 삭제 요청이 동시에 와도 댓글 수는 한 번만 내려감', async () => {
  const id = await createPost(alice)
  await fetch(`${app.baseUrl}/posts/${id}/comments`, form({ content: '동시 삭제' }, bob))
  const comment = await app.db.getDb().collection('comments').findOne({ content: '동시 삭제' })

  await Promise.all(
    Array.from({ length: 5 }, () =>
      fetch(`${app.baseUrl}/comments/${comment._id}?_method=DELETE`, { method: 'POST', redirect: 'manual', headers: { cookie: bob } }),
    ),
  )
  assert.equal((await postDoc(id)).commentCount, 0)
})

test('공감과 공감 취소는 JSON으로 상태와 숫자를 돌려줌', async () => {
  const id = await createPost(alice)

  const liked = await (await likeRequest(id, bob, 'PUT')).json()
  assert.deepEqual(liked, { liked: true, likeCount: 1 })

  const unliked = await (await likeRequest(id, bob, 'DELETE')).json()
  assert.deepEqual(unliked, { liked: false, likeCount: 0 })
})

test('비로그인 공감 요청은 401 JSON을 돌려줌', async () => {
  const id = await createPost(alice)
  const res = await fetch(`${app.baseUrl}/posts/${id}/like`, { method: 'PUT', headers: { Accept: 'application/json' } })
  assert.equal(res.status, 401)
  assert.equal((await res.json()).message, '로그인이 필요합니다.')
})

test('같은 사람이 공감을 10번 동시에 눌러도 공감은 1개임', async () => {
  const id = await createPost(alice)
  await Promise.all(Array.from({ length: 10 }, () => likeRequest(id, bob, 'PUT')))

  assert.equal(await app.db.getDb().collection('likes').countDocuments({ postId: new ObjectId(id) }), 1)
  assert.equal((await postDoc(id)).likeCount, 1)
})

test('여러 사람이 동시에 공감하면 정확히 사람 수만큼 오름', async () => {
  const id = await createPost(alice)
  const users = await Promise.all(
    Array.from({ length: 8 }, (_, i) => signup(app.baseUrl, `fan${String(i).padStart(4, '0')}`, `팬${i}번`)),
  )
  await Promise.all(users.map((cookie) => likeRequest(id, cookie, 'PUT')))

  assert.equal((await postDoc(id)).likeCount, 8)
})

test('공감하지 않은 글에 취소를 보내도 공감 수가 음수가 되지 않음', async () => {
  const id = await createPost(alice)
  await Promise.all(Array.from({ length: 3 }, () => likeRequest(id, bob, 'DELETE')))
  assert.equal((await postDoc(id)).likeCount, 0)
})

test('상세 화면은 내가 공감한 상태를 표시함', async () => {
  const id = await createPost(alice)
  await likeRequest(id, bob, 'PUT')

  const html = await (await fetch(`${app.baseUrl}/posts/${id}`, { headers: { cookie: bob } })).text()
  assert.match(html, /data-liked="true"/)
  assert.match(html, /♥ 공감 1/)
})
