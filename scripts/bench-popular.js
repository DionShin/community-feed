// 이벤트 양에 따른 인기 피드 응답 시간 측정
//
// 사용법: npm run bench:popular
//        npm run bench:popular -- 100000,300000     이벤트 양을 직접 지정
//        BENCH_MODE=events npm run bench:popular     이전 방식(원본 이벤트 집계) 측정
//
// 매번 임시 MongoDB(WiredTiger)를 새로 띄워 같은 조건에서 측정
const fs = require('fs')
const os = require('os')
const path = require('path')
const { performance } = require('perf_hooks')
const { MongoMemoryServer } = require('mongodb-memory-server')
const db = require('../src/db')
const popular = require('../src/services/popular')
const hourlyStats = require('../src/services/hourlyStats')
const { seed } = require('./seed')

const DEFAULT_SIZES = [100000, 300000, 1000000]

// 인덱스 구성별 비교용. 예: BENCH_EVENTS_INDEX=baseline npm run bench:popular
const EVENTS_INDEX_VARIANTS = {
  baseline: { receivedAt: 1 },
  'time-type-post': { receivedAt: 1, type: 1, postId: 1 },
  'type-time-post': { type: 1, receivedAt: 1, postId: 1 },
}
const indexVariant = process.env.BENCH_EVENTS_INDEX || 'type-time-post'

async function applyEventsIndex(collection) {
  const spec = EVENTS_INDEX_VARIANTS[indexVariant]
  if (!spec) throw new Error(`알 수 없는 인덱스 구성: ${indexVariant}`)
  await collection.dropIndexes()
  await collection.createIndex(spec)
}
const WARMUP_RUNS = 3
const MEASURE_RUNS = 20

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

// 실행 계획 구조가 버전마다 달라 필요한 값을 찾아서 꺼냄
function findStats(node) {
  if (!node || typeof node !== 'object') return null
  if ('totalDocsExamined' in node && 'totalKeysExamined' in node) return node
  for (const value of Object.values(node)) {
    const found = findStats(value)
    if (found) return found
  }
  return null
}

function findInputStage(node) {
  if (!node || typeof node !== 'object') return null
  if (node.winningPlan) return node.winningPlan
  for (const value of Object.values(node)) {
    const found = findInputStage(value)
    if (found) return found
  }
  return null
}

function stageNames(plan) {
  const names = []
  let node = plan?.queryPlan ?? plan
  while (node) {
    if (node.stage) names.push(node.stage)
    node = node.inputStage ?? node.inputStages?.[0]
  }
  return names.join(' <- ')
}

// events: 원본 이벤트 집계(이전 방식), hourly: 시간별 통계(현재 방식)
const mode = process.env.BENCH_MODE || 'hourly'

const MODES = {
  events: {
    collection: 'events',
    query: (now) => popular.getPopularPostsFromEvents({ now }),
    pipeline: (now) => popular.buildPopularPipelineFromEvents({ now }),
  },
  hourly: {
    collection: hourlyStats.COLLECTION,
    query: (now) => popular.getPopularPosts({ now }),
    pipeline: (now) => popular.buildPopularPipeline({ now }),
  },
}

async function timeIt(fn, runs, warmup = 0) {
  for (let i = 0; i < warmup; i++) await fn()
  const times = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await fn()
    times.push(performance.now() - t0)
  }
  return times.sort((a, b) => a - b)
}

const round = (n) => Number(n.toFixed(1))

async function measure(size, now) {
  const d = db.getDb()
  const target = MODES[mode]
  if (!target) throw new Error(`알 수 없는 측정 방식: ${mode}`)

  const seedStart = performance.now()
  await seed(d, { events: size, now })
  await db.ensureIndexes()
  await applyEventsIndex(d.collection('events'))
  const seedSeconds = (performance.now() - seedStart) / 1000

  const since = new Date(now.getTime() - popular.WINDOW_HOURS * 60 * 60 * 1000)
  const eventsInWindow = await d.collection('events').countDocuments({ receivedAt: { $gte: since, $lte: now } })

  // 통계 생성 비용도 함께 기록
  let job = null
  if (mode === 'hourly') {
    const backfillStart = performance.now()
    await hourlyStats.backfill({ now })
    const backfillMs = performance.now() - backfillStart
    const recent = await timeIt(() => hourlyStats.rebuildRecent({ now }), 5, 1)
    job = {
      backfillMs: round(backfillMs),
      rebuildRecentP50Ms: round(percentile(recent, 50)),
      statsRowsInWindow: await d.collection(hourlyStats.COLLECTION).countDocuments({ hour: { $gte: since, $lte: now } }),
    }
  }

  const times = await timeIt(() => target.query(now), MEASURE_RUNS, WARMUP_RUNS)
  const posts = await target.query(now)

  const explain = await d.collection(target.collection).aggregate(target.pipeline(now)).explain('executionStats')
  const stats = findStats(explain)

  // 기준 시각이 정각이라 두 방식의 집계 기간이 같음. 결과 일치 여부 확인
  let sameAsEvents = null
  if (mode === 'hourly') {
    const fromEvents = await popular.getPopularPostsFromEvents({ now })
    const key = (list) => list.map((p) => `${p._id}:${p.stats.score}`).join(',')
    sameAsEvents = key(posts) === key(fromEvents)
  }

  return {
    totalEvents: size,
    eventsInWindow,
    resultCount: posts.length,
    p50Ms: round(percentile(times, 50)),
    p95Ms: round(percentile(times, 95)),
    maxMs: round(times[times.length - 1]),
    keysExamined: stats?.totalKeysExamined ?? null,
    docsExamined: stats?.totalDocsExamined ?? null,
    plan: stageNames(findInputStage(explain)),
    job,
    sameAsEvents,
    seedSeconds: round(seedSeconds),
  }
}

// 측정이 실패하거나 중단돼도 임시 DB와 폴더를 정리함(남기면 수백 MB씩 쌓임)
const cleanupTasks = []
async function cleanup() {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop()
    try {
      await task()
    } catch {
      // 정리 중 오류는 무시
    }
  }
}
process.on('SIGINT', () => cleanup().finally(() => process.exit(130)))

async function main() {
  const sizes = process.argv[2] ? process.argv[2].split(',').map(Number) : DEFAULT_SIZES

  const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-mongo-'))
  cleanupTasks.push(() => fs.rmSync(dbPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }))
  const mongo = await MongoMemoryServer.create({
    instance: {
      dbPath,
      storageEngine: 'wiredTiger',
      // 기본 200MB를 넘으면 임시 파일을 쓰는데, 경로에 한글이 있으면 실패해서 메모리 한도를 늘림
      args: ['--setParameter', 'maxIndexBuildMemoryUsageMegabytes=2048'],
    },
  })
  cleanupTasks.push(() => mongo.stop())
  await db.connect(mongo.getUri(), 'community_bench')
  const buildInfo = await db.getDb().admin().command({ buildInfo: 1 })

  const environment = {
    measuredAt: new Date().toISOString(),
    mongodb: buildInfo.version,
    node: process.version,
    cpu: os.cpus()[0].model.trim(),
    cores: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    os: `${os.type()} ${os.release()}`,
    runs: { warmup: WARMUP_RUNS, measured: MEASURE_RUNS },
    eventsIndex: { variant: indexVariant, spec: EVENTS_INDEX_VARIANTS[indexVariant] },
    mode,
  }
  console.log('측정 환경:', environment)

  // 모든 크기에서 같은 기준 시각 사용
  const now = new Date('2026-10-14T12:00:00Z')
  const results = []
  for (const size of sizes) {
    console.log(`\n이벤트 ${size.toLocaleString()}개 준비 중...`)
    const result = await measure(size, now)
    results.push(result)
    console.log(result)
  }

  console.log('\n요약')
  console.table(
    results.map((r) => ({
      전체이벤트: r.totalEvents,
      '24시간내이벤트': r.eventsInWindow,
      p50ms: r.p50Ms,
      p95ms: r.p95Ms,
      읽은인덱스키: r.keysExamined,
      읽은문서: r.docsExamined,
      ...(r.job ? { 통계갱신ms: r.job.rebuildRecentP50Ms, 전체채우기ms: r.job.backfillMs, 결과일치: r.sameAsEvents } : {}),
    })),
  )

  const outDir = path.join(__dirname, '..', 'bench-results')
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `popular-${process.env.BENCH_LABEL || (mode === 'hourly' ? 'hourly-stats' : indexVariant)}.json`)
  fs.writeFileSync(outFile, JSON.stringify({ environment, results }, null, 2))
  console.log(`\n결과 저장: ${path.relative(process.cwd(), outFile)}`)

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
