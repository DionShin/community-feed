const { getDb } = require('../db')
const { SCORED_TYPES, WINDOW_HOURS, HOUR_MS, startOfHour, countOf } = require('./scoring')

const COLLECTION = 'post_stats_hourly'

// 직전 시간까지 재계산해 조금 늦게 저장된 이벤트를 반영함. 그보다 오래된 칸은 확정으로 봄
const RECENT_HOURS = 2

// 갱신마다 1씩 증가. 인기 피드 캐시 무효화 기준
let version = 0
function getVersion() {
  return version
}

// 칸을 통째로 덮어써서 여러 번 실행해도 결과가 같음
// 시작을 정시로 맞춤. 한 칸을 일부 이벤트만으로 덮어쓰면 숫자가 줄어들기 때문
async function rebuild({ from, to }) {
  const start = startOfHour(from)

  await getDb()
    .collection('events')
    .aggregate([
      { $match: { type: { $in: SCORED_TYPES }, receivedAt: { $gte: start, $lt: to } } },
      {
        $group: {
          _id: {
            postId: '$postId',
            hour: { $dateTrunc: { date: '$receivedAt', unit: 'hour' } },
          },
          views: countOf('view'),
          likes: countOf('like'),
          unlikes: countOf('unlike'),
          comments: countOf('comment'),
        },
      },
      { $addFields: { postId: '$_id.postId', hour: '$_id.hour', updatedAt: '$$NOW' } },
      { $merge: { into: COLLECTION, on: '_id', whenMatched: 'replace', whenNotMatched: 'insert' } },
    ])
    .toArray()

  version++
  // 품질 검사의 작업 정지 판단용. 통계 문서 갱신 시각만 보면 이벤트가 없는 시간대에 오탐이 남
  await getDb()
    .collection('job_runs')
    .updateOne({ _id: 'hourly_stats' }, { $set: { lastRunAt: new Date(), lastRangeStart: start, lastRangeEnd: to } }, { upsert: true })
}

function rebuildRecent({ now = new Date() } = {}) {
  return rebuild({ from: new Date(now.getTime() - RECENT_HOURS * HOUR_MS), to: now })
}

// 서버 시작 시 한 번 실행
function backfill({ now = new Date() } = {}) {
  return rebuild({ from: new Date(now.getTime() - (WINDOW_HOURS + 1) * HOUR_MS), to: now })
}

module.exports = { COLLECTION, RECENT_HOURS, getVersion, rebuild, rebuildRecent, backfill }
