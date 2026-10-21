// 원본 이벤트 집계와 시간별 통계 집계가 같은 규칙을 쓰도록 한곳에 둠

// 행동별 점수(가설, 데이터로 조정 예정)
const WEIGHTS = { view: 1, like: 3, unlike: -3, comment: 5 }
const SCORED_TYPES = Object.keys(WEIGHTS)

const WINDOW_HOURS = 24
const HOUR_MS = 60 * 60 * 1000

function startOfHour(date) {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS)
}

const countOf = (type) => ({ $sum: { $cond: [{ $eq: ['$type', type] }, 1, 0] } })

// 점수 계산 후 상위 후보에만 글 정보를 붙이고 삭제된 글을 거름
const CANDIDATES = 50
function rankingStages(limit) {
  return [
    {
      $addFields: {
        score: {
          $add: [
            { $multiply: ['$views', WEIGHTS.view] },
            { $multiply: ['$likes', WEIGHTS.like] },
            { $multiply: ['$unlikes', WEIGHTS.unlike] },
            { $multiply: ['$comments', WEIGHTS.comment] },
          ],
        },
        likes: { $subtract: ['$likes', '$unlikes'] },
      },
    },
    { $match: { score: { $gt: 0 } } },
    { $sort: { score: -1, _id: -1 } },
    { $limit: CANDIDATES },
    // 모든 글이 아니라 상위 후보에만 lookup
    { $lookup: { from: 'posts', localField: '_id', foreignField: '_id', as: 'post' } },
    { $unwind: '$post' },
    { $match: { 'post.deletedAt': null } },
    { $limit: limit },
  ]
}

function toPostWithStats(row) {
  return {
    ...row.post,
    stats: { views: row.views, likes: row.likes, comments: row.comments, score: row.score },
  }
}

module.exports = {
  WEIGHTS,
  SCORED_TYPES,
  WINDOW_HOURS,
  HOUR_MS,
  startOfHour,
  countOf,
  rankingStages,
  toPostWithStats,
}
