const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { ObjectId } = require('mongodb')
const { startTestApp, form, signup } = require('./helpers')

let app
let alice
let bob
let bobId
let dq
let hourlyStats

const HOUR = 60 * 60 * 1000
const MIN = 60 * 1000

before(async () => {
  app = await startTestApp()
  alice = await signup(app.baseUrl, 'alice01', '앨리스')
  bob = await signup(app.baseUrl, 'bob0001', '바비')
  bobId = (await db().collection('users').findOne({ username: 'bob0001' }))._id
  dq = require('../src/services/dataQuality')
  hourlyStats = require('../src/services/hourlyStats')
})

after(async () => {
  await app.close()
})

beforeEach(async () => {
  for (const name of ['posts', 'likes', 'comments', 'events', 'post_stats_hourly', 'job_runs', 'dq_reports']) {
    await db().collection(name).deleteMany({})
  }
})

const db = () => app.db.getDb()
const startOfHour = (d) => new Date(Math.floor(d.getTime() / HOUR) * HOUR)

async function createPost(cookie = alice) {
  const body = new FormData()
  body.append('board', 'free')
  body.append('title', '글')
  body.append('content', '내용')
  const res = await fetch(`${app.baseUrl}/posts`, { method: 'POST', redirect: 'manual', headers: { cookie }, body })
  return new ObjectId(res.headers.get('location').split('/').pop())
}

function event(type, postId, at, extra = {}) {
  return { type, userId: null, postId, surface: 'detail', position: null, occurredAt: at, receivedAt: at, source: 'server', ...extra }
}

async function run() {
  const report = await dq.runChecks({ now: new Date() })
  return Object.fromEntries(report.checks.map((c) => [c.name, c]))
}

test('정상 데이터에서는 모든 검사가 정상임', async () => {
  const id = await createPost()
  await fetch(`${app.baseUrl}/posts/${id}/like`, { method: 'PUT', headers: { cookie: bob, Accept: 'application/json' } })
  await fetch(`${app.baseUrl}/posts/${id}/comments`, form({ content: '댓글' }, bob))
  await fetch(`${app.baseUrl}/posts/${id}`, { headers: { cookie: bob } })
  await fetch(`${app.baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [{ type: 'impression', postId: String(id), surface: 'feed_latest', position: 0, occurredAt: new Date().toISOString() }] }),
  })
  await hourlyStats.backfill()

  const checks = await run()
  for (const c of Object.values(checks)) {
    if (c.status !== 'info') assert.equal(c.status, 'ok', `${c.name}: ${JSON.stringify(c)}`)
  }
})

test('공감 수 어긋남을 찾고, 확인 후에만 원본 기준으로 바로잡음', async () => {
  const id = await createPost()
  await fetch(`${app.baseUrl}/posts/${id}/like`, { method: 'PUT', headers: { cookie: bob, Accept: 'application/json' } })
  // 공감 문서는 1개인데 숫자만 5가 된 상황(두 번의 쓰기 사이에 어긋남)
  await db().collection('posts').updateOne({ _id: id }, { $set: { likeCount: 5 } })

  const c = (await run()).like_count_drift
  assert.equal(c.status, 'warn')
  assert.equal(c.value, 1)
  assert.deepEqual(c.samples[0], { postId: String(id), stored: 5, actual: 1 })

  const dry = await dq.reconcileCounts()
  assert.equal(dry.applied, false)
  assert.equal((await db().collection('posts').findOne({ _id: id })).likeCount, 5, '확인 전에는 고치지 않는다')

  const applied = await dq.reconcileCounts({ apply: true })
  assert.equal(applied.changes.length, 1)
  assert.equal((await db().collection('posts').findOne({ _id: id })).likeCount, 1)
  assert.equal((await run()).like_count_drift.status, 'ok')
})

test('댓글 수는 삭제되지 않은 댓글 기준으로 비교함', async () => {
  const id = await createPost()
  await fetch(`${app.baseUrl}/posts/${id}/comments`, form({ content: '하나' }, bob))
  await fetch(`${app.baseUrl}/posts/${id}/comments`, form({ content: '둘' }, bob))
  assert.equal((await run()).comment_count_drift.status, 'ok')

  // 댓글 하나를 삭제 표시했는데 숫자를 내리지 못한 상황
  await db().collection('comments').updateOne({ content: '둘' }, { $set: { deletedAt: new Date() } })
  const c = (await run()).comment_count_drift
  assert.equal(c.value, 1)
  assert.deepEqual(c.samples[0], { postId: String(id), stored: 2, actual: 1 })
})

test('평소 검사는 최근 활동한 글만 보고, 활동 없는 글의 어긋남은 전체 검사에서만 잡음', async () => {
  const active = await createPost()
  const quiet = await createPost()
  await fetch(`${app.baseUrl}/posts/${active}/like`, { method: 'PUT', headers: { cookie: bob, Accept: 'application/json' } })
  // 두 글 모두 숫자를 틀어 놓음. quiet 글은 최근 공감 활동이 없음(DB를 직접 고친 경우)
  await db().collection('posts').updateMany({ _id: { $in: [active, quiet] } }, { $set: { likeCount: 9 } })

  const recent = (await dq.runChecks({ now: new Date() })).checks.find((c) => c.name === 'like_count_drift')
  assert.equal(recent.value, 1)
  assert.deepEqual(recent.detail, { scope: 'recent', postsChecked: 1 })
  assert.equal(recent.samples[0].postId, String(active))

  const full = (await dq.runChecks({ now: new Date(), fullScan: true })).checks.find((c) => c.name === 'like_count_drift')
  assert.equal(full.value, 2)
  assert.equal(full.detail.scope, 'full')
})

test('댓글 삭제는 실제로 지워진 한 번만 이벤트로 남음', async () => {
  const id = await createPost()
  await fetch(`${app.baseUrl}/posts/${id}/comments`, form({ content: '지울 댓글' }, bob))
  const comment = await db().collection('comments').findOne({ content: '지울 댓글' })

  await Promise.all(
    Array.from({ length: 5 }, () =>
      fetch(`${app.baseUrl}/comments/${comment._id}?_method=DELETE`, { method: 'POST', redirect: 'manual', headers: { cookie: bob } }),
    ),
  )
  assert.equal(await db().collection('events').countDocuments({ type: 'comment_delete', postId: id }), 1)
})

test('같은 사람의 10분 내 반복 조회 비율을 계산하고, 비로그인 조회는 사람 구분 없이 제외함', async () => {
  const id = await createPost()
  // 10분 고정 구간 경계에 걸치지 않도록 구간 시작 1분 뒤로 맞춤
  const tenMin = 10 * MIN
  const base = new Date(Math.floor((Date.now() - 30 * MIN) / tenMin) * tenMin + MIN)
  // 바비가 같은 글을 1초 간격으로 6번 조회(반복 5회) + 비로그인 조회 4번
  const docs = []
  for (let i = 0; i < 6; i++) docs.push(event('view', id, new Date(base.getTime() + i * 1000), { userId: bobId }))
  for (let i = 0; i < 4; i++) docs.push(event('view', id, new Date(base.getTime() + i * 1000)))
  await db().collection('events').insertMany(docs)

  const c = (await run()).duplicate_views
  assert.equal(c.status, 'warn')
  assert.equal(c.value, 0.5)
  assert.deepEqual(c.detail, { totalViews: 10, repeatedViews: 5, repeatedPairs: 1 })
})

test('존재하지 않는 글을 가리키는 이벤트를 찾고, 삭제된 글의 이벤트는 따로 셈', async () => {
  const kept = await createPost()
  const removed = await createPost()
  await fetch(`${app.baseUrl}/posts/${removed}?_method=DELETE`, { method: 'POST', redirect: 'manual', headers: { cookie: alice } })

  const at = new Date(Date.now() - 10 * MIN)
  const ghost = new ObjectId()
  await db().collection('events').insertMany([
    ...Array.from({ length: 7 }, () => event('impression', kept, at)),
    ...Array.from({ length: 2 }, () => event('impression', removed, at)),
    event('impression', ghost, at),
  ])

  const c = (await run()).orphan_events
  assert.equal(c.status, 'warn')
  assert.equal(c.value, 0.1)
  assert.deepEqual(c.detail, { totalEvents: 10, orphanEvents: 1, deletedPostEvents: 2 })
  assert.deepEqual(c.samples, [{ postId: String(ghost), events: 1 }])
})

test('발생 시각과 수신 시각이 1분 넘게 차이 나는 노출을 셈', async () => {
  const id = await createPost()
  const received = new Date(Date.now() - 5 * MIN)
  await db().collection('events').insertMany([
    ...Array.from({ length: 8 }, () => event('impression', id, received)),
    event('impression', id, received, { occurredAt: new Date(received.getTime() - 10 * MIN) }),
    event('impression', id, received, { occurredAt: new Date(received.getTime() + 3 * MIN) }),
  ])

  const c = (await run()).clock_skew
  assert.equal(c.status, 'warn')
  assert.equal(c.value, 0.2)
  assert.equal(c.detail.late, 1)
  assert.equal(c.detail.ahead, 1)
})

test('통계 작업이 멈추거나 한 번도 돌지 않으면 실패로 봄', async () => {
  assert.equal((await run()).stats_freshness.status, 'fail')

  await hourlyStats.rebuildRecent()
  assert.equal((await run()).stats_freshness.status, 'ok')

  await db().collection('job_runs').updateOne({ _id: 'hourly_stats' }, { $set: { lastRunAt: new Date(Date.now() - 20 * MIN) } })
  assert.equal((await run()).stats_freshness.status, 'fail')
})

test('직전 한 시간의 통계가 원본과 다르면 실패로 보고, 늦게 들어온 이벤트도 잡아냄', async () => {
  const id = await createPost()
  const prevHourMid = new Date(startOfHour(new Date()).getTime() - 30 * MIN)
  await db().collection('events').insertMany(Array.from({ length: 3 }, () => event('view', id, prevHourMid)))
  await hourlyStats.rebuildRecent()
  assert.equal((await run()).stats_consistency.status, 'ok')

  // 갱신 이후 직전 시간 이벤트가 뒤늦게 저장된 상황
  await db().collection('events').insertOne(event('view', id, prevHourMid))
  const c = (await run()).stats_consistency
  assert.equal(c.status, 'fail')
  assert.deepEqual(c.samples[0], { postId: String(id), expected: '4/0/0/0', actual: '3/0/0/0' })

  // 다음 갱신이 바로잡음
  await hourlyStats.rebuildRecent()
  assert.equal((await run()).stats_consistency.status, 'ok')
})

test('결과 0건 검색어를 많이 검색된 순서로 보여줌', async () => {
  await fetch(`${app.baseUrl}/search?q=${encodeURIComponent('없는책')}`)
  await fetch(`${app.baseUrl}/search?q=${encodeURIComponent('없는책')}`)
  await fetch(`${app.baseUrl}/search?q=${encodeURIComponent('아무거나')}`)

  const c = (await run()).zero_result_searches
  assert.equal(c.status, 'info')
  assert.deepEqual(c.samples, [
    { query: '없는책', searches: 2 },
    { query: '아무거나', searches: 1 },
  ])
})

test('검사 결과를 저장하고, 30일 뒤 자동 삭제되도록 TTL 인덱스가 걸려 있음', async () => {
  await dq.saveReport(await dq.runChecks())
  const latest = await dq.latestReport()
  assert.ok(latest.runAt instanceof Date)
  assert.equal(latest.checks.length, 8)

  const indexes = await db().collection('dq_reports').indexes()
  const ttl = indexes.find((i) => i.key.runAt === 1)
  assert.equal(ttl.expireAfterSeconds, 30 * 24 * 60 * 60)
})
