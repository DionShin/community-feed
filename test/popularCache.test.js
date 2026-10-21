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
  popular.resetCache()
})

async function createPost(title) {
  const body = new FormData()
  body.append('board', 'free')
  body.append('title', title)
  body.append('content', '내용')
  const res = await fetch(`${app.baseUrl}/posts`, { method: 'POST', redirect: 'manual', headers: { cookie: alice }, body })
  return new ObjectId(res.headers.get('location').split('/').pop())
}

async function addViews(postId, n) {
  const at = new Date(Date.now() - 10 * 60 * 1000)
  const docs = Array.from({ length: n }, () => ({
    type: 'view', userId: null, postId, surface: 'detail', position: null, occurredAt: at, receivedAt: at, source: 'server',
  }))
  await app.db.getDb().collection('events').insertMany(docs)
}

const titles = (posts) => posts.map((p) => p.title)

test('통계가 갱신되기 전까지는 계산 결과를 재사용함', async () => {
  const a = await createPost('글A')
  await addViews(a, 3)
  await hourlyStats.backfill()

  const first = await popular.getPopularPostsCached()
  const second = await popular.getPopularPostsCached()

  assert.deepEqual(titles(first), ['글A'])
  assert.equal(second, first, '같은 결과 객체를 돌려줘야 한다')
  assert.deepEqual(popular.cacheStats(), { hits: 1, misses: 1, computations: 1 })
})

test('통계가 갱신되면 다음 요청에서 새로 계산함', async () => {
  const a = await createPost('글A')
  const b = await createPost('글B')
  await addViews(a, 3)
  await hourlyStats.backfill()
  assert.deepEqual(titles(await popular.getPopularPostsCached()), ['글A'])

  // 통계가 갱신되기 전에는 캐시된 결과가 그대로임
  await addViews(b, 10)
  assert.deepEqual(titles(await popular.getPopularPostsCached()), ['글A'])

  // 통계 갱신 후 버전이 바뀌어 새 결과가 나옴
  await hourlyStats.rebuildRecent()
  assert.deepEqual(titles(await popular.getPopularPostsCached()), ['글B', '글A'])
  assert.equal(popular.cacheStats().computations, 2)
})

test('캐시가 빈 순간 요청이 몰려도 계산은 한 번만 함', async () => {
  const a = await createPost('글A')
  await addViews(a, 1)
  await hourlyStats.backfill()

  const results = await Promise.all(Array.from({ length: 20 }, () => popular.getPopularPostsCached()))

  assert.equal(popular.cacheStats().computations, 1)
  assert.ok(results.every((r) => r === results[0]))
})

test('계산이 실패하면 다음 요청에서 다시 시도함', async () => {
  const a = await createPost('글A')
  await addViews(a, 1)
  await hourlyStats.backfill()

  // 첫 집계만 잘못된 단계로 바꿔 DB 에러를 한 번 발생시킴
  const collection = app.db.getDb().collection('post_stats_hourly')
  const realAggregate = collection.constructor.prototype.aggregate
  let failOnce = true
  collection.constructor.prototype.aggregate = function (...args) {
    if (failOnce && this.collectionName === 'post_stats_hourly') {
      failOnce = false
      return realAggregate.call(this, [{ $notAStage: {} }])
    }
    return realAggregate.apply(this, args)
  }

  try {
    await assert.rejects(popular.getPopularPostsCached())
    assert.deepEqual(titles(await popular.getPopularPostsCached()), ['글A'])
  } finally {
    collection.constructor.prototype.aggregate = realAggregate
  }
})
