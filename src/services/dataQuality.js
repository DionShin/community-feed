const { getDb } = require('../db')
const { SCORED_TYPES, HOUR_MS, startOfHour, countOf } = require('./scoring')
const hourlyStats = require('./hourlyStats')

// status: ok(정상), warn(데이터 이상), fail(파이프라인 이상), info(참고)

const THRESHOLDS = {
  countDrift: 0,
  duplicateViewRatio: 0.2,
  orphanEventRatio: 0.01,
  clockSkewRatio: 0.05,
  clockSkewMs: 60 * 1000,
  // 통계 작업은 1분 주기라 5분 넘게 멈추면 실패로 봄
  statsStaleMs: 5 * 60 * 1000,
}

const WINDOW_MS = 24 * HOUR_MS
const DUPLICATE_WINDOW_MINUTES = 10
const SAMPLE_SIZE = 5

const col = (name) => getDb().collection(name)
const ratio = (part, total) => (total === 0 ? 0 : part / total)
const round4 = (n) => Math.round(n * 10000) / 10000

function result(name, title, { status, value, threshold = null, detail = {}, samples = [] }) {
  return { name, title, status, value, threshold, detail, samples }
}

// 원본(likes, comments)을 기준으로 비교. postIds를 주면 그 글만 확인
async function findCountDrift({ field, from, sourceFilter = {} }, postIds = null) {
  const match = { deletedAt: null }
  if (postIds) match._id = { $in: postIds }
  return col('posts')
    .aggregate([
      { $match: match },
      {
        $lookup: {
          from,
          localField: '_id',
          foreignField: 'postId',
          pipeline: [{ $match: sourceFilter }, { $count: 'n' }],
          as: 'src',
        },
      },
      { $project: { title: 1, stored: `$${field}`, actual: { $ifNull: [{ $first: '$src.n' }, 0] } } },
      { $match: { $expr: { $ne: ['$stored', '$actual'] } } },
    ])
    .toArray()
}

// 숫자는 공감, 댓글 쓰기가 일어날 때만 어긋나므로 최근 24시간에 그런 이벤트가 있던 글만 고름
async function recentlyChangedPosts(types, now) {
  const since = new Date(now.getTime() - WINDOW_MS)
  const rows = await col('events')
    .aggregate([
      { $match: { type: { $in: types }, receivedAt: { $gte: since, $lt: now } } },
      { $group: { _id: '$postId' } },
    ])
    .toArray()
  return rows.map((r) => r._id)
}

// 평소에는 최근 변경된 글만 확인(비용이 전체 글 수에 비례하지 않게). DB를 직접 고친 경우는 fullScan으로만 잡힘
async function checkCountDrift(name, title, options, { now, fullScan }) {
  const candidates = fullScan ? null : await recentlyChangedPosts(options.changeTypes, now)
  const drifted = await findCountDrift(options, candidates)
  return result(name, title, {
    status: drifted.length > THRESHOLDS.countDrift ? 'warn' : 'ok',
    value: drifted.length,
    threshold: THRESHOLDS.countDrift,
    detail: { scope: fullScan ? 'full' : 'recent', postsChecked: candidates ? candidates.length : 'all' },
    samples: drifted.slice(0, SAMPLE_SIZE).map((d) => ({ postId: String(d._id), stored: d.stored, actual: d.actual })),
  })
}

const LIKE_COUNT = { field: 'likeCount', from: 'likes', changeTypes: ['like', 'unlike'] }
const COMMENT_COUNT = {
  field: 'commentCount',
  from: 'comments',
  sourceFilter: { deletedAt: null },
  changeTypes: ['comment', 'comment_delete'],
}

// 10분 고정 구간 기준 근사치(구간 경계를 걸친 반복은 놓침). 비로그인 조회는 제외
async function checkDuplicateViews(now) {
  const since = new Date(now.getTime() - WINDOW_MS)
  const [r] = await col('events')
    .aggregate([
      { $match: { type: 'view', receivedAt: { $gte: since, $lt: now } } },
      {
        $facet: {
          total: [{ $count: 'n' }],
          repeats: [
            { $match: { userId: { $ne: null } } },
            {
              $group: {
                _id: {
                  userId: '$userId',
                  postId: '$postId',
                  bucket: { $dateTrunc: { date: '$receivedAt', unit: 'minute', binSize: DUPLICATE_WINDOW_MINUTES } },
                },
                n: { $sum: 1 },
              },
            },
            { $match: { n: { $gt: 1 } } },
            { $sort: { n: -1 } },
            {
              $group: {
                _id: null,
                extraViews: { $sum: { $subtract: ['$n', 1] } },
                groups: { $sum: 1 },
                top: { $push: { userId: '$_id.userId', postId: '$_id.postId', views: '$n' } },
              },
            },
            { $project: { extraViews: 1, groups: 1, top: { $slice: ['$top', SAMPLE_SIZE] } } },
          ],
        },
      },
    ])
    .toArray()

  const total = r.total[0]?.n ?? 0
  const extra = r.repeats[0]?.extraViews ?? 0
  const value = round4(ratio(extra, total))
  return result('duplicate_views', `같은 사람의 ${DUPLICATE_WINDOW_MINUTES}분 내 반복 조회 비율`, {
    status: value > THRESHOLDS.duplicateViewRatio ? 'warn' : 'ok',
    value,
    threshold: THRESHOLDS.duplicateViewRatio,
    detail: { totalViews: total, repeatedViews: extra, repeatedPairs: r.repeats[0]?.groups ?? 0 },
    samples: (r.repeats[0]?.top ?? []).map((t) => ({ userId: String(t.userId), postId: String(t.postId), views: t.views })),
  })
}

// 글 id별로 먼저 묶어 조회 횟수를 줄임. 삭제된 글의 이벤트는 정상 기록이라 따로 셈
async function checkOrphanEvents(now) {
  const since = new Date(now.getTime() - WINDOW_MS)
  const rows = await col('events')
    .aggregate([
      { $match: { receivedAt: { $gte: since, $lt: now }, postId: { $ne: null } } },
      { $group: { _id: '$postId', n: { $sum: 1 } } },
      {
        $lookup: {
          from: 'posts',
          localField: '_id',
          foreignField: '_id',
          pipeline: [{ $project: { deletedAt: 1 } }],
          as: 'post',
        },
      },
      {
        $project: {
          n: 1,
          missing: { $eq: [{ $size: '$post' }, 0] },
          deleted: { $gt: [{ $first: '$post.deletedAt' }, null] },
        },
      },
    ])
    .toArray()

  let total = 0
  let missing = 0
  let deleted = 0
  const samples = []
  for (const row of rows) {
    total += row.n
    if (row.missing) {
      missing += row.n
      if (samples.length < SAMPLE_SIZE) samples.push({ postId: String(row._id), events: row.n })
    } else if (row.deleted) {
      deleted += row.n
    }
  }

  const value = round4(ratio(missing, total))
  return result('orphan_events', '존재하지 않는 글을 가리키는 이벤트 비율', {
    status: value > THRESHOLDS.orphanEventRatio ? 'warn' : 'ok',
    value,
    threshold: THRESHOLDS.orphanEventRatio,
    detail: { totalEvents: total, orphanEvents: missing, deletedPostEvents: deleted },
    samples,
  })
}

// 수집 단계에서 걸러지지 않은 범위 안의 시계 오차를 확인
async function checkClockSkew(now) {
  const since = new Date(now.getTime() - WINDOW_MS)
  const skew = THRESHOLDS.clockSkewMs
  const [r] = await col('events')
    .aggregate([
      { $match: { type: 'impression', receivedAt: { $gte: since, $lt: now } } },
      { $project: { diff: { $subtract: ['$receivedAt', '$occurredAt'] } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          late: { $sum: { $cond: [{ $gt: ['$diff', skew] }, 1, 0] } },
          ahead: { $sum: { $cond: [{ $lt: ['$diff', -skew] }, 1, 0] } },
          maxLateMs: { $max: '$diff' },
        },
      },
    ])
    .toArray()

  const total = r?.total ?? 0
  const skewed = (r?.late ?? 0) + (r?.ahead ?? 0)
  const value = round4(ratio(skewed, total))
  return result('clock_skew', '발생 시각과 수신 시각이 1분 넘게 차이 나는 노출 비율', {
    status: value > THRESHOLDS.clockSkewRatio ? 'warn' : 'ok',
    value,
    threshold: THRESHOLDS.clockSkewRatio,
    detail: { totalImpressions: total, late: r?.late ?? 0, ahead: r?.ahead ?? 0, maxLateMs: r?.maxLateMs ?? 0 },
  })
}

async function checkStatsFreshness(now) {
  const run = await col('job_runs').findOne({ _id: 'hourly_stats' })
  if (!run) {
    return result('stats_freshness', '시간별 통계 작업 마지막 실행 후 경과 시간(ms)', {
      status: 'fail',
      value: null,
      threshold: THRESHOLDS.statsStaleMs,
      detail: { message: '통계 작업이 한 번도 실행되지 않았습니다.' },
    })
  }
  const age = now.getTime() - run.lastRunAt.getTime()
  return result('stats_freshness', '시간별 통계 작업 마지막 실행 후 경과 시간(ms)', {
    status: age > THRESHOLDS.statsStaleMs ? 'fail' : 'ok',
    value: age,
    threshold: THRESHOLDS.statsStaleMs,
    detail: { lastRunAt: run.lastRunAt.toISOString() },
  })
}

// 직전 한 시간은 1분마다 재계산되는 범위라 정상이면 원본과 정확히 같아야 함
async function checkStatsConsistency(now) {
  const hourEnd = startOfHour(now)
  const hourStart = new Date(hourEnd.getTime() - HOUR_MS)

  const expectedRows = await col('events')
    .aggregate([
      { $match: { type: { $in: SCORED_TYPES }, receivedAt: { $gte: hourStart, $lt: hourEnd } } },
      {
        $group: {
          _id: '$postId',
          views: countOf('view'),
          likes: countOf('like'),
          unlikes: countOf('unlike'),
          comments: countOf('comment'),
        },
      },
    ])
    .toArray()
  const actualRows = await col(hourlyStats.COLLECTION).find({ hour: hourStart }).toArray()

  const key = (r) => `${r.views}/${r.likes}/${r.unlikes}/${r.comments}`
  const expected = new Map(expectedRows.map((r) => [String(r._id), key(r)]))
  const actual = new Map(actualRows.map((r) => [String(r.postId), key(r)]))

  const mismatches = []
  for (const id of new Set([...expected.keys(), ...actual.keys()])) {
    if (expected.get(id) !== actual.get(id)) {
      mismatches.push({ postId: id, expected: expected.get(id) ?? '없음', actual: actual.get(id) ?? '없음' })
    }
  }

  return result('stats_consistency', '직전 한 시간 통계와 원본 재계산 값이 다른 글 수', {
    status: mismatches.length > 0 ? 'fail' : 'ok',
    value: mismatches.length,
    threshold: 0,
    detail: { hour: hourStart.toISOString(), postsChecked: expected.size },
    samples: mismatches.slice(0, SAMPLE_SIZE),
  })
}

async function zeroResultSearches(now) {
  const since = new Date(now.getTime() - 7 * WINDOW_MS)
  const rows = await col('events')
    .aggregate([
      { $match: { type: 'search', receivedAt: { $gte: since, $lt: now }, 'meta.resultCount': 0 } },
      { $group: { _id: '$meta.query', n: { $sum: 1 } } },
      { $sort: { n: -1, _id: 1 } },
      { $limit: 10 },
    ])
    .toArray()
  return result('zero_result_searches', '최근 7일 결과 0건 검색어', {
    status: 'info',
    value: rows.length,
    samples: rows.map((r) => ({ query: r._id, searches: r.n })),
  })
}

async function runChecks({ now = new Date(), fullScan = false } = {}) {
  const scope = { now, fullScan }
  const checks = [
    () => checkCountDrift('like_count_drift', '공감 수가 실제 공감 문서 수와 다른 글 수', LIKE_COUNT, scope),
    () => checkCountDrift('comment_count_drift', '댓글 수가 실제 댓글 수와 다른 글 수', COMMENT_COUNT, scope),
    () => checkDuplicateViews(now),
    () => checkOrphanEvents(now),
    () => checkClockSkew(now),
    () => checkStatsFreshness(now),
    () => checkStatsConsistency(now),
    () => zeroResultSearches(now),
  ]

  const startedAt = Date.now()
  const results = []
  for (const check of checks) {
    const t0 = Date.now()
    const r = await check()
    results.push({ ...r, durationMs: Date.now() - t0 })
  }

  return { runAt: now, fullScan, durationMs: Date.now() - startedAt, checks: results }
}

async function saveReport(report) {
  await col('dq_reports').insertOne(report)
}

async function latestReport() {
  return col('dq_reports').findOne({}, { sort: { runAt: -1 } })
}

// apply가 false면 고칠 목록만 반환. 드물게 직접 실행하는 작업이라 모든 글을 확인
async function reconcileCounts({ apply = false } = {}) {
  const changes = []
  for (const t of [LIKE_COUNT, COMMENT_COUNT]) {
    for (const d of await findCountDrift(t)) {
      changes.push({ postId: d._id, field: t.field, from: d.stored, to: d.actual })
    }
  }

  if (apply && changes.length > 0) {
    await col('posts').bulkWrite(
      changes.map((c) => ({ updateOne: { filter: { _id: c.postId }, update: { $set: { [c.field]: c.to } } } })),
    )
  }
  return { applied: apply, changes: changes.map((c) => ({ ...c, postId: String(c.postId) })) }
}

module.exports = { THRESHOLDS, runChecks, saveReport, latestReport, reconcileCounts }
