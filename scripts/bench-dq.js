// 데이터 품질 검사의 탐지 정확도와 실행 시간 측정
// 개수를 아는 이상 데이터를 섞고, 섞기 전후 결과의 차이가 섞은 양과 같은지 확인
//
// 사용법: npm run bench:dq
//        npm run bench:dq -- 300000     이벤트 수 지정
const fs = require('fs')
const os = require('os')
const path = require('path')
const { ObjectId } = require('mongodb')
const { MongoMemoryServer } = require('mongodb-memory-server')
const db = require('../src/db')
const hourlyStats = require('../src/services/hourlyStats')
const dataQuality = require('../src/services/dataQuality')
const { seed } = require('./seed')

const EVENTS = Number(process.argv[2]) || 1000000
// 글 수에 비례하는 검사를 확인하기 위한 옵션. 예: BENCH_POSTS=100000
const POSTS = Number(process.env.BENCH_POSTS) || 20000
const MIN = 60 * 1000
const HOUR = 60 * MIN

const INJECT = {
  likeCountDrift: 50,
  commentCountDrift: 30,
  repeatedViewPairs: 1000, // 쌍마다 6번 조회 → 반복 5회씩
  orphanEvents: 2000,
  skewedImpressions: 1000,
  statsMismatches: 10,
}

const cleanupTasks = []
async function cleanup() {
  while (cleanupTasks.length > 0) {
    try {
      await cleanupTasks.pop()()
    } catch {
      // 정리 중 오류는 무시
    }
  }
}
process.on('SIGINT', () => cleanup().finally(() => process.exit(130)))

function byName(report) {
  return Object.fromEntries(report.checks.map((c) => [c.name, c]))
}

function event(type, postId, at, extra = {}) {
  return { type, userId: null, postId, surface: 'feed_latest', position: null, occurredAt: at, receivedAt: at, source: 'server', ...extra }
}

async function inject(d, now) {
  const posts = await d.collection('posts').find({}, { projection: { _id: 1 } }).limit(200).toArray()
  const ids = posts.map((p) => p._id)

  // 1. 공감 수, 댓글 수 어긋남. 실제 어긋남처럼 해당 글에 행동 이벤트도 함께 넣음
  //    통계 정합성 검사(직전 한 시간)에 영향이 없도록 5시간 전 시각 사용
  const writeAt = new Date(now.getTime() - 5 * HOUR)
  await d.collection('events').insertMany([
    ...ids.slice(0, INJECT.likeCountDrift).map((id) => event('like', id, writeAt)),
    ...ids.slice(100, 100 + INJECT.commentCountDrift).map((id) => event('comment', id, writeAt)),
  ])
  await d.collection('posts').updateMany({ _id: { $in: ids.slice(0, INJECT.likeCountDrift) } }, { $set: { likeCount: 7 } })
  await d.collection('posts').updateMany(
    { _id: { $in: ids.slice(100, 100 + INJECT.commentCountDrift) } },
    { $set: { commentCount: 3 } },
  )

  // 2. 반복 조회. 기존 데이터와 겹치지 않게 새 유저 id 사용, 10분 구간 경계를 피해 배치
  const tenMin = 10 * MIN
  const base = Math.floor((now.getTime() - 3 * HOUR) / tenMin) * tenMin + MIN
  const views = []
  for (let i = 0; i < INJECT.repeatedViewPairs; i++) {
    const userId = new ObjectId()
    const postId = ids[i % ids.length]
    for (let k = 0; k < 6; k++) views.push(event('view', postId, new Date(base + k * 1000), { userId }))
  }
  await d.collection('events').insertMany(views)

  // 3. 존재하지 않는 글을 가리키는 노출
  const at = new Date(now.getTime() - 2 * HOUR)
  await d.collection('events').insertMany(
    Array.from({ length: INJECT.orphanEvents }, () => event('impression', new ObjectId(), at, { source: 'client' })),
  )

  // 4. 발생 시각이 수신 시각보다 10분 이른 노출
  await d.collection('events').insertMany(
    Array.from({ length: INJECT.skewedImpressions }, (_, i) =>
      event('impression', ids[i % ids.length], at, { occurredAt: new Date(at.getTime() - 10 * MIN), source: 'client' }),
    ),
  )

  // 5. 직전 한 시간의 통계 일부를 원본과 다르게 변경
  const prevHour = new Date(Math.floor(now.getTime() / HOUR) * HOUR - HOUR)
  const statRows = await d.collection(hourlyStats.COLLECTION).find({ hour: prevHour }).limit(INJECT.statsMismatches).toArray()
  for (const row of statRows) await d.collection(hourlyStats.COLLECTION).updateOne({ _id: row._id }, { $inc: { views: 1 } })

  // 6. 통계 작업이 20분째 멈춘 상황
  await d.collection('job_runs').updateOne({ _id: 'hourly_stats' }, { $set: { lastRunAt: new Date(now.getTime() - 20 * MIN) } })

  return { statsMismatchesInjected: statRows.length }
}

async function main() {
  const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-dq-'))
  cleanupTasks.push(() => fs.rmSync(dbPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }))
  const mongo = await MongoMemoryServer.create({
    instance: { dbPath, storageEngine: 'wiredTiger', args: ['--setParameter', 'maxIndexBuildMemoryUsageMegabytes=2048'] },
  })
  cleanupTasks.push(() => mongo.stop())

  await db.connect(mongo.getUri(), 'community_dq')
  const d = db.getDb()
  const now = new Date()

  console.log(`이벤트 ${EVENTS.toLocaleString()}개, 글 ${POSTS.toLocaleString()}개 준비 중...`)
  await seed(d, { events: EVENTS, posts: POSTS, now })
  await db.ensureIndexes()
  await hourlyStats.backfill({ now })

  const before = byName(await dataQuality.runChecks({ now }))
  const { statsMismatchesInjected } = await inject(d, now)
  const afterReport = await dataQuality.runChecks({ now })
  const after = byName(afterReport)
  // 같은 데이터로 전체 검사도 돌려 범위별 비용 비교
  const fullReport = byName(await dataQuality.runChecks({ now, fullScan: true }))

  const rows = [
    ['공감 수 어긋남(글)', INJECT.likeCountDrift, after.like_count_drift.value - before.like_count_drift.value],
    ['댓글 수 어긋남(글)', INJECT.commentCountDrift, after.comment_count_drift.value - before.comment_count_drift.value],
    ['반복 조회(회)', INJECT.repeatedViewPairs * 5, after.duplicate_views.detail.repeatedViews - before.duplicate_views.detail.repeatedViews],
    ['주인 없는 이벤트(건)', INJECT.orphanEvents, after.orphan_events.detail.orphanEvents - before.orphan_events.detail.orphanEvents],
    ['시계 오차 노출(건)', INJECT.skewedImpressions, after.clock_skew.detail.late - before.clock_skew.detail.late],
    ['통계 불일치(글)', statsMismatchesInjected, after.stats_consistency.value - before.stats_consistency.value],
  ].map(([항목, 넣은양, 찾은양]) => ({ 항목, 넣은양, 찾은양, 일치: 넣은양 === 찾은양 }))

  const statusRows = afterReport.checks.map((c) => ({
    검사: c.name,
    섞기전: before[c.name].status,
    섞은후: c.status,
    소요ms: c.durationMs,
    전체검사ms: fullReport[c.name].durationMs,
    확인한글수: c.detail?.postsChecked ?? '-',
  }))

  console.log('\n탐지 정확도')
  console.table(rows)
  console.log('\n검사별 상태와 소요 시간(섞은 후)')
  console.table(statusRows)
  console.log(`전체 검사 시간: ${afterReport.durationMs}ms`)

  const outDir = path.join(__dirname, '..', 'bench-results')
  fs.mkdirSync(outDir, { recursive: true })
  const outName = process.env.BENCH_LABEL ? `data-quality-${process.env.BENCH_LABEL}.json` : 'data-quality.json'
  fs.writeFileSync(
    path.join(outDir, outName),
    JSON.stringify(
      {
        environment: {
          measuredAt: new Date().toISOString(),
          events: EVENTS,
          posts: POSTS,
          node: process.version,
          cpu: os.cpus()[0].model.trim(),
          memoryGb: Math.round(os.totalmem() / 1024 ** 3),
        },
        injected: INJECT,
        detection: rows,
        checks: statusRows,
        totalCheckMs: afterReport.durationMs,
        before: before,
      },
      null,
      2,
    ),
  )
  console.log(`결과 저장: bench-results/${outName}`)
  await db.close()
}

main()
  .then(cleanup)
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err)
    await cleanup()
    process.exit(1)
  })
