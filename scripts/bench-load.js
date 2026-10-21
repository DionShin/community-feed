// 동시 요청에서 인기 피드의 처리량과 응답 시간 측정
// 실제 앱 서버를 띄우고 계산 방식을 바꿔 가며 같은 부하를 줌
//
// 사용법: npm run bench:load
//        npm run bench:load -- 1000000 50 10     이벤트 수, 동시 연결 수, 측정 시간(초)
const fs = require('fs')
const os = require('os')
const path = require('path')
const autocannon = require('autocannon')
const { MongoMemoryServer } = require('mongodb-memory-server')

const EVENTS = Number(process.argv[2]) || 1000000
const CONNECTIONS = Number(process.argv[3]) || 50
const DURATION_SEC = Number(process.argv[4]) || 10
const WARMUP_SEC = 3

function load(url, duration) {
  return autocannon({ url, connections: CONNECTIONS, duration })
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
  const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-load-'))
  cleanupTasks.push(() => fs.rmSync(dbPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }))
  const mongo = await MongoMemoryServer.create({
    instance: { dbPath, storageEngine: 'wiredTiger', args: ['--setParameter', 'maxIndexBuildMemoryUsageMegabytes=2048'] },
  })
  cleanupTasks.push(() => mongo.stop())

  // 앱 모듈을 불러오기 전에 환경변수 설정
  // 개발 모드는 요청마다 템플릿을 다시 컴파일하므로 운영 모드로 측정
  process.env.NODE_ENV = 'production'
  process.env.MONGO_URL = mongo.getUri()
  process.env.DB_NAME = 'community_load'
  process.env.SESSION_SECRET = 'bench'
  delete process.env.S3_BUCKET

  const db = require('../src/db')
  const { createApp } = require('../src/app')
  const popular = require('../src/services/popular')
  const hourlyStats = require('../src/services/hourlyStats')
  const { seed } = require('./seed')

  await db.connect(process.env.MONGO_URL, process.env.DB_NAME)
  console.log(`이벤트 ${EVENTS.toLocaleString()}개 준비 중...`)
  await seed(db.getDb(), { events: EVENTS, now: new Date() })
  await db.ensureIndexes()
  await hourlyStats.backfill()

  const server = createApp().listen(0)
  const url = `http://localhost:${server.address().port}/popular`

  // 라우터가 부르는 getPopularPostsCached를 방식별로 바꿔 끼워 측정
  const original = popular.getPopularPostsCached
  const strategies = [
    { name: '1차: 원본 이벤트 집계(커버링 인덱스)', fn: () => popular.getPopularPostsFromEvents() },
    { name: '2차: 시간별 통계', fn: () => popular.getPopularPosts() },
    { name: '3차: 시간별 통계 + 결과 캐시', fn: original },
  ]

  const results = []
  for (const s of strategies) {
    popular.getPopularPostsCached = s.fn
    popular.resetCache()

    await load(url, WARMUP_SEC)
    popular.resetCache()
    const r = await load(url, DURATION_SEC)

    const row = {
      strategy: s.name,
      requestsPerSec: Math.round(r.requests.average),
      totalRequests: r.requests.total,
      latencyP50Ms: r.latency.p50,
      latencyP99Ms: r.latency.p99,
      errors: r.errors,
      non2xx: r.non2xx,
      computations: s.fn === original ? popular.cacheStats().computations : r.requests.total,
    }
    results.push(row)
    console.log(row)
  }
  popular.getPopularPostsCached = original

  const environment = {
    measuredAt: new Date().toISOString(),
    events: EVENTS,
    connections: CONNECTIONS,
    durationSec: DURATION_SEC,
    node: process.version,
    cpu: os.cpus()[0].model.trim(),
    cores: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
  }

  console.log('\n요약')
  console.table(
    results.map((r) => ({
      방식: r.strategy,
      초당요청: r.requestsPerSec,
      p50ms: r.latencyP50Ms,
      p99ms: r.latencyP99Ms,
      인기순위계산횟수: r.computations,
      에러: r.errors + r.non2xx,
    })),
  )

  const outDir = path.join(__dirname, '..', 'bench-results')
  fs.mkdirSync(outDir, { recursive: true })
  // 확인용 실행은 BENCH_LABEL로 이름을 바꿔 본 결과를 덮어쓰지 않게 함
  const outName = process.env.BENCH_LABEL ? `load-${process.env.BENCH_LABEL}.json` : 'load-popular.json'
  fs.writeFileSync(path.join(outDir, outName), JSON.stringify({ environment, results }, null, 2))
  console.log(`결과 저장: bench-results/${outName}`)

  server.close()
  await db.close()
  process.exit(0)
}

main()
  .then(cleanup)
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err)
    await cleanup()
    process.exit(1)
  })
