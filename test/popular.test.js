const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { ObjectId } = require('mongodb')
const { startTestApp, signup } = require('./helpers')

let app
let alice
let popular
let hourlyStats

before(async () => {
  app = await startTestApp()
  alice = await signup(app.baseUrl, 'alice01', '앨리스')
  popular = require('../src/services/popular')
  hourlyStats = require('../src/services/hourlyStats')
})

after(async () => {
  await app.close()
})

beforeEach(async () => {
  await app.db.getDb().collection('events').deleteMany({})
  await app.db.getDb().collection('post_stats_hourly').deleteMany({})
})

// 인기 피드는 시간별 통계를 읽으므로 이벤트를 넣은 뒤 통계를 갱신해야 반영됨
async function popularPosts() {
  await hourlyStats.backfill()
  return popular.getPopularPosts()
}

async function popularHtml() {
  await hourlyStats.backfill()
  return (await fetch(`${app.baseUrl}/popular`)).text()
}

async function createPost(title) {
  const body = new FormData()
  body.append('board', 'free')
  body.append('title', title)
  body.append('content', '내용')
  const res = await fetch(`${app.baseUrl}/posts`, { method: 'POST', redirect: 'manual', headers: { cookie: alice }, body })
  return new ObjectId(res.headers.get('location').split('/').pop())
}

const HOUR = 60 * 60 * 1000

async function addEvents(postId, type, n, hoursAgo = 1) {
  const at = new Date(Date.now() - hoursAgo * HOUR)
  const docs = Array.from({ length: n }, () => ({
    type,
    userId: null,
    postId,
    surface: 'feed_latest',
    position: null,
    occurredAt: at,
    receivedAt: at,
    source: 'server',
  }))
  await app.db.getDb().collection('events').insertMany(docs)
}

const titlesOf = (posts) => posts.map((p) => p.title)

test('조회 1점, 공감 3점, 댓글 5점으로 점수를 매겨 높은 순으로 정렬함', async () => {
  const a = await createPost('조회만 많은 글')
  const b = await createPost('반응이 좋은 글')
  await addEvents(a, 'view', 10)
  await addEvents(b, 'view', 1)
  await addEvents(b, 'like', 2)
  await addEvents(b, 'comment', 1)

  const posts = await popularPosts()
  assert.deepEqual(titlesOf(posts), ['반응이 좋은 글', '조회만 많은 글'])
  assert.deepEqual(posts[0].stats, { views: 1, likes: 2, comments: 1, score: 12 })
  assert.equal(posts[1].stats.score, 10)
})

test('24시간보다 오래된 이벤트는 점수에 들어가지 않음', async () => {
  const fresh = await createPost('최근에 뜬 글')
  const old = await createPost('어제 뜬 글')
  await addEvents(fresh, 'view', 3, 2)
  await addEvents(old, 'view', 100, 30)

  assert.deepEqual(titlesOf(await popularPosts()), ['최근에 뜬 글'])
})

test('공감 취소는 공감 점수를 되돌리고, 노출은 점수에 들어가지 않음', async () => {
  const id = await createPost('공감했다 취소한 글')
  await addEvents(id, 'like', 2)
  await addEvents(id, 'unlike', 2)
  await addEvents(id, 'impression', 500)

  assert.deepEqual(await popularPosts(), [])
})

test('삭제된 글은 점수가 높아도 보이지 않음', async () => {
  const kept = await createPost('남은 글')
  const removed = await createPost('삭제된 인기글')
  await addEvents(kept, 'view', 1)
  await addEvents(removed, 'comment', 10)
  await fetch(`${app.baseUrl}/posts/${removed}?_method=DELETE`, { method: 'POST', redirect: 'manual', headers: { cookie: alice } })

  assert.deepEqual(titlesOf(await popularPosts()), ['남은 글'])
})

test('인기 화면은 순위와 최근 통계를 보여주고, 노출과 조회를 인기 피드 출처로 남김', async () => {
  const id = await createPost('화면 확인용 인기글')
  await addEvents(id, 'view', 4)

  const html = await popularHtml()
  assert.match(html, /data-surface="feed_popular"/)
  assert.match(html, /class="rank">1</)
  assert.match(html, /조회 4 · 공감 0/)
  assert.match(html, new RegExp(`href="/posts/${id}\\?from=feed_popular"`))

  await fetch(`${app.baseUrl}/posts/${id}?from=feed_popular`)
  const view = await app.db.getDb().collection('events').findOne({ type: 'view', surface: 'feed_popular' })
  assert.ok(view)

  const res = await fetch(`${app.baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      events: [{ type: 'impression', postId: String(id), surface: 'feed_popular', position: 0, occurredAt: new Date().toISOString() }],
    }),
  })
  assert.deepEqual(await res.json(), { accepted: 1, rejected: 0 })
})

test('인기글이 없으면 안내 문구를 보여줌', async () => {
  const html = await popularHtml()
  assert.match(html, /아직 인기글이 없습니다/)
})
