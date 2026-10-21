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

// 글쓰기 화면처럼 multipart 형식으로 전송
async function writePost(cookie, fields) {
  const body = new FormData()
  for (const [k, v] of Object.entries(fields)) body.append(k, v)
  return fetch(`${app.baseUrl}/posts`, { method: 'POST', redirect: 'manual', headers: { cookie }, body })
}

async function createPost(cookie, fields = {}) {
  const res = await writePost(cookie, { board: 'free', title: '제목', content: '내용', ...fields })
  assert.equal(res.status, 302)
  return res.headers.get('location').split('/').pop()
}

const get = (path, cookie) =>
  fetch(`${app.baseUrl}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} })

test('로그인하지 않으면 글쓰기 화면 대신 로그인 화면으로 보냄', async () => {
  const res = await get('/posts/new')
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/login')
})

test('글을 쓰면 상세 화면으로 이동하고, HTML은 escape되어 보임', async () => {
  const id = await createPost(alice, { title: '<script>alert(1)</script>', content: '첫 글' })
  const html = await (await get(`/posts/${id}`)).text()

  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  assert.match(html, /앨리스/)
})

test('없는 게시판이나 빈 제목은 400을 돌려줌', async () => {
  assert.equal((await writePost(alice, { board: 'nope', title: 't', content: 'c' })).status, 400)
  assert.equal((await writePost(alice, { board: 'free', title: '  ', content: 'c' })).status, 400)
})

test('이미지 업로드가 설정되지 않은 서버에 파일을 보내면 400을 돌려줌', async () => {
  const body = new FormData()
  body.append('board', 'free')
  body.append('title', '사진')
  body.append('content', '내용')
  body.append('images', new Blob(['fake'], { type: 'image/png' }), 'a.png')
  const res = await fetch(`${app.baseUrl}/posts`, { method: 'POST', redirect: 'manual', headers: { cookie: alice }, body })
  assert.equal(res.status, 400)
})

test('형식이 틀린 id와 없는 id는 404를 돌려줌', async () => {
  assert.equal((await get('/posts/not-an-id')).status, 404)
  assert.equal((await get(`/posts/${new ObjectId()}`)).status, 404)
})

test('남의 글은 수정하거나 삭제할 수 없음', async () => {
  const id = await createPost(alice, { title: '앨리스 글' })

  assert.equal((await get(`/posts/${id}/edit`, bob)).status, 403)
  const edit = await fetch(`${app.baseUrl}/posts/${id}?_method=PATCH`, form({ board: 'free', title: '해킹', content: 'x' }, bob))
  assert.equal(edit.status, 403)
  const del = await fetch(`${app.baseUrl}/posts/${id}?_method=DELETE`, { method: 'POST', redirect: 'manual', headers: { cookie: bob } })
  assert.equal(del.status, 403)

  const post = await app.db.getDb().collection('posts').findOne({ _id: new ObjectId(id) })
  assert.equal(post.title, '앨리스 글')
  assert.equal(post.deletedAt, undefined)
})

test('내 글은 수정할 수 있음', async () => {
  const id = await createPost(alice, { title: '수정 전' })
  const res = await fetch(`${app.baseUrl}/posts/${id}?_method=PATCH`, form({ board: 'info', title: '수정 후', content: '바뀐 내용' }, alice))
  assert.equal(res.status, 302)

  const html = await (await get(`/posts/${id}`)).text()
  assert.match(html, /수정 후/)
  assert.match(html, /수정됨/)
})

test('삭제한 글은 상세와 피드에서 사라지지만 DB에는 남음', async () => {
  const id = await createPost(alice, { title: '곧 삭제될 글' })
  const res = await fetch(`${app.baseUrl}/posts/${id}?_method=DELETE`, { method: 'POST', redirect: 'manual', headers: { cookie: alice } })
  assert.equal(res.status, 302)

  assert.equal((await get(`/posts/${id}`)).status, 404)
  assert.doesNotMatch(await (await get('/')).text(), /곧 삭제될 글/)

  const post = await app.db.getDb().collection('posts').findOne({ _id: new ObjectId(id) })
  assert.ok(post.deletedAt instanceof Date)
})

test('피드는 최신순 20개씩 보여주고, 커서로 다음 페이지를 겹치지 않게 이어감', async () => {
  // 앞 테스트의 글과 섞이지 않도록 전용 게시판에 25개 생성
  for (let i = 1; i <= 25; i++) await createPost(bob, { board: 'hobby', title: `취미글-${i}번` })

  const titles = (html) => [...html.matchAll(/취미글-(\d+)번/g)].map((m) => Number(m[1]))

  const page1 = await (await get('/?board=hobby')).text()
  assert.deepEqual(titles(page1), Array.from({ length: 20 }, (_, i) => 25 - i))

  // EJS는 링크 안의 &를 &amp;로 출력함
  const next = page1.match(/href="(\/\?board=hobby&(?:amp;)?cursor=[0-9a-f]{24})"/)
  assert.ok(next, '다음 페이지 링크가 있어야 한다')

  const page2 = await (await get(next[1].replace(/&amp;/g, '&'))).text()
  assert.deepEqual(titles(page2), [5, 4, 3, 2, 1])
  assert.doesNotMatch(page2, /cursor=/, '마지막 페이지에는 다음 링크가 없어야 한다')
})

test('게시판을 고르면 그 게시판 글만 보임', async () => {
  await createPost(alice, { board: 'question', title: '질문게시판 글' })
  const html = await (await get('/?board=question')).text()
  assert.match(html, /질문게시판 글/)
  assert.doesNotMatch(html, /취미글-/)
})

test('잘못된 커서와 없는 게시판은 각각 400과 404를 돌려줌', async () => {
  assert.equal((await get('/?cursor=zzz')).status, 400)
  assert.equal((await get('/?board=nope')).status, 404)
})
