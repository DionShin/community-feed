const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { ObjectId } = require('mongodb')
const { startTestApp, signup } = require('./helpers')

let app
let alice
let hourlyStats
let popular

const HOUR = 60 * 60 * 1000
// 결과를 예측할 수 있도록 기준 시각 고정
const NOW = new Date('2026-10-14T12:30:00Z')

before(async () => {
  app = await startTestApp()
  alice = await signup(app.baseUrl, 'alice01', '앨리스')
  hourlyStats = require('../src/services/hourlyStats')
  popular = require('../src/services/popular')
})

after(async () => {
  await app.close()
})

beforeEach(async () => {
  await app.db.getDb().collection('events').deleteMany({})
  await app.db.getDb().collection('post_stats_hourly').deleteMany({})
})

const stats = () => app.db.getDb().collection('post_stats_hourly')

async function createPost(title) {
  const body = new FormData()
  body.append('board', 'free')
  body.append('title', title)
  body.append('content', '내용')
  const res = await fetch(`${app.baseUrl}/posts`, { method: 'POST', redirect: 'manual', headers: { cookie: alice }, body })
  return new ObjectId(res.headers.get('location').split('/').pop())
}

async function addEvents(postId, type, n, at) {
  const docs = Array.from({ length: n }, () => ({
    type,
    userId: null,
    postId,
    surface: 'detail',
    position: null,
    occurredAt: at,
    receivedAt: at,
    source: 'server',
  }))
  await app.db.getDb().collection('events').insertMany(docs)
}

const minutesAgo = (m) => new Date(NOW.getTime() - m * 60 * 1000)

test('원본 이벤트를 글별, 시간별 칸으로 집계함', async () => {
  const id = await createPost('글')
  await addEvents(id, 'view', 3, minutesAgo(10)) // 12시 칸
  await addEvents(id, 'like', 2, minutesAgo(20)) // 12시 칸
  await addEvents(id, 'view', 5, minutesAgo(50)) // 11시 칸
  await addEvents(id, 'impression', 100, minutesAgo(10)) // 점수에 쓰지 않으므로 집계하지 않음

  await hourlyStats.backfill({ now: NOW })

  const rows = await stats().find({ postId: id }).sort({ hour: 1 }).toArray()
  assert.deepEqual(
    rows.map((r) => [r.hour.toISOString(), r.views, r.likes, r.unlikes, r.comments]),
    [
      ['2026-10-14T11:00:00.000Z', 5, 0, 0, 0],
      ['2026-10-14T12:00:00.000Z', 3, 2, 0, 0],
    ],
  )
})

test('여러 번 실행해도 숫자가 늘어나지 않음', async () => {
  const id = await createPost('글')
  await addEvents(id, 'view', 4, minutesAgo(5))

  for (let i = 0; i < 3; i++) await hourlyStats.rebuildRecent({ now: NOW })

  const rows = await stats().find({ postId: id }).toArray()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].views, 4)
})

test('직전 시간에 늦게 저장된 이벤트도 다음 갱신에서 반영됨', async () => {
  const id = await createPost('글')
  await addEvents(id, 'view', 1, minutesAgo(70))
  await hourlyStats.rebuildRecent({ now: NOW })

  // 갱신 후 70분 전 시각의 이벤트가 뒤늦게 저장된 상황
  await addEvents(id, 'view', 2, minutesAgo(70))
  await hourlyStats.rebuildRecent({ now: NOW })

  const row = await stats().findOne({ postId: id, hour: new Date('2026-10-14T11:00:00Z') })
  assert.equal(row.views, 3)
})

test('최근 갱신 범위보다 오래된 칸은 확정된 것으로 보고 다시 계산하지 않음', async () => {
  const id = await createPost('글')
  await addEvents(id, 'view', 1, minutesAgo(5 * 60))
  await hourlyStats.backfill({ now: NOW })

  // 5시간 전 시각의 이벤트가 아주 늦게 저장되면 1분 주기 갱신으로는 반영되지 않음
  await addEvents(id, 'view', 10, minutesAgo(5 * 60))
  await hourlyStats.rebuildRecent({ now: NOW })
  const row = await stats().findOne({ postId: id, hour: new Date('2026-10-14T07:00:00Z') })
  assert.equal(row.views, 1)

  // 전체 다시 채우기로 바로잡힘
  await hourlyStats.backfill({ now: NOW })
  assert.equal((await stats().findOne({ _id: row._id })).views, 11)
})

test('정각 기준으로는 통계 방식과 원본 이벤트 방식의 순위가 같음', async () => {
  const exactHour = new Date('2026-10-14T12:00:00Z')
  const ago = (h) => new Date(exactHour.getTime() - h * HOUR)

  const ids = []
  for (let i = 0; i < 6; i++) ids.push(await createPost(`글${i}`))
  await addEvents(ids[0], 'view', 7, ago(1))
  await addEvents(ids[1], 'comment', 2, ago(3))
  await addEvents(ids[2], 'like', 3, ago(10))
  await addEvents(ids[2], 'unlike', 1, ago(9))
  await addEvents(ids[3], 'view', 40, ago(25)) // 24시간 밖
  await addEvents(ids[4], 'view', 1, ago(23.5))
  await addEvents(ids[5], 'like', 1, ago(0.5))

  await hourlyStats.backfill({ now: exactHour })

  const summarize = (posts) => posts.map((p) => [p.title, p.stats.score])
  const fromStats = await popular.getPopularPosts({ now: exactHour })
  const fromEvents = await popular.getPopularPostsFromEvents({ now: exactHour })

  assert.deepEqual(summarize(fromStats), summarize(fromEvents))
  assert.deepEqual(summarize(fromStats), [
    ['글1', 10],
    ['글0', 7],
    ['글2', 6],
    ['글5', 3],
    ['글4', 1],
  ])
})
