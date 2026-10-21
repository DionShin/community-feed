const { getDb } = require('../db')
const {
  WEIGHTS,
  SCORED_TYPES,
  WINDOW_HOURS,
  HOUR_MS,
  startOfHour,
  countOf,
  rankingStages,
  toPostWithStats,
} = require('./scoring')
const hourlyStats = require('./hourlyStats')
const { COLLECTION } = hourlyStats

const PAGE_SIZE = 20

// 시간별 통계에서 최근 24칸을 더함. 칸 단위라 정각이 아니면 기간이 최대 25시간이 됨
function buildPopularPipeline({ now = new Date(), windowHours = WINDOW_HOURS, limit = PAGE_SIZE } = {}) {
  const since = startOfHour(new Date(now.getTime() - windowHours * HOUR_MS))
  return [
    { $match: { hour: { $gte: since, $lte: now } } },
    {
      $group: {
        _id: '$postId',
        views: { $sum: '$views' },
        likes: { $sum: '$likes' },
        unlikes: { $sum: '$unlikes' },
        comments: { $sum: '$comments' },
      },
    },
    ...rankingStages(limit),
  ]
}

async function getPopularPosts(options = {}) {
  const rows = await getDb().collection(COLLECTION).aggregate(buildPopularPipeline(options)).toArray()
  return rows.map(toPostWithStats)
}

// 결과 캐시. 통계 버전이 같을 때만 재사용(시간 기준과 달리 갱신 직후 옛 결과를 보여주지 않음)
// 다른 서버의 갱신이나 작업 정지에 대비해 2분이 지나면 무조건 재계산
const CACHE_MAX_AGE_MS = 2 * 60 * 1000

let cache = null // { version, expiresAt, value }
let inFlight = null // { version, promise }
const counters = { hits: 0, misses: 0, computations: 0 }

async function getPopularPostsCached() {
  const version = hourlyStats.getVersion()

  if (cache && cache.version === version && cache.expiresAt > Date.now()) {
    counters.hits++
    return cache.value
  }
  counters.misses++

  // 캐시 쇄도 방지: 같은 버전을 계산 중이면 그 결과를 함께 기다림
  if (inFlight && inFlight.version === version) return inFlight.promise

  const promise = (async () => {
    counters.computations++
    const value = await getPopularPosts()
    cache = { version, expiresAt: Date.now() + CACHE_MAX_AGE_MS, value }
    return value
  })()
  inFlight = { version, promise }

  try {
    return await promise
  } finally {
    // 실패해도 다음 요청이 다시 시도할 수 있게 진행 중 표시 제거
    if (inFlight && inFlight.promise === promise) inFlight = null
  }
}

function cacheStats() {
  return { ...counters }
}

function resetCache() {
  cache = null
  inFlight = null
  counters.hits = 0
  counters.misses = 0
  counters.computations = 0
}

// 이전 방식(요청마다 원본 이벤트 집계). 성능 비교와 결과 검증용
function buildPopularPipelineFromEvents({ now = new Date(), windowHours = WINDOW_HOURS, limit = PAGE_SIZE } = {}) {
  const since = new Date(now.getTime() - windowHours * HOUR_MS)
  return [
    { $match: { type: { $in: SCORED_TYPES }, receivedAt: { $gte: since, $lte: now } } },
    {
      $group: {
        _id: '$postId',
        views: countOf('view'),
        likes: countOf('like'),
        unlikes: countOf('unlike'),
        comments: countOf('comment'),
      },
    },
    ...rankingStages(limit),
  ]
}

async function getPopularPostsFromEvents(options = {}) {
  const rows = await getDb().collection('events').aggregate(buildPopularPipelineFromEvents(options)).toArray()
  return rows.map(toPostWithStats)
}

module.exports = {
  WEIGHTS,
  WINDOW_HOURS,
  buildPopularPipeline,
  getPopularPosts,
  getPopularPostsCached,
  cacheStats,
  resetCache,
  buildPopularPipelineFromEvents,
  getPopularPostsFromEvents,
}
